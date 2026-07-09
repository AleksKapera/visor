import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

import {
  ACCESSIBILITY_ID,
  ANDROID_UIAUTOMATOR,
  formatDriverCreationError,
  parseTarget,
  RealAppiumAdapter,
  resolveWebdriverConnectionTimeout,
  resolveTapMode,
  XPATH
} from '../src/adapters.js';

const webdriverMock = vi.hoisted(() => ({
  remote: vi.fn()
}));

vi.mock('webdriverio', () => webdriverMock);

function createFakeDriver() {
  return {
    execute: vi.fn(),
    performActions: vi.fn(),
    releaseActions: vi.fn(),
    deleteSession: vi.fn(),
    getWindowSize: vi.fn().mockResolvedValue({ width: 200, height: 400 }),
    $: vi.fn(),
    $$: vi.fn()
  };
}

beforeEach(() => {
  webdriverMock.remote.mockReset();
});

describe('adapter selector helpers', () => {
  it('uses accessibility id for plain selector', () => {
    const [by, value] = parseTarget('Increment');
    expect(by).toBe(ACCESSIBILITY_ID);
    expect(value).toBe('Increment');
  });

  it('uses exact xpath matches for text selectors', () => {
    const [by, value] = parseTarget('text=1');
    expect(by).toBe(XPATH);
    expect(value).toContain("@text = '1'");
    expect(value).toContain("@content-desc = '1'");
    expect(value).not.toContain('contains(');
  });

  it('uses contains-style xpath matches for text-contains selectors', () => {
    const [by, value] = parseTarget('text~=Starter');
    expect(by).toBe(XPATH);
    expect(value).toContain("contains(@text, 'Starter')");
    expect(value).toContain("contains(@content-desc, 'Starter')");
  });

  it('supports android uiautomator selectors', () => {
    const [by, value] = parseTarget('uiautomator=new UiSelector().text("OK")');
    expect(by).toBe(ANDROID_UIAUTOMATOR);
    expect(value).toContain('text("OK")');
  });

  it('keeps selector values after additional equals signs intact', () => {
    const [by, value] = parseTarget("xpath=//XCUIElementTypeKey[@name='1']");
    expect(by).toBe(XPATH);
    expect(value).toBe("//XCUIElementTypeKey[@name='1']");
  });

  it('requires complete coordinates for tap mode', () => {
    expect(() => resolveTapMode({ x: 10 })).toThrowError(
      'tap coordinate mode requires both x and y'
    );
  });

  it('rejects mixed target and coordinates', () => {
    expect(() => resolveTapMode({ target: 'foo', x: 1, y: 2 })).toThrowError(
      'tap cannot mix target with x/y coordinates'
    );
  });

  it('adds an iOS-specific bundle id hint for unknown apps', () => {
    const message = formatDriverCreationError(
      'ios',
      'com.example.empty_app',
      true,
      new Error("WebDriverError: App with bundle identifier 'com.example.empty_app' unknown")
    );

    expect(message).toContain('exact installed bundle identifier');
    expect(message).toContain('Android package names do not carry over automatically');
    expect(message).toContain('launch that app on the simulator/device first');
  });

  it('adds an iOS simulator service hint for simctl failures', () => {
    const message = formatDriverCreationError(
      'ios',
      'com.example.emptyApp',
      true,
      new Error('WebDriverError: Error running list: Unable to lookup com.apple.CoreSimulator.CoreSimulatorService')
    );

    expect(message).toContain('xcrun simctl list');
    expect(message).toContain('sandboxed process');
  });

  it('allows slower first-time WebDriverAgent startup on iOS', () => {
    const previous = process.env.VISOR_WEBDRIVER_CONNECTION_TIMEOUT_MS;
    delete process.env.VISOR_WEBDRIVER_CONNECTION_TIMEOUT_MS;

    try {
      expect(resolveWebdriverConnectionTimeout('android')).toBe(60000);
      expect(resolveWebdriverConnectionTimeout('ios')).toBe(240000);

      process.env.VISOR_WEBDRIVER_CONNECTION_TIMEOUT_MS = '120000';
      expect(resolveWebdriverConnectionTimeout('ios')).toBe(120000);
    } finally {
      if (previous === undefined) {
        delete process.env.VISOR_WEBDRIVER_CONNECTION_TIMEOUT_MS;
      } else {
        process.env.VISOR_WEBDRIVER_CONNECTION_TIMEOUT_MS = previous;
      }
    }
  });

  it('passes iOS coordinate tap arguments as the Appium execute object', async () => {
    const driver = createFakeDriver();
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    await adapter.tap({ x: 10, y: 20 });

    expect(driver.execute).toHaveBeenCalledWith('mobile: tap', { x: 10, y: 20 });
    await adapter.close();
  });

  it('taps the center point of target elements on iOS', async () => {
    const driver = createFakeDriver();
    const element = {
      click: vi.fn(),
      getRect: vi.fn().mockResolvedValue({ x: 40, y: 100, width: 80, height: 30 })
    };
    driver.$.mockResolvedValue(element);
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    const result = await adapter.tap({ target: 'Starter' });

    expect(driver.execute).toHaveBeenCalledWith('mobile: tap', { x: 80, y: 115 });
    expect(element.click).not.toHaveBeenCalled();
    expect(result.args).toMatchObject({
      target: 'Starter',
      tap_method: 'coordinate',
      x: 80,
      y: 115
    });
    await adapter.close();
  });

  it('reports element tap fallback when target rectangle lookup fails', async () => {
    const driver = createFakeDriver();
    const element = {
      click: vi.fn(),
      getRect: vi.fn().mockRejectedValue(new Error('rect unavailable'))
    };
    driver.$.mockResolvedValue(element);
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'android',
      'http://127.0.0.1:4723',
      'emulator-5554',
      'com.example.app'
    );

    const result = await adapter.tap({ target: 'Starter' });

    expect(driver.execute).not.toHaveBeenCalled();
    expect(element.click).toHaveBeenCalled();
    expect(result.args).toMatchObject({
      target: 'Starter',
      tap_method: 'element'
    });
    await adapter.close();
  });

  it('passes Android coordinate tap arguments as the Appium execute object', async () => {
    const driver = createFakeDriver();
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'android',
      'http://127.0.0.1:4723',
      'emulator-5554',
      'com.example.app'
    );

    await adapter.tap({ x: 0.25, y: 0.5, normalized: true });

    expect(driver.execute).toHaveBeenCalledWith('mobile: clickGesture', { x: 50, y: 200 });
    await adapter.close();
  });

  it('waits for a selector by polling until it appears', async () => {
    const driver = createFakeDriver();
    driver.$$.mockResolvedValueOnce([]).mockResolvedValueOnce([{}]);
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'android',
      'http://127.0.0.1:4723',
      'emulator-5554',
      'com.example.app'
    );

    const result = await adapter.wait({ for: 'Ready', timeout: 50, interval: 1 });

    expect(driver.$$).toHaveBeenCalledWith('~Ready');
    expect(driver.$$).toHaveBeenCalledTimes(2);
    expect(result.args).toMatchObject({
      for: 'Ready',
      timeout_ms: 50,
      matched: true
    });
    expect(result.args.elapsed_ms).toEqual(expect.any(Number));
    await adapter.close();
  });

  it('reports unmatched selector waits after the timeout expires', async () => {
    const driver = createFakeDriver();
    driver.$$.mockResolvedValue([]);
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'android',
      'http://127.0.0.1:4723',
      'emulator-5554',
      'com.example.app'
    );

    const result = await adapter.wait({ for: 'Ready', timeout: 0 });

    expect(driver.$$).toHaveBeenCalledWith('~Ready');
    expect(result.args).toMatchObject({
      for: 'Ready',
      timeout_ms: 0,
      matched: false
    });
    expect(result.args.elapsed_ms).toEqual(expect.any(Number));
    await adapter.close();
  });

  it('waits for stable source captures', async () => {
    const driver = createFakeDriver();
    (driver as any).getPageSource = vi.fn()
      .mockResolvedValueOnce('<App><Text>Loading</Text></App>')
      .mockResolvedValueOnce('<App><Text>Ready</Text></App>')
      .mockResolvedValueOnce('<App><Text>Ready</Text></App>');
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'android',
      'http://127.0.0.1:4723',
      'emulator-5554',
      'com.example.app'
    );

    const result = await adapter.wait({ stable: true, timeout: 50, interval: 1 });

    expect((driver as any).getPageSource).toHaveBeenCalledTimes(3);
    expect(result.args).toMatchObject({
      stable: true,
      timeout_ms: 50,
      poll_interval_ms: 1,
      matched: true
    });
    await adapter.close();
  });

  it('reports unstable source waits after timeout', async () => {
    const driver = createFakeDriver();
    let count = 0;
    (driver as any).getPageSource = vi.fn().mockImplementation(async () => `<App><Text>${++count}</Text></App>`);
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'android',
      'http://127.0.0.1:4723',
      'emulator-5554',
      'com.example.app'
    );

    const result = await adapter.wait({ stable: true, timeout: 0 });

    expect(result.args).toMatchObject({
      stable: true,
      timeout_ms: 0,
      matched: false
    });
    await adapter.close();
  });

  it('accepts settle timing before screenshots', async () => {
    const driver = createFakeDriver();
    (driver as any).saveScreenshot = vi.fn();
    webdriverMock.remote.mockResolvedValue(driver);
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-adapter-'));
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    try {
      const filePath = path.join(outputDir, 'settled.png');
      const result = await adapter.screenshot({ label: 'settled', path: filePath, settleMs: 1 });

      expect((driver as any).saveScreenshot).toHaveBeenCalledWith(filePath);
      expect(result.args).toMatchObject({
        label: 'settled',
        path: filePath,
        settle_ms: 1
      });
    } finally {
      await adapter.close();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('accepts settle timing before source capture', async () => {
    const driver = createFakeDriver();
    (driver as any).getPageSource = vi.fn().mockResolvedValue('<hierarchy />');
    webdriverMock.remote.mockResolvedValue(driver);
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-adapter-'));
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    try {
      const filePath = path.join(outputDir, 'settled.xml');
      const result = await adapter.source({ label: 'settled', path: filePath, settle_ms: 1 });

      expect((driver as any).getPageSource).toHaveBeenCalled();
      expect(fs.readFileSync(filePath, 'utf8')).toBe('<hierarchy />');
      expect(result.args).toMatchObject({
        label: 'settled',
        path: filePath,
        settle_ms: 1
      });
    } finally {
      await adapter.close();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('performs drag act gestures with normalized coordinates', async () => {
    const driver = createFakeDriver();
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    await adapter.act({
      name: 'drag',
      startX: 0.25,
      startY: 0.75,
      endX: 0.75,
      endY: 0.25,
      normalized: true
    });

    expect(driver.performActions).toHaveBeenCalledWith([
      expect.objectContaining({
        actions: expect.arrayContaining([
          { type: 'pointerMove', duration: 0, x: 50, y: 300 },
          { type: 'pointerMove', duration: 400, x: 150, y: 100 }
        ])
      })
    ]);
    expect(driver.releaseActions).toHaveBeenCalled();
    await adapter.close();
  });

  it('types into the active element when act type omits a target', async () => {
    const driver = createFakeDriver();
    const activeElement = {
      addValue: vi.fn()
    };
    (driver as any).getActiveElement = vi.fn().mockResolvedValue(activeElement);
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    const result = await adapter.act({ name: 'type', value: 'hello' });

    expect((driver as any).getActiveElement).toHaveBeenCalled();
    expect(activeElement.addValue).toHaveBeenCalledWith('hello');
    expect(driver.$).not.toHaveBeenCalled();
    expect(result.args).toEqual({ name: 'type', value: 'hello' });
    await adapter.close();
  });

  it('falls back to mobile type when focused type cannot resolve an active element', async () => {
    const driver = createFakeDriver();
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    const result = await adapter.act({ name: 'type', value: 'aapl' });

    expect(driver.execute).toHaveBeenCalledWith('mobile: type', { text: 'aapl' });
    expect(result.args).toEqual({ name: 'type', value: 'aapl' });
    await adapter.close();
  });

  it('types into the first visible text input when active element is unavailable', async () => {
    const driver = createFakeDriver();
    const input = {
      addValue: vi.fn()
    };
    driver.$.mockResolvedValue(input);
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    const result = await adapter.act({ name: 'type', value: 'aapl' });

    expect(driver.$).toHaveBeenCalledWith(
      expect.stringContaining('XCUIElementTypeTextField')
    );
    expect(input.addValue).toHaveBeenCalledWith('aapl');
    expect(driver.execute).not.toHaveBeenCalledWith('mobile: type', expect.any(Object));
    expect(result.args).toEqual({ name: 'type', value: 'aapl' });
    await adapter.close();
  });

  it('types into the first visible text input when active element lookup rejects', async () => {
    const driver = createFakeDriver();
    const input = {
      addValue: vi.fn()
    };
    (driver as any).getActiveElement = vi.fn().mockRejectedValue(new Error('active lookup failed'));
    driver.$.mockResolvedValue(input);
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    const result = await adapter.act({ name: 'type', value: 'aapl' });

    expect((driver as any).getActiveElement).toHaveBeenCalled();
    expect(input.addValue).toHaveBeenCalledWith('aapl');
    expect(driver.execute).not.toHaveBeenCalledWith('mobile: type', expect.any(Object));
    expect(result.args).toEqual({ name: 'type', value: 'aapl' });
    await adapter.close();
  });

  it('falls back to driver keys when mobile type is unavailable', async () => {
    const driver = createFakeDriver();
    driver.$.mockResolvedValue(null);
    driver.execute.mockRejectedValue(new Error('mobile type unsupported'));
    (driver as any).keys = vi.fn();
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    const result = await adapter.act({ name: 'type', value: 'aapl' });

    expect(driver.execute).toHaveBeenCalledWith('mobile: type', { text: 'aapl' });
    expect((driver as any).keys).toHaveBeenCalledWith('aapl');
    expect(result.args).toEqual({ name: 'type', value: 'aapl' });
    await adapter.close();
  });

  it('fails focused type when neither active element nor driver keys is available', async () => {
    const driver = createFakeDriver();
    driver.$.mockResolvedValue(null);
    driver.execute.mockRejectedValue(new Error('mobile type unsupported'));
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    await expect(adapter.act({ name: 'type', value: 'aapl' })).rejects.toThrow(
      'act type without target requires an active element or driver keys support'
    );
    await adapter.close();
  });

  it('keeps target typing on the selected element', async () => {
    const driver = createFakeDriver();
    const element = {
      clearValue: vi.fn(),
      addValue: vi.fn()
    };
    driver.$.mockResolvedValue(element);
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    const result = await adapter.act({ name: 'type', target: 'Username', value: 'ada' });

    expect(driver.$).toHaveBeenCalledWith('~Username');
    expect(element.clearValue).toHaveBeenCalled();
    expect(element.addValue).toHaveBeenCalledWith('ada');
    expect(result.args).toEqual({ name: 'type', target: 'Username', value: 'ada' });
    await adapter.close();
  });

  it('performs slider act gestures across the target element', async () => {
    const driver = createFakeDriver();
    const element = {
      getRect: vi.fn().mockResolvedValue({ x: 10, y: 100, width: 100, height: 20 })
    };
    driver.$.mockResolvedValue(element);
    webdriverMock.remote.mockResolvedValue(driver);
    const adapter = await RealAppiumAdapter.create(
      'ios',
      'http://127.0.0.1:4723',
      'simulator-udid',
      'com.example.app'
    );

    await adapter.act({
      name: 'slider',
      target: 'Volume',
      startValue: 0.2,
      value: 0.8
    });

    expect(driver.$).toHaveBeenCalledWith('~Volume');
    expect(driver.performActions).toHaveBeenCalledWith([
      expect.objectContaining({
        actions: expect.arrayContaining([
          { type: 'pointerMove', duration: 0, x: 30, y: 110 },
          { type: 'pointerMove', duration: 400, x: 90, y: 110 }
        ])
      })
    ]);
    await adapter.close();
  });
});
