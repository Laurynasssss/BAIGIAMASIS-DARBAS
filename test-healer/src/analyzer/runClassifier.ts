import fs from 'fs';
import path from 'path';
import { classifyFailure } from './classifyFailure';
import { extractMissingSelectors, findNewSelector } from '../healer/selectorHealing';

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
        const cached = cachedBySlug.get(slug);
        const classification = cached ?? classifyFailure(fs.readFileSync(errorFile, 'utf-8'), run);
        const outputPath = path.join(runDir, 'classification.json');
        fs.writeFileSync(outputPath, JSON.stringify(classification, null, 2));
        console.log(`✅ Classified failure for: ${classification.testName}`);
        processed += 1;
      } else {
        const errorFile = path.join(runDir, 'error.json');
        if (!fs.existsSync(errorFile)) continue;

        let parsed: { title?: string; error?: string; stack?: string } = {};
        try {
          parsed = JSON.parse(fs.readFileSync(errorFile, 'utf-8'));
        } catch (err) {
          console.warn(`⚠️ Could not parse ${errorFile}: ${(err as Error).message}`);
          continue;
        }

        const hint = parsed.title || run;
        const errorText = parsed.error || parsed.stack || '';
        const classification = classifyFailure(errorText, hint);

        if (classification.failureType === 'SELECTOR_NOT_FOUND') {
          const domPath = path.join(runDir, 'dom.html');
          const missingSelectors = extractMissingSelectors(errorText);

          if (missingSelectors.length && fs.existsSync(domPath)) {
            const domHtml = fs.readFileSync(domPath, 'utf-8');

            for (const selector of missingSelectors) {
              const healing = findNewSelector(domHtml, selector);
              if (healing) {
                classification.healing = healing;
                break;
              }
            }
          }
        }

        cachedBySlug.set(slugify(classification.testName), classification);

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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}