import fs from 'fs';
import path from 'path';
import { load, CheerioAPI } from 'cheerio';

type Healing = {
  originalSelector: string;
  suggestedSelector: string;
  confidence: number;
  reason?: string;
};

type Classification = {
  failureType?: string;
  healing?: Healing;
  timeoutFix?: { timeoutMs: number; reason?: string; testFile?: string };
  testName?: string;
  [key: string]: unknown;
};

type Suggestion = {
  from: string;
  to: string;
  confidence: number;
  sourceFile: string; // classification.json path
  domFile?: string; // dom snapshot paired with classification
  domMatches?: number; // how many nodes matched the suggested selector in the dom snapshot
  refinedFromDom?: boolean;
  domAvailable?: boolean;
  styleDerived?: boolean;
  scriptDerived?: boolean;
};

type ClassificationSource = 'test-results' | 'failures';

type ClassificationFileMeta = {
  file: string;
  source: ClassificationSource;
  runKey: string;
  timestamp?: string;
};

type HealerConfig = {
  artifacts: {
    failuresDir: string;
    testResultsDir: string;
  };
  healing: {
    defaultScope: string;
    minConfidence: number;
  };
};

/**
 * CLI flags:
 * --dry-run              Only show changes, do not write files
 * --min-confidence=0.8   Minimum confidence to apply a change (overrides config)
 * --scope=apps/testapp   Limit replacements to a subfolder (default: config.healing.defaultScope)
 */
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const minConfidenceArg = args.find(a => a.startsWith('--min-confidence='));
const scopeArg = args.find(a => a.startsWith('--scope='));

const projectRoot = path.resolve(__dirname, '..', '..'); // test-healer
const config = readConfig();

const minConfidence = minConfidenceArg
  ? Number(minConfidenceArg.split('=')[1])
  : config.healing.minConfidence;

const scope = scopeArg ? scopeArg.split('=')[1] : config.healing.defaultScope;
const applyRoot = path.isAbsolute(scope) ? scope : path.resolve(projectRoot, scope);

const fallbackDomCandidates = [
  path.resolve(projectRoot, 'apps', 'testapp', 'app_for_testing.html'),
];

// Only heal code/spec files; never touch HTML templates.
const codeFileExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
const excludeDirs = new Set(['node_modules', 'failures', 'test-results', 'artifacts']);
const cssClassCache: CssClassCache = new Map();
const domTokensCache: DomTokensCache = new Map();
const scriptIdsCache: ScriptIdsCache = new Map();

function readConfig(): HealerConfig {
  const configPath = path.resolve(__dirname, '..', '..', 'config.json');
  const fallback: HealerConfig = {
    artifacts: {
      failuresDir: 'artifacts/failures',
      testResultsDir: 'artifacts/test-results',
    },
    healing: {
      defaultScope: 'apps/testapp/tests',
      minConfidence: 0.75,
    },
  };

  if (!fs.existsSync(configPath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as HealerConfig;
  } catch (err) {
    console.warn(`⚠️ Failed to read config.json, using defaults. ${(err as Error).message}`);
    return fallback;
  }
}

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function* walk(dir: string): Generator<string> {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (excludeDirs.has(e.name)) continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function getRunMetaFromClassificationFile(file: string): { runKey: string; timestamp?: string } {
  const runDir = path.basename(path.dirname(file));
  const match = runDir.match(/^(.*)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/);
  if (!match) {
    return { runKey: runDir };
  }

  return { runKey: match[1], timestamp: match[2] };
}

function listClassificationFiles(root: string, source: ClassificationSource): ClassificationFileMeta[] {
  const files: ClassificationFileMeta[] = [];
  if (!fs.existsSync(root)) return files;

  for (const file of walk(root)) {
    if (!file.endsWith('classification.json')) continue;
    const meta = getRunMetaFromClassificationFile(file);
    files.push({ file, source, runKey: meta.runKey, timestamp: meta.timestamp });
  }

  return files;
}

function getFileMtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function pickLatestByRunKey(files: ClassificationFileMeta[]): ClassificationFileMeta[] {
  const latestByRunKey = new Map<string, ClassificationFileMeta>();

  for (const item of files) {
    const prev = latestByRunKey.get(item.runKey);
    if (!prev) {
      latestByRunKey.set(item.runKey, item);
      continue;
    }

    if (item.timestamp && prev.timestamp) {
      if (item.timestamp > prev.timestamp) latestByRunKey.set(item.runKey, item);
      continue;
    }

    if (getFileMtimeMs(item.file) > getFileMtimeMs(prev.file)) {
      latestByRunKey.set(item.runKey, item);
    }
  }

  return Array.from(latestByRunKey.values());
}

function selectClassificationFiles(): { files: string[]; sourceLabel: string } {
  const testResultsRoot = path.resolve(projectRoot, config.artifacts.testResultsDir);
  const failuresRoot = path.resolve(projectRoot, config.artifacts.failuresDir);

  const testResultFiles = listClassificationFiles(testResultsRoot, 'test-results');
  const failureFiles = listClassificationFiles(failuresRoot, 'failures');

  if (testResultFiles.length === 0 && failureFiles.length === 0) {
    return { files: [], sourceLabel: 'none' };
  }

  const shouldUseFailures = failureFiles.length > 0;

  if (shouldUseFailures) {
    const latestFailureFiles = pickLatestByRunKey(failureFiles);
    return {
      files: latestFailureFiles.map(item => item.file),
      sourceLabel: 'failures (latest per test)',
    };
  }

  if (testResultFiles.length > 0) {
    const latestTestResultFiles = pickLatestByRunKey(testResultFiles);
    return {
      files: latestTestResultFiles.map(item => item.file),
      sourceLabel: 'test-results (latest per test)',
    };
  }

  return {
    files: [],
    sourceLabel: 'none',
  };
}

function collectSuggestions(): { suggestions: Suggestion[]; timeoutTargets: Map<string, number>; sourceLabel: string } {
  const suggestions: Suggestion[] = [];
  const timeoutTargets = new Map<string, number>();
  const selected = selectClassificationFiles();

  for (const file of selected.files) {
    const json = readJsonSafe<Classification>(file);
    if (!json) continue;

    if (json.timeoutFix?.timeoutMs) {
      const testFile = json.timeoutFix.testFile;
      if (testFile) {
        const prev = timeoutTargets.get(testFile) ?? 0;
        timeoutTargets.set(testFile, Math.max(prev, json.timeoutFix.timeoutMs));
      }
    }

    if (json.healing) {
      const { originalSelector, suggestedSelector, confidence } = json.healing;
      if (!originalSelector || !suggestedSelector) continue;
      if (confidence < minConfidence) continue;

      suggestions.push({
        from: originalSelector,
        to: suggestedSelector,
        confidence,
        sourceFile: file,
        domFile: path.join(path.dirname(file), 'dom.html'),
      });
    }
  }

  return { suggestions, timeoutTargets, sourceLabel: selected.sourceLabel };
}

function findCodeFiles(root: string): string[] {
  const files: string[] = [];
  for (const file of walk(root)) {
    const ext = path.extname(file).toLowerCase();
    if (codeFileExtensions.has(ext)) files.push(file);
  }
  return files;
}

function buildReplacementRegex(from: string): RegExp[] {
  // Strip quotes if present (from might be "value" or [attr="value"] or just value)
  let unquoted = from;
  if ((from.startsWith('"') && from.endsWith('"')) ||
      (from.startsWith("'") && from.endsWith("'"))) {
    unquoted = from.slice(1, -1);
  }
  
  const e = escapeForRegex(unquoted);

  return [
    new RegExp(`(locator\\s*\\(\\s*['"\\\`])${e}(['"\\\`]\\s*\\))`, 'g'),
    new RegExp(`(querySelector(All)?\\s*\\(\\s*['"\\\`])${e}(['"\\\`]\\s*\\))`, 'g'),
    new RegExp(`(selector\\s*:\\s*['"\\\`])${e}(['"\\\`])`, 'g'),
    new RegExp(`(getByTestId\\s*\\(\\s*['"\\\`])${e}(['"\\\`]\\s*\\))`, 'g'),
    // Generic quoted string fallback (last resort) - matches the value with any surrounding quotes
    new RegExp(`(['"\\\`])${e}\\1`, 'g'),
  ];
}

type DomCache = Map<string, CheerioAPI | null>;
type CssClassCache = Map<string, Set<string>>;
type DomTokensCache = Map<string, { ids: Set<string>; classes: Set<string> }>;
type ScriptIdsCache = Map<string, Set<string>>;
type ScriptDomMismatch = {
  domFile: string;
  scriptId: string;
  closestDomId?: string;
  similarity?: number;
};

function loadDom(file: string | undefined, cache: DomCache): CheerioAPI | null {
  if (file) {
    if (cache.has(file)) return cache.get(file) ?? null;
    if (fs.existsSync(file)) {
      try {
        const html = fs.readFileSync(file, 'utf8');
        const $ = load(html);
        cache.set(file, $);
        return $;
      } catch {
        cache.set(file, null);
      }
    }
  }
  return null;
}

function extractCssClassesFromHtml(file: string, cache: CssClassCache): Set<string> {
  if (cache.has(file)) return cache.get(file) ?? new Set<string>();
  const classes = new Set<string>();
  if (!fs.existsSync(file)) {
    cache.set(file, classes);
    return classes;
  }
  try {
    const html = fs.readFileSync(file, 'utf8');
    const classRegex = /\.([a-zA-Z0-9_-]+)\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = classRegex.exec(html)) !== null) {
      classes.add(match[1]);
    }
  } catch {
    // ignore
  }
  cache.set(file, classes);
  return classes;
}

function extractDomTokens(file: string, $: CheerioAPI | null): { ids: Set<string>; classes: Set<string> } {
  const cached = domTokensCache.get(file);
  if (cached) return cached;

  const ids = new Set<string>();
  const classes = new Set<string>();

  if ($) {
    $('[id]').each((_, el) => {
      const id = $(el).attr('id');
      if (id) ids.add(id);
    });
    $('[class]').each((_, el) => {
      const classAttr = $(el).attr('class') || '';
      classAttr.split(/\s+/).filter(Boolean).forEach(cls => classes.add(cls));
    });
  }

  domTokensCache.set(file, { ids, classes });
  return { ids, classes };
}

function extractScriptIdsFromHtml(file: string, cache: ScriptIdsCache): Set<string> {
  if (cache.has(file)) return cache.get(file) ?? new Set<string>();
  const ids = new Set<string>();
  if (!fs.existsSync(file)) {
    cache.set(file, ids);
    return ids;
  }

  try {
    const html = fs.readFileSync(file, 'utf8');
    const getByIdRx = /getElementById\(\s*['"`]([a-zA-Z0-9_-]+)['"`]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = getByIdRx.exec(html)) !== null) {
      ids.add(match[1]);
    }

    const queryIdRx = /querySelector\(\s*['"`]#([a-zA-Z0-9_-]+)['"`]\s*\)/g;
    while ((match = queryIdRx.exec(html)) !== null) {
      ids.add(match[1]);
    }
  } catch {
    // ignore
  }

  cache.set(file, ids);
  return ids;
}

function aggregateFallbackDomTokens(domCache: DomCache): { ids: Set<string>; classes: Set<string>; scriptIds: Set<string>; domFiles: string[] } {
  const ids = new Set<string>();
  const classes = new Set<string>();
  const scriptIds = new Set<string>();
  const domFiles: string[] = [];

  for (const fallback of fallbackDomCandidates) {
    const dom = loadDom(fallback, domCache);
    if (!dom) continue;
    domFiles.push(fallback);
    const tokens = extractDomTokens(fallback, dom);
    tokens.ids.forEach(id => ids.add(id));
    tokens.classes.forEach(cls => classes.add(cls));
    const scriptTokens = extractScriptIdsFromHtml(fallback, scriptIdsCache);
    scriptTokens.forEach(id => scriptIds.add(id));
  }

  return { ids, classes, scriptIds, domFiles };
}

function detectScriptDomIdMismatches(domCache: DomCache): ScriptDomMismatch[] {
  const { ids, scriptIds, domFiles } = aggregateFallbackDomTokens(domCache);
  if (domFiles.length === 0 || scriptIds.size === 0) return [];

  const domIdList = Array.from(ids);
  const mismatches: ScriptDomMismatch[] = [];

  for (const scriptId of scriptIds) {
    if (ids.has(scriptId)) continue;

    let closestDomId = '';
    let bestScore = 0;
    for (const domId of domIdList) {
      const similarity = stringSimilarity(scriptId, domId);
      if (similarity > bestScore) {
        bestScore = similarity;
        closestDomId = domId;
      }
    }

    mismatches.push({
      domFile: domFiles[0],
      scriptId,
      closestDomId: closestDomId || undefined,
      similarity: closestDomId ? bestScore : undefined,
    });
  }

  return mismatches;
}

function synthesizeIdLookupSuggestions(codeFiles: string[], domCache: DomCache): Suggestion[] {
  const { ids, domFiles } = aggregateFallbackDomTokens(domCache);
  if (!domFiles.length || ids.size === 0) return [];

  const primaryDomFile = domFiles[0];
  const $ = loadDom(primaryDomFile, domCache);
  if (!$) return [];

  const idTokens = Array.from(ids);
  const dedup = new Map<string, Suggestion>();

  for (const file of codeFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const rx = /getElementById\(\s*['"`]([a-zA-Z0-9_-]+)['"`]\s*\)/g;
    let match: RegExpExecArray | null;

    while ((match = rx.exec(content)) !== null) {
      const idToken = match[1];
      if (ids.has(idToken)) continue;

      let best = '';
      let bestScore = 0.5;
      for (const candidate of idTokens) {
        const similarity = stringSimilarity(idToken, candidate);
        const prefixBoost = idToken.startsWith(candidate) || candidate.startsWith(idToken) ? 0.2 : 0;
        const score = similarity + prefixBoost;
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }

      if (!best) continue;

      const selector = `#${best}`;
      const matchCount = safeCountMatches($, selector);
      if (matchCount !== 1) continue;

      const confidence = Math.max(0.76, Math.min(0.95, 0.6 + bestScore * 0.5));
      if (confidence < minConfidence) continue;

      const suggestion: Suggestion = {
        from: idToken,
        to: best,
        confidence,
        sourceFile: 'synthesized-id',
        domFile: primaryDomFile,
        domMatches: matchCount,
        domAvailable: true,
        refinedFromDom: true,
      };

      const prev = dedup.get(idToken);
      if (!prev || suggestion.confidence > prev.confidence) dedup.set(idToken, suggestion);
    }
  }

  return Array.from(dedup.values());
}

function synthesizeTokenSuggestions(codeFiles: string[], domCache: DomCache): Suggestion[] {
  const { ids, classes, scriptIds, domFiles } = aggregateFallbackDomTokens(domCache);
  if (domFiles.length === 0) return [];

  const primaryDomFile = domFiles[0];
  const $ = loadDom(primaryDomFile, domCache);
  if (!$) return [];

  const idTokens = Array.from(ids);
  const scriptIdTokens = Array.from(scriptIds);
  const classTokens = Array.from(classes);
  const dedup = new Map<string, Suggestion>();

  for (const file of codeFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const rx = /['"`]([#.][a-zA-Z0-9_-][^'"`\n]*)['"`]/g;
    let match: RegExpExecArray | null;

    while ((match = rx.exec(content)) !== null) {
      const selector = match[1].trim();
      if (!selector || selector.length > 120) continue;

      const tokenRx = /([#.][a-zA-Z0-9_-]+)/g;
      let tokenMatch: RegExpExecArray | null;

      while ((tokenMatch = tokenRx.exec(selector)) !== null) {
        const token = tokenMatch[1];
        const tokenIndex = tokenMatch.index;
        const isId = token.startsWith('#');
        const tokenBare = token.slice(1);

        const existsInDom = isId ? ids.has(tokenBare) : classes.has(tokenBare);
        const existsInScript = isId ? scriptIds.has(tokenBare) : false;

        let tokenCandidates = isId ? idTokens : classTokens;
        let scriptPreferred = false;

        if (existsInDom) continue;

        if (isId && scriptIdTokens.length > 0 && !existsInScript) {
          tokenCandidates = Array.from(new Set([...idTokens, ...scriptIdTokens]));
          scriptPreferred = true;
        }

        let best = '';
        let bestScore = 0.5;
        for (const candidate of tokenCandidates) {
          if (candidate === tokenBare) continue;
          const similarity = stringSimilarity(tokenBare, candidate);
          const prefixBoost = tokenBare.startsWith(candidate) || candidate.startsWith(tokenBare) ? 0.2 : 0;
          const score = similarity + prefixBoost;

          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }

        if (!best) continue;

        const candidateToken = `${isId ? '#' : '.'}${best}`;
        const updatedSelector = `${selector.slice(0, tokenIndex)}${candidateToken}${selector.slice(tokenIndex + token.length)}`;
        if (updatedSelector === selector) continue;

        const scriptDerived = isId && scriptIds.has(best) && !ids.has(best);

        let finalSelector = updatedSelector;
        let matchCount = safeCountMatches($, finalSelector);

        if (matchCount !== 1) {
          const tokenOnlyCount = safeCountMatches($, candidateToken);
          // If the parent token is uniquely found, keep the original tail to avoid over-trimming.
          if (tokenOnlyCount === 1 && finalSelector !== candidateToken) {
            matchCount = tokenOnlyCount;
          } else if (tokenOnlyCount === 1) {
            finalSelector = candidateToken;
            matchCount = tokenOnlyCount;
          }
        }

        if (matchCount !== 1) continue;

        const confidence = Math.max(0.76, Math.min(0.95, 0.6 + bestScore * 0.5));
        if (confidence < minConfidence) continue;

        const suggestion: Suggestion = {
          from: selector,
          to: finalSelector,
          confidence,
          sourceFile: scriptDerived ? 'synthesized-script-token' : 'synthesized-token',
          domFile: primaryDomFile,
          domMatches: matchCount,
          domAvailable: true,
          refinedFromDom: !scriptDerived,
          scriptDerived,
        };

        const prev = dedup.get(selector);
        if (!prev || suggestion.confidence > prev.confidence) {
          dedup.set(selector, suggestion);
        }
      }
    }
  }

  return Array.from(dedup.values());
}

function synthesizeAttributeValueSuggestions(codeFiles: string[], domCache: DomCache): Suggestion[] {
  const { domFiles } = aggregateFallbackDomTokens(domCache);
  if (!domFiles.length) return [];

  const primaryDomFile = domFiles[0];
  const $ = loadDom(primaryDomFile, domCache);
  if (!$) return [];

  // Extract all attribute values from DOM
  const attrValues = new Map<string, Set<string>>();
  $.root().find('*').each((_, el) => {
    const wrapped = $(el);
    const attrs = wrapped.attr();
    if (!attrs) return;

    for (const [attrName, attrValue] of Object.entries(attrs)) {
      if (!attrValue || typeof attrValue !== 'string') continue;
      const normalized = attrValue.trim();
      if (!normalized || normalized.length > 100) continue;

      if (!attrValues.has(attrName)) attrValues.set(attrName, new Set());
      attrValues.get(attrName)!.add(normalized);
    }
  });

  const dedup = new Map<string, Suggestion>();

  // Scan code for attribute selectors and suggest corrected values
  for (const file of codeFiles) {
    const content = fs.readFileSync(file, 'utf8');
    // Match selectors with attribute predicates - focus on the [attr="value"] part
    const rx = /\[([a-z-]+)=["']([^"']+)["']\]/gi;
    let match: RegExpExecArray | null;

    while ((match = rx.exec(content)) !== null) {
      const fullMatchStr = match[0]; // e.g., [placeholder="Search movie"]
      const attrName = match[1].toLowerCase();
      const attrValue = match[2].trim();

      if (!attrValue || attrValue.length > 100) continue;
      if (attrValue.startsWith('#') || attrValue.startsWith('.')) continue; // Skip selectors

      const domAttrSet = attrValues.get(attrName);
      if (!domAttrSet) continue; // No such attribute in DOM

      if (domAttrSet.has(attrValue)) continue; // Value already matches

      // Find closest matching value
      let best = '';
      let bestScore = 0.65;
      for (const candidate of Array.from(domAttrSet)) {
        const similarity = stringSimilarity(attrValue, candidate);
        const prefixBoost = attrValue.startsWith(candidate) || candidate.startsWith(attrValue) ? 0.15 : 0;
        const score = similarity + prefixBoost;

        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }

      if (!best) continue;

      // Construct from/to: just the value itself, without quotes
      // The regex patterns in buildReplacementRegex will handle the quoting
      const fromSelector = attrValue;
      const toSelector = best;

      // Verify that at least one element in DOM has the target attribute value
      let domMatches = 0;
      try {
        domMatches = $(`.${best}`).length + $(`[${attrName}="${best}"]`).length;
      } catch {
        // Ignore invalid selectors
      }

      if (domMatches === 0) continue; // Don't suggest if the corrected value doesn't exist

      const confidence = Math.max(0.75, Math.min(0.92, 0.55 + bestScore * 0.4));
      if (confidence < minConfidence) continue;

      const suggestion: Suggestion = {
        from: fromSelector,
        to: toSelector,
        confidence,
        sourceFile: 'synthesized-attr-value',
        domFile: primaryDomFile,
        domMatches,
        domAvailable: true,
        refinedFromDom: true,
      };

      const key = `${attrName}:${attrValue}`;
      const prev = dedup.get(key);
      if (!prev || suggestion.confidence > prev.confidence) {
        dedup.set(key, suggestion);
      }
    }
  }

  return Array.from(dedup.values());
}

function safeCountMatches($: CheerioAPI | null, selector: string): number {
  if (!$) return 0;
  try {
    return $(selector).length;
  } catch {
    return 0;
  }
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[a.length][b.length];
}

function stringSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  return 1 - distance / maxLen;
}

function extractRemainder(original: string, suggested: string): string | null {
  const trimmedOriginal = original.trim();
  const trimmedSuggested = suggested.trim();
  if (!trimmedOriginal.startsWith(trimmedSuggested)) return null;

  const remainder = trimmedOriginal.slice(trimmedSuggested.length).trim();
  return remainder || null;
}

function stitchSelector(base: string, tail: string): string {
  const trimmedBase = base.trim();
  const trimmedTail = tail.trim();
  if (!trimmedTail) return trimmedBase;

  const needsSpace = /^[>+~]/.test(trimmedTail) || /[>+~]$/.test(trimmedBase) ? '' : ' ';
  return `${trimmedBase}${needsSpace}${trimmedTail}`.trim();
}

function preserveOriginalTailAfterAnchor(originalSelector: string, anchorSelector: string): string | null {
  const anchorMatch = anchorSelector.match(/([#.][a-zA-Z0-9_-]+)/);
  if (!anchorMatch) return null;

  const anchor = anchorMatch[1];
  const anchorIndex = originalSelector.indexOf(anchor);
  if (anchorIndex < 0) return null;

  const tail = originalSelector.slice(anchorIndex + anchor.length).trim();
  if (!tail) return null;

  return stitchSelector(anchorSelector, tail);
}

function replaceFirstToken(selector: string, newToken: string): string {
  const tokenMatch = selector.match(/([#.][a-zA-Z0-9_-]+)/);
  if (!tokenMatch) return selector;
  const [full, token] = tokenMatch;
  const idx = tokenMatch.index ?? selector.indexOf(full);
  return `${selector.slice(0, idx)}${newToken}${selector.slice(idx + token.length)}`;
}

function softenTrailingClass(remainder: string): string | null {
  // If the trailing class has a modifier suffix (e.g., .todo-item-now), drop the final dash segment.
  const match = remainder.match(/\.([a-zA-Z0-9_-]+)(?!.*\.[a-zA-Z0-9_-]+)/);
  if (!match) return null;

  const className = match[1];
  const parts = className.split('-');
  if (parts.length < 2) return null;

  const softened = parts.slice(0, -1).join('-');
  if (!softened) return null;

  return remainder.replace(`.${className}`, `.${softened}`);
}

function extractLeafClass(selector: string): string | null {
  const match = selector.match(/\.([a-zA-Z0-9_-]+)(?!.*\.[a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function extractLeafTag(selector: string): string | null {
  const lastChunk = selector.trim().split(/\s+/).pop() || '';
  const match = lastChunk.match(/^([a-zA-Z][a-zA-Z0-9_-]*)/);
  return match ? match[1].toLowerCase() : null;
}

function hasStrongAnchor(selector: string): boolean {
  return /#/.test(selector) || /\[data-(testid|test|qa)/i.test(selector);
}

function findBetterDescendantSelector(
  $: CheerioAPI,
  baseSelector: string,
  targetClass: string | null,
  targetTag: string | null,
  currentSpec: number,
): { selector: string; matchCount: number } | null {
  if (!targetClass) return null;
  let bestSelector: string | null = null;
  let bestScore = 0;
  let bestCount = 0;

  let bases;
  try {
    bases = $(baseSelector);
  } catch {
    return null;
  }

  bases.each((_, baseEl) => {
    const base = $(baseEl);
    base
      .find('[class]')
      .each((__, node) => {
        const nodeWrapper = $(node);
        const classAttr = nodeWrapper.attr('class') || '';
        const classes = classAttr.split(/\s+/).filter(Boolean);
        const tagName = (node as unknown as { tagName?: string; name?: string }).tagName || (node as unknown as { name?: string }).name || '';

        for (const cls of classes) {
          const similarity = stringSimilarity(targetClass, cls);
          const tagBoost = targetTag && tagName.toLowerCase() === targetTag ? 0.1 : 0;
          const score = similarity + tagBoost;
          if (score < 0.35) continue;
          if (score < bestScore) continue;

          const segment = tagName ? `${tagName}.${cls}` : `.${cls}`;
          const candidate = stitchSelector(baseSelector, segment);
          const spec = computeSpecificity(candidate);
          if (spec <= currentSpec) continue;

          const count = safeCountMatches($, candidate);
          if (count === 0) continue;

          bestScore = score;
          bestSelector = candidate;
          bestCount = count;
        }
      });
  });

  if (bestSelector) {
    return { selector: bestSelector, matchCount: bestCount };
  }

  return null;
}

function findApproximateClassMatch(
  $: CheerioAPI,
  baseSelector: string,
  targetClass: string | null,
): { selector: string; matchCount: number } | null {
  if (!targetClass) return null;

  let bases;
  try {
    bases = $(baseSelector);
  } catch {
    return null;
  }

  let bestSelector: string | null = null;
  let bestScore = 0.2;
  let bestCount = 0;

  bases.each((_, baseEl) => {
    const base = $(baseEl);
    base
      .find('[class]')
      .each((__, node) => {
        const nodeWrapper = $(node);
        const classAttr = nodeWrapper.attr('class') || '';
        const classes = classAttr.split(/\s+/).filter(Boolean);
        const tagName = (node as unknown as { tagName?: string; name?: string }).tagName || (node as unknown as { name?: string }).name || '';

        for (const cls of classes) {
          const similarity = stringSimilarity(targetClass, cls);
          if (similarity <= bestScore) continue;
          const segment = tagName ? `${tagName}.${cls}` : `.${cls}`;
          const candidate = stitchSelector(baseSelector, segment);
          const count = safeCountMatches($, candidate);
          if (count === 0) continue;
          bestScore = similarity;
          bestSelector = candidate;
          bestCount = count;
        }
      });
  });

  if (bestSelector) return { selector: bestSelector, matchCount: bestCount };
  return null;
}

function buildImprovedSelector(
  $: CheerioAPI,
  originalSelector: string,
  suggestedSelector: string,
): { selector: string; matchCount: number; styleDerived?: boolean } | null {
  const remainder = extractRemainder(originalSelector, suggestedSelector);
  const currentSpec = computeSpecificity(suggestedSelector);

  if (remainder) {
    const candidate = stitchSelector(suggestedSelector, remainder);
    const count = safeCountMatches($, candidate);
    const spec = computeSpecificity(candidate);
    if (count > 0 && spec > currentSpec) {
      return { selector: candidate, matchCount: count };
    }
  }

  const targetClass = extractLeafClass(originalSelector);
  const targetTag = extractLeafTag(originalSelector);
  const descendant = findBetterDescendantSelector($, suggestedSelector, targetClass, targetTag, currentSpec);
  if (descendant) return descendant;

  // If the suggested selector has no matches, fall back to using the parent part of the original as base.
  const parentBase = originalSelector.includes(' ')
    ? originalSelector.substring(0, originalSelector.lastIndexOf(' ')).trim()
    : originalSelector;
  if (parentBase && parentBase !== suggestedSelector) {
    const parentDescendant = findBetterDescendantSelector($, parentBase, targetClass, targetTag, currentSpec);
    if (parentDescendant) return parentDescendant;

    const approx = findApproximateClassMatch($, parentBase, targetClass);
    if (approx) return { ...approx, styleDerived: true };
  }

  // Try a softened class match directly under the parent base (style-derived heuristic).
  if (targetClass && parentBase) {
    const softened = softenTrailingClass(`.${targetClass}`);
    if (softened) {
      const candidate = stitchSelector(parentBase, softened);
      const count = safeCountMatches($, candidate);
      const spec = computeSpecificity(candidate);
      if (count > 0 && spec >= currentSpec) {
        return { selector: candidate, matchCount: count, styleDerived: true };
      }
    }
  }

  return null;
}

function improveSuggestionSpecificity(s: Suggestion, domCache: DomCache): Suggestion {
  let domFile = s.domFile ?? path.join(path.dirname(s.sourceFile), 'dom.html');
  let $ = loadDom(domFile, domCache);
  let usedFallbackDom = false;

  if (!$) {
    for (const fallback of fallbackDomCandidates) {
      const dom = loadDom(fallback, domCache);
      if (dom) {
        $ = dom;
        domFile = fallback;
        usedFallbackDom = true;
        break;
      }
    }
  }

  const fromSpec = computeSpecificity(s.from);
  const toSpec = computeSpecificity(s.to);
  let refinedTo = s.to;
  let refinedFromDom = Boolean(s.refinedFromDom);
  let domMatches = s.domMatches ?? ($ ? safeCountMatches($, s.to) : 0);
  const domAvailable = s.domAvailable ?? Boolean($);
  let styleDerived = Boolean(s.styleDerived);
  let blockedByLeafGuard = false;

  if ($ && toSpec < fromSpec) {
    const improved = buildImprovedSelector($, s.from, s.to);
    if (improved) {
      refinedTo = improved.selector;
      domMatches = improved.matchCount;
      refinedFromDom = true;
    }
  }

  if ($ && toSpec < fromSpec) {
    const tailCandidate = preserveOriginalTailAfterAnchor(s.from, refinedTo);
    if (tailCandidate && tailCandidate !== refinedTo) {
      const tailMatches = safeCountMatches($, tailCandidate);
      if (tailMatches > 0) {
        refinedTo = tailCandidate;
        domMatches = tailMatches;
        refinedFromDom = true;
      }
    }
  }

  // Guard against collapsing row/list/item selectors into container-only selectors.
  // Keep the original leaf tag when possible; otherwise force this heal to be skipped.
  if ($ && toSpec < fromSpec) {
    const originalHasCombinator = /[\s>+~]/.test(s.from.trim());
    const originalLeafTag = extractLeafTag(s.from);
    const refinedLeafTag = extractLeafTag(refinedTo);

    // Table-body selectors are especially sensitive; avoid collapsing to header rows.
    const originalHasTbody = /(^|\s|>)tbody(\s|$|>)/i.test(s.from);
    const refinedHasTbody = /(^|\s|>)tbody(\s|$|>)/i.test(refinedTo);
    if (originalHasTbody && !refinedHasTbody) {
      const tbodyTail = originalLeafTag ? `tbody ${originalLeafTag}` : 'tbody';
      const tbodyCandidate = stitchSelector(refinedTo, tbodyTail);
      const tbodyMatches = safeCountMatches($, tbodyCandidate);
      if (tbodyMatches > 0) {
        refinedTo = tbodyCandidate;
        domMatches = tbodyMatches;
        refinedFromDom = true;
      } else {
        domMatches = 0;
        blockedByLeafGuard = true;
      }
    }

    if (originalHasCombinator && originalLeafTag && refinedLeafTag !== originalLeafTag) {
      const leafCandidate = stitchSelector(refinedTo, originalLeafTag);
      const leafMatches = safeCountMatches($, leafCandidate);
      if (leafMatches > 0) {
        refinedTo = leafCandidate;
        domMatches = leafMatches;
        refinedFromDom = true;
      } else {
        domMatches = 0;
        blockedByLeafGuard = true;
      }
    }
  }

  if (!refinedFromDom && $ && domMatches === 0 && !blockedByLeafGuard) {
    domMatches = safeCountMatches($, refinedTo);
  }

  // Heuristic refinement when we lack DOM evidence: if the original had a trailing class
  // modifier and the suggestion dropped it, try softening that modifier (e.g., -now -> base).
  if (!refinedFromDom) {
    const remainder = extractRemainder(s.from, s.to);
    const softened = remainder ? softenTrailingClass(remainder) : null;
    if (softened) {
      const candidate = stitchSelector(refinedTo, softened);
      const candidateSpec = computeSpecificity(candidate);
      if (candidateSpec > toSpec) {
        refinedTo = candidate;
        domMatches = $ ? safeCountMatches($, refinedTo) : domMatches;
      }
    }
  }

  // If we still have no matches but a DOM is available, attempt a descendant/class similarity improvement.
  if ($ && domMatches === 0 && !blockedByLeafGuard) {
    const improved = buildImprovedSelector($, s.from, refinedTo);
    if (improved) {
      refinedTo = improved.selector;
      domMatches = improved.matchCount;
      refinedFromDom = true;
      styleDerived = Boolean(improved.styleDerived);
    }
  }

  // If no usable matches, fall back to CSS-defined classes for closest match under the parent base.
  if (domMatches === 0 && !blockedByLeafGuard) {
    const parentBase = s.from.includes(' ')
      ? s.from.substring(0, s.from.lastIndexOf(' ')).trim()
      : s.from;
    const targetClass = extractLeafClass(s.from);
    if (parentBase && targetClass) {
      for (const fallback of fallbackDomCandidates) {
        const classSet = extractCssClassesFromHtml(fallback, cssClassCache);
        if (!classSet.size) continue;
        let bestCls = '';
        let bestScore = 0.2;
        for (const cls of classSet) {
          const score = stringSimilarity(targetClass, cls);
          if (score > bestScore) {
            bestScore = score;
            bestCls = cls;
          }
        }
        if (bestCls) {
          refinedTo = stitchSelector(parentBase, `.${bestCls}`);
          styleDerived = true;
          break;
        }
      }
    }
  }

  return {
    ...s,
    to: refinedTo,
    domFile,
    refinedFromDom,
    domMatches,
    domAvailable,
    usedFallbackDom,
    styleDerived,
  };
}

function applyToFile(file: string, from: string, to: string): { changed: boolean; changes: number } {
  let content = fs.readFileSync(file, 'utf8');
  let totalChanges = 0;
  
  // Strip quotes from to if present, since we'll add them back during replacement
  let unquotedTo = to;
  if ((to.startsWith('"') && to.endsWith('"')) ||
      (to.startsWith("'") && to.endsWith("'"))) {
    unquotedTo = to.slice(1, -1);
  }
  
  const regexes = buildReplacementRegex(from);

  for (const rx of regexes) {
    const before = content;
    content = content.replace(rx, (...args: unknown[]) => {
      const fullMatch = String(args[0] ?? '');
      const captures = args.slice(1, -2).map(value => String(value ?? ''));

      if (captures.length === 0) return fullMatch;

      // Generic quoted fallback has one capture (quote char), keep matching quote on both sides.
      if (captures.length === 1) {
        const quote = captures[0];
        return `${quote}${unquotedTo}${quote}`;
      }

      const prefix = captures[0];
      const suffix = captures[captures.length - 1];
      return `${prefix}${unquotedTo}${suffix}`;
    });
    if (content !== before) {
      const beforeCount = (before.match(rx) || []).length;
      const afterCount = (content.match(rx) || []).length;
      totalChanges += Math.max(beforeCount - afterCount, 0) || beforeCount;
    }
  }

  const changed = totalChanges > 0;
  if (changed && !isDryRun) {
    fs.writeFileSync(`${file}.bak`, content);
    fs.writeFileSync(file, content, 'utf8');
  }

  return { changed, changes: totalChanges };
}

function formatPathForLog(filePath: string): string {
  const rel = path.relative(projectRoot, filePath);
  if (!rel || rel.startsWith('..')) {
    return filePath.split(path.sep).join('/');
  }
  return rel.split(path.sep).join('/');
}

function main(): void {
  console.log(`[applyHealing] mode=${isDryRun ? 'dry-run' : 'apply'}`);
  console.log(`[applyHealing] root=${projectRoot}`);
  console.log(`[applyHealing] scope=${applyRoot}`);
  console.log(`[applyHealing] minConfidence=${minConfidence}`);

  const domCache: DomCache = new Map();
  const codeFiles = findCodeFiles(applyRoot);
  const { suggestions, timeoutTargets, sourceLabel } = collectSuggestions();
  const synthesizedTokens = synthesizeTokenSuggestions(codeFiles, domCache);
  const synthesizedIds = synthesizeIdLookupSuggestions(codeFiles, domCache);
  const synthesizedAttrValues = synthesizeAttributeValueSuggestions(codeFiles, domCache);
  const scriptDomMismatches = detectScriptDomIdMismatches(domCache);
  const combinedSuggestions = [...suggestions, ...synthesizedTokens, ...synthesizedIds, ...synthesizedAttrValues];
  const enrichedSuggestions = combinedSuggestions.map(s => improveSuggestionSpecificity(s, domCache));
  console.log(`[applyHealing] artifacts=${sourceLabel}, synthesizedTokens=${synthesizedTokens.length}, synthesizedIds=${synthesizedIds.length}, synthesizedAttrs=${synthesizedAttrValues.length}`);

  if (synthesizedAttrValues.length > 0) {
    console.log('[applyHealing] Attribute value suggestions:');
    for (const s of synthesizedAttrValues) {
      console.log(`  - from="${s.from}" to="${s.to}" dom=${s.domMatches}`);
    }
  }

  if (scriptDomMismatches.length > 0) {
    console.log(`[applyHealing] runtime id mismatches detected: ${scriptDomMismatches.length}`);
    for (const mismatch of scriptDomMismatches) {
      const closest = mismatch.closestDomId && (mismatch.similarity ?? 0) >= 0.45
        ? ` (closest DOM id: ${mismatch.closestDomId})`
        : '';
      console.log(`  - script getElementById('${mismatch.scriptId}') does not exist in DOM${closest}`);
    }
  }

  if (combinedSuggestions.length === 0 && timeoutTargets.size === 0) {
    console.log('No applicable healing suggestions found.');
    return;
  }

  const scoreByFrom = (s: Suggestion): number => {
    const fromSpec = computeSpecificity(s.from);
    const toSpec = computeSpecificity(s.to);
    const specDelta = toSpec - fromSpec;
    const specBoost = specDelta >= 0
      ? Math.min(specDelta / 500, 0.06)
      : Math.max(specDelta / 500, -0.12);
    const domMatches = s.domMatches ?? 0;
    const domBoost = domMatches === 1 ? 0.05 : domMatches > 0 ? 0.03 : 0;
    const stylePenalty = s.styleDerived ? 0.01 : 0;
    const scriptPenalty = s.scriptDerived ? 0.05 : 0;
    return s.confidence + specBoost + domBoost - stylePenalty - scriptPenalty;
  };

  const bestByFrom = new Map<string, Suggestion>();
  for (const s of enrichedSuggestions) {
    const prev = bestByFrom.get(s.from);
    if (!prev) {
      bestByFrom.set(s.from, s);
      continue;
    }

    const prevScore = scoreByFrom(prev);
    const nextScore = scoreByFrom(s);
    if (nextScore > prevScore) {
      bestByFrom.set(s.from, s);
      continue;
    }

    if (nextScore === prevScore && computeSpecificity(s.to) > computeSpecificity(prev.to)) {
      bestByFrom.set(s.from, s);
    }
  }

  // Resolve direct two-way conflicts (A->B and B->A) by keeping the stronger suggestion.
  const resolvedPairs = new Set<string>();
  const scoreSuggestion = (s: Suggestion): number => scoreByFrom(s);

  for (const [from, suggestion] of Array.from(bestByFrom.entries())) {
    const reverse = bestByFrom.get(suggestion.to);
    if (!reverse || reverse.to !== from) continue;

    const pairKey = [from, suggestion.to].sort().join('::');
    if (resolvedPairs.has(pairKey)) continue;
    resolvedPairs.add(pairKey);

    if (scoreSuggestion(suggestion) >= scoreSuggestion(reverse)) {
      bestByFrom.delete(reverse.from);
    } else {
      bestByFrom.delete(from);
    }
  }

  console.log(`Scanning ${codeFiles.length} code files...`);

  const changedFiles = new Set<string>();
  let totalReplacements = 0;
  const selectorSummary: Array<{
    from: string;
    to: string;
    confidence: number;
    changedFiles: string[];
    replacements: number;
    skippedSameSelector?: boolean;
    skipReason?: string;
    appliedWithDomContext?: boolean;
    appliedWithAnchor?: boolean;
    domMatches?: number;
    domAvailable?: boolean;
    usedFallbackDom?: boolean;
    styleDerived?: boolean;
    scriptDerived?: boolean;
  }> = [];

  for (const suggestion of bestByFrom.values()) {
    const fromSpec = computeSpecificity(suggestion.from);
    const toSpec = computeSpecificity(suggestion.to);
    const isLessSpecific = toSpec < fromSpec;
    const domMatches = suggestion.domMatches ?? 0;
    const domAvailable = suggestion.domAvailable ?? false;

    if (suggestion.sourceFile === 'synthesized-attr-value') {
      console.log(`[DEBUG] Processing attr: "${suggestion.from}" (spec=${fromSpec}) -> "${suggestion.to}" (spec=${toSpec}) dom=${domMatches} avail=${domAvailable} less=${isLessSpecific}`);
    }
    const usedFallbackDom = suggestion.usedFallbackDom ?? false;
    const styleDerived = suggestion.styleDerived ?? false;
    const scriptDerived = suggestion.scriptDerived ?? false;
    const hasDomEvidence = domMatches > 0;
    const hasUniqueDomMatch = domMatches === 1;
    const hasStrongAnchorTarget = isLessSpecific && hasStrongAnchor(suggestion.to);
    const dropsTbodyRowScope = /tbody\s+tr/i.test(suggestion.from) && !/tbody\s+tr/i.test(suggestion.to);
    // Less-specific heals now require unique DOM evidence; anchors alone are no longer sufficient.
    const canApplyLessSpecific = hasUniqueDomMatch;

    if (dropsTbodyRowScope) {
      selectorSummary.push({
        from: suggestion.from,
        to: suggestion.to,
        confidence: suggestion.confidence,
        changedFiles: [],
        replacements: 0,
        skipReason: 'skipped (would drop tbody row scope from the original selector)',
      });
      continue;
    }

    if (isLessSpecific && !canApplyLessSpecific) {
      selectorSummary.push({
        from: suggestion.from,
        to: suggestion.to,
        confidence: suggestion.confidence,
        changedFiles: [],
        replacements: 0,
        skipReason: 'skipped (suggested selector is less specific than the original and lacks unique DOM evidence)',
      });
      continue;
    }

    if (domAvailable && domMatches === 0 && !styleDerived && !scriptDerived) {
      selectorSummary.push({
        from: suggestion.from,
        to: suggestion.to,
        confidence: suggestion.confidence,
        changedFiles: [],
        replacements: 0,
        skipReason: 'skipped (selector did not match anything in the DOM snapshot)',
      });
      continue;
    }

    if (!domAvailable && toSpec <= fromSpec) {
      selectorSummary.push({
        from: suggestion.from,
        to: suggestion.to,
        confidence: suggestion.confidence,
        changedFiles: [],
        replacements: 0,
        skipReason: 'skipped (no DOM snapshot available to verify a non-stronger selector)',
      });
      continue;
    }

    if (suggestion.from === suggestion.to) {
      selectorSummary.push({
        from: suggestion.from,
        to: suggestion.to,
        confidence: suggestion.confidence,
        changedFiles: [],
        replacements: 0,
        skippedSameSelector: true,
      });
      continue;
    }

    const filesChangedForSuggestion: string[] = [];
    let replacementsForSuggestion = 0;

    for (const file of codeFiles) {
      const { changed, changes } = applyToFile(file, suggestion.from, suggestion.to);
      if (suggestion.sourceFile === 'synthesized-attr-value') {
        console.log(`[DEBUG]   applyToFile(${formatPathForLog(file)}, "${suggestion.from}", "${suggestion.to}") = changed=${changed} changes=${changes}`);
      }
      if (changed) {
        changedFiles.add(file);
        totalReplacements += changes;
        replacementsForSuggestion += changes;
        filesChangedForSuggestion.push(file);
      }
    }

    selectorSummary.push({
      from: suggestion.from,
      to: suggestion.to,
      confidence: suggestion.confidence,
      changedFiles: filesChangedForSuggestion,
      replacements: replacementsForSuggestion,
      appliedWithDomContext: isLessSpecific && hasUniqueDomMatch,
      appliedWithAnchor: isLessSpecific && !hasUniqueDomMatch && hasStrongAnchorTarget,
      domMatches,
      domAvailable,
      usedFallbackDom,
      styleDerived,
      scriptDerived,
    });
  }

  const appliedSelectorSummary = selectorSummary.filter(item => {
    if (item.skippedSameSelector) return false;
    if (item.skipReason) return false;
    if (item.changedFiles.length === 0) return false;
    if (item.replacements <= 0) return false;
    return true;
  });

  console.log('\nSelector healing summary:');
  if (appliedSelectorSummary.length === 0) {
    console.log('  - No selector changes to apply.');
  }

  for (const item of appliedSelectorSummary) {
    const selectorLabel = `"${item.from}" -> "${item.to}"`;
    const fileCount = item.changedFiles.length;
    const replacementLabel = `${item.replacements} replacement${item.replacements !== 1 ? 's' : ''}`;
    const fileLabel = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
    const formattedFiles = item.changedFiles.map(formatPathForLog).join(', ');
    const domNote = item.appliedWithDomContext ? ' (applied using DOM snapshot despite lower specificity)' : '';
    const anchorNote = item.appliedWithAnchor ? ' (applied using id/data-* anchor despite lower specificity)' : '';
    const domCountNote = item.domMatches !== undefined ? ` [dom matches: ${item.domMatches}]` : '';
    const fallbackNote = item.usedFallbackDom ? ' [fallback DOM]' : '';
    const styleNote = item.styleDerived ? ' [style-derived]' : '';
    const scriptNote = item.scriptDerived ? ' [script-derived]' : '';
    console.log(`  - ${selectorLabel}${domNote}${anchorNote} (confidence ${item.confidence}): ${replacementLabel} in ${fileLabel}.${domCountNote}${fallbackNote}${styleNote}${scriptNote}`);
    console.log(`    Files: ${formattedFiles}`);
  }

  let timeoutChanges: { filesChanged: number; changedFilePaths: string[] } = {
    filesChanged: 0,
    changedFilePaths: [],
  };
  if (timeoutTargets.size) {
    timeoutChanges = applyTimeoutFixes(timeoutTargets);
    for (const filePath of timeoutChanges.changedFilePaths) {
      changedFiles.add(filePath);
    }
  }

  if (timeoutChanges.filesChanged > 0) {
    console.log('\nTimeout healing summary:');
    const formattedTimeoutFiles = timeoutChanges.changedFilePaths.map(formatPathForLog).join(', ');
    console.log(`  - Updated timeout settings in ${timeoutChanges.filesChanged} file${timeoutChanges.filesChanged !== 1 ? 's' : ''}.`);
    console.log(`    Files: ${formattedTimeoutFiles}`);
  }

  console.log(`\nSummary: ${changedFiles.size} file${changedFiles.size !== 1 ? 's' : ''} affected, ${totalReplacements} selector replacement${totalReplacements !== 1 ? 's' : ''}.`);
  if (isDryRun) {
    console.log('Dry-run mode: no files were written. Run `npm run heal:apply` to apply these changes.');
  } else {
    console.log('Backups (*.bak) created next to modified files.');
  }
}

function applyTimeoutFixes(timeoutTargets: Map<string, number>): { filesChanged: number; changedFilePaths: string[] } {
  let filesChanged = 0;
  const changedFilePaths: string[] = [];

  for (const [testFile, timeoutMs] of timeoutTargets.entries()) {
    if (!testFile) continue;
    const filePath = path.isAbsolute(testFile)
      ? testFile
      : path.resolve(projectRoot, testFile);

    // Only touch spec/test files inside the apply scope
    const isSpec = /\.spec\.(t|j)sx?$/i.test(filePath) || /\.test\.(t|j)sx?$/i.test(filePath);
    if (!isSpec) continue;
    if (!filePath.startsWith(applyRoot)) continue;
    const ext = path.extname(filePath).toLowerCase();
    if (!codeFileExtensions.has(ext)) continue;

    if (!fs.existsSync(filePath)) continue;

    let content = fs.readFileSync(filePath, 'utf8');
    let changed = false;

    const hasAnyTestTimeout = /test\.setTimeout\s*\(/.test(content);
    const testTimeoutRx = /test\.setTimeout\s*\(\s*(\d+)\s*\)/g;
    content = content.replace(testTimeoutRx, (_m, rawMs) => {
      const currentMs = Number(rawMs);
      if (Number.isFinite(currentMs) && currentMs < timeoutMs) {
        changed = true;
        return `test.setTimeout(${timeoutMs})`;
      }
      return _m;
    });

    if (!hasAnyTestTimeout) {
      const lines = content.split(/\r?\n/);
      let insertAt = 0;
      while (insertAt < lines.length && /^import\s/.test(lines[insertAt])) insertAt += 1;
      lines.splice(insertAt, 0, `test.setTimeout(${timeoutMs});`);
      content = lines.join('\n');
      changed = true;
    }

    const expectRx = /to(Have|Contain)Text\(([^,()]+)\)/g;
    if (expectRx.test(content)) {
      content = content.replace(expectRx, (_m, kind, arg1) => `to${kind}Text(${arg1}, { timeout: ${timeoutMs} })`);
      changed = true;
    }

    const expectTimeoutRx = /to(Have|Contain)Text\(([^)]*?)\{\s*timeout\s*:\s*(\d+)\s*\}\s*\)/g;
    content = content.replace(expectTimeoutRx, (match, kind, prefix, rawMs) => {
      const currentMs = Number(rawMs);
      if (!Number.isFinite(currentMs) || currentMs >= timeoutMs) return match;

      changed = true;
      const normalizedPrefix = String(prefix).replace(/\s*,\s*$/, '');
      return `to${kind}Text(${normalizedPrefix}, { timeout: ${timeoutMs} })`;
    });

    if (changed && !isDryRun) {
      fs.writeFileSync(`${filePath}.bak`, content);
      fs.writeFileSync(filePath, content, 'utf8');
      filesChanged += 1;
      changedFilePaths.push(filePath);
    } else if (changed) {
      filesChanged += 1;
      changedFilePaths.push(filePath);
    }
  }

  return { filesChanged, changedFilePaths };
}

function computeSpecificity(selector: string): number {
  // Very lightweight specificity approximation: ids >> classes/attrs/pseudos >> tags
  // Only the first selector in a comma list is considered.
  const first = selector.split(',')[0] || selector;
  const idCount = (first.match(/#/g) || []).length;
  const classCount = (first.match(/\.[a-zA-Z0-9_-]+/g) || []).length;
  const attrCount = (first.match(/\[[^\]]+\]/g) || []).length;
  const pseudoCount = (first.match(/:[a-zA-Z0-9_-]+/g) || []).length;
  const typeCount = (first.match(/(^|\s|>|\+|~)([a-zA-Z][a-zA-Z0-9_-]*)/g) || []).length;

  return idCount * 100 + (classCount + attrCount + pseudoCount) * 10 + typeCount;
}

main();