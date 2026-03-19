import fs from 'fs';
import path from 'path';
import { classifyFailure } from './classifyFailure';
import {
  extractMissingSelectors,
  findNewSelector,
  inferMissingSelectorContextsFromTestSource,
  type MissingSelectorContext,
} from '../healer/selectorHealing';

type HealerConfig = {
  artifacts: {
    failuresDir: string;
    testResultsDir: string;
  };
};

function readConfig(): HealerConfig {
  const configPath = path.resolve(__dirname, '..', '..', 'config.json');
  const fallback: HealerConfig = {
    artifacts: {
      failuresDir: 'artifacts/failures',
      testResultsDir: 'artifacts/test-results',
    },
  };

  if (!fs.existsSync(configPath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as HealerConfig;
  } catch (err) {
    console.warn(`⚠️ Failed to read config.json, using defaults. ${(err as Error).message}`);
    return fallback;
  }
}

function runClassifier(): void {
  const config = readConfig();
  const projectRoot = path.resolve(__dirname, '..', '..'); // test-healer

  const failuresDir = path.resolve(projectRoot, config.artifacts.failuresDir);
  const resultsDir = path.resolve(projectRoot, config.artifacts.testResultsDir);

  const sources: Array<{ dir: string; type: 'md' | 'json' }> = [
    { dir: failuresDir, type: 'json' },
    { dir: resultsDir, type: 'md' },
  ];

  let processed = 0;

  const cachedBySlug = new Map<string, ReturnType<typeof classifyFailure>>();

  for (const source of sources) {
    if (!fs.existsSync(source.dir)) {
      console.warn(`⚠️ Skipping missing directory: ${source.dir}`);
      continue;
    }

    const testRuns = fs.readdirSync(source.dir);

    for (const run of testRuns) {
      const runDir = path.join(source.dir, run);
      if (!fs.statSync(runDir).isDirectory()) continue;

      if (source.type === 'md') {
        const errorFile = path.join(runDir, 'error-context.md');
        if (!fs.existsSync(errorFile)) continue;

        const slug = slugify(run.replace(/^app-AI-Test-Healer-Playground-/, ''));
        const cached = resolveCachedClassification(cachedBySlug, slug);
        const classification = cached ?? classifyFailure(fs.readFileSync(errorFile, 'utf-8'), run);
        const outputPath = path.join(runDir, 'classification.json');
        fs.writeFileSync(outputPath, JSON.stringify(classification, null, 2));
        console.log(`✅ Classified failure for: ${classification.testName}`);
        processed += 1;
      } else {
        const errorFile = path.join(runDir, 'error.json');
        if (!fs.existsSync(errorFile)) continue;

        let parsed: { title?: string; file?: string; error?: string; stack?: string } = {};
        try {
          parsed = JSON.parse(fs.readFileSync(errorFile, 'utf-8'));
        } catch (err) {
          console.warn(`⚠️ Could not parse ${errorFile}: ${(err as Error).message}`);
          continue;
        }

        const hint = parsed.title || run;
        const errorText = parsed.error || parsed.stack || '';
        const classification = classifyFailure(errorText, hint);
        const domPath = path.join(runDir, 'dom.html');
        const testSourcePath = path.join(runDir, 'test-source.js');
        const runSlug = slugify(run.replace(/^app-AI-Test-Healer-Playground-/, ''));

        let missingSelectors = extractMissingSelectors(errorText);
        let inferredContexts: MissingSelectorContext[] = [];

        if (
          (classification.failureType === 'TIMEOUT' || classification.failureType === 'UNKNOWN')
          && missingSelectors.length === 0
          && fs.existsSync(domPath)
          && fs.existsSync(testSourcePath)
        ) {
          const domHtml = fs.readFileSync(domPath, 'utf-8');
          const testSource = fs.readFileSync(testSourcePath, 'utf-8');
          inferredContexts = inferMissingSelectorContextsFromTestSource(
            testSource,
            domHtml,
            parsed.title || classification.testName || hint,
          );
          if (inferredContexts.length > 0) {
            missingSelectors = inferredContexts.map(item => item.selector);
          }
        }

        if (classification.failureType === 'UNKNOWN' && missingSelectors.length > 0) {
          classification.failureType = 'SELECTOR_NOT_FOUND';
          classification.confidence = Math.max(classification.confidence, 0.72);
          classification.explanation = 'Likely selector issue inferred from failed test source and captured DOM.';
          classification.suggestedFix = 'Update/heal the inferred selector, then rerun tests.';
        }

        // If this is a timeout, attach a default healing hint to increase timeouts in tests.
        if (classification.failureType === 'TIMEOUT') {
          (classification as any).timeoutFix = {
            timeoutMs: 15000,
            reason: 'Increase test and expect timeouts for slow UI responses',
            testFile: parsed.file,
          };
        }

        const shouldTrySelectorHealing =
          classification.failureType === 'SELECTOR_NOT_FOUND'
          || (classification.failureType === 'TIMEOUT' && isLikelySelectorTimeout(errorText, missingSelectors))
          || ((classification.failureType === 'TIMEOUT' || classification.failureType === 'UNKNOWN') && inferredContexts.length > 0);

        if (shouldTrySelectorHealing) {
          if (missingSelectors.length && fs.existsSync(domPath)) {
            const domHtml = fs.readFileSync(domPath, 'utf-8');

            for (const selector of missingSelectors) {
              const context = inferredContexts.find(item => item.selector === selector)?.context;
              const healing = findNewSelector(domHtml, selector, context);
              if (healing && healing.suggestedSelector !== selector) {
                classification.healing = healing;
                break;
              }
            }
          }

          if (classification.failureType === 'TIMEOUT' && classification.healing) {
            classification.explanation = 'The timeout likely occurred while waiting for a missing or stale selector.';
            classification.suggestedFix = 'Update/heal the selector first; if selector is valid but UI is slow, increase timeout.';
          }
        }

        cachedBySlug.set(slugify(classification.testName), classification);
        cachedBySlug.set(runSlug, classification);

        const outputPath = path.join(runDir, 'classification.json');
        fs.writeFileSync(outputPath, JSON.stringify(classification, null, 2));
        console.log(`✅ Classified failure for: ${classification.testName}`);
        processed += 1;
      }
    }
  }

  if (processed === 0) {
    console.error('❌ No failures classified (no error files found).');
    process.exit(1);
  }
}

runClassifier();

function isLikelySelectorTimeout(errorText: string, extractedSelectors: string[]): boolean {
  if (extractedSelectors.length === 0) return false;

  const text = stripAnsi(errorText || '').toLowerCase();
  if (!text.includes('timeout')) return false;

  const clickSignal = /\b(click|dblclick|tap)\b/.test(text);
  const selectorWaitSignal =
    text.includes('waiting for selector')
    || text.includes('element(s) not found')
    || text.includes('resolved to 0 elements')
    || text.includes('not found');

  return clickSignal || selectorWaitSignal;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolveCachedClassification(
  cache: Map<string, ReturnType<typeof classifyFailure>>,
  slug: string,
): ReturnType<typeof classifyFailure> | undefined {
  if (cache.has(slug)) return cache.get(slug);

  const parts = slug.split('-').filter(Boolean);
  for (let i = 1; i < parts.length; i += 1) {
    const alt = parts.slice(i).join('-');
    if (cache.has(alt)) return cache.get(alt);
  }

  return undefined;
}