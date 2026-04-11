import fs from 'node:fs';
import path from 'node:path';

import type { remote as remoteFn } from 'webdriverio';

import type { AdapterCapability, Platform, PlatformAdapter } from './types.js';
import { errorMessage, parseServerUrl, sleep } from './utils.js';

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:4723';
export const DEFAULT_ANDROID_APP = 'com.example.app';
export const DEFAULT_IOS_BUNDLE = 'com.example.app';
export const DEFAULT_ANDROID_DEVICE = 'emulator-5554';
export const DEFAULT_IOS_DEVICE = 'iPhone 17 Pro';

export const ACCESSIBILITY_ID = 'accessibility id';
export const XPATH = 'xpath';
export const ELEMENT_ID = 'id';
export const ANDROID_UIAUTOMATOR = '-android uiautomator';
export const IOS_PREDICATE = '-ios predicate string';
export const IOS_CLASS_CHAIN = '-ios class chain';

type TapMode = 'target' | 'coordinates';
type ScrollDirection = 'up' | 'down';
type RemoteSession = Awaited<ReturnType<typeof remoteFn>>;

interface ParsedTarget {
  strategy: string;
  value: string;
  selector: string;
}

function env(preferred: string, legacy: string, defaultValue?: string): string | undefined {
  return process.env[preferred] ?? process.env[legacy] ?? defaultValue;
}

function envBool(preferred: string, legacy: string, defaultValue = false): boolean {
  const raw = env(preferred, legacy);
  if (raw === undefined) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function envNumber(preferred: string, defaultValue: number): number {
  const raw = process.env[preferred];
  if (raw === undefined) {
    return defaultValue;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function resolveWebdriverConnectionTimeout(platform: Platform): number {
  const defaultTimeout = platform === 'ios' ? 240000 : 60000;
  return envNumber('VISOR_WEBDRIVER_CONNECTION_TIMEOUT_MS', defaultTimeout);
}

function pngDimensions(filePath: string): { width: number | null; height: number | null } {
  try {
    const header = fs.readFileSync(filePath).subarray(0, 24);
    if (
      header.length < 24 ||
      !header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return { width: null, height: null };
    }

    return {
      width: header.readUInt32BE(16),
      height: header.readUInt32BE(20)
    };
  } catch {
    return { width: null, height: null };
  }
}

export function formatDriverCreationError(
  platform: Platform,
  appId: string | undefined,
  attachToRunning: boolean,
  error: unknown
): string {
  const message = errorMessage(error);

  if (platform === 'ios' && message.includes('bundle identifier') && message.includes('unknown')) {
    const targetApp = appId ?? DEFAULT_IOS_BUNDLE;
    const attachHint = attachToRunning
      ? ' When using --attach, launch that app on the simulator/device first.'
      : '';
    return `Failed to create WebdriverIO Appium session: ${message}. On iOS, --app-id must be the exact installed bundle identifier for the target app (${targetApp}). Android package names do not carry over automatically.${attachHint}`;
  }

  if (platform === 'ios' && (message.includes('CoreSimulatorService') || message.includes('simctl'))) {
    return `Failed to create WebdriverIO Appium session: ${message}. iOS simulator access failed before the command ran; verify \`xcrun simctl list\` works from the same shell and that Appium is not running in a sandboxed process.`;
  }

  return `Failed to create WebdriverIO Appium session: ${message}`;
}

export function parseTarget(target: string): [string, string] {
  if (target.startsWith('text=')) {
    const value = target.split('=', 2)[1] ?? '';
    const xpath = `//*[contains(@text, '${value}') or contains(@content-desc, '${value}') or contains(@label, '${value}') or contains(@name, '${value}') or contains(@value, '${value}')]`;
    return [XPATH, xpath];
  }

  if (target.startsWith('id=')) {
    return [ELEMENT_ID, target.split('=', 2)[1] ?? ''];
  }

  if (target.startsWith('xpath=')) {
    return [XPATH, target.split('=', 2)[1] ?? ''];
  }

  if (target.startsWith('uiautomator=')) {
    return [ANDROID_UIAUTOMATOR, target.split('=', 2)[1] ?? ''];
  }

  if (target.startsWith('predicate=')) {
    return [IOS_PREDICATE, target.split('=', 2)[1] ?? ''];
  }

  if (target.startsWith('classchain=')) {
    return [IOS_CLASS_CHAIN, target.split('=', 2)[1] ?? ''];
  }

  if (target.startsWith('accessibility=')) {
    return [ACCESSIBILITY_ID, target.split('=', 2)[1] ?? ''];
  }

  return [ACCESSIBILITY_ID, target];
}

function selectorForTarget(target: string): ParsedTarget {
  const [strategy, value] = parseTarget(target);

  if (strategy === ACCESSIBILITY_ID) {
    return { strategy, value, selector: `~${value}` };
  }

  if (strategy === XPATH) {
    return { strategy, value, selector: value };
  }

  if (strategy === ELEMENT_ID) {
    return { strategy, value, selector: `id=${value}` };
  }

  if (strategy === ANDROID_UIAUTOMATOR) {
    return { strategy, value, selector: `android=${value}` };
  }

  if (strategy === IOS_PREDICATE) {
    return { strategy, value, selector: `-ios predicate string:${value}` };
  }

  return { strategy, value, selector: `-ios class chain:${value}` };
}

export function resolveTapMode(args: Record<string, unknown>): TapMode {
  const hasTarget = Object.hasOwn(args, 'target') && args.target !== undefined && args.target !== null;
  const hasX = Object.hasOwn(args, 'x') && args.x !== undefined && args.x !== null;
  const hasY = Object.hasOwn(args, 'y') && args.y !== undefined && args.y !== null;

  if (hasTarget && (hasX || hasY)) {
    throw new Error('tap cannot mix target with x/y coordinates');
  }

  if (hasTarget) {
    return 'target';
  }

  if (hasX && hasY) {
    return 'coordinates';
  }

  if (hasX !== hasY) {
    throw new Error('tap coordinate mode requires both x and y');
  }

  throw new Error('tap requires target or x/y coordinates');
}

function resolveScrollOptions(
  args: Record<string, unknown>
): { direction: ScrollDirection; percent: number; gesturePercent: number } {
  const direction = typeof args.direction === 'string' ? args.direction.toLowerCase() : '';
  if (direction !== 'up' && direction !== 'down') {
    throw new Error("scroll requires args.direction to be 'up' or 'down'");
  }

  const rawPercent = args.percent ?? 70;
  const percent = Number(rawPercent);
  if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
    throw new Error('scroll args.percent must be a number between 1 and 100');
  }

  return {
    direction,
    percent,
    gesturePercent: percent / 100
  };
}

export class RealAppiumAdapter implements PlatformAdapter {
  private readonly platform: Platform;
  private readonly serverUrl: string;
  private readonly device?: string;
  private readonly appId?: string;
  private readonly attachToRunning: boolean;
  private driver: RemoteSession | null = null;

  private constructor(
    platform: Platform,
    serverUrl: string,
    device?: string,
    appId?: string,
    attachToRunning = false
  ) {
    this.platform = platform;
    this.serverUrl = serverUrl;
    this.device = device;
    this.appId = appId;
    this.attachToRunning = attachToRunning;
  }

  static async create(
    platform: Platform,
    serverUrl: string,
    device?: string,
    appId?: string,
    attachToRunning = false
  ): Promise<RealAppiumAdapter> {
    const adapter = new RealAppiumAdapter(platform, serverUrl, device, appId, attachToRunning);
    adapter.driver = await adapter.createDriver();
    return adapter;
  }

  capability(): AdapterCapability {
    return {
      platform: this.platform,
      commands: ['navigate', 'tap', 'act', 'scroll', 'screenshot', 'wait', 'source']
    };
  }

  async navigate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const to = String(args.to ?? '');
    if (to) {
      await (this.requireDriver() as any).url(to);
    }

    return {
      action: 'navigate',
      platform: this.platform,
      args: { to }
    };
  }

  async tap(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (resolveTapMode(args) === 'coordinates') {
      const { x, y } = await this.resolveCoordinates(args);
      await this.tapPoint(x, y);
      return {
        action: 'tap',
        platform: this.platform,
        args: {
          x,
          y,
          normalized: Boolean(args.normalized)
        }
      };
    }

    const target = String(args.target);
    const selector = selectorForTarget(target);
    const element = await this.requireDriver().$(selector.selector);
    await element.click();
    return {
      action: 'tap',
      platform: this.platform,
      args: { target }
    };
  }

  async act(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = String(args.name ?? '');
    const value = String(args.value ?? '');
    const target = typeof args.target === 'string' ? args.target : undefined;

    if (name === 'type' && target) {
      const selector = selectorForTarget(target);
      const element = await this.requireDriver().$(selector.selector);
      await element.clearValue();
      await element.addValue(value);
      return {
        action: 'act',
        platform: this.platform,
        args: { name, target, value }
      };
    }

    if (name === 'back') {
      await (this.requireDriver() as any).back();
      return {
        action: 'act',
        platform: this.platform,
        args: { name }
      };
    }

    throw new Error(
      'Unsupported act operation; use --name type --target <selector> --value <text> or --name back'
    );
  }

  async scroll(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { direction, percent, gesturePercent } = resolveScrollOptions(args);
    await this.scrollViewport(direction, gesturePercent);

    return {
      action: 'scroll',
      platform: this.platform,
      args: { direction, percent }
    };
  }

  async screenshot(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const label = String(args.label ?? 'capture');
    const filePath = path.resolve(typeof args.path === 'string' ? args.path : `${label}.png`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await (this.requireDriver() as any).saveScreenshot(filePath);
    const { width, height } = pngDimensions(filePath);

    return {
      action: 'screenshot',
      platform: this.platform,
      args: {
        label,
        file: path.basename(filePath),
        path: filePath,
        width,
        height
      }
    };
  }

  async wait(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ms = Number(args.ms ?? 0);
    if (ms < 0) {
      throw new Error('wait requires non-negative ms');
    }

    await sleep(ms);
    return {
      action: 'wait',
      platform: this.platform,
      args: { ms }
    };
  }

  async source(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const label = String(args.label ?? 'source');
    const filePath = path.resolve(typeof args.path === 'string' ? args.path : `${label}.xml`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = await (this.requireDriver() as any).getPageSource();
    fs.writeFileSync(filePath, content, 'utf8');

    return {
      action: 'source',
      platform: this.platform,
      args: {
        label,
        file: path.basename(filePath),
        path: filePath,
        format: 'xml',
        bytes: fs.statSync(filePath).size
      }
    };
  }

  async exists(target: string): Promise<boolean> {
    const selector = selectorForTarget(target);
    const elements = (await this.requireDriver().$$(selector.selector)) as unknown as Array<unknown>;
    return elements.length > 0;
  }

  async close(): Promise<void> {
    if (!this.driver) {
      return;
    }

    const currentDriver = this.driver;
    this.driver = null;
    await currentDriver.deleteSession();
  }

  private requireDriver(): RemoteSession {
    if (!this.driver) {
      throw new Error('Driver session is not initialized');
    }

    return this.driver;
  }

  private async createDriver(): Promise<RemoteSession> {
    const attachToRunning =
      this.attachToRunning ||
      envBool('VISOR_ATTACH_TO_RUNNING', 'PATF_ATTACH_TO_RUNNING', false);
    const server = parseServerUrl(this.serverUrl);
    const capabilities: Record<string, unknown> = {};

    if (this.platform === 'android') {
      capabilities.platformName = 'Android';
      capabilities['appium:automationName'] = 'UiAutomator2';
      capabilities['appium:udid'] =
        this.device ?? env('VISOR_ANDROID_DEVICE', 'PATF_ANDROID_DEVICE', DEFAULT_ANDROID_DEVICE);
      capabilities['appium:appPackage'] =
        this.appId ?? env('VISOR_ANDROID_APP_PACKAGE', 'PATF_ANDROID_APP_PACKAGE', DEFAULT_ANDROID_APP);
      capabilities['appium:appActivity'] = env(
        'VISOR_ANDROID_APP_ACTIVITY',
        'PATF_ANDROID_APP_ACTIVITY',
        '.MainActivity'
      );
      capabilities['appium:newCommandTimeout'] = 60;

      if (attachToRunning) {
        capabilities['appium:noReset'] = true;
        capabilities['appium:fullReset'] = false;
        capabilities['appium:autoLaunch'] = false;
        capabilities['appium:dontStopAppOnReset'] = true;
      }
    } else {
      capabilities.platformName = 'iOS';
      capabilities['appium:automationName'] = 'XCUITest';
      capabilities['appium:deviceName'] =
        this.device ?? env('VISOR_IOS_DEVICE', 'PATF_IOS_DEVICE', DEFAULT_IOS_DEVICE);
      capabilities['appium:bundleId'] =
        this.appId ?? env('VISOR_IOS_BUNDLE_ID', 'PATF_IOS_BUNDLE_ID', DEFAULT_IOS_BUNDLE);
      capabilities['appium:newCommandTimeout'] = 60;

      if (attachToRunning) {
        capabilities['appium:noReset'] = true;
        capabilities['appium:fullReset'] = false;
        capabilities['appium:autoLaunch'] = false;
        capabilities['appium:shouldTerminateApp'] = false;
        capabilities['appium:forceAppLaunch'] = false;
      }
    }

    try {
      const { remote } = await import('webdriverio');
      return await remote({
        protocol: server.protocol,
        hostname: server.host,
        port: server.port,
        path: server.pathname,
        capabilities,
        logLevel: 'error',
        connectionRetryCount: envNumber('VISOR_WEBDRIVER_CONNECTION_RETRY_COUNT', 0),
        connectionRetryTimeout: resolveWebdriverConnectionTimeout(this.platform)
      });
    } catch (error) {
      throw new Error(
        formatDriverCreationError(this.platform, this.appId, attachToRunning, error)
      );
    }
  }

  private async resolveCoordinates(args: Record<string, unknown>): Promise<{ x: number; y: number }> {
    let x = Number(args.x);
    let y = Number(args.y);
    if (Boolean(args.normalized)) {
      const size = await (this.requireDriver() as any).getWindowSize();
      x *= Number(size.width);
      y *= Number(size.height);
    }

    return {
      x: Math.round(x),
      y: Math.round(y)
    };
  }

  private async tapPoint(x: number, y: number): Promise<void> {
    const driver = this.requireDriver() as any;
    if (this.platform === 'android') {
      await driver.execute('mobile: clickGesture', [{ x, y }]);
      return;
    }

    if (this.platform === 'ios') {
      await driver.execute('mobile: tap', [{ x, y }]);
      return;
    }

    throw new Error(`Coordinate tap is unsupported for platform: ${this.platform}`);
  }

  private async scrollViewport(direction: ScrollDirection, gesturePercent: number): Promise<void> {
    const driver = this.requireDriver() as any;
    const size = await driver.getWindowSize();
    const left = Math.max(0, Math.round(size.width * 0.1));
    const top = Math.max(0, Math.round(size.height * 0.1));
    const width = Math.max(1, Math.round(size.width * 0.8));
    const height = Math.max(1, Math.round(size.height * 0.8));

    if (this.platform === 'android') {
      await driver.execute('mobile: scrollGesture', [
        { left, top, width, height, direction, percent: gesturePercent }
      ]);
      return;
    }

    if (this.platform === 'ios') {
      try {
        await driver.execute('mobile: scrollGesture', [
          { left, top, width, height, direction, percent: gesturePercent }
        ]);
        return;
      } catch {
        await this.swipeViewport(direction, gesturePercent, size.width, size.height);
        return;
      }
    }

    throw new Error(`Scroll is unsupported for platform: ${this.platform}`);
  }

  private async swipeViewport(
    direction: ScrollDirection,
    gesturePercent: number,
    viewportWidth: number,
    viewportHeight: number
  ): Promise<void> {
    const driver = this.requireDriver() as any;
    const x = Math.round(viewportWidth / 2);
    const lowY = Math.round(viewportHeight * 0.75);
    const highY = Math.round(viewportHeight * 0.25);
    const travel = Math.max(1, Math.round(viewportHeight * gesturePercent));
    const startY = direction === 'down' ? lowY : highY;
    const unclampedEndY = direction === 'down' ? startY - travel : startY + travel;
    const endY = Math.max(1, Math.min(viewportHeight - 1, unclampedEndY));

    await driver.performActions([
      {
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x, y: startY },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 150 },
          { type: 'pointerMove', duration: 400, x, y: endY },
          { type: 'pointerUp', button: 0 }
        ]
      }
    ]);
    await driver.releaseActions();
  }
}

export async function getAdapter(
  platform: string,
  serverUrl = DEFAULT_SERVER_URL,
  device?: string,
  appId?: string,
  attachToRunning = false
): Promise<PlatformAdapter> {
  const normalized = platform.toLowerCase() as Platform;
  return RealAppiumAdapter.create(normalized, serverUrl, device, appId, attachToRunning);
}
