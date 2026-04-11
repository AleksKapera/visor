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

  it('treats lost iOS WebDriverAgent proxy targets as recoverable cache misses', () => {
    expect(
      isRecoverableSessionCacheError(
        new Error(
          'WebDriverError: An unknown server-side error occurred while processing the command. Original error: Could not proxy command to the remote server. Original error: connect ECONNREFUSED 127.0.0.1:8100 when running "window/rect" with method "GET"'
        )
      )
    ).toBe(true);
  });

  it('does not treat regular action failures as recoverable cache misses', () => {
    expect(isRecoverableSessionCacheError(new Error('tap target was not found'))).toBe(false);
  });
});
