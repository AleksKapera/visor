import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';

import type { Platform } from './types.js';

const execFileAsync = promisify(execFile);

export type DeviceCommandRunner = (command: string, args: string[]) => Promise<string>;

export interface RunningDevice {
  platform: Platform;
  id: string;
  name: string;
}

export interface DeviceSelectionIo {
  input: Readable & { isTTY?: boolean };
  output: Writable & { isTTY?: boolean };
}

export class DeviceSelectionError extends Error {
  readonly devices: RunningDevice[];

  constructor(message: string, devices: RunningDevice[] = []) {
    super(message);
    this.name = 'DeviceSelectionError';
    this.devices = devices;
  }
}

async function defaultDeviceCommandRunner(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args);
  return stdout.toString();
}

let deviceCommandRunner: DeviceCommandRunner = defaultDeviceCommandRunner;

export function setDeviceCommandRunner(runner: DeviceCommandRunner): void {
  deviceCommandRunner = runner;
}

export function resetDeviceCommandRunner(): void {
  deviceCommandRunner = defaultDeviceCommandRunner;
}

export function deviceLabel(device: RunningDevice): string {
  return `${device.name} (${device.id}, ${device.platform})`;
}

export function parseAndroidDevices(output: string): RunningDevice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices attached'))
    .flatMap((line) => {
      const [id, state] = line.split(/\s+/);
      if (!id || state !== 'device') {
        return [];
      }

      return [{ platform: 'android' as const, id, name: id }];
    });
}

export function parseIosBootedDevices(output: string): RunningDevice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(/^(.+?)\s+\(([0-9a-fA-F-]{8,})\)\s+\(Booted\)$/);
      if (!match) {
        return [];
      }

      return [{ platform: 'ios' as const, id: match[2], name: match[1] }];
    });
}

async function discoverAndroidDevices(): Promise<RunningDevice[]> {
  try {
    const stdout = await deviceCommandRunner('adb', ['devices']);
    return parseAndroidDevices(stdout);
  } catch {
    return [];
  }
}

async function discoverIosDevices(): Promise<RunningDevice[]> {
  try {
    const stdout = await deviceCommandRunner('xcrun', ['simctl', 'list', 'devices', 'booted']);
    return parseIosBootedDevices(stdout);
  } catch {
    return [];
  }
}

export async function discoverRunningDevices(): Promise<RunningDevice[]> {
  const [android, ios] = await Promise.all([discoverAndroidDevices(), discoverIosDevices()]);
  return [...android, ...ios];
}

function matchesDevice(device: RunningDevice, requested: string): boolean {
  return device.id === requested || device.name === requested;
}

function deviceListForError(devices: RunningDevice[]): string {
  if (devices.length === 0) {
    return 'No running Android devices or booted iOS simulators were detected.';
  }

  return `Detected devices: ${devices.map(deviceLabel).join('; ')}`;
}

async function promptForDevice(devices: RunningDevice[], io: DeviceSelectionIo): Promise<RunningDevice> {
  if (!io.input.isTTY || !io.output.isTTY) {
    throw new DeviceSelectionError(
      `${deviceListForError(devices)} Specify one with --device.`,
      devices
    );
  }

  io.output.write('Multiple running devices detected:\n');
  devices.forEach((device, index) => {
    io.output.write(`  ${index + 1}. ${deviceLabel(device)}\n`);
  });

  const readline = createInterface({ input: io.input, output: io.output });
  try {
    const answer = (await readline.question('Select device number: ')).trim();
    const selectedIndex = Number(answer);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > devices.length) {
      throw new DeviceSelectionError(
        `Invalid device selection '${answer}'. Specify one with --device.`,
        devices
      );
    }

    return devices[selectedIndex - 1];
  } finally {
    readline.close();
  }
}

export async function resolveRunningDevice(
  requestedDevice?: string,
  io: DeviceSelectionIo = { input: process.stdin, output: process.stderr }
): Promise<RunningDevice> {
  const devices = await discoverRunningDevices();

  if (requestedDevice) {
    const matches = devices.filter((device) => matchesDevice(device, requestedDevice));
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new DeviceSelectionError(
        `Device '${requestedDevice}' matches multiple running devices. ${deviceListForError(matches)}`,
        matches
      );
    }

    throw new DeviceSelectionError(
      `Device '${requestedDevice}' is not running or could not be detected. ${deviceListForError(devices)}`,
      devices
    );
  }

  if (devices.length === 1) {
    return devices[0];
  }

  if (devices.length === 0) {
    throw new DeviceSelectionError(
      'No running Android devices or booted iOS simulators were detected. Start a target device or pass --device for a detected running target.',
      devices
    );
  }

  return promptForDevice(devices, io);
}
