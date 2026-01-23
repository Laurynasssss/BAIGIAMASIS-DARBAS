const express = require('express');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;

const repoRoot = path.resolve(__dirname, '..', '..');
const testAppDir = __dirname;

function runCommand(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

app.use(express.json());
app.use(express.static(testAppDir));

app.post('/api/run-tests', async (_req, res) => {
  const result = await runCommand('npm', ['test'], testAppDir);
  res.json({ ok: result.code === 0, ...result });
});

app.post('/api/heal', async (_req, res) => {
  const result = await runCommand('npm', ['run', 'heal'], repoRoot);
  res.json({ ok: result.code === 0, ...result });
});

app.post('/api/apply-heal', async (_req, res) => {
  const result = await runCommand('npm', ['run', 'heal:apply'], repoRoot);
  res.json({ ok: result.code === 0, ...result });
});

app.post('/api/apply-heal-dry', async (_req, res) => {
  const result = await runCommand('npm', ['run', 'heal:apply:dry'], repoRoot);
  res.json({ ok: result.code === 0, ...result });
});

app.listen(port, () => {
  console.log(`Control server running at http://localhost:${port}/control.html`);
});
