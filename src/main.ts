#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeCommand } from './cli.js';
import { runDaemonFromEnv } from './daemon.js';
import { makeError } from './errors.js';
import { makeId, utcNowIso } from './utils.js';

function isHelpData(value: unknown): value is { usageText: string } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'usageText' in value &&
      typeof (value as { usageText: unknown }).usageText === 'string'
  );
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    if (argv[0] === '__daemon') {
      await runDaemonFromEnv();
      return 0;
    }

    const result = await executeCommand(argv);
    if (isHelpData(result.response.data)) {
      console.log(result.response.data.usageText);
    } else {
      console.log(JSON.stringify(result.response, null, 2));
    }
    return result.code;
  } catch (error) {
    const startedAt = utcNowIso();
    const response = {
      status: 'fail',
      command_id: makeId('cmd'),
      started_at: startedAt,
      ended_at: utcNowIso(),
      artifacts: [],
      next_action: 'Inspect CLI arguments and retry',
      error: makeError(
        'SYSTEM_ERROR',
        'Unhandled CLI failure',
        error instanceof Error ? error.message : String(error),
        'Inspect CLI arguments and retry'
      ),
      data: {}
    };
    console.log(JSON.stringify(response, null, 2));
    return 1;
  }
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  try {
    const currentModulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    const invokedPath = fs.realpathSync(path.resolve(process.argv[1]));
    return currentModulePath === invokedPath;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

export { main };
