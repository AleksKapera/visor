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

function benchmarkRun(runId: string): Record<string, unknown> {
  return {
    run_id: runId,
    platform: 'android',
    device: 'emulator-5554',
    started_at: new Date(0).toISOString(),
    ended_at: new Date(0).toISOString(),
    status: 'ok',
    steps: [],
    assertions: [],
    artifacts: [],
    determinism_signature: `sig-${runId}`
  };
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

  it('passes drag act coordinates through direct actions', async () => {
    daemonMock.runDaemonAction.mockResolvedValue({
      action: 'act',
      args: {
        name: 'drag',
        startX: 10,
        startY: 200,
        endX: 300,
        endY: 200
      },
      map: {
        enabled: true,
        used: false,
        updated: false,
        repaired: false,
        repairs: 0
      }
    });

    const result = await executeCommand([
      'act',
      '--device',
      'emulator-5554',
      '--app-id',
      'com.example.settings',
      '--name',
      'drag',
      '--start-x',
      '10',
      '--start-y',
      '200',
      '--end-x',
      '300',
      '--end-y',
      '200'
    ]);

    expect(result.code).toBe(0);
    expect(daemonMock.runDaemonAction).toHaveBeenCalledWith(
      expect.any(Object),
      'act',
      {
        name: 'drag',
        startX: 10,
        startY: 200,
        endX: 300,
        endY: 200
      },
      {
        enabled: true,
        appId: 'com.example.settings'
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

  it('passes crawl include and risky opt-in options through discover', async () => {
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
        actions: 1
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
      '--crawl-include',
      'Delete',
      '--crawl-allow-risky'
    ]);

    expect(result.code).toBe(0);
    expect(daemonMock.runDaemonDiscover).toHaveBeenCalledWith(
      expect.any(Object),
      {
        enabled: true,
        appId: 'com.example.settings',
        crawl: true,
        crawlInclude: ['Delete'],
        crawlAllowRisky: true
      }
    );
  });

  it('honors output directories for direct screenshot and source captures', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-direct-captures-'));
    daemonMock.runDaemonAction
      .mockResolvedValueOnce({
        action: 'screenshot',
        args: { label: 'checkout', path: path.join(outputDir, 'checkout.png') }
      })
      .mockResolvedValueOnce({
        action: 'source',
        args: { label: 'tree', path: path.join(outputDir, 'tree.xml') }
      });

    try {
      const screenshot = await executeCommand([
        'screenshot',
        '--device',
        'emulator-5554',
        '--label',
        'checkout',
        '--output',
        outputDir
      ]);
      const source = await executeCommand([
        'source',
        '--device',
        'emulator-5554',
        '--label',
        'tree',
        '--output',
        outputDir
      ]);

      expect(screenshot.code).toBe(0);
      expect(source.code).toBe(0);
      expect(daemonMock.runDaemonAction).toHaveBeenNthCalledWith(
        1,
        expect.any(Object),
        'screenshot',
        { label: 'checkout', path: path.join(outputDir, 'checkout.png') },
        expect.any(Object)
      );
      expect(daemonMock.runDaemonAction).toHaveBeenNthCalledWith(
        2,
        expect.any(Object),
        'source',
        { label: 'tree', path: path.join(outputDir, 'tree.xml') },
        expect.any(Object)
      );
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('passes selector waits through direct wait commands', async () => {
    daemonMock.runDaemonAction.mockResolvedValue({
      action: 'wait',
      args: {
        for: 'text=Ready',
        timeout_ms: 8000,
        poll_interval_ms: 50,
        matched: true
      }
    });

    const result = await executeCommand([
      'wait',
      '--device',
      'emulator-5554',
      '--for',
      'text=Ready',
      '--timeout',
      '8000',
      '--poll-ms',
      '50'
    ]);

    expect(result.code).toBe(0);
    expect(result.response.data.args).toMatchObject({
      for: 'text=Ready',
      matched: true
    });
    expect(daemonMock.runDaemonAction).toHaveBeenCalledWith(
      expect.any(Object),
      'wait',
      { for: 'text=Ready', timeout: 8000, pollMs: 50 },
      expect.any(Object)
    );
  });

  it('passes stable waits through direct wait commands', async () => {
    daemonMock.runDaemonAction.mockResolvedValue({
      action: 'wait',
      args: {
        stable: true,
        timeout_ms: 1000,
        matched: true
      }
    });

    const result = await executeCommand([
      'wait',
      '--device',
      'emulator-5554',
      '--stable',
      '--timeout',
      '1000'
    ]);

    expect(result.code).toBe(0);
    expect(daemonMock.runDaemonAction).toHaveBeenCalledWith(
      expect.any(Object),
      'wait',
      { stable: true, timeout: 1000 },
      expect.any(Object)
    );
  });

  it('fuses direct actions with a post-action wait predicate', async () => {
    daemonMock.runDaemonAction
      .mockResolvedValueOnce({
        action: 'tap',
        args: { target: 'Deposit' },
        observation: { screen_changed: true }
      })
      .mockResolvedValueOnce({
        action: 'wait',
        args: {
          for: 'text=Slide to Confirm',
          timeout_ms: 8000,
          matched: true
        }
      });

    const result = await executeCommand([
      'tap',
      '--device',
      'emulator-5554',
      '--target',
      'Deposit',
      '--wait-for',
      'text=Slide to Confirm',
      '--timeout',
      '8000'
    ]);

    expect(result.code).toBe(0);
    expect(result.response.data).toMatchObject({
      action: 'tap',
      wait: {
        action: 'wait',
        args: {
          for: 'text=Slide to Confirm',
          matched: true
        }
      }
    });
    expect(daemonMock.runDaemonAction).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      'tap',
      { target: 'Deposit' },
      expect.any(Object)
    );
    expect(daemonMock.runDaemonAction).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      'wait',
      { for: 'text=Slide to Confirm', timeout: 8000 },
      expect.any(Object)
    );
  });

  it('records successful direct actions into a named replay flow', async () => {
    const originalCwd = process.cwd();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-record-flow-'));
    daemonMock.runDaemonAction.mockResolvedValue({
      action: 'tap',
      args: { target: 'Deposit', tap_method: 'coordinate', x: 224, y: 686 },
      map: {
        enabled: true,
        used: false,
        updated: true,
        repaired: false,
        repairs: 0
      }
    });

    try {
      process.chdir(workspace);
      const started = await executeCommand(['record', 'deposit']);
      expect(started.code).toBe(0);
      expect(started.response.data).toMatchObject({
        action: 'record',
        name: 'deposit',
        active: true,
        steps: 0
      });

      const tapped = await executeCommand([
        'tap',
        '--device',
        'emulator-5554',
        '--target',
        'Deposit'
      ]);
      expect(tapped.code).toBe(0);

      const stopped = await executeCommand(['record', 'deposit', '--stop']);
      expect(stopped.code).toBe(0);
      expect(stopped.response.data).toMatchObject({
        action: 'record',
        name: 'deposit',
        active: false,
        steps: 1
      });

      const flowPath = path.join(workspace, '.visor', 'flows', 'deposit.json');
      const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8')) as {
        active: boolean;
        steps: Array<{ id: string; command: string; args: Record<string, unknown> }>;
      };
      expect(flow.active).toBe(false);
      expect(flow.steps).toHaveLength(1);
      expect(flow.steps[0]).toMatchObject({
        id: '001-tap',
        command: 'tap'
      });
      expect(flow.steps[0]?.args).toEqual({ x: 224, y: 686 });
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('replays a recorded flow with parameter substitution through the scenario runner', async () => {
    const originalCwd = process.cwd();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-replay-flow-'));
    const outputDir = path.join(workspace, 'artifacts');
    daemonMock.runDaemonScenario.mockResolvedValue(benchmarkRun('replay_1'));

    try {
      process.chdir(workspace);
      fs.mkdirSync(path.join(workspace, '.visor', 'flows'), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, '.visor', 'flows', 'deposit.json'),
        `${JSON.stringify({
          schema_version: 1,
          name: 'deposit',
          active: false,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
          steps: [
            {
              id: '001-tap',
              command: 'tap',
              args: { target: 'Deposit' }
            },
            {
              id: '002-type',
              command: 'act',
              args: { name: 'type', target: 'Amount', value: '{{amount}}' }
            }
          ]
        }, null, 2)}\n`,
        'utf8'
      );

      const result = await executeCommand([
        'replay',
        'deposit',
        '--device',
        'emulator-5554',
        '--app-id',
        'com.example.bank',
        '--param',
        'amount=100',
        '--output',
        outputDir
      ]);

      expect(result.code).toBe(0);
      expect(result.response.data).toMatchObject({
        action: 'replay',
        name: 'deposit',
        steps: 2,
        run: {
          run_id: 'replay_1'
        }
      });
      expect(daemonMock.runDaemonScenario).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          meta: expect.objectContaining({ name: 'replay:deposit' }),
          steps: [
            { id: '001-tap', command: 'tap', args: { target: 'Deposit' } },
            { id: '002-type', command: 'act', args: { name: 'type', target: 'Amount', value: '100' } }
          ]
        }),
        'emulator-5554',
        expect.any(Number),
        outputDir,
        expect.objectContaining({ enabled: true, appId: 'com.example.bank' })
      );
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('runs benchmark map A/B variants with fixed scenario and run count', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-ab-benchmark-'));
    let index = 0;
    daemonMock.runDaemonScenario.mockImplementation(async () => benchmarkRun(`run_${++index}`));

    try {
      const result = await executeCommand([
        'benchmark',
        'scenarios/local-fake-smoke.json',
        '--device',
        'emulator-5554',
        '--app-id',
        'com.example.settings',
        '--runs',
        '1',
        '--compare-map',
        '--output',
        outputDir
      ]);

      expect(result.code).toBe(0);
      expect(result.response.data.variants).toEqual([
        expect.objectContaining({ name: 'no-map', mapEnabled: false, runs: 1, failures: 0 }),
        expect.objectContaining({ name: 'map', mapEnabled: true, runs: 1, failures: 0 })
      ]);
      expect(daemonMock.runDaemonScenario).toHaveBeenNthCalledWith(
        1,
        expect.any(Object),
        expect.any(Object),
        'emulator-5554',
        expect.any(Number),
        outputDir,
        expect.objectContaining({ enabled: false, appId: 'com.example.settings' })
      );
      expect(daemonMock.runDaemonScenario).toHaveBeenNthCalledWith(
        2,
        expect.any(Object),
        expect.any(Object),
        'emulator-5554',
        expect.any(Number),
        outputDir,
        expect.objectContaining({ enabled: true, appId: 'com.example.settings' })
      );
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
