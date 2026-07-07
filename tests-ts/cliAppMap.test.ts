import { vi } from 'vitest';

import { resetDeviceCommandRunner, setDeviceCommandRunner } from '../src/devices.js';

const daemonMock = vi.hoisted(() => {
  class DaemonOperationError extends Error {
    constructor(
      message: string,
      readonly data?: Record<string, unknown>
    ) {
      super(message);
    }
  }
  class DaemonUnavailableError extends Error {}
  class DaemonRequestTimeoutError extends Error {}

  return {
    DaemonOperationError,
    DaemonUnavailableError,
    DaemonRequestTimeoutError,
    runDaemonAction: vi.fn(),
    runDaemonDiscover: vi.fn(),
    runDaemonScenario: vi.fn(),
    startVisorDaemon: vi.fn(),
    statusVisorDaemon: vi.fn(),
    stopVisorDaemon: vi.fn()
  };
});

vi.mock('../src/daemon.js', () => daemonMock);

const { executeCommand } = await import('../src/cli.js');

function detectAndroidDevice(): void {
  setDeviceCommandRunner(async (command) => {
    if (command === 'adb') {
      return 'List of devices attached\nemulator-5554\tdevice\n';
    }
    return '';
  });
}

describe('cli app map options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectAndroidDevice();
  });

  afterEach(() => {
    resetDeviceCommandRunner();
  });

  it('enables mapped execution for direct actions by default and returns map metadata', async () => {
    daemonMock.runDaemonAction.mockResolvedValue({
      action: 'tap',
      args: { target: 'Advanced' },
      map: {
        enabled: true,
        used: true,
        updated: true,
        repaired: false,
        repairs: 0,
        path: '/tmp/visor-map.json'
      }
    });

    const result = await executeCommand([
      'tap',
      '--device',
      'emulator-5554',
      '--app-id',
      'com.example.settings',
      '--target',
      'Advanced'
    ]);

    expect(result.code).toBe(0);
    expect(result.response.data.map).toMatchObject({
      enabled: true,
      used: true,
      updated: true,
      repaired: false
    });
    expect(daemonMock.runDaemonAction).toHaveBeenCalledWith(
      {
        platform: 'android',
        server_url: 'http://127.0.0.1:4723',
        device: 'emulator-5554',
        app_id: 'com.example.settings',
        attach_to_running: false
      },
      'tap',
      { target: 'Advanced' },
      {
        enabled: true,
        appId: 'com.example.settings'
      }
    );
  });

  it('passes no-map through direct actions', async () => {
    daemonMock.runDaemonAction.mockResolvedValue({
      action: 'tap',
      args: { target: 'Advanced' },
      map: {
        enabled: false,
        used: false,
        updated: false,
        repaired: false,
        repairs: 0
      }
    });

    const result = await executeCommand([
      'tap',
      '--device',
      'emulator-5554',
      '--app-id',
      'com.example.settings',
      '--target',
      'Advanced',
      '--no-map'
    ]);

    expect(result.code).toBe(0);
    expect(result.response.data.map).toMatchObject({
      enabled: false,
      used: false,
      updated: false
    });
    expect(daemonMock.runDaemonAction).toHaveBeenCalledWith(
      expect.any(Object),
      'tap',
      { target: 'Advanced' },
      {
        enabled: false,
        appId: 'com.example.settings'
      }
    );
  });

  it('passes repair opt-in through direct actions', async () => {
    daemonMock.runDaemonAction.mockResolvedValue({
      action: 'tap',
      args: { target: 'Advanced' },
      map: {
        enabled: true,
        used: false,
        updated: false,
        repaired: false,
        repairs: 0
      }
    });

    const result = await executeCommand([
      'tap',
      '--device',
      'emulator-5554',
      '--app-id',
      'com.example.settings',
      '--target',
      'Advanced',
      '--repair'
    ]);

    expect(result.code).toBe(0);
    expect(daemonMock.runDaemonAction).toHaveBeenCalledWith(
      expect.any(Object),
      'tap',
      { target: 'Advanced' },
      {
        enabled: true,
        appId: 'com.example.settings',
        repair: true
      }
    );
  });

  it('keeps disabled map metadata on no-map direct action failures', async () => {
    daemonMock.runDaemonAction.mockRejectedValue(
      new daemonMock.DaemonOperationError('target not visible on home: Advanced', {
        map: {
          enabled: false,
          used: false,
          updated: false,
          repaired: false,
          repairs: 0
        }
      })
    );

    const result = await executeCommand([
      'tap',
      '--device',
      'emulator-5554',
      '--app-id',
      'com.example.settings',
      '--target',
      'Advanced',
      '--no-map'
    ]);

    expect(result.code).toBe(1);
    expect(result.response.status).toBe('fail');
    expect(result.response.data.map).toMatchObject({
      enabled: false,
      used: false,
      updated: false
    });
  });

  it('keeps map metadata on mapped direct action failures', async () => {
    daemonMock.runDaemonAction.mockRejectedValue(
      new daemonMock.DaemonOperationError('Target text=Save is ambiguous in the app map', {
        map: {
          enabled: true,
          used: false,
          updated: true,
          repaired: false,
          repairs: 0
        }
      })
    );

    const result = await executeCommand([
      'tap',
      '--device',
      'emulator-5554',
      '--app-id',
      'com.example.settings',
      '--target',
      'text=Save'
    ]);

    expect(result.code).toBe(1);
    expect(result.response.status).toBe('fail');
    expect(result.response.data.map).toMatchObject({
      enabled: true,
      updated: true
    });
  });

  it('exposes explicit discovery as a map-updating command', async () => {
    daemonMock.runDaemonDiscover.mockResolvedValue({
      action: 'discover',
      map: {
        enabled: true,
        used: false,
        updated: true,
        repaired: false,
        repairs: 0
      },
      screen: {
        variant_id: 'variant_1',
        element_count: 3
      }
    });

    const result = await executeCommand([
      'discover',
      '--device',
      'emulator-5554',
      '--app-id',
      'com.example.settings'
    ]);

    expect(result.code).toBe(0);
    expect(result.response.data).toMatchObject({
      action: 'discover',
      map: {
        enabled: true,
        updated: true
      },
      screen: {
        variant_id: 'variant_1'
      }
    });
    expect(daemonMock.runDaemonDiscover).toHaveBeenCalledWith(
      {
        platform: 'android',
        server_url: 'http://127.0.0.1:4723',
        device: 'emulator-5554',
        app_id: 'com.example.settings',
        attach_to_running: false
      },
      {
        enabled: true,
        appId: 'com.example.settings'
      }
    );
  });

  it('passes crawl discovery options through discover', async () => {
    daemonMock.runDaemonDiscover.mockResolvedValue({
      action: 'discover',
      map: {
        enabled: true,
        used: false,
        updated: true,
        repaired: false,
        repairs: 0
      },
      crawl: {
        enabled: true,
        actions: 4
      },
      screen: {
        variant_id: 'variant_1'
      }
    });

    const result = await executeCommand([
      'discover',
      '--device',
      'emulator-5554',
      '--app-id',
      'com.example.settings',
      '--crawl',
      '--crawl-depth',
      '3',
      '--crawl-limit',
      '10'
    ]);

    expect(result.code).toBe(0);
    expect(result.response.data).toMatchObject({
      crawl: {
        enabled: true,
        actions: 4
      }
    });
    expect(daemonMock.runDaemonDiscover).toHaveBeenCalledWith(
      expect.any(Object),
      {
        enabled: true,
        appId: 'com.example.settings',
        crawl: true,
        crawlDepth: 3,
        crawlLimit: 10
      }
    );
  });
});
