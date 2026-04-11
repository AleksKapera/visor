import { isRecoverableSessionCacheError } from '../src/daemon.js';

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

  it('does not treat regular action failures as recoverable cache misses', () => {
    expect(isRecoverableSessionCacheError(new Error('tap target was not found'))).toBe(false);
  });
});
