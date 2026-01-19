import fs from 'fs';
import path from 'path';

type Healing = {
  originalSelector: string;
  suggestedSelector: string;
  confidence: number;
  reason?: string;
};

type Classification = {
  failureType?: string;
  healing?: Healing;
  testName?: string;
  [key: string]: unknown;
};

type Suggestion = {
  from: string;
  to: string;
  confidence: number;
  sourceFile: string; // classification.json path
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

const classificationDirs = [
  path.resolve(projectRoot, config.artifacts.testResultsDir),
  path.resolve(projectRoot, config.artifacts.failuresDir),
];

const codeFileExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
const excludeDirs = new Set(['node_modules', 'failures', 'test-results', 'artifacts']);

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

function collectSuggestions(): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const root of classificationDirs) {
    for (const file of walk(root)) {
      if (!file.endsWith('classification.json')) continue;
      const json = readJsonSafe<Classification>(file);
      if (!json || !json.healing) continue;
      const { originalSelector, suggestedSelector, confidence } = json.healing;
      if (!originalSelector || !suggestedSelector) continue;
      if (confidence < minConfidence) continue;

      suggestions.push({
        from: originalSelector,
        to: suggestedSelector,
        confidence,
        sourceFile: file,
      });
    }
  }

  return suggestions;
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
  const e = escapeForRegex(from);

  return [
    new RegExp(`(locator\\s*\\(\\s*['"\\\`])${e}(['"\\\`]\\s*\\))`, 'g'),
    new RegExp(`(querySelector(All)?\\s*\\(\\s*['"\\\`])${e}(['"\\\`]\\s*\\))`, 'g'),
    new RegExp(`(selector\\s*:\\s*['"\\\`])${e}(['"\\\`])`, 'g'),
    new RegExp(`(getByTestId\\s*\\(\\s*['"\\\`])${e}(['"\\\`]\\s*\\))`, 'g'),
    // Generic quoted string fallback (last resort)
    new RegExp(`(['"\\\`])${e}\\1`, 'g'),
  ];
}

function applyToFile(file: string, from: string, to: string): { changed: boolean; changes: number } {
  let content = fs.readFileSync(file, 'utf8');
  let totalChanges = 0;
  const regexes = buildReplacementRegex(from);

  for (const rx of regexes) {
    const before = content;
    content = content.replace(rx, (_m, p1, p2) => `${p1}${to}${p2}`);
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

function main(): void {
  console.log(`[applyHealing] root=${projectRoot}`);
  console.log(`[applyHealing] scope=${applyRoot}`);
  console.log(`[applyHealing] minConfidence=${minConfidence} dryRun=${isDryRun}`);

  const suggestions = collectSuggestions();
  if (suggestions.length === 0) {
    console.log('No applicable healing suggestions found.');
    return;
  }

  const bestByFrom = new Map<string, Suggestion>();
  for (const s of suggestions) {
    const prev = bestByFrom.get(s.from);
    if (!prev || s.confidence > prev.confidence) bestByFrom.set(s.from, s);
  }

  const codeFiles = findCodeFiles(applyRoot);
  console.log(`Scanning ${codeFiles.length} code files...`);

  let totalFilesChanged = 0;
  let totalReplacements = 0;

  for (const suggestion of bestByFrom.values()) {
    if (suggestion.from === suggestion.to) {
      console.log(`Skip (same selector): "${suggestion.from}" from ${suggestion.sourceFile}`);
      continue;
    }

    console.log(`Applying: "${suggestion.from}" -> "${suggestion.to}" (confidence ${suggestion.confidence})`);
    for (const file of codeFiles) {
      const { changed, changes } = applyToFile(file, suggestion.from, suggestion.to);
      if (changed) {
        totalFilesChanged += 1;
        totalReplacements += changes;
        console.log(`  ✔ ${file} (${changes} replacement${changes !== 1 ? 's' : ''})`);
      }
    }
  }

  console.log(`Done. Files changed: ${totalFilesChanged}, total replacements: ${totalReplacements}`);
  if (isDryRun) {
    console.log('Dry-run mode: no files were written. Re-run without --dry-run to apply changes.');
  } else {
    console.log('Backups (*.bak) created next to modified files.');
  }
}

main();