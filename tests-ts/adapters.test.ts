import {
  ACCESSIBILITY_ID,
  ANDROID_UIAUTOMATOR,
  MockAdapter,
  formatDriverCreationError,
  parseTarget,
  resolveWebdriverConnectionTimeout,
  resolveTapMode,
  XPATH
} from '../src/adapters.js';

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

  it('includes scroll in adapter capabilities', () => {
    const adapter = new MockAdapter('android');

    expect(adapter.capability().commands).toContain('scroll');
  });

  it('defaults scroll percent to 70 in the mock adapter', async () => {
    const adapter = new MockAdapter('android');

    await expect(adapter.scroll({ direction: 'down' })).resolves.toEqual({
      action: 'scroll',
      platform: 'android',
      args: { direction: 'down', percent: 70 }
    });
  });

  it('rejects invalid scroll direction values', async () => {
    const adapter = new MockAdapter('android');

    await expect(adapter.scroll({ direction: 'left' })).rejects.toThrowError(
      "scroll requires args.direction to be 'up' or 'down'"
    );
  });

  it('rejects invalid scroll percent values', async () => {
    const adapter = new MockAdapter('android');

    await expect(adapter.scroll({ direction: 'down', percent: 0 })).rejects.toThrowError(
      'scroll args.percent must be a number between 1 and 100'
    );
  });
});
