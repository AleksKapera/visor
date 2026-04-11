import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SERVER_URL, getAdapter } from './adapters.js';
import {
  DEFAULT_STARTUP_TIMEOUT_SECONDS,
  startManagedAppium,
  statusManagedAppium,
  stopManagedAppium
} from './appiumLifecycle.js';
import { runScenario } from './runner.js';
import type { CommandName, Platform, PlatformAdapter, RunResult, Scenario } from './types.js';
import { ensureDir, errorMessage, resolveExecutable, sleep } from './utils.js';

interface RuntimeKeyInput {
  platform: Platform;
  server_url: string;
  device?: string;
  app_id?: string;
  attach_to_running: boolean;
}

interface DaemonMetadata {
  pid: number;
  serverUrl: string;
  socketPath: string;
  appiumStarted: boolean;
  startedAt: number;
}

type DaemonRequest =
  | { type: 'status' }
  | { type: 'stop'; force?: boolean }
  | { type: 'action'; runtime: RuntimeKeyInput; command: CommandName; args: Record<string, unknown> }
  | {
      type: 'scenario';
      runtime: RuntimeKeyInput;
      scenario: Scenario;
      device: string;
      timeout?: number;
      outputDir: string;
    };

type DaemonResponse =
  | { ok: true; data: Record<string, unknown> | RunResult }
  | { ok: false; error: string };

interface DaemonOptions {
  serverUrl: string;
  appiumStarted: boolean;
}

interface SessionEntry {
  adapter: PlatformAdapter;
  runtime: RuntimeKeyInput;
  createdAt: number;
}

export class DaemonUnavailableError extends Error {
  constructor(message = 'Visor daemon is not running. Run `visor start` before real-device commands.') {
    super(message);
    this.name = 'DaemonUnavailableError';
  }
}

export class DaemonRequestTimeoutError extends Error {
  constructor(requestType: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for the Visor daemon to finish '${requestType}'. Inspect .visor/daemon/daemon.log and .visor/appium/*.log for the underlying Appium operation.`
    );
    this.name = 'DaemonRequestTimeoutError';
  }
}

function daemonDir(): string {
  return ensureDir(path.join(process.cwd(), '.visor', 'daemon'));
}

function socketPath(): string {
  if (process.env.VISOR_DAEMON_SOCKET_PATH) {
    return process.env.VISOR_DAEMON_SOCKET_PATH;
  }

  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\visor-daemon';
  }

  return path.join(daemonDir(), 'visor.sock');
}

function metadataPath(): string {
  return path.join(daemonDir(), 'daemon.json');
}

function logPath(): string {
  return path.join(daemonDir(), 'daemon.log');
}

function readMetadata(): DaemonMetadata | null {
  const filePath = metadataPath();
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as DaemonMetadata;
  } catch {
    return null;
  }
}

function writeMetadata(meta: DaemonMetadata): void {
  fs.writeFileSync(metadataPath(), JSON.stringify(meta, null, 2), 'utf8');
}

function cleanupMetadata(): void {
  const filePath = metadataPath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function pidExists(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function runtimeKey(runtime: RuntimeKeyInput): string {
  return JSON.stringify({
    platform: runtime.platform,
    server_url: runtime.server_url,
    device: runtime.device ?? '',
    app_id: runtime.app_id ?? '',
    attach_to_running: runtime.attach_to_running
  });
}

function parseBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

export function isRecoverableSessionCacheError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('session is either terminated or not started') ||
    message.includes('invalid session id') ||
    message.includes('no such driver')
  );
}

async function requestDaemon(request: DaemonRequest, timeoutMs = 1000): Promise<DaemonResponse> {
  const targetSocket = socketPath();

  return new Promise<DaemonResponse>((resolve, reject) => {
    const client = net.createConnection(targetSocket);
    let output = '';
    let settled = false;

    function settle(error?: Error, response?: DaemonResponse): void {
      if (settled) {
        return;
      }
      settled = true;
      client.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(response ?? { ok: false, error: 'Empty daemon response' });
      }
    }

    client.setTimeout(timeoutMs);
    client.on('connect', () => {
      client.write(`${JSON.stringify(request)}\n`);
    });
    client.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    client.on('end', () => {
      try {
        settle(undefined, JSON.parse(output) as DaemonResponse);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });
    client.on('timeout', () => {
      settle(new DaemonRequestTimeoutError(request.type, timeoutMs));
    });
    client.on('error', () => {
      settle(new DaemonUnavailableError());
    });
  });
}

async function daemonRequestData<T>(request: DaemonRequest, timeoutMs = 1000): Promise<T> {
  const response = await requestDaemon(request, timeoutMs);
  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.data as T;
}

async function isDaemonReachable(): Promise<boolean> {
  try {
    await daemonRequestData<Record<string, unknown>>({ type: 'status' }, 500);
    return true;
  } catch {
    return false;
  }
}

function daemonEntryCommand(): { command: string; args: string[] } {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const builtMain = path.join(moduleDir, 'main.js');
  if (fs.existsSync(builtMain)) {
    return { command: process.execPath, args: [builtMain] };
  }

  const sourceMain = path.resolve(process.cwd(), 'src', 'main.ts');
  const localTsx = path.resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  if (fs.existsSync(sourceMain) && fs.existsSync(localTsx)) {
    return { command: localTsx, args: [sourceMain] };
  }

  if (process.argv[1] && fs.existsSync(process.argv[1])) {
    return { command: process.execPath, args: [process.argv[1]] };
  }

  const tsx = resolveExecutable('tsx');
  if (tsx && fs.existsSync(sourceMain)) {
    return { command: tsx, args: [sourceMain] };
  }

  throw new Error('Unable to resolve a Visor CLI entrypoint for the daemon.');
}

export async function startVisorDaemon(
  serverUrl = DEFAULT_SERVER_URL,
  appiumCmd?: string
): Promise<Record<string, unknown>> {
  const existing = readMetadata();
  if (existing && pidExists(existing.pid) && (await isDaemonReachable())) {
    return {
      serverUrl,
      daemon: {
        running: true,
        alreadyRunning: true,
        pid: existing.pid,
        socketPath: existing.socketPath,
        metadataPath: metadataPath(),
        logPath: logPath()
      },
      appium: await statusManagedAppium(serverUrl)
    };
  }

  if (process.platform !== 'win32' && fs.existsSync(socketPath())) {
    fs.unlinkSync(socketPath());
  }
  cleanupMetadata();

  const appiumStatus = await statusManagedAppium(serverUrl);
  if (Boolean(appiumStatus.reachable) && !Boolean(appiumStatus.managed)) {
    throw new Error(
      `Appium is already reachable at ${serverUrl}, but it is not managed by Visor. Stop the existing Appium process or choose a different --server-url, then run \`visor start\` again.`
    );
  }

  const appium = await startManagedAppium(
    serverUrl,
    appiumCmd,
    DEFAULT_STARTUP_TIMEOUT_SECONDS
  );

  const entry = daemonEntryCommand();
  const targetLogPath = logPath();
  ensureDir(path.dirname(targetLogPath));
  const logFd = fs.openSync(targetLogPath, 'a');
  const child = spawn(entry.command, [...entry.args, '__daemon'], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      VISOR_DAEMON_SERVER_URL: serverUrl,
      VISOR_DAEMON_APPIUM_STARTED: String(Boolean(appium.started)),
      VISOR_DAEMON_SOCKET_PATH: socketPath()
    }
  });
  fs.closeSync(logFd);

  const meta: DaemonMetadata = {
    pid: child.pid ?? -1,
    serverUrl,
    socketPath: socketPath(),
    appiumStarted: Boolean(appium.started),
    startedAt: Date.now()
  };
  writeMetadata(meta);
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await isDaemonReachable()) {
      return {
        serverUrl,
        daemon: {
          running: true,
          alreadyRunning: false,
          pid: meta.pid,
          socketPath: meta.socketPath,
          metadataPath: metadataPath(),
          logPath: targetLogPath
        },
        appium
      };
    }

    if (child.exitCode !== null) {
      cleanupMetadata();
      throw new Error(`Visor daemon exited before becoming ready. See log at ${targetLogPath}`);
    }

    await sleep(100);
  }

  cleanupMetadata();
  throw new Error(`Visor daemon did not become ready within 5.0s. See log at ${targetLogPath}`);
}

export async function statusVisorDaemon(serverUrl = DEFAULT_SERVER_URL): Promise<Record<string, unknown>> {
  const meta = readMetadata();
  let daemonData: Record<string, unknown> = {};
  let running = false;
  let daemonError: string | undefined;

  const pidPresent = meta ? pidExists(meta.pid) : false;
  try {
    daemonData = await daemonRequestData<Record<string, unknown>>({ type: 'status' }, 2000);
    running = true;
  } catch (error) {
    running = false;
    daemonError = errorMessage(error);
  }

  if (meta && !running && !pidPresent) {
    cleanupMetadata();
  }

  return {
    serverUrl,
    daemon: {
      running,
      responsive: running,
      unresponsive: Boolean(meta && pidPresent && !running),
      pid: meta?.pid ?? null,
      socketPath: socketPath(),
      metadataPath: metadataPath(),
      logPath: logPath(),
      appiumStarted: running ? (meta?.appiumStarted ?? false) : false,
      error: daemonError,
      ...daemonData
    },
    appium: await statusManagedAppium(serverUrl)
  };
}

export async function stopVisorDaemon(
  serverUrl = DEFAULT_SERVER_URL,
  force = false
): Promise<Record<string, unknown>> {
  const meta = readMetadata();
  let daemonResponse: Record<string, unknown> | null = null;

  try {
    daemonResponse = await daemonRequestData<Record<string, unknown>>({ type: 'stop', force }, 5000);
  } catch (error) {
    if (!(error instanceof DaemonUnavailableError) && !(error instanceof DaemonRequestTimeoutError)) {
      throw error;
    }
  }

  if (meta && pidExists(meta.pid)) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && pidExists(meta.pid)) {
      await sleep(100);
    }

    if (pidExists(meta.pid) && force) {
      process.kill(meta.pid, 'SIGKILL');
    }

    if (pidExists(meta.pid)) {
      return {
        serverUrl,
        stopped: false,
        daemon: {
          running: false,
          unresponsive: true,
          reason: 'daemon_did_not_stop',
          pid: meta.pid,
          socketPath: socketPath(),
          metadataPath: metadataPath(),
          logPath: logPath()
        },
        appium: await statusManagedAppium(serverUrl)
      };
    }
  }

  if (meta?.appiumStarted) {
    try {
      await stopManagedAppium(meta.serverUrl, force);
    } catch {
      if (!force) {
        await stopManagedAppium(meta.serverUrl, true);
      }
    }
  }

  cleanupMetadata();
  if (process.platform !== 'win32' && fs.existsSync(socketPath())) {
    fs.unlinkSync(socketPath());
  }

  return {
    serverUrl,
    stopped: Boolean(daemonResponse),
    daemon: daemonResponse ?? {
      running: false,
      reason: 'daemon_not_running',
      socketPath: socketPath(),
      metadataPath: metadataPath(),
      logPath: logPath()
    },
    appium: await statusManagedAppium(serverUrl)
  };
}

export async function runDaemonAction(
  runtime: RuntimeKeyInput,
  command: CommandName,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return daemonRequestData<Record<string, unknown>>({ type: 'action', runtime, command, args }, 300000);
}

export async function runDaemonScenario(
  runtime: RuntimeKeyInput,
  scenario: Scenario,
  device: string,
  timeout: number | undefined,
  outputDir: string
): Promise<RunResult> {
  return daemonRequestData<RunResult>(
    { type: 'scenario', runtime, scenario, device, timeout, outputDir },
    600000
  );
}

export async function runDaemonFromEnv(): Promise<void> {
  const options: DaemonOptions = {
    serverUrl: process.env.VISOR_DAEMON_SERVER_URL ?? DEFAULT_SERVER_URL,
    appiumStarted: parseBoolean(process.env.VISOR_DAEMON_APPIUM_STARTED)
  };
  const sessions = new Map<string, SessionEntry>();
  let queue = Promise.resolve();
  let activeOperation: string | null = null;
  let lastError: string | null = null;

  async function closeSessions(): Promise<void> {
    const entries = Array.from(sessions.values());
    sessions.clear();
    for (const entry of entries) {
      try {
        await entry.adapter.close();
      } catch {
        // Stopping the daemon should still succeed if Appium already dropped the session.
      }
    }
  }

  async function sessionFor(runtime: RuntimeKeyInput): Promise<PlatformAdapter> {
    const key = runtimeKey(runtime);
    const existing = sessions.get(key);
    if (existing) {
      return existing.adapter;
    }

    const adapter = await getAdapter(
      runtime.platform,
      runtime.server_url,
      runtime.device,
      runtime.app_id,
      runtime.attach_to_running
    );
    sessions.set(key, {
      adapter,
      runtime,
      createdAt: Date.now()
    });
    return adapter;
  }

  async function discardSession(runtime: RuntimeKeyInput): Promise<void> {
    const key = runtimeKey(runtime);
    const existing = sessions.get(key);
    if (!existing) {
      return;
    }

    sessions.delete(key);
    try {
      await existing.adapter.close();
    } catch {
      // The backing WebDriver session is already gone; removing it from the cache is enough.
    }
  }

  async function runActionWithSessionRetry(
    runtime: RuntimeKeyInput,
    command: CommandName,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const adapter = await sessionFor(runtime);
    try {
      return await adapter[command](args);
    } catch (error) {
      if (!isRecoverableSessionCacheError(error)) {
        throw error;
      }

      await discardSession(runtime);
      const freshAdapter = await sessionFor(runtime);
      return freshAdapter[command](args);
    }
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work).catch((error) => {
      lastError = errorMessage(error);
      throw error;
    });
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  const server = net.createServer((socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8');
      if (!input.includes('\n')) {
        return;
      }

      socket.pause();
      void (async () => {
        let response: DaemonResponse;
        try {
          const request = JSON.parse(input) as DaemonRequest;
          if (request.type === 'status') {
            response = {
              ok: true,
              data: {
                activeOperation,
                lastError,
                sessions: Array.from(sessions.entries()).map(([key, entry]) => ({
                  key,
                  runtime: entry.runtime,
                  createdAt: entry.createdAt
                }))
              }
            };
          } else if (request.type === 'stop') {
            await closeSessions();
            response = {
              ok: true,
              data: {
                running: false,
                sessionsClosed: true,
                appiumStarted: options.appiumStarted
              }
            };
            socket.end(`${JSON.stringify(response)}\n`, () => {
              server.close(() => {
                process.exit(0);
              });
            });
            return;
          } else if (request.type === 'action') {
            const data = await enqueue(async () => {
              activeOperation = `${request.command}:${runtimeKey(request.runtime)}`;
              try {
                return await runActionWithSessionRetry(
                  request.runtime,
                  request.command,
                  request.args
                );
              } finally {
                activeOperation = null;
              }
            });
            response = { ok: true, data };
          } else {
            const data = await enqueue(async () => {
              activeOperation = `scenario:${runtimeKey(request.runtime)}`;
              try {
                const adapter = await sessionFor(request.runtime);
                return await runScenario(
                  request.scenario,
                  adapter,
                  request.device,
                  request.timeout,
                  request.outputDir,
                  false
                );
              } finally {
                activeOperation = null;
              }
            });
            response = { ok: true, data };
          }
        } catch (error) {
          response = { ok: false, error: errorMessage(error) };
        }

        socket.end(`${JSON.stringify(response)}\n`);
      })();
    });
  });

  process.on('SIGTERM', () => {
    void closeSessions().finally(() => {
      server.close();
    });
  });

  if (process.platform !== 'win32' && fs.existsSync(socketPath())) {
    fs.unlinkSync(socketPath());
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath(), () => {
      server.off('error', reject);
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    server.once('close', resolve);
  });
}
