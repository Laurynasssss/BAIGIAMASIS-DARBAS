import { load } from 'cheerio';

export interface SelectorSuggestion {
  originalSelector: string;
  suggestedSelector: string;
  confidence: number;
  reason: string;
}

export interface SelectorContext {
  action?: string;
  valueHint?: string;
  usedSelectors?: string[];
}

export interface MissingSelectorContext {
  selector: string;
  context?: SelectorContext;
}

type SelectorUsage = {
  action: string;
  selector: string;
  valueHint?: string;
  index: number;
};

type ElementMetadata = {
  tagName: string;
  inputType: string;
  semanticText: string;
};

type Candidate = {
  selector: string;
  score: number;
  contextBonus: number;
  reason: string;
};

export function extractMissingSelectors(errorText: string): string[] {
  const selectors = new Set<string>();
  const patterns = [
    /locator\((['"`])(.*?)\1\)/gi,
    /querySelectorAll?\((['"`])(.*?)\1\)/gi,
    /(?:click|dblclick|tap)\((['"`])(.*?)\1\)/gi,
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

export function inferMissingSelectorsFromTestSource(
  testSource: string,
  domHtml: string,
  testNameHint?: string
): string[] {
  return inferMissingSelectorContextsFromTestSource(testSource, domHtml, testNameHint).map(item => item.selector);
}

export function inferMissingSelectorContextsFromTestSource(
  testSource: string,
  domHtml: string,
  testNameHint?: string
): MissingSelectorContext[] {
  if (!testSource || !domHtml) return [];

  const sourceSegment = extractRelevantTestSegment(testSource, testNameHint);
  const usages = collectSelectorUsages(sourceSegment);
  const missing: MissingSelectorContext[] = [];
  const seenMissing = new Set<string>();
  const seenByAction = new Map<string, string[]>();

  for (const usage of usages) {
    const normalized = usage.selector.trim();
    if (!normalized) continue;
    if (!isLikelyCssSelector(normalized)) continue;

    const actionKey = usage.action.toLowerCase();
    if (isSelectorMissing(domHtml, normalized)) {
      if (seenMissing.has(normalized)) continue;

      missing.push({
        selector: normalized,
        context: {
          action: actionKey,
          valueHint: usage.valueHint,
          usedSelectors: [...(seenByAction.get(actionKey) ?? [])],
        },
      });
      seenMissing.add(normalized);
      continue;
    }

    if (!seenByAction.has(actionKey)) seenByAction.set(actionKey, []);
    seenByAction.get(actionKey)!.push(normalized);
  }

  return missing;
}

export function findNewSelector(
  domHtml: string,
  missingSelector: string,
  context?: SelectorContext
): SelectorSuggestion | null {
  const $ = load(domHtml);
  const normalizedMissing = normalizeText(missingSelector);
  const tokens = tokenize(missingSelector);

  const candidates: Candidate[] = [];

  scanAttribute($, 'data-testid', normalizedMissing, tokens, context, candidates, value => `[data-testid="${value}"]`);
  scanAttribute($, 'id', normalizedMissing, tokens, context, candidates, value => `#${value}`);
  scanAttribute($, 'name', normalizedMissing, tokens, context, candidates, value => `[name="${value}"]`);
  scanAttribute($, 'aria-label', normalizedMissing, tokens, context, candidates, value => `[aria-label="${value}"]`);
  scanClass($, normalizedMissing, tokens, context, candidates);
  scanText($, normalizedMissing, tokens, context, candidates);

  const best = candidates.sort((a, b) => {
    const scoreDiff = (b.score + b.contextBonus) - (a.score + a.contextBonus);
    if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;

    const priorityDiff = candidatePriority(b.selector, normalizedMissing) - candidatePriority(a.selector, normalizedMissing);
    if (Math.abs(priorityDiff) > 1e-6) return priorityDiff;

    return a.selector.length - b.selector.length;
  })[0];
  if (!best) return null;

  const finalScore = best.score + best.contextBonus;
  if (finalScore < 0.25) return null;

  const reason = best.contextBonus > 0.05
    ? `${best.reason}; context-aware ranking applied`
    : best.reason;

  return {
    originalSelector: missingSelector,
    suggestedSelector: best.selector,
    confidence: Number(Math.min(0.95, 0.4 + finalScore * 0.6).toFixed(2)),
    reason,
  };
}

function scanAttribute(
  $: ReturnType<typeof load>,
  attribute: string,
  normalizedMissing: string,
  tokens: string[],
  context: SelectorContext | undefined,
  candidates: Candidate[],
  buildSelector: (value: string) => string
): void {
  $(`[${attribute}]`).each((_, el) => {
    const value = $(el).attr(attribute);
    if (!value) return;

    const score = scoreMatch(value, normalizedMissing, tokens);
    if (score <= 0) return;

    const selector = buildSelector(value);
    const metadata = getElementMetadata($, el);
    candidates.push({
      selector,
      score,
      contextBonus: computeContextBonus(context, metadata, selector, normalizedMissing, tokens),
      reason: `${attribute} matched ${value}`,
    });
  });
}

function scanClass(
  $: ReturnType<typeof load>,
  normalizedMissing: string,
  tokens: string[],
  context: SelectorContext | undefined,
  candidates: Candidate[]
): void {
  $('[class]').each((_, el) => {
    const classAttr = $(el).attr('class');
    if (!classAttr) return;

    const classNames = classAttr.split(/\s+/).filter(Boolean);
    for (const className of classNames) {
      const score = scoreMatch(className, normalizedMissing, tokens) * 0.9;
      if (score <= 0) continue;

      const selector = `.${className}`;
      const metadata = getElementMetadata($, el);
      candidates.push({
        selector,
        score,
        contextBonus: computeContextBonus(context, metadata, selector, normalizedMissing, tokens),
        reason: `class matched ${className}`,
      });
    }
  });
}

function scanText(
  $: ReturnType<typeof load>,
  normalizedMissing: string,
  tokens: string[],
  context: SelectorContext | undefined,
  candidates: Candidate[]
): void {
  $('button, a, label, span, p, div').each((_, el) => {
    const text = $(el).text().trim();
    if (!text) return;

    const score = scoreMatch(text, normalizedMissing, tokens) * 0.6;
    if (score <= 0.2) return;

    const safeText = text.replace(/"/g, '\\"').slice(0, 80);
    const tagName = (el as unknown as { name?: string; tagName?: string }).tagName || (el as unknown as { name?: string }).name || 'element';
    const selector = `${tagName}:has-text("${safeText}")`;
    const metadata = getElementMetadata($, el);
    candidates.push({
      selector,
      score,
      contextBonus: computeContextBonus(context, metadata, selector, normalizedMissing, tokens),
      reason: `text matched "${safeText}"`,
    });
  });
}

function computeContextBonus(
  context: SelectorContext | undefined,
  metadata: ElementMetadata,
  selector: string,
  normalizedMissing: string,
  missingTokens: string[]
): number {
  if (!context) return 0;

  let bonus = 0;
  const action = (context.action || '').toLowerCase();

  if (action === 'fill') {
    if (metadata.tagName === 'input' || metadata.tagName === 'textarea') bonus += 0.06;
    else bonus -= 0.05;
  }

  if (action === 'click' || action === 'tap' || action === 'dblclick') {
    if (metadata.tagName === 'button' || metadata.tagName === 'a') bonus += 0.06;
  }

  const valueHint = (context.valueHint || '').trim();
  const semanticTokens = new Set(normalizeTextTokens(metadata.semanticText));
  if (valueHint) {
    const intentTokens = inferIntentTokensFromValue(valueHint);
    if (intentTokens.length > 0) {
      const hits = intentTokens.filter(token => semanticTokens.has(token)).length;
      bonus += Math.min(0.24, hits * 0.08);
    }

    if (looksLikeEmail(valueHint)) {
      if (metadata.inputType === 'email') bonus += 0.2;
      if (metadata.inputType === 'password') bonus -= 0.12;
    }

    if (looksLikeSecretValue(valueHint)) {
      if (metadata.inputType === 'password') bonus += 0.2;
      if (metadata.inputType === 'email') bonus -= 0.1;
    }
  }

  const usedSelectors = context.usedSelectors || [];
  if (usedSelectors.includes(selector) && isGenericSelector(normalizedMissing, missingTokens)) {
    bonus -= 0.15;
  }

  return bonus;
}

function getElementMetadata($: ReturnType<typeof load>, el: unknown): ElementMetadata {
  const node = el as { name?: string; tagName?: string };
  const tagName = (node.tagName || node.name || 'element').toLowerCase();
  const wrapped = $(el as never);
  const id = wrapped.attr('id') || '';
  const name = wrapped.attr('name') || '';
  const inputType = (wrapped.attr('type') || '').toLowerCase();
  const placeholder = wrapped.attr('placeholder') || '';
  const ariaLabel = wrapped.attr('aria-label') || '';
  const autoComplete = wrapped.attr('autocomplete') || '';
  const role = wrapped.attr('role') || '';
  const className = wrapped.attr('class') || '';
  const testId = wrapped.attr('data-testid') || '';
  const directText = wrapped.text().trim();

  let labelText = '';
  if (id) {
    const safeId = id.replace(/"/g, '\\"');
    labelText = $(`label[for="${safeId}"]`).first().text().trim();
  }
  if (!labelText) {
    labelText = wrapped.closest('label').text().trim();
  }

  const semanticText = normalizeText(
    [tagName, id, name, inputType, placeholder, ariaLabel, autoComplete, role, className, testId, labelText, directText].join(' ')
  );

  return { tagName, inputType, semanticText };
}

function inferIntentTokensFromValue(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return [];

  const tokens = new Set<string>();

  if (looksLikeEmail(normalized)) {
    ['email', 'mail', 'user', 'username', 'login'].forEach(token => tokens.add(token));
  }

  if (/^https?:\/\//.test(normalized) || /^www\./.test(normalized)) {
    ['url', 'link', 'website', 'site'].forEach(token => tokens.add(token));
  }

  if (/^\+?[0-9 ()-]{7,}$/.test(normalized)) {
    ['phone', 'tel', 'mobile', 'contact'].forEach(token => tokens.add(token));
  }

  if (/^[0-9]{4,8}$/.test(normalized)) {
    ['pin', 'code', 'otp', 'password', 'pass', 'verification', 'secret'].forEach(token => tokens.add(token));
  }

  if (/[a-z]/.test(normalized) && /\d/.test(normalized) && normalized.length >= 6) {
    ['password', 'pass', 'token', 'secret', 'key'].forEach(token => tokens.add(token));
  }

  if (/^[a-z]+\s+[a-z]+/.test(normalized)) {
    ['name', 'full', 'first', 'last'].forEach(token => tokens.add(token));
  }

  return Array.from(tokens);
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 4) return false;
  if (looksLikeEmail(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^\+?[0-9 ()-]{7,}$/.test(trimmed)) return false;

  if (/^[0-9]{4,8}$/.test(trimmed)) return true;
  if (/[a-z]/i.test(trimmed) && /\d/.test(trimmed)) return true;
  if (/[^a-z0-9]/i.test(trimmed) && trimmed.length >= 6) return true;

  return false;
}

function isGenericSelector(normalizedMissing: string, missingTokens: string[]): boolean {
  if (missingTokens.length <= 1) return true;
  return /(^|[\s_-])(input|field|value|item|element|control|text)([\s_-]|$)/.test(normalizedMissing);
}

function scoreMatch(value: string, normalizedMissing: string, tokens: string[]): number {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) return 0;

  const overlapScore = tokenOverlap(tokens, normalizeTextTokens(normalizedValue));
  const substringScore = normalizedMissing.includes(normalizedValue) || normalizedValue.includes(normalizedMissing) ? 0.35 : 0;
  const proximityScore = longestCommonSubstring(normalizedMissing, normalizedValue) / Math.max(normalizedMissing.length, normalizedValue.length, 1);

  return Math.min(1, overlapScore + substringScore + proximityScore * 0.5);
}

function candidatePriority(selector: string, normalizedMissing: string): number {
  const normalizedSelector = normalizeText(selector);
  let priority = 0;

  if (selector.startsWith('#')) priority += 0.03;
  if (selector.startsWith('.')) priority -= 0.01;

  if (/(^|[\s_-])(btn|button|submit|toggle|link|cta)([\s_-]|$)/.test(normalizedSelector)) {
    priority += 0.08;
  }

  if (/(^|[\s_-])(card|container|wrapper|panel|layout|content)([\s_-]|$)/.test(normalizedSelector)) {
    priority -= 0.08;
  }

  if (normalizedSelector.startsWith(normalizedMissing)) {
    priority += 0.02;
  }

  return priority;
}

function collectSelectorUsages(source: string): SelectorUsage[] {
  const usages: SelectorUsage[] = [];

  const actionRx = /\b(click|fill|check|uncheck|hover|tap|dblclick|press)\s*\(\s*(['"`])(.*?)\2\s*(?:,\s*([^)]*?))?\)/gi;
  let actionMatch: RegExpExecArray | null;
  while ((actionMatch = actionRx.exec(source)) !== null) {
    const action = (actionMatch[1] || '').toLowerCase();
    const selector = (actionMatch[3] || '').trim();
    if (!selector) continue;

    usages.push({
      action,
      selector,
      valueHint: action === 'fill' ? extractLiteralArgument(actionMatch[4]) : undefined,
      index: actionMatch.index,
    });
  }

  const locatorRx = /\b(locator|querySelectorAll?|waitForSelector)\s*\(\s*(['"`])(.*?)\2/gi;
  let locatorMatch: RegExpExecArray | null;
  while ((locatorMatch = locatorRx.exec(source)) !== null) {
    const action = (locatorMatch[1] || '').toLowerCase();
    const selector = (locatorMatch[3] || '').trim();
    if (!selector) continue;

    usages.push({
      action,
      selector,
      index: locatorMatch.index,
    });
  }

  usages.sort((a, b) => a.index - b.index);
  return usages;
}

function extractLiteralArgument(rawArg: string | undefined): string | undefined {
  if (!rawArg) return undefined;

  const first = rawArg.split(',')[0]?.trim();
  if (!first) return undefined;

  const quoted = first.match(/^(['"`])([\s\S]*)\1$/);
  if (quoted) return quoted[2].trim();

  if (/^\d+(\.\d+)?$/.test(first)) return first;

  return undefined;
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

function extractRelevantTestSegment(testSource: string, testNameHint?: string): string {
  const testDeclarationRx = /test\(\s*(['"`])(.*?)\1\s*,/g;
  const declarations = Array.from(testSource.matchAll(testDeclarationRx));
  if (declarations.length === 0) return testSource;

  if (!testNameHint) {
    const firstStart = declarations[0].index ?? 0;
    const firstEnd = declarations[1]?.index ?? testSource.length;
    return testSource.slice(firstStart, firstEnd);
  }

  const normalizedHint = normalizeName(testNameHint);
  let targetIndex = declarations.findIndex(match => normalizeName(match[2] || '') === normalizedHint);

  if (targetIndex < 0) {
    targetIndex = declarations.findIndex(match => {
      const normalizedName = normalizeName(match[2] || '');
      return normalizedName.includes(normalizedHint) || normalizedHint.includes(normalizedName);
    });
  }

  if (targetIndex < 0) return testSource;

  const start = declarations[targetIndex].index ?? 0;
  const end = declarations[targetIndex + 1]?.index ?? testSource.length;
  return testSource.slice(start, end);
}

function isLikelyCssSelector(selector: string): boolean {
  if (!selector.trim()) return false;
  if (/^(text=|xpath=|\/\/|role=|id=)/i.test(selector)) return false;
  return true;
}

function isSelectorMissing(domHtml: string, selector: string): boolean {
  const $ = load(domHtml);
  try {
    return $(selector).length === 0;
  } catch {
    return false;
  }
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
