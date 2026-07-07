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

function packageVersion(): string {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    version?: unknown;
  };
  return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
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
    const data = responseData<{ usageText: string; commands: string[]; examples: string[] }>(
      result.response.data
    );
    expect(result.code).toBe(0);
    expect(result.response.status).toBe('ok');
    expect(data.usageText).toContain('Visor TypeScript CLI');
    expect(data.usageText).toContain('visor status');
    expect(data.usageText).toContain('visor --help | -h');
    expect(data.usageText).toContain('visor --version | -v');
    expect(data.usageText).not.toContain('node dist/main.js status');
    expect(data.usageText).not.toContain('scenarios/local-fake-smoke.json');
    expect(data.examples).toContain(
      'visor run path/to/scenario.json --runtime local --output artifacts-local'
    );
    expect(data.examples).not.toContain(
      'visor run scenarios/local-fake-smoke.json --runtime local --output artifacts-local-e2e'
    );
    expect(data.commands).toContain('run');
    expect(data.commands).toContain('scroll');
  });

  it('returns package version for --version', async () => {
    const result = await executeCommand(['--version']);
    const data = responseData<{ version: string; versionText: string }>(result.response.data);
    expect(result.code).toBe(0);
    expect(result.response.status).toBe('ok');
    expect(data.version).toBe(packageVersion());
    expect(data.versionText).toBe(packageVersion());
  });

  it('returns package version for -v', async () => {
    const result = await executeCommand(['-v']);
    const data = responseData<{ version: string }>(result.response.data);
    expect(result.code).toBe(0);
    expect(result.response.status).toBe('ok');
    expect(data.version).toBe(packageVersion());
  });

  it('returns help when no command is provided', async () => {
    const result = await executeCommand([]);
    const data = responseData<{ usageText: string }>(result.response.data);
    expect(result.code).toBe(0);
    expect(data.usageText).toContain('Usage:');
  });

  it('returns command-specific help for tap --help', async () => {
    const result = await executeCommand(['tap', '--help']);
    const data = responseData<{ usageText: string; examples: string[] }>(result.response.data);
    expect(result.code).toBe(0);
    expect(data.usageText).toContain('visor tap --target <selector>');
    expect(data.usageText).toContain('visor tap --x <points> --y <points>');
    expect(data.usageText).toContain('--normalized');
    expect(data.usageText).not.toContain('validate <scenario>');
    expect(data.examples).toContain('visor tap --target accessibility=Continue');
    expect(data.examples).toContain('visor tap --target "first-in-section=Top Starter portfolios"');
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

  it('runs a scenario with the deterministic local runtime and writes review artifacts', async () => {
    const outputDir = tempOutputDir();

    try {
      const result = await executeCommand([
        'run',
        'scenarios/local-fake-smoke.json',
        '--runtime',
        'local',
        '--output',
        outputDir
      ]);

      const data = responseData<{
        run: {
          run_id: string;
          status: string;
          device: string;
          assertions: Array<{ id: string; status: string }>;
          artifacts: string[];
        };
      }>(result.response.data);
      const runRoot = path.join(outputDir, data.run.run_id);

      expect(result.code).toBe(0);
      expect(result.response.status).toBe('ok');
      expect(data.run.status).toBe('ok');
      expect(data.run.device).toBe('local');
      expect(data.run.assertions).toContainEqual(expect.objectContaining({ id: 'a1', status: 'passed' }));
      expect(result.response.artifacts).toEqual(
        expect.arrayContaining([
          path.join(runRoot, 'summary.txt'),
          path.join(runRoot, 'summary.json'),
          path.join(runRoot, 'junit.xml'),
          path.join(runRoot, 'timeline.log'),
          path.join(runRoot, 'report.html')
        ])
      );
      expect(data.run.artifacts.some((artifact) => artifact.endsWith('001-counter-initial.png'))).toBe(true);
      expect(data.run.artifacts.some((artifact) => artifact.endsWith('002-counter-after-tap.xml'))).toBe(true);
      expect(fs.existsSync(path.join(runRoot, 'screenshots', '001-counter-initial.png'))).toBe(true);
      expect(fs.existsSync(path.join(runRoot, 'sources', '002-counter-after-tap.xml'))).toBe(true);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported runtime values before device discovery', async () => {
    const result = await executeCommand([
      'run',
      'scenarios/local-fake-smoke.json',
      '--runtime',
      'remote'
    ]);

    expect(result.code).toBe(1);
    expect(result.response.status).toBe('fail');
    expect(result.response.error?.code).toBe('INPUT_ERROR');
    expect(result.response.error?.message).toBe('Unsupported runtime');
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
