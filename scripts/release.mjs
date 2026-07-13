#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RELEASE_TYPES = new Set(['patch', 'minor', 'major']);
const releaseType = process.argv[2];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
}

function capture(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
  }).trim();
}

function ensureCleanWorktree(context) {
  const status = capture('git', ['status', '--short']);
  if (status.length > 0) {
    fail(
      `Release aborted: git working tree is not clean ${context}.\n` +
        'Commit, stash, or remove local changes before creating a release.'
    );
  }
}

if (!RELEASE_TYPES.has(releaseType)) {
  fail('Usage: node scripts/release.mjs <patch|minor|major>');
}

try {
  ensureCleanWorktree('before verification');

  console.log('Running release checks...');
  run('npm', ['run', 'verify']);

  ensureCleanWorktree('after verification');

  console.log(`Bumping ${releaseType} version and creating tag...`);
  run('npm', ['version', releaseType]);

  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  console.log(`Pushing commit and tag for v${version}...`);
  run('git', ['push', '--follow-tags']);

  console.log(`Release complete: v${version}`);
} catch (error) {
  if (typeof error?.status === 'number') {
    process.exit(error.status ?? 1);
  }

  fail(error instanceof Error ? error.message : String(error));
}
