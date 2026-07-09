import fs from 'node:fs';
import path from 'node:path';

import type { remote as remoteFn } from 'webdriverio';

import type { AdapterCapability, Platform, PlatformAdapter } from './types.js';
import { errorMessage, parseServerUrl, sleep } from './utils.js';

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:4723';
export const DEFAULT_ANDROID_APP = 'com.example.app';
export const DEFAULT_IOS_BUNDLE = 'com.example.app';

export const ACCESSIBILITY_ID = 'accessibility id';
export const XPATH = 'xpath';
export const ELEMENT_ID = 'id';
export const ANDROID_UIAUTOMATOR = '-android uiautomator';
export const IOS_PREDICATE = '-ios predicate string';
export const IOS_CLASS_CHAIN = '-ios class chain';

type TapMode = 'target' | 'coordinates';
type ElementTapResult = { tap_method: 'coordinate'; x: number; y: number } | { tap_method: 'element' };
type ScrollDirection = 'up' | 'down';
type RemoteSession = Awaited<ReturnType<typeof remoteFn>>;
type Point = { x: number; y: number };

const TEXT_ATTRIBUTES = ['text', 'content-desc', 'label', 'name', 'value'];

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

function validateRect(rect: unknown): { x: number; y: number; width: number; height: number } {
  const candidate = rect && typeof rect === 'object' && !Array.isArray(rect)
    ? (rect as Record<string, unknown>)
    : {};
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const width = Number(candidate.width);
  const height = Number(candidate.height);

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('Element rectangle is invalid');
  }

  return { x, y, width, height };
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes('"')) {
    return `"${value}"`;
  }

  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(', "\"\'\"", ')})`;
}

function textXPath(value: string, mode: 'exact' | 'contains'): string {
  const literal = xpathLiteral(value);
  const clauses = TEXT_ATTRIBUTES.map((attribute) =>
    mode === 'exact'
      ? `@${attribute} = ${literal}`
      : `contains(@${attribute}, ${literal})`
  );
  return `//*[${clauses.join(' or ')}]`;
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
  const valueAfterPrefix = () => target.slice(target.indexOf('=') + 1);

  if (target.startsWith('text~=')) {
    return [XPATH, textXPath(valueAfterPrefix(), 'contains')];
  }

  if (target.startsWith('text=')) {
    return [XPATH, textXPath(valueAfterPrefix(), 'exact')];
  }

  if (target.startsWith('id=')) {
    return [ELEMENT_ID, valueAfterPrefix()];
  }

  if (target.startsWith('xpath=')) {
    return [XPATH, valueAfterPrefix()];
  }

  if (target.startsWith('uiautomator=')) {
    return [ANDROID_UIAUTOMATOR, valueAfterPrefix()];
  }

  if (target.startsWith('predicate=')) {
    return [IOS_PREDICATE, valueAfterPrefix()];
  }

  if (target.startsWith('classchain=')) {
    return [IOS_CLASS_CHAIN, valueAfterPrefix()];
  }

  if (target.startsWith('accessibility=')) {
    return [ACCESSIBILITY_ID, valueAfterPrefix()];
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
    const tapResult = await this.tapElementCenter(element);
    return {
      action: 'tap',
      platform: this.platform,
      args: { target, ...tapResult }
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

    if (name === 'type') {
      await this.typeIntoFocusedElement(value);
      return {
        action: 'act',
        platform: this.platform,
        args: { name, value }
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

    if (name === 'drag') {
      const gesture = await this.resolveDragGesture(args);
      await this.dragPointer(gesture.start, gesture.end);
      return {
        action: 'act',
        platform: this.platform,
        args: {
          name,
          startX: gesture.start.x,
          startY: gesture.start.y,
          endX: gesture.end.x,
          endY: gesture.end.y
        }
      };
    }

    if (name === 'slider') {
      const gesture = await this.resolveSliderGesture(args);
      await this.dragPointer(gesture.start, gesture.end);
      return {
        action: 'act',
        platform: this.platform,
        args: {
          name,
          target,
          value: gesture.value,
          startValue: gesture.startValue
        }
      };
    }

    if (name === 'home') {
      await this.pressHome();
      return {
        action: 'act',
        platform: this.platform,
        args: { name }
      };
    }

    if (name === 'reset') {
      await this.resetApp();
      return {
        action: 'act',
        platform: this.platform,
        args: { name, app_id: this.appId }
      };
    }

    throw new Error(
      'Unsupported act operation; use --name type [--target <selector>] --value <text>, --name drag, --name slider, --name back, --name home, or --name reset'
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
    const settleMs = await this.settleBeforeCapture(args);
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
        height,
        ...(settleMs > 0 ? { settle_ms: settleMs } : {})
      }
    };
  }

  async wait(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (args.stable === true) {
      const waitResult = await this.waitForStableSource(args);
      return {
        action: 'wait',
        platform: this.platform,
        args: waitResult
      };
    }

    if (typeof args.for === 'string' && args.for) {
      const waitResult = await this.waitForTarget(args.for, args);
      return {
        action: 'wait',
        platform: this.platform,
        args: waitResult
      };
    }

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
    const settleMs = await this.settleBeforeCapture(args);
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
        bytes: fs.statSync(filePath).size,
        ...(settleMs > 0 ? { settle_ms: settleMs } : {})
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

    if (!this.device) {
      throw new Error('A running device must be selected before creating an Appium session.');
    }

    if (this.platform === 'android') {
      capabilities.platformName = 'Android';
      capabilities['appium:automationName'] = 'UiAutomator2';
      capabilities['appium:udid'] = this.device;
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
      capabilities['appium:udid'] = this.device;
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
      await driver.execute('mobile: clickGesture', { x, y });
      return;
    }

    if (this.platform === 'ios') {
      await driver.execute('mobile: tap', { x, y });
      return;
    }

    throw new Error(`Coordinate tap is unsupported for platform: ${this.platform}`);
  }

  private async tapElementCenter(element: any): Promise<ElementTapResult> {
    try {
      const rect = await this.elementRect(element);
      const x = Math.round(rect.x + rect.width / 2);
      const y = Math.round(rect.y + rect.height / 2);
      await this.tapPoint(x, y);
      return { tap_method: 'coordinate', x, y };
    } catch {
      await element.click();
      return { tap_method: 'element' };
    }
  }

  private async elementRect(element: any): Promise<{ x: number; y: number; width: number; height: number }> {
    if (typeof element.getRect === 'function') {
      const rect = await element.getRect();
      return validateRect(rect);
    }

    if (typeof element.getLocation === 'function' && typeof element.getSize === 'function') {
      const location = await element.getLocation();
      const size = await element.getSize();
      return validateRect({
        x: location.x,
        y: location.y,
        width: size.width,
        height: size.height
      });
    }

    throw new Error('Element rectangle is unavailable');
  }

  private async waitForTarget(
    target: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const timeoutMs = nonNegativeMs(
      args.timeout ?? args.timeoutMs ?? args['timeout-ms'] ?? args.ms,
      5000,
      'wait for requires a non-negative timeout'
    );
    const intervalMs = nonNegativeMs(
      args.interval ?? args.pollMs ?? args['poll-ms'],
      250,
      'wait for requires a non-negative poll interval'
    );
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let matched = await this.exists(target);

    while (!matched && Date.now() < deadline) {
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
      matched = await this.exists(target);
    }

    return {
      for: target,
      timeout_ms: timeoutMs,
      poll_interval_ms: intervalMs,
      matched,
      elapsed_ms: Date.now() - startedAt
    };
  }

  private async waitForStableSource(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const timeoutMs = nonNegativeMs(
      args.timeout ?? args.timeoutMs ?? args['timeout-ms'] ?? args.ms,
      5000,
      'wait stable requires a non-negative timeout'
    );
    const intervalMs = nonNegativeMs(
      args.interval ?? args.pollMs ?? args['poll-ms'],
      250,
      'wait stable requires a non-negative poll interval'
    );
    const driver = this.requireDriver() as any;
    if (typeof driver.getPageSource !== 'function') {
      throw new Error('wait stable requires driver getPageSource support');
    }

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let previous = String(await driver.getPageSource());
    let matched = false;

    while (Date.now() < deadline) {
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
      const next = String(await driver.getPageSource());
      if (next === previous) {
        matched = true;
        previous = next;
        break;
      }
      previous = next;
    }

    return {
      stable: true,
      timeout_ms: timeoutMs,
      poll_interval_ms: intervalMs,
      matched,
      elapsed_ms: Date.now() - startedAt
    };
  }

  private async settleBeforeCapture(args: Record<string, unknown>): Promise<number> {
    const raw = args.settleMs ?? args.settle_ms ?? args['settle-ms'] ?? args.settle;
    if (raw === undefined || raw === null || raw === false) {
      return 0;
    }

    const settleMs = raw === true
      ? 250
      : nonNegativeMs(raw, 0, 'capture settle requires non-negative ms');
    if (settleMs > 0) {
      await sleep(settleMs);
    }

    return settleMs;
  }

  private async typeIntoFocusedElement(value: string): Promise<void> {
    const driver = this.requireDriver() as any;
    let element: any | null = null;
    try {
      element =
        typeof driver.getActiveElement === 'function'
          ? await driver.getActiveElement()
          : typeof driver.activeElement === 'function'
            ? await driver.activeElement()
            : null;
    } catch {
      element = null;
    }

    if (element && typeof element.addValue === 'function') {
      await element.addValue(value);
      return;
    }

    const visibleInput = await this.visibleTextInputElement();
    if (visibleInput && typeof visibleInput.addValue === 'function') {
      try {
        await visibleInput.addValue(value);
        return;
      } catch {
        // Fall through to lower-level input if the visible field rejected addValue.
      }
    }

    if (typeof driver.execute === 'function') {
      try {
        await driver.execute('mobile: type', { text: value });
        return;
      } catch {
        // Fall through to generic key input if Appium does not expose mobile typing.
      }
    }

    if (typeof driver.keys === 'function') {
      await driver.keys(value);
      return;
    }

    throw new Error('act type without target requires an active element or driver keys support');
  }

  private async visibleTextInputElement(): Promise<any | null> {
    const selector = this.platform === 'ios'
      ? "//*[(@type='XCUIElementTypeTextField' or @type='XCUIElementTypeSearchField' or @type='XCUIElementTypeSecureTextField') and @visible='true'][1]"
      : "//*[contains(@class, 'EditText') and @displayed='true'][1]";

    try {
      const element = await this.requireDriver().$(selector);
      return element ?? null;
    } catch {
      return null;
    }
  }

  private async pressHome(): Promise<void> {
    const driver = this.requireDriver() as any;
    if (this.platform === 'ios') {
      await driver.execute('mobile: pressButton', { name: 'home' });
      return;
    }

    if (typeof driver.pressKeyCode === 'function') {
      await driver.pressKeyCode(3);
      return;
    }

    await driver.execute('mobile: pressKey', { keycode: 3 });
  }

  private async resetApp(): Promise<void> {
    if (!this.appId) {
      throw new Error('act reset requires --app-id so Visor can restart the target app');
    }

    const driver = this.requireDriver() as any;
    if (typeof driver.terminateApp === 'function') {
      await driver.terminateApp(this.appId);
    } else {
      await driver.execute(
        'mobile: terminateApp',
        this.platform === 'ios' ? { bundleId: this.appId } : { appId: this.appId }
      );
    }

    await sleep(500);

    if (typeof driver.activateApp === 'function') {
      await driver.activateApp(this.appId);
      return;
    }

    await driver.execute(
      'mobile: activateApp',
      this.platform === 'ios' ? { bundleId: this.appId } : { appId: this.appId }
    );
  }

  private async resolveDragGesture(args: Record<string, unknown>): Promise<{ start: Point; end: Point }> {
    const normalized = Boolean(args.normalized);
    const size = normalized ? await (this.requireDriver() as any).getWindowSize() : null;
    const start = {
      x: gestureNumber(args, ['startX', 'start-x', 'fromX', 'from-x'], 'act drag requires startX/startY and endX/endY'),
      y: gestureNumber(args, ['startY', 'start-y', 'fromY', 'from-y'], 'act drag requires startX/startY and endX/endY')
    };
    const end = {
      x: gestureNumber(args, ['endX', 'end-x', 'toX', 'to-x'], 'act drag requires startX/startY and endX/endY'),
      y: gestureNumber(args, ['endY', 'end-y', 'toY', 'to-y'], 'act drag requires startX/startY and endX/endY')
    };

    return {
      start: normalized && size ? scalePoint(start, size.width, size.height) : roundPoint(start),
      end: normalized && size ? scalePoint(end, size.width, size.height) : roundPoint(end)
    };
  }

  private async resolveSliderGesture(
    args: Record<string, unknown>
  ): Promise<{ start: Point; end: Point; value: number; startValue: number }> {
    const target = typeof args.target === 'string' ? args.target : '';
    if (!target) {
      throw new Error('act slider requires args.target');
    }

    const value = unitIntervalNumber(args.value, 'act slider args.value must be a number between 0 and 1');
    const startValue = unitIntervalNumber(
      args.startValue ?? args['start-value'] ?? 0.5,
      'act slider args.startValue must be a number between 0 and 1'
    );
    const selector = selectorForTarget(target);
    const element = await this.requireDriver().$(selector.selector);
    const rect = await this.elementRect(element);
    const y = Math.round(rect.y + rect.height / 2);

    return {
      start: { x: Math.round(rect.x + rect.width * startValue), y },
      end: { x: Math.round(rect.x + rect.width * value), y },
      value,
      startValue
    };
  }

  private async scrollViewport(direction: ScrollDirection, gesturePercent: number): Promise<void> {
    const driver = this.requireDriver() as any;
    const size = await driver.getWindowSize();
    const left = Math.max(0, Math.round(size.width * 0.1));
    const top = Math.max(0, Math.round(size.height * 0.1));
    const width = Math.max(1, Math.round(size.width * 0.8));
    const height = Math.max(1, Math.round(size.height * 0.8));

    if (this.platform === 'android') {
      await driver.execute('mobile: scrollGesture', {
        left,
        top,
        width,
        height,
        direction,
        percent: gesturePercent
      });
      return;
    }

    if (this.platform === 'ios') {
      try {
        await driver.execute('mobile: scrollGesture', {
          left,
          top,
          width,
          height,
          direction,
          percent: gesturePercent
        });
        return;
      } catch {
        await this.swipeViewport(direction, gesturePercent, size.width, size.height);
        return;
      }
    }

    throw new Error(`Scroll is unsupported for platform: ${this.platform}`);
  }

  private async dragPointer(start: Point, end: Point): Promise<void> {
    const driver = this.requireDriver() as any;
    await driver.performActions([
      {
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: start.x, y: start.y },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 100 },
          { type: 'pointerMove', duration: 400, x: end.x, y: end.y },
          { type: 'pointerUp', button: 0 }
        ]
      }
    ]);
    await driver.releaseActions();
  }

  private async swipeViewport(
    direction: ScrollDirection,
    gesturePercent: number,
    viewportWidth: number,
    viewportHeight: number
  ): Promise<void> {
    const x = Math.round(viewportWidth / 2);
    const lowY = Math.round(viewportHeight * 0.75);
    const highY = Math.round(viewportHeight * 0.25);
    const travel = Math.max(1, Math.round(viewportHeight * gesturePercent));
    const startY = direction === 'down' ? lowY : highY;
    const unclampedEndY = direction === 'down' ? startY - travel : startY + travel;
    const endY = Math.max(1, Math.min(viewportHeight - 1, unclampedEndY));

    await this.dragPointer({ x, y: startY }, { x, y: endY });
  }
}

function gestureNumber(args: Record<string, unknown>, keys: string[], message: string): number {
  const raw = keys.map((key) => args[key]).find((value) => value !== undefined);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(message);
  }
  return parsed;
}

function unitIntervalNumber(value: unknown, message: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(message);
  }
  return parsed;
}

function nonNegativeMs(value: unknown, defaultValue: number, message: string): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(message);
  }

  return Math.round(parsed);
}

function scalePoint(point: Point, width: number, height: number): Point {
  return {
    x: Math.round(point.x * width),
    y: Math.round(point.y * height)
  };
}

function roundPoint(point: Point): Point {
  return {
    x: Math.round(point.x),
    y: Math.round(point.y)
  };
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
