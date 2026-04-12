import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { executeCommand } from '../src/cli.js';
import { resetDeviceCommandRunner, setDeviceCommandRunner } from '../src/devices.js';

function tempOutputDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'visor-output-'));
}

function responseData<T>(value: unknown): T {
  return value as T;
}

async function withMissingDaemonSocket<T>(work: () => Promise<T>): Promise<T> {
  const originalSocket = process.env.VISOR_DAEMON_SOCKET_PATH;
  const socketDir = tempOutputDir();
  process.env.VISOR_DAEMON_SOCKET_PATH = path.join(socketDir, 'missing.sock');

  try {
    return await work();
  } finally {
    if (originalSocket === undefined) {
      delete process.env.VISOR_DAEMON_SOCKET_PATH;
    } else {
      process.env.VISOR_DAEMON_SOCKET_PATH = originalSocket;
    }
    fs.rmSync(socketDir, { recursive: true, force: true });
  }
}

async function withDetectedDevice<T>(work: () => Promise<T>): Promise<T> {
  setDeviceCommandRunner(async (command) => {
    if (command === 'adb') {
      return 'List of devices attached\nemulator-5554\tdevice\n';
    }
    return '';
  });

  try {
    return await work();
  } finally {
    resetDeviceCommandRunner();
  }
}

describe('typescript cli', () => {
  it('returns help for --help', async () => {
    const result = await executeCommand(['--help']);
    const data = responseData<{ usageText: string; commands: string[] }>(result.response.data);
    expect(result.code).toBe(0);
    expect(result.response.status).toBe('ok');
    expect(data.usageText).toContain('Visor TypeScript CLI');
    expect(data.usageText).toContain('visor status');
    expect(data.usageText).not.toContain('node dist/main.js status');
    expect(data.commands).toContain('run');
    expect(data.commands).toContain('scroll');
  });

  it('returns help when no command is provided', async () => {
    const result = await executeCommand([]);
    const data = responseData<{ usageText: string }>(result.response.data);
    expect(result.code).toBe(0);
    expect(data.usageText).toContain('Usage:');
  });

  it('validates a good scenario', async () => {
    const result = await executeCommand(['validate', 'scenarios/checkout-smoke.json']);
    expect(result.code).toBe(0);
    expect(result.response.status).toBe('ok');
    expect(result.response.data.valid).toBe(true);
  });

  it('accepts format flags after validate positionals', async () => {
    const result = await executeCommand([
      'validate',
      'scenarios/checkout-smoke.json',
      '--format',
      'json'
    ]);
    expect(result.code).toBe(0);
    expect(result.response.status).toBe('ok');
  });

  it('accepts action format flags after action options', async () => {
    const result = await withDetectedDevice(() =>
      withMissingDaemonSocket(() =>
        executeCommand([
          'wait',
          '--device',
          'emulator-5554',
          '--ms',
          '1',
          '--format',
          'json'
        ])
      )
    );
    expect(result.code).toBe(1);
    expect(result.response.status).toBe('fail');
    expect(result.response.error?.code).toBe('TARGET_ERROR');
  });

  it('requires visor start for scenario runs', async () => {
    const result = await withDetectedDevice(() =>
      withMissingDaemonSocket(() =>
        executeCommand(['run', 'scenarios/checkout-smoke.json', '--app-id', 'com.example.custom'])
      )
    );

    expect(result.code).toBe(1);
    expect(result.response.status).toBe('fail');
    expect(result.response.error?.code).toBe('TARGET_ERROR');
    expect(result.response.error?.next_step).toContain('visor start');
  });

  it('requires visor start for benchmark runs', async () => {
    const result = await withDetectedDevice(() =>
      withMissingDaemonSocket(() =>
        executeCommand([
          'benchmark',
          'scenarios/checkout-smoke.json',
          '--runs',
          '1',
          '--threshold',
          '95',
          '--format',
          'json'
        ])
      )
    );

    expect(result.code).toBe(1);
    expect(result.response.status).toBe('fail');
    expect(result.response.error?.code).toBe('TARGET_ERROR');
    expect(result.response.error?.next_step).toContain('visor start');
  });

  it('accepts report positional paths', async () => {
    const result = await executeCommand(['report', 'artifacts-test', '--format', 'json']);
    const data = responseData<{ path: string }>(result.response.data);
    expect(result.code).toBe(0);
    expect(result.response.status).toBe('ok');
    expect(data.path).toBe('artifacts-test');
  });

  it('returns status output for unmanaged appium', async () => {
    const originalSocket = process.env.VISOR_DAEMON_SOCKET_PATH;
    const originalCwd = process.cwd();
    const outputDir = tempOutputDir();
    process.env.VISOR_DAEMON_SOCKET_PATH = path.join(outputDir, 'missing.sock');

    try {
      process.chdir(outputDir);
      const result = await executeCommand(['status', '--server-url', 'http://127.0.0.1:4723']);
      const data = responseData<{ daemon: { running: boolean }; appium: { managed: boolean } }>(
        result.response.data
      );
      expect(result.code).toBe(0);
      expect(result.response.status).toBe('ok');
      expect(data.daemon.running).toBe(false);
      expect(data.appium.managed).toBe(false);
    } finally {
      if (originalSocket === undefined) {
        delete process.env.VISOR_DAEMON_SOCKET_PATH;
      } else {
        process.env.VISOR_DAEMON_SOCKET_PATH = originalSocket;
      }
      process.chdir(originalCwd);
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('requires visor start for real action commands', async () => {
    await withDetectedDevice(() => withMissingDaemonSocket(async () => {
      const result = await executeCommand([
        'scroll',
        '--direction',
        'down'
      ]);
      expect(result.code).toBe(1);
      expect(result.response.status).toBe('fail');
      expect(result.response.error?.code).toBe('TARGET_ERROR');
      expect(result.response.error?.next_step).toContain('visor start');
    }));
  });

  it('rejects removed platform runtime option', async () => {
    await expect(
      executeCommand(['scroll', '--platform', 'android', '--direction', 'down'])
    ).rejects.toThrow("Unknown option '--platform'");
  });
});
