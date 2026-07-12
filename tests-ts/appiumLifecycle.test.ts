import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_STARTUP_TIMEOUT_SECONDS,
  injectServerBinding,
  resolveAppiumCommand,
  statusManagedAppium,
  stopManagedAppium
} from '../src/appiumLifecycle.js';

describe('appium lifecycle helpers', () => {
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-appium-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.VISOR_APPIUM_CMD;
  });

  it('allows native drivers enough time to load before declaring startup failure', () => {
    expect(DEFAULT_STARTUP_TIMEOUT_SECONDS).toBe(60);
  });

  it('prefers cli override when resolving appium command', () => {
    process.env.VISOR_APPIUM_CMD = 'appium --port 4725';
    expect(resolveAppiumCommand('custom-appium --port 4726')).toBe('custom-appium --port 4726');
  });

  it('prefers environment when no override is provided', () => {
    process.env.VISOR_APPIUM_CMD = 'appium --port 4725';
    expect(resolveAppiumCommand()).toBe('appium --port 4725');
  });

  it('adds address and port bindings when missing', () => {
    expect(injectServerBinding(['npx', 'appium'], '127.0.0.1', 4725)).toEqual([
      'npx',
      'appium',
      '--address',
      '127.0.0.1',
      '--port',
      '4725'
    ]);
  });

  it('keeps existing address and port bindings', () => {
    expect(
      injectServerBinding(['appium', '--address', '0.0.0.0', '--port', '9999'], '127.0.0.1', 4725)
    ).toEqual(['appium', '--address', '0.0.0.0', '--port', '9999']);
  });

  it('returns unmanaged status when metadata is missing', async () => {
    const status = await statusManagedAppium('http://127.0.0.1:4723');
    expect(status.managed).toBe(false);
    expect(String(status.metadataPath)).toContain('.visor/appium/127.0.0.1_4723.json');
  });

  it('returns no managed process when stopping without metadata', async () => {
    const result = await stopManagedAppium('http://127.0.0.1:4723');
    expect(result.stopped).toBe(false);
    expect(result.reason).toBe('no_managed_process');
  });
});
