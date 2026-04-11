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

  it('uses xpath for text selectors', () => {
    const [by, value] = parseTarget('text=1');
    expect(by).toBe(XPATH);
    expect(value).toContain("contains(@text, '1')");
    expect(value).toContain("contains(@content-desc, '1')");
  });

  it('supports android uiautomator selectors', () => {
    const [by, value] = parseTarget('uiautomator=new UiSelector().text("OK")');
    expect(by).toBe(ANDROID_UIAUTOMATOR);
    expect(value).toContain('text("OK")');
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
});
