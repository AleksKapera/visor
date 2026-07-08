import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const appiumStatus = {
  serverUrl: 'http://127.0.0.1:4723',
  reachable: false,
  managed: false,
  pid: null,
  command: null,
  metadataPath: '/tmp/appium.json',
  logPath: '/tmp/appium.log'
};

vi.mock('../src/appiumLifecycle.js', () => ({
  DEFAULT_STARTUP_TIMEOUT_SECONDS: 20,
  statusManagedAppium: vi.fn(async () => appiumStatus),
  startManagedAppium: vi.fn(async () => ({ ...appiumStatus, started: true })),
  stopManagedAppium: vi.fn(async () => undefined)
}));

import { isRecoverableSessionCacheError, startVisorDaemon, statusVisorDaemon } from '../src/daemon.js';

function packageVersion(): string {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    version?: unknown;
  };
  return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
}

async function withFakeRunningDaemon<T>(
  responseData: Record<string, unknown>,
  test: () => Promise<T>
): Promise<T> {
  const originalCwd = process.cwd();
  const originalSocketPath = process.env.VISOR_DAEMON_SOCKET_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-daemon-'));
  const socketPath = path.join(tempDir, 'visor.sock');

  process.chdir(tempDir);
  process.env.VISOR_DAEMON_SOCKET_PATH = socketPath;
  fs.mkdirSync(path.join(tempDir, '.visor', 'daemon'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, '.visor', 'daemon', 'daemon.json'),
    JSON.stringify(
      {
        pid: process.pid,
        serverUrl: 'http://127.0.0.1:4723',
        socketPath,
        appiumStarted: false,
        startedAt: Date.now()
      },
      null,
      2
    ),
    'utf8'
  );

  const server = net.createServer((socket) => {
    socket.on('data', () => {
      socket.end(`${JSON.stringify({ ok: true, data: responseData })}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    return await test();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.chdir(originalCwd);
    if (originalSocketPath === undefined) {
      delete process.env.VISOR_DAEMON_SOCKET_PATH;
    } else {
      process.env.VISOR_DAEMON_SOCKET_PATH = originalSocketPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('daemon session cache helpers', () => {
  it('treats terminated WebDriver sessions as recoverable cache misses', () => {
    expect(
      isRecoverableSessionCacheError(
        new Error(
          'WebDriverError: A session is either terminated or not started when running "window/rect" with method "GET"'
        )
      )
    ).toBe(true);
  });

  it('treats lost iOS WebDriverAgent proxy targets as recoverable cache misses', () => {
    expect(
      isRecoverableSessionCacheError(
        new Error(
          'WebDriverError: An unknown server-side error occurred while processing the command. Original error: Could not proxy command to the remote server. Original error: connect ECONNREFUSED 127.0.0.1:8100 when running "window/rect" with method "GET"'
        )
      )
    ).toBe(true);
  });

  it('does not treat regular action failures as recoverable cache misses', () => {
    expect(isRecoverableSessionCacheError(new Error('tap target was not found'))).toBe(false);
  });
});

describe('daemon version metadata', () => {
  it('marks status and already-running start responses stale when daemon package version differs from the current CLI', async () => {
    const currentVersion = packageVersion();
    const daemonVersion = `${currentVersion}-old`;

    await withFakeRunningDaemon(
      {
        packageVersion: daemonVersion,
        runtimeVersion: 'v20.0.0',
        activeOperation: null,
        lastError: null,
        sessions: []
      },
      async () => {
        const status = await statusVisorDaemon();
        const statusDaemon = status.daemon as Record<string, unknown>;

        expect(statusDaemon.running).toBe(true);
        expect(statusDaemon.packageVersion).toBe(daemonVersion);
        expect(statusDaemon.runtimeVersion).toBe('v20.0.0');
        expect(statusDaemon.currentPackageVersion).toBe(currentVersion);
        expect(statusDaemon.stale).toBe(true);
        expect(statusDaemon.warning).toContain('differs from current CLI version');
        expect(statusDaemon.nextAction).toBe('restart');

        const started = await startVisorDaemon();
        const startDaemon = started.daemon as Record<string, unknown>;

        expect(startDaemon.alreadyRunning).toBe(true);
        expect(startDaemon.packageVersion).toBe(daemonVersion);
        expect(startDaemon.currentPackageVersion).toBe(currentVersion);
        expect(startDaemon.stale).toBe(true);
        expect(startDaemon.nextAction).toBe('restart');
      }
    );
  });
});
