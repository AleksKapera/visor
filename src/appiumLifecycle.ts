import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ensureDir, parseServerUrl, resolveExecutable, sleep, splitCommandLine } from './utils.js';

export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 60;

interface ServerMetadata {
  pid: number;
  command: string;
  serverUrl: string;
  startedAt: number;
}

function stateDir(): string {
  return ensureDir(path.join(process.cwd(), '.visor', 'appium'));
}

function slug(serverUrl: string): string {
  const address = parseServerUrl(serverUrl);
  return `${address.host.replaceAll(':', '_')}_${address.port}`;
}

function metaPath(serverUrl: string): string {
  return path.join(stateDir(), `${slug(serverUrl)}.json`);
}

function logPath(serverUrl: string): string {
  return path.join(stateDir(), `${slug(serverUrl)}.log`);
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

function readMeta(serverUrl: string): ServerMetadata | null {
  const filePath = metaPath(serverUrl);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ServerMetadata;
  } catch {
    return null;
  }
}

function writeMeta(serverUrl: string, meta: ServerMetadata): string {
  const filePath = metaPath(serverUrl);
  fs.writeFileSync(filePath, JSON.stringify(meta, null, 2), 'utf8');
  return filePath;
}

function cleanupMeta(serverUrl: string): void {
  const filePath = metaPath(serverUrl);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function localAppiumBin(): string {
  const executable = process.platform === 'win32' ? 'appium.cmd' : 'appium';
  return path.resolve(process.cwd(), 'node_modules', '.bin', executable);
}

function terminatePid(pid: number, force: boolean): void {
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';

  if (process.platform === 'win32') {
    process.kill(pid, signal);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    process.kill(pid, signal);
  }
}

export async function isAppiumReachable(serverUrl: string, timeout = 1000): Promise<boolean> {
  const address = parseServerUrl(serverUrl);
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(
      {
        host: address.host,
        port: address.port
      },
      () => {
        socket.destroy();
        resolve(true);
      }
    );

    socket.setTimeout(timeout);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export function resolveAppiumCommand(overrideCmd?: string): string {
  if (overrideCmd?.trim()) {
    return overrideCmd.trim();
  }

  const envCmd = process.env.VISOR_APPIUM_CMD?.trim();
  if (envCmd) {
    return envCmd;
  }

  const localBin = localAppiumBin();
  if (fs.existsSync(localBin)) {
    return localBin;
  }

  if (resolveExecutable('npx')) {
    return 'npx appium';
  }

  if (resolveExecutable('appium')) {
    return 'appium';
  }

  throw new Error(
    'Unable to find Appium launcher. Install project dependencies, run `npm install`, or set VISOR_APPIUM_CMD / --appium-cmd.'
  );
}

export function injectServerBinding(cmdParts: string[], host: string, port: number): string[] {
  const hasPort = cmdParts.includes('--port') || cmdParts.includes('-p');
  const hasAddress = cmdParts.includes('--address') || cmdParts.includes('-a');
  const withBinding = [...cmdParts];

  if (!hasAddress) {
    withBinding.push('--address', host);
  }

  if (!hasPort) {
    withBinding.push('--port', String(port));
  }

  return withBinding;
}

export async function statusManagedAppium(serverUrl: string): Promise<Record<string, unknown>> {
  const reachable = await isAppiumReachable(serverUrl);
  const meta = readMeta(serverUrl);

  if (!meta) {
    return {
      serverUrl: serverUrl,
      reachable,
      managed: false,
      pid: null,
      command: null,
      metadataPath: metaPath(serverUrl),
      logPath: logPath(serverUrl)
    };
  }

  if (!pidExists(meta.pid)) {
    cleanupMeta(serverUrl);
    return {
      serverUrl: serverUrl,
      reachable,
      managed: false,
      pid: null,
      command: null,
      metadataPath: metaPath(serverUrl),
      logPath: logPath(serverUrl)
    };
  }

  return {
    serverUrl: serverUrl,
    reachable,
    managed: true,
    pid: meta.pid,
    command: meta.command,
    metadataPath: metaPath(serverUrl),
    logPath: logPath(serverUrl)
  };
}

export async function startManagedAppium(
  serverUrl: string,
  appiumCmd?: string,
  startupTimeoutS = DEFAULT_STARTUP_TIMEOUT_SECONDS
): Promise<Record<string, unknown>> {
  const existingStatus = await statusManagedAppium(serverUrl);
  if (Boolean(existingStatus.reachable)) {
    return {
      ...existingStatus,
      alreadyRunning: true,
      started: false
    };
  }

  const resolvedCmd = resolveAppiumCommand(appiumCmd);
  const server = parseServerUrl(serverUrl);
  const cmdParts = injectServerBinding(splitCommandLine(resolvedCmd), server.host, server.port);
  if (cmdParts.length === 0) {
    throw new Error('Appium command is empty after parsing.');
  }

  const targetLogPath = logPath(serverUrl);
  ensureDir(path.dirname(targetLogPath));
  const logFd = fs.openSync(targetLogPath, 'a');
  const child = spawn(cmdParts[0], cmdParts.slice(1), {
    detached: process.platform !== 'win32',
    stdio: ['ignore', logFd, logFd]
  });
  fs.closeSync(logFd);

  const metadataPath = writeMeta(serverUrl, {
    pid: child.pid ?? -1,
    command: resolvedCmd,
    serverUrl,
    startedAt: Date.now()
  });

  const deadline = Date.now() + Math.max(100, startupTimeoutS * 1000);
  while (Date.now() < deadline) {
    if (await isAppiumReachable(serverUrl)) {
      child.unref();
      return {
        serverUrl,
        reachable: true,
        managed: true,
        pid: child.pid,
        command: resolvedCmd,
        metadataPath,
        logPath: targetLogPath,
        started: true,
        alreadyRunning: false
      };
    }

    if (child.exitCode !== null) {
      cleanupMeta(serverUrl);
      throw new Error(
        `Appium exited before becoming ready (exit code ${child.exitCode}). See log at ${targetLogPath}`
      );
    }

    await sleep(250);
  }

  try {
    if (child.pid) {
      terminatePid(child.pid, true);
    }
  } catch {
    // best effort cleanup
  }
  cleanupMeta(serverUrl);
  throw new Error(
    `Appium did not become reachable within ${startupTimeoutS.toFixed(1)}s. See log at ${targetLogPath}`
  );
}

export async function stopManagedAppium(
  serverUrl: string,
  force = false,
  timeoutS = 5
): Promise<Record<string, unknown>> {
  const meta = readMeta(serverUrl);
  if (!meta) {
    return {
      serverUrl,
      stopped: false,
      managed: false,
      reason: 'no_managed_process',
      reachable: await isAppiumReachable(serverUrl),
      metadataPath: metaPath(serverUrl),
      logPath: logPath(serverUrl)
    };
  }

  if (!pidExists(meta.pid)) {
    cleanupMeta(serverUrl);
    return {
      serverUrl,
      stopped: false,
      managed: false,
      reason: 'stale_metadata',
      reachable: await isAppiumReachable(serverUrl),
      pid: meta.pid,
      metadataPath: metaPath(serverUrl),
      logPath: logPath(serverUrl)
    };
  }

  terminatePid(meta.pid, force);
  const deadline = Date.now() + Math.max(100, timeoutS * 1000);
  while (Date.now() < deadline) {
    if (!pidExists(meta.pid)) {
      cleanupMeta(serverUrl);
      return {
        serverUrl,
        stopped: true,
        managed: true,
        pid: meta.pid,
        reachable: await isAppiumReachable(serverUrl),
        metadataPath: metaPath(serverUrl),
        logPath: logPath(serverUrl)
      };
    }

    await sleep(100);
  }

  throw new Error(`Failed to stop managed Appium process ${meta.pid} within ${timeoutS.toFixed(1)}s. Retry with --force.`);
}
