import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScenario } from '../src/runner.js';
import { writeReports } from '../src/report.js';
import type { AdapterCapability, PlatformAdapter, Scenario } from '../src/types.js';

class ScreenGraphAdapter implements PlatformAdapter {
  readonly actions: string[] = [];

  constructor(
    private readonly graph: Record<string, { source: string; taps: Record<string, string> }>,
    private screen = 'home'
  ) {}

  capability(): AdapterCapability {
    return {
      platform: 'ios',
      commands: ['navigate', 'tap', 'act', 'scroll', 'screenshot', 'wait', 'source']
    };
  }

  async navigate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.actions.push(`navigate:${String(args.to ?? '')}`);
    return { action: 'navigate', args };
  }

  async tap(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof args.x === 'number' && typeof args.y === 'number') {
      this.actions.push(`tap:${args.x},${args.y}`);
      return { action: 'tap', args: { x: args.x, y: args.y } };
    }

    const target = String(args.target ?? '');
    this.actions.push(`tap:${target}`);
    const next = this.graph[this.screen]?.taps[target];
    if (!next) {
      throw new Error(`target not visible on ${this.screen}: ${target}`);
    }
    this.screen = next;
    return { action: 'tap', args: { target } };
  }

  async act(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = String(args.name ?? '');
    this.actions.push(`act:${name}`);
    if (name === 'type') {
      const target = String(args.target ?? '');
      const next = this.graph[this.screen]?.taps[`type:${target}`];
      if (next) {
        this.screen = next;
      }
    }
    return { action: 'act', args };
  }

  async scroll(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.actions.push(`scroll:${String(args.direction ?? '')}`);
    return { action: 'scroll', args };
  }

  async screenshot(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.actions.push('screenshot');
    return { action: 'screenshot', args };
  }

  async wait(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.actions.push(`wait:${String(args.ms ?? '')}`);
    return { action: 'wait', args };
  }

  async source(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.actions.push(`source:${this.screen}`);
    const filePath = path.resolve(String(args.path ?? path.join(os.tmpdir(), `${this.screen}.xml`)));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, this.graph[this.screen]?.source ?? '<App />', 'utf8');
    return {
      action: 'source',
      args: {
        path: filePath,
        bytes: fs.statSync(filePath).size,
        format: 'xml'
      }
    };
  }

  async exists(target: string): Promise<boolean> {
    return this.graph[this.screen]?.source.includes(target) ?? false;
  }

  async close(): Promise<void> {}
}

function appMapDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'visor-app-map-'));
}

function scenarioWithTap(target: string): Scenario {
  return {
    meta: { name: `tap ${target}`, version: '1.0.0' },
    config: {},
    steps: [{ id: `tap-${target.toLowerCase()}`, command: 'tap', args: { target } }],
    assertions: [],
    output: {}
  };
}

function scenarioWithCoordinateTap(): Scenario {
  return {
    meta: { name: 'coordinate tap', version: '1.0.0' },
    config: {},
    steps: [{ id: 'tap-coordinate', command: 'tap', args: { x: 10, y: 20 } }],
    assertions: [],
    output: {}
  };
}

function scenarioWithType(target: string, value: string): Scenario {
  return {
    meta: { name: `type ${target}`, version: '1.0.0' },
    config: {},
    steps: [{ id: `type-${target.toLowerCase()}`, command: 'act', args: { name: 'type', target, value } }],
    assertions: [],
    output: {}
  };
}

const graph = {
  home: {
    source: '<App><Button name="Settings" label="Settings" /></App>',
    taps: { Settings: 'settings' }
  },
  settings: {
    source: '<App><Button name="Advanced" label="Advanced" /></App>',
    taps: { Advanced: 'advanced' }
  },
  advanced: {
    source: '<App><StaticText name="Done" label="Done" /></App>',
    taps: {}
  }
};

const subsetScreenGraph = {
  home: {
    source: '<App><Button name="Settings" label="Settings" /></App>',
    taps: { Settings: 'settings' }
  },
  settings: {
    source:
      '<App><StaticText name="Settings" label="Settings" /><Button name="General" label="General" /><Button name="Account" label="Account" /><Button name="Advanced" label="Advanced" /></App>',
    taps: { General: 'general', Account: 'account', Advanced: 'advanced' }
  },
  general: {
    source: '<App><StaticText name="General" label="General" /></App>',
    taps: {}
  },
  account: {
    source: '<App><StaticText name="Account" label="Account" /></App>',
    taps: {}
  },
  advanced: {
    source: '<App><StaticText name="Advanced" label="Advanced" /></App>',
    taps: {}
  }
};

const cachedActionFailureLearningGraph = {
  home: {
    source:
      '<App><StaticText name="Home" label="Home" /><StaticText name="Help" label="Help" /><Button name="Settings" label="Settings" /></App>',
    taps: { Settings: 'settings' }
  },
  settings: {
    source: '<App><Button name="Advanced" label="Advanced" /></App>',
    taps: { Advanced: 'advanced' }
  },
  advanced: {
    source: '<App><StaticText name="Done" label="Done" /></App>',
    taps: {}
  }
};

const cachedActionFailureRepairGraph = {
  home: {
    source:
      '<App><StaticText name="Home" label="Home" /><StaticText name="Help" label="Help" /><Button name="Preferences" label="Preferences" /></App>',
    taps: { Preferences: 'settings' }
  },
  settings: {
    source: '<App><Button name="Advanced" label="Advanced" /></App>',
    taps: { Advanced: 'advanced' }
  },
  advanced: {
    source: '<App><StaticText name="Done" label="Done" /></App>',
    taps: {}
  }
};

const repairedGraph = {
  home: {
    source:
      '<App><Button name="Settings" label="Settings" /><Button name="Delete" label="Delete" /><TextField name="Email" label="Email" /><Button name="Preferences" label="Preferences" /></App>',
    taps: { Settings: 'help', Delete: 'deleted', Email: 'form', Preferences: 'settings' }
  },
  help: {
    source: '<App><Button name="Back" label="Back" /><StaticText name="Help" label="Help" /></App>',
    taps: { Back: 'home' }
  },
  settings: {
    source: '<App><Button name="Advanced" label="Advanced" /></App>',
    taps: { Advanced: 'advanced' }
  },
  advanced: {
    source: '<App><StaticText name="Done" label="Done" /></App>',
    taps: {}
  }
};

const ambiguousTextGraph = {
  home: {
    source: '<App><Button name="Settings" label="Settings" /><Button name="Profile" label="Profile" /></App>',
    taps: { Settings: 'settings', Profile: 'profile' }
  },
  settings: {
    source: '<App><Button name="SaveSettings" label="Save" /></App>',
    taps: { SaveSettings: 'settings-saved', 'text=Save': 'settings-saved' }
  },
  profile: {
    source: '<App><Button name="SaveProfile" label="Save" /></App>',
    taps: { SaveProfile: 'profile-saved', 'text=Save': 'profile-saved' }
  },
  'settings-saved': {
    source: '<App><StaticText name="SavedSettings" label="Saved" /></App>',
    taps: {}
  },
  'profile-saved': {
    source: '<App><StaticText name="SavedProfile" label="Saved" /></App>',
    taps: {}
  }
};

const authGraph = {
  login: {
    source:
      '<App><TextField name="Username" label="Username" /><SecureTextField name="Password" label="Password" /><Button name="Sign In" label="Sign In" /></App>',
    taps: { 'Sign In': 'login' }
  },
  settings: {
    source: '<App><Button name="Advanced" label="Advanced" /></App>',
    taps: { Advanced: 'advanced' }
  },
  advanced: {
    source: '<App><StaticText name="Done" label="Done" /></App>',
    taps: {}
  }
};

const deadEndRepairGraph = {
  home: {
    source:
      '<App><Button name="Dead End" label="Dead End" /><Button name="Preferences" label="Preferences" /></App>',
    taps: { 'Dead End': 'dead', Preferences: 'settings' }
  },
  dead: {
    source: '<App><StaticText name="Nowhere" label="Nowhere" /></App>',
    taps: {}
  },
  settings: {
    source: '<App><Button name="Advanced" label="Advanced" /></App>',
    taps: { Advanced: 'advanced' }
  },
  advanced: {
    source: '<App><StaticText name="Done" label="Done" /></App>',
    taps: {}
  }
};

const privateFormGraph = {
  home: {
    source:
      '<App><TextField name="Email" label="Email" value="person@example.com">private@example.com</TextField><SecureTextField name="Password" label="Password" value="hunter2" /><Button name="Submit" label="Submit" /></App>',
    taps: { Submit: 'done' }
  },
  done: {
    source: '<App><StaticText name="Done" label="Done" /></App>',
    taps: {}
  }
};

const typedSecretGraph = {
  home: {
    source:
      '<App><TextField name="Token" label="Token" /><Button name="Continue" label="Continue" /></App>',
    taps: { Continue: 'done', 'type:Token': 'done' }
  },
  done: {
    source: '<App><StaticText name="Done" label="Done" /></App>',
    taps: {}
  }
};

describe('app map execution', () => {
  it('learns a destination screen whose labels contain the source screen labels', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.subset-settings'
    };

    const learningAdapter = new ScreenGraphAdapter(subsetScreenGraph);
    const firstRun = await runScenario(
      scenarioWithTap('Settings'),
      learningAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(firstRun.status).toBe('ok');
    expect(learningAdapter.actions).toEqual(['source:home', 'tap:Settings', 'source:settings']);

    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const persisted = JSON.parse(fs.readFileSync(path.join(mapRoot, mapFile), 'utf8')) as {
      variants: Array<{ id: string; element_keys: string[] }>;
      edges: Array<{ target?: string; from_variant_id: string; to_variant_id: string }>;
    };
    const settingsEdge = persisted.edges.find((edge) => edge.target === 'Settings');

    expect(persisted.variants).toHaveLength(2);
    expect(settingsEdge).toBeDefined();
    expect(settingsEdge?.from_variant_id).not.toBe(settingsEdge?.to_variant_id);
  });

  it('reuses a learned route to tap a target from a different screen', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.settings'
    };

    const learningAdapter = new ScreenGraphAdapter(graph);
    const firstRun = await runScenario(
      scenarioWithTap('Settings'),
      learningAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(firstRun.status).toBe('ok');
    expect(firstRun.map?.enabled).toBe(true);
    expect(firstRun.map?.updated).toBe(true);

    const reuseAdapter = new ScreenGraphAdapter(graph);
    const secondRun = await runScenario(
      scenarioWithTap('Advanced'),
      reuseAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(secondRun.status).toBe('ok');
    expect(reuseAdapter.actions).toEqual([
      'source:home',
      'tap:Settings',
      'source:settings',
      'tap:Advanced',
      'source:advanced'
    ]);
    expect(secondRun.map?.enabled).toBe(true);
    expect(secondRun.map?.used).toBe(true);
    expect(secondRun.map?.updated).toBe(true);
    expect(secondRun.map?.repairs).toBe(0);
    expect(secondRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'Settings' }]
    });

    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const persisted = JSON.parse(fs.readFileSync(path.join(mapRoot, mapFile), 'utf8')) as {
      schema_version: number;
      app_id: string;
      identity: string;
      variants: Array<{ elements: Array<{ labels: string[] }> }>;
    };
    expect(persisted.schema_version).toBe(1);
    expect(persisted.app_id).toBe('com.example.settings');
    expect(persisted.identity).toBe('ios:com.example.settings');
    expect(JSON.stringify(persisted)).toContain('Settings');
    expect(JSON.stringify(persisted)).not.toContain('.png');
    expect(JSON.stringify(persisted)).not.toContain('base64');

    const reportDir = appMapDir();
    const outputs = writeReports(secondRun, reportDir);
    const report = JSON.parse(fs.readFileSync(outputs.json, 'utf8')) as {
      map?: { used?: boolean };
      steps: Array<{ details: { map?: { route?: Array<{ target?: string }> } } }>;
    };
    expect(report.map?.used).toBe(true);
    expect(report.steps[0]?.details.map?.route?.[0]?.target).toBe('Settings');
  });

  it('disables map reads and writes in no-map mode', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.settings'
    };

    const learningAdapter = new ScreenGraphAdapter(graph);
    await runScenario(
      scenarioWithTap('Settings'),
      learningAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const mapPath = path.join(mapRoot, mapFile);
    const before = fs.readFileSync(mapPath, 'utf8');

    const rawAdapter = new ScreenGraphAdapter(graph);
    const rawRun = await runScenario(
      scenarioWithTap('Advanced'),
      rawAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      { ...mapOptions, enabled: false }
    );

    expect(rawRun.status).toBe('fail');
    expect(rawRun.map?.enabled).toBe(false);
    expect(rawRun.map?.updated).toBe(false);
    expect(rawAdapter.actions).toEqual(['tap:Advanced']);
    expect(fs.readFileSync(mapPath, 'utf8')).toBe(before);
  });

  it('demotes a stale cached edge and repairs through safe controls', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.settings'
    };

    const learningAdapter = new ScreenGraphAdapter(graph);
    await runScenario(
      scenarioWithTap('Settings'),
      learningAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const repairAdapter = new ScreenGraphAdapter(repairedGraph);
    const repairedRun = await runScenario(
      scenarioWithTap('Advanced'),
      repairAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(repairedRun.status).toBe('ok');
    expect(repairAdapter.actions).toEqual([
      'source:home',
      'tap:Settings',
      'source:help',
      'tap:Back',
      'source:home',
      'tap:Preferences',
      'source:settings',
      'tap:Advanced',
      'source:advanced'
    ]);
    expect(repairedRun.map).toMatchObject({
      enabled: true,
      used: true,
      repaired: true,
      repairs: 1,
      updated: true
    });
    expect(repairedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      repaired: true,
      repairs: 1,
      route: [
        { command: 'tap', target: 'Settings' },
        { command: 'tap', target: 'Back' },
        { command: 'tap', target: 'Preferences' }
      ]
    });
    expect(repairAdapter.actions).not.toContain('tap:Delete');
    expect(repairAdapter.actions).not.toContain('tap:Email');

    const secondRepairAdapter = new ScreenGraphAdapter(repairedGraph);
    const secondRepairRun = await runScenario(
      scenarioWithTap('Advanced'),
      secondRepairAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(secondRepairRun.status).toBe('ok');
    expect(secondRepairAdapter.actions).toEqual([
      'source:home',
      'tap:Settings',
      'source:help',
      'tap:Back',
      'source:home',
      'tap:Preferences',
      'source:settings',
      'tap:Advanced',
      'source:advanced'
    ]);

    const promotedAdapter = new ScreenGraphAdapter(repairedGraph);
    const promotedRun = await runScenario(
      scenarioWithTap('Advanced'),
      promotedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(promotedRun.status).toBe('ok');
    expect(promotedAdapter.actions).toEqual([
      'source:home',
      'tap:Preferences',
      'source:settings',
      'tap:Advanced',
      'source:advanced'
    ]);

    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const persistedMap = JSON.parse(fs.readFileSync(path.join(mapRoot, mapFile), 'utf8')) as {
      edges: Array<{ target?: string; stale: boolean; candidate: boolean; successes: number }>;
    };
    expect(persistedMap.edges.find((edge) => edge.target === 'Settings')?.stale).toBe(true);
    expect(persistedMap.edges.find((edge) => edge.target === 'Preferences')).toMatchObject({
      stale: false,
      candidate: false
    });
  });

  it('demotes a cached edge when the learned control is no longer visible and repairs', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.disappearing-control'
    };

    await runScenario(
      scenarioWithTap('Settings'),
      new ScreenGraphAdapter(cachedActionFailureLearningGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const repairAdapter = new ScreenGraphAdapter(cachedActionFailureRepairGraph);
    const repairedRun = await runScenario(
      scenarioWithTap('Advanced'),
      repairAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(repairedRun.status).toBe('ok');
    expect(repairAdapter.actions).toEqual([
      'source:home',
      'tap:Settings',
      'source:home',
      'tap:Preferences',
      'source:settings',
      'tap:Advanced',
      'source:advanced'
    ]);
    expect(repairedRun.map).toMatchObject({
      enabled: true,
      used: true,
      repaired: true,
      repairs: 1
    });
    expect(repairedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      repaired: true,
      route: [
        { command: 'tap', target: 'Settings' },
        { command: 'tap', target: 'Preferences' }
      ]
    });
  });

  it('does not continue repair from stale sibling targets after a dead-end branch', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.dead-end'
    };

    const deadEndAdapter = new ScreenGraphAdapter(deadEndRepairGraph);
    const deadEndRun = await runScenario(
      scenarioWithTap('Advanced'),
      deadEndAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(deadEndRun.status).toBe('fail');
    expect(deadEndAdapter.actions).toEqual(['source:home', 'tap:Dead End', 'source:dead']);
    expect(deadEndAdapter.actions).not.toContain('tap:Preferences');
    expect(deadEndAdapter.actions).not.toContain('tap:Advanced');
    expect(deadEndRun.steps[0]?.error?.likely_cause).toContain('not reachable');
  });

  it('keeps determinism signatures stable as mapped route confidence changes', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.determinism'
    };

    await runScenario(
      scenarioWithTap('Settings'),
      new ScreenGraphAdapter(graph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const firstMappedRun = await runScenario(
      scenarioWithTap('Advanced'),
      new ScreenGraphAdapter(graph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    const secondMappedRun = await runScenario(
      scenarioWithTap('Advanced'),
      new ScreenGraphAdapter(graph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(firstMappedRun.status).toBe('ok');
    expect(secondMappedRun.status).toBe('ok');
    expect(firstMappedRun.steps[0]?.details.map).toMatchObject({
      route: [{ command: 'tap', target: 'Settings', confidence: 0.9 }]
    });
    expect(secondMappedRun.steps[0]?.details.map).toMatchObject({
      route: [{ command: 'tap', target: 'Settings', confidence: 1 }]
    });
    expect(firstMappedRun.determinism_signature).toBe(secondMappedRun.determinism_signature);
  });

  it('keeps determinism signatures stable between repaired cold mapping and cached reuse', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.cold-determinism'
    };

    const coldMappedRun = await runScenario(
      scenarioWithTap('Advanced'),
      new ScreenGraphAdapter(graph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    const cachedMappedRun = await runScenario(
      scenarioWithTap('Advanced'),
      new ScreenGraphAdapter(graph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(coldMappedRun.status).toBe('ok');
    expect(cachedMappedRun.status).toBe('ok');
    expect(coldMappedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      repaired: true,
      route: [{ command: 'tap', target: 'Settings' }]
    });
    expect(cachedMappedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      repaired: false,
      route: [{ command: 'tap', target: 'Settings' }]
    });
    expect(coldMappedRun.determinism_signature).toBe(cachedMappedRun.determinism_signature);
  });

  it('redacts form values and email-like content before persisting the app map', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.private-form'
    };

    const privateRun = await runScenario(
      scenarioWithTap('Submit'),
      new ScreenGraphAdapter(privateFormGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(privateRun.status).toBe('ok');
    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const persistedText = fs.readFileSync(path.join(mapRoot, mapFile), 'utf8');
    expect(persistedText).toContain('Email');
    expect(persistedText).toContain('Password');
    expect(persistedText).toContain('Submit');
    expect(persistedText).not.toContain('person@example.com');
    expect(persistedText).not.toContain('private@example.com');
    expect(persistedText).not.toContain('hunter2');
  });

  it('does not persist typed act values into app-map edges', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.typed-secret'
    };

    await runScenario(
      scenarioWithTap('Continue'),
      new ScreenGraphAdapter(typedSecretGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    const typeRun = await runScenario(
      scenarioWithType('Token', 'secret-token-123'),
      new ScreenGraphAdapter(typedSecretGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(typeRun.status).toBe('ok');
    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const persistedText = fs.readFileSync(path.join(mapRoot, mapFile), 'utf8');
    expect(persistedText).not.toContain('secret-token-123');
  });

  it('scrubs legacy typed act values from disk when loading and persisting a map', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.legacy-typed-secret'
    };

    await runScenario(
      scenarioWithTap('Continue'),
      new ScreenGraphAdapter(typedSecretGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const mapPath = path.join(mapRoot, mapFile);
    const legacyMap = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as {
      variants: Array<{ id: string; normalized_fingerprint: string }>;
      edges: Array<Record<string, unknown>>;
    };
    const fromVariant = legacyMap.variants[0];
    const toVariant = legacyMap.variants[1] ?? fromVariant;
    legacyMap.edges.push({
      id: 'edge_legacy_typed_secret',
      from_variant_id: fromVariant?.id ?? 'variant_1',
      to_variant_id: toVariant?.id ?? 'variant_2',
      command: 'act',
      args: { name: 'type', target: 'Token', value: 'secret-token-legacy' },
      target: 'Token',
      confidence: 0.9,
      successes: 1,
      failures: 0,
      stale: false,
      candidate: false,
      destination_contract: {
        variant_id: toVariant?.id ?? 'variant_2',
        required_targets: [],
        normalized_fingerprint: toVariant?.normalized_fingerprint ?? ''
      },
      last_observed_at: new Date(0).toISOString()
    });
    fs.writeFileSync(mapPath, `${JSON.stringify(legacyMap, null, 2)}\n`, 'utf8');
    expect(fs.readFileSync(mapPath, 'utf8')).toContain('secret-token-legacy');

    const loadOnlyRun = await runScenario(
      scenarioWithCoordinateTap(),
      new ScreenGraphAdapter(typedSecretGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(loadOnlyRun.status).toBe('ok');
    expect(loadOnlyRun.map?.updated).toBe(true);
    expect(fs.readFileSync(mapPath, 'utf8')).not.toContain('secret-token-legacy');
  });

  it('refuses ambiguous text route targets instead of guessing', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.ambiguous'
    };

    await runScenario(
      scenarioWithTap('Settings'),
      new ScreenGraphAdapter(ambiguousTextGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    await runScenario(
      scenarioWithTap('Profile'),
      new ScreenGraphAdapter(ambiguousTextGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const ambiguousAdapter = new ScreenGraphAdapter(ambiguousTextGraph);
    const ambiguousRun = await runScenario(
      scenarioWithTap('text=Save'),
      ambiguousAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(ambiguousRun.status).toBe('fail');
    expect(ambiguousAdapter.actions).toEqual(['source:home']);
    expect(ambiguousRun.steps[0]?.error?.likely_cause).toContain('ambiguous');
  });

  it('excludes coordinate taps from route planning and map updates', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.coordinates'
    };

    await runScenario(
      scenarioWithTap('Settings'),
      new ScreenGraphAdapter(graph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const mapPath = path.join(mapRoot, mapFile);
    const before = fs.readFileSync(mapPath, 'utf8');

    const coordinateAdapter = new ScreenGraphAdapter(graph);
    const coordinateRun = await runScenario(
      scenarioWithCoordinateTap(),
      coordinateAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(coordinateRun.status).toBe('ok');
    expect(coordinateAdapter.actions).toEqual(['tap:10,20']);
    expect(coordinateRun.map?.updated).toBe(false);
    expect(fs.readFileSync(mapPath, 'utf8')).toBe(before);
  });

  it('short-circuits auth-required states before repair exploration', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.auth'
    };

    const authAdapter = new ScreenGraphAdapter(authGraph, 'login');
    const authRun = await runScenario(
      scenarioWithTap('Advanced'),
      authAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(authRun.status).toBe('fail');
    expect(authAdapter.actions).toEqual(['source:login']);
    expect(authRun.steps[0]?.error?.likely_cause).toContain('requires authentication');
  });
});
