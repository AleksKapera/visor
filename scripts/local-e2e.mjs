import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outputDir = path.join(root, 'artifacts-local-e2e');
const scenarioPath = path.join(root, 'scenarios', 'local-fake-smoke.json');
const sourceCli = path.join(root, 'src', 'main.ts');
const tsxBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function cliCommand() {
  if (fs.existsSync(tsxBin) && fs.existsSync(sourceCli)) {
    return { command: tsxBin, args: [sourceCli] };
  }

  fail('Unable to find the source Visor CLI entrypoint. Run `npm ci`, then retry.');
}

fs.rmSync(outputDir, { recursive: true, force: true });

const entry = cliCommand();
const result = spawnSync(
  entry.command,
  [
    ...entry.args,
    'run',
    scenarioPath,
    '--runtime',
    'local',
    '--output',
    outputDir
  ],
  {
    cwd: root,
    encoding: 'utf8'
  }
);

if (result.error) {
  fail(result.error.message);
}

if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  fail(`Local E2E command failed with exit code ${result.status ?? 'unknown'}.`);
}

let response;
try {
  response = JSON.parse(result.stdout);
} catch {
  console.error(result.stdout);
  fail('Local E2E command did not return a JSON response envelope.');
}

const run = response?.data?.run;
if (response.status !== 'ok' || run?.status !== 'ok') {
  fail('Local E2E scenario did not finish with ok status.');
}

const reportPaths = Object.values(response.artifacts ?? {});
for (const reportPath of reportPaths) {
  if (typeof reportPath !== 'string' || !fs.existsSync(reportPath)) {
    fail(`Expected report artifact was not written: ${reportPath}`);
  }
}

for (const artifactPath of run.artifacts ?? []) {
  if (typeof artifactPath !== 'string' || !fs.existsSync(artifactPath)) {
    fail(`Expected run artifact was not written: ${artifactPath}`);
  }
}

const runRoot = path.join(outputDir, run.run_id);
const expectedScenarioArtifacts = [
  path.join(runRoot, 'screenshots', '001-counter-initial.png'),
  path.join(runRoot, 'sources', '002-counter-after-tap.xml')
];

for (const artifactPath of expectedScenarioArtifacts) {
  if (!fs.existsSync(artifactPath)) {
    fail(`Expected local smoke artifact was not written: ${artifactPath}`);
  }
}

console.log(`Local E2E passed: ${path.relative(root, path.join(outputDir, run.run_id))}`);
