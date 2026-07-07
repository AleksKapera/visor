import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  it('adds a shareable app-map summary to discover responses without depending on host paths', async () => {
    const mapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-cli-map-summary-'));
    const mapPath = path.join(mapRoot, 'map.json');
    fs.writeFileSync(
      mapPath,
      `${JSON.stringify({
        schema_version: 1,
        identity: 'android:com.example.settings',
        app_id: 'com.example.settings',
        platform: 'android',
        created_at: '2026-07-07T00:00:00.000Z',
        updated_at: '2026-07-07T00:01:00.000Z',
        screens: [
          { id: 'screen_1', variant_ids: ['variant_1'] },
          { id: 'screen_2', variant_ids: ['variant_2'] }
        ],
        variants: [
          {
            id: 'variant_1',
            screen_id: 'screen_1',
            auth_required: false,
            actions: [{ intent: 'like' }, { intent: 'comment' }]
          },
          {
            id: 'variant_2',
            screen_id: 'screen_2',
            auth_required: true,
            actions: [{ intent: 'share' }]
          }
        ],
        edges: [
          { id: 'edge_1', from_variant_id: 'variant_1', to_variant_id: 'variant_2' },
          { id: 'edge_2', from_variant_id: 'variant_2', to_variant_id: 'variant_1' }
        ]
      })}\n`,
      'utf8'
    );
    daemonMock.runDaemonDiscover.mockResolvedValue({
      action: 'discover',
      map: {
        enabled: true,
        used: false,
        updated: true,
        repaired: false,
        repairs: 0,
        schema_version: 1,
        identity: 'android:com.example.settings',
        path: mapPath
      },
      screen: {
        variant_id: 'variant_2',
        screen_id: 'screen_2',
        element_count: 5
      }
    });

    try {
      const result = await executeCommand([
        'discover',
        '--device',
        'emulator-5554',
        '--app-id',
        'com.example.settings'
      ]);

      expect(result.code).toBe(0);
      expect(result.response.data.map).toMatchObject({
        summary: {
          schema_version: 1,
          identity: 'android:com.example.settings',
          app_id: 'com.example.settings',
          platform: 'android',
          screens: 2,
          variants: 2,
          edges: 2,
          actions: 3,
          auth_required_variants: 1,
          updated_at: '2026-07-07T00:01:00.000Z'
        }
      });
      expect(JSON.stringify((result.response.data.map as { summary?: unknown }).summary)).not.toContain(mapPath);
    } finally {
      fs.rmSync(mapRoot, { recursive: true, force: true });
    }
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
