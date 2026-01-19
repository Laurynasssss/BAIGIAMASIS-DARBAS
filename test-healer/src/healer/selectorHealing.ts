import { load } from 'cheerio';

export interface SelectorSuggestion {
  originalSelector: string;
  suggestedSelector: string;
  confidence: number;
  reason: string;
}

export function extractMissingSelectors(errorText: string): string[] {
  const selectors = new Set<string>();
  const patterns = [
    /locator\((['"`])(.*?)\1\)/gi,
    /querySelectorAll?\((['"`])(.*?)\1\)/gi,
    /selector\s*:\s*(['"`])(.*?)\1/gi,
    /waiting for selector ['"`](.*?)['"`]/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(errorText)) !== null) {
      const value = match[2] ?? match[1];
      if (value) selectors.add(value.trim());
    }
  }

  return Array.from(selectors);
}

export function findNewSelector(domHtml: string, missingSelector: string): SelectorSuggestion | null {
  const $ = load(domHtml);
  const normalizedMissing = normalizeText(missingSelector);
  const tokens = tokenize(missingSelector);

  const candidates: Array<{ selector: string; score: number; reason: string }> = [];

  scanAttribute($, 'data-testid', normalizedMissing, tokens, candidates, value => `[data-testid="${value}"]`);
  scanAttribute($, 'id', normalizedMissing, tokens, candidates, value => `#${value}`);
  scanAttribute($, 'name', normalizedMissing, tokens, candidates, value => `[name="${value}"]`);
  scanAttribute($, 'aria-label', normalizedMissing, tokens, candidates, value => `[aria-label="${value}"]`);
  scanClass($, normalizedMissing, tokens, candidates);
  scanText($, normalizedMissing, tokens, candidates);

  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 0.25) return null;

  return {
    originalSelector: missingSelector,
    suggestedSelector: best.selector,
    confidence: Number(Math.min(0.95, 0.4 + best.score * 0.6).toFixed(2)),
    reason: best.reason,
  };
}

function scanAttribute(
  $: ReturnType<typeof load>,
  attribute: string,
  normalizedMissing: string,
  tokens: string[],
  candidates: Array<{ selector: string; score: number; reason: string }>,
  buildSelector: (value: string) => string
): void {
  $(`[${attribute}]`).each((_, el) => {
    const value = $(el).attr(attribute);
    if (!value) return;

    const score = scoreMatch(value, normalizedMissing, tokens);
    if (score <= 0) return;

    candidates.push({
      selector: buildSelector(value),
      score,
      reason: `${attribute} matched ${value}`,
    });
  });
}

function scanClass(
  $: ReturnType<typeof load>,
  normalizedMissing: string,
  tokens: string[],
  candidates: Array<{ selector: string; score: number; reason: string }>
): void {
  $('[class]').each((_, el) => {
    const classAttr = $(el).attr('class');
    if (!classAttr) return;

    const classNames = classAttr.split(/\s+/).filter(Boolean);
    for (const className of classNames) {
      const score = scoreMatch(className, normalizedMissing, tokens) * 0.9;
      if (score <= 0) continue;

      candidates.push({
        selector: `.${className}`,
        score,
        reason: `class matched ${className}`,
      });
    }
  });
}

function scanText(
  $: ReturnType<typeof load>,
  normalizedMissing: string,
  tokens: string[],
  candidates: Array<{ selector: string; score: number; reason: string }>
): void {
  $('button, a, label, span, p, div').each((_, el) => {
    const text = $(el).text().trim();
    if (!text) return;

    const score = scoreMatch(text, normalizedMissing, tokens) * 0.6;
    if (score <= 0.2) return;

    const safeText = text.replace(/"/g, '\"').slice(0, 80);
    const tagName = (el as unknown as { name?: string; tagName?: string }).tagName || (el as unknown as { name?: string }).name || 'element';
    candidates.push({
      selector: `${tagName}:has-text("${safeText}")`,
      score,
      reason: `text matched "${safeText}"`,
    });
  });
}

function scoreMatch(value: string, normalizedMissing: string, tokens: string[]): number {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) return 0;

  const overlapScore = tokenOverlap(tokens, normalizeTextTokens(normalizedValue));
  const substringScore = normalizedMissing.includes(normalizedValue) || normalizedValue.includes(normalizedMissing) ? 0.35 : 0;
  const proximityScore = longestCommonSubstring(normalizedMissing, normalizedValue) / Math.max(normalizedMissing.length, normalizedValue.length, 1);

  return Math.min(1, overlapScore + substringScore + proximityScore * 0.5);
}

function tokenOverlap(targetTokens: string[], candidateTokens: string[]): number {
  if (targetTokens.length === 0 || candidateTokens.length === 0) return 0;
  const candidateSet = new Set(candidateTokens);
  const hits = targetTokens.filter(token => candidateSet.has(token)).length;
  return hits / targetTokens.length;
}

function normalizeText(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, ' ').trim().toLowerCase();
}

function normalizeTextTokens(value: string): string[] {
  return normalizeText(value).split(/\s+|_|-/).filter(Boolean);
}

function tokenize(selector: string): string[] {
  const normalized = normalizeText(selector);
  return normalized.split(/\s+|_|-/).filter(Boolean);
}

function longestCommonSubstring(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  let max = 0;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > max) max = dp[i][j];
      }
    }
  }

  return max;
}