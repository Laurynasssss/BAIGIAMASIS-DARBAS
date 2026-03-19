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
  timeoutFix?: { timeoutMs: number; reason?: string; testFile?: string };
  testName?: string;
  [key: string]: unknown;
};

type Suggestion = {
  from: string;
  to: string;
  confidence: number;
  sourceFile: string; // classification.json path
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

function selectClassificationFiles(): { files: string[]; sourceLabel: string } {
  const testResultsRoot = path.resolve(projectRoot, config.artifacts.testResultsDir);
  const failuresRoot = path.resolve(projectRoot, config.artifacts.failuresDir);

  const testResultFiles = listClassificationFiles(testResultsRoot, 'test-results');
  if (testResultFiles.length > 0) {
    return {
      files: testResultFiles.map(item => item.file),
      sourceLabel: 'test-results (latest run)',
    };
  }

  const failureFiles = listClassificationFiles(failuresRoot, 'failures');
  const latestByRunKey = new Map<string, ClassificationFileMeta>();

  for (const item of failureFiles) {
    const prev = latestByRunKey.get(item.runKey);
    if (!prev) {
      latestByRunKey.set(item.runKey, item);
      continue;
    }

    if (item.timestamp && prev.timestamp) {
      if (item.timestamp > prev.timestamp) latestByRunKey.set(item.runKey, item);
      continue;
    }

    const itemMtime = fs.statSync(item.file).mtimeMs;
    const prevMtime = fs.statSync(prev.file).mtimeMs;
    if (itemMtime > prevMtime) latestByRunKey.set(item.runKey, item);
  }

  return {
    files: Array.from(latestByRunKey.values()).map(item => item.file),
    sourceLabel: 'failures (latest per test)',
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
    content = content.replace(rx, (...args: unknown[]) => {
      const fullMatch = String(args[0] ?? '');
      const captures = args.slice(1, -2).map(value => String(value ?? ''));

      if (captures.length === 0) return fullMatch;

      // Generic quoted fallback has one capture (quote char), keep matching quote on both sides.
      if (captures.length === 1) {
        const quote = captures[0];
        return `${quote}${to}${quote}`;
      }

      const prefix = captures[0];
      const suffix = captures[captures.length - 1];
      return `${prefix}${to}${suffix}`;
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

  const { suggestions, timeoutTargets, sourceLabel } = collectSuggestions();
  console.log(`[applyHealing] artifacts=${sourceLabel}`);
  if (suggestions.length === 0 && timeoutTargets.size === 0) {
    console.log('No applicable healing suggestions found.');
    return;
  }

  const bestByFrom = new Map<string, Suggestion>();
  for (const s of suggestions) {
    const prev = bestByFrom.get(s.from);
    if (!prev || s.confidence > prev.confidence) bestByFrom.set(s.from, s);
  }

  const codeFiles = findCodeFiles(applyRoot);

    // Drop suggestions where "from" is already the target of another suggestion.
    // If we're healing something TO "#open-modal", then "#open-modal" is the
    // correct selector – don't try to heal FROM "#open-modal" again.
    const allTargets = new Set(Array.from(bestByFrom.values()).map(s => s.to));
    for (const [from] of bestByFrom) {
      if (allTargets.has(from)) {
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
  }> = [];

  for (const suggestion of bestByFrom.values()) {
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
    });
  }

  console.log('\nSelector healing summary:');
  for (const item of selectorSummary) {
    const selectorLabel = `"${item.from}" -> "${item.to}"`;
    if (item.skippedSameSelector) {
      console.log(`  - Skipped ${selectorLabel} (already the same selector).`);
      continue;
    }

    if (item.changedFiles.length === 0) {
      console.log(`  - ${selectorLabel} (confidence ${item.confidence}): no matches found in current scope.`);
      continue;
    }

    const fileCount = item.changedFiles.length;
    const replacementLabel = `${item.replacements} replacement${item.replacements !== 1 ? 's' : ''}`;
    const fileLabel = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
    const formattedFiles = item.changedFiles.map(formatPathForLog).join(', ');
    console.log(`  - ${selectorLabel} (confidence ${item.confidence}): ${replacementLabel} in ${fileLabel}.`);
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

  console.log('\nTimeout healing summary:');
  if (timeoutTargets.size === 0) {
    console.log('  - No timeout updates were suggested.');
  } else if (timeoutChanges.filesChanged === 0) {
    console.log(`  - Timeout updates were suggested for ${timeoutTargets.size} test target(s), but no code changes were needed.`);
  } else {
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

main();