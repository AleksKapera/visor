import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createAppMapContext,
  discoverAppMap,
  executeRoutePlan,
  mapDebugSnapshot,
  runMappedCommand
} from '../src/appMap.js';
import { runScenario } from '../src/runner.js';
import { writeReports } from '../src/report.js';
import type { RoutePlan } from '../src/routePlan.js';
import type { AdapterCapability, PlatformAdapter, Scenario } from '../src/types.js';

class ScreenGraphAdapter implements PlatformAdapter {
  readonly actions: string[] = [];

  constructor(
    private readonly graph: Record<
      string,
      {
        source: string | string[];
        taps: Record<string, string>;
        liveTargets?: string[];
        missingLiveTargets?: string[];
        coordinateTaps?: Record<string, string>;
        scrolls?: Record<string, string>;
      }
    >,
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
      const next = this.graph[this.screen]?.coordinateTaps?.[`${args.x},${args.y}`];
      if (next) {
        this.screen = next;
      }
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
    const direction = String(args.direction ?? '');
    this.actions.push(`scroll:${direction}`);
    const next = this.graph[this.screen]?.scrolls?.[direction];
    if (next) {
      this.screen = next;
    }
    return { action: 'scroll', args };
  }

  async screenshot(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.actions.push('screenshot');
    return { action: 'screenshot', args };
  }

  async wait(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (args.label !== 'app-map-settle') {
      this.actions.push(`wait:${String(args.ms ?? '')}`);
    }
    if (typeof args.for === 'string') {
      return {
        action: 'wait',
        args: {
          ...args,
          matched: await this.exists(args.for)
        }
      };
    }
    if (args.stable === true) {
      return {
        action: 'wait',
        args: {
          ...args,
          matched: false
        }
      };
    }
    return { action: 'wait', args };
  }

  async source(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.actions.push(`source:${this.screen}`);
    const filePath = path.resolve(String(args.path ?? path.join(os.tmpdir(), `${this.screen}.xml`)));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const current = this.graph[this.screen];
    const source = Array.isArray(current?.source)
      ? current.source.shift() ?? current.source[current.source.length - 1] ?? '<App />'
      : current?.source ?? '<App />';
    fs.writeFileSync(filePath, source, 'utf8');
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
    const current = this.graph[this.screen];
    if (current?.missingLiveTargets?.includes(target)) {
      return false;
    }
    return current?.liveTargets?.includes(target) || current?.source.includes(target) || false;
  }

  async close(): Promise<void> {}
}

const temporaryAppMapDirs = new Set<string>();

afterEach(() => {
  for (const directory of temporaryAppMapDirs) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryAppMapDirs.clear();
});

function appMapDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-app-map-'));
  temporaryAppMapDirs.add(directory);
  return directory;
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
  return scenarioWithCoordinateTapAt(10, 20);
}

function scenarioWithCoordinateTapAt(x: number, y: number): Scenario {
  return {
    meta: { name: `coordinate tap ${x},${y}`, version: '1.0.0' },
    config: {},
    steps: [{ id: 'tap-coordinate', command: 'tap', args: { x, y } }],
    assertions: [],
    output: {}
  };
}

function scenarioWithWait(): Scenario {
  return {
    meta: { name: 'wait', version: '1.0.0' },
    config: {},
    steps: [{ id: 'wait', command: 'wait', args: { ms: 1 } }],
    assertions: [],
    output: {}
  };
}

function scenarioWithWaitFor(target: string): Scenario {
  return {
    meta: { name: `wait for ${target}`, version: '1.0.0' },
    config: {},
    steps: [{ id: 'wait-for-target', command: 'wait', args: { for: target, timeout: 100 } }],
    assertions: [],
    output: {}
  };
}

function scenarioWithScroll(direction: string): Scenario {
  return {
    meta: { name: `scroll ${direction}`, version: '1.0.0' },
    config: {},
    steps: [{ id: `scroll-${direction}`, command: 'scroll', args: { direction } }],
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
    taps: { Advanced: 'advanced', 'text~=Adv': 'advanced' }
  },
  advanced: {
    source: '<App><StaticText name="Done" label="Done" /></App>',
    taps: {}
  }
};

const annotatedVariantGraph = {
  loaded: {
    source:
      '<App><Button name="Primary" label="Primary" /><Button name="Secondary" label="Secondary" />' +
      '<Button name="Loaded action" label="Loaded action" /><Button name="Loaded help" label="Loaded help" /></App>',
    taps: {}
  },
  error: {
    source:
      '<App><Button name="Primary" label="Primary" /><Button name="Secondary" label="Secondary" />' +
      '<Button name="Retry action" label="Retry action" /><Button name="Error help" label="Error help" /></App>',
    taps: {}
  },
  payment: {
    source: '<App><Button name="Choose card" label="Choose card" /><Button name="Billing help" label="Billing help" /></App>',
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

const nestedDuplicateTextGraph = {
  home: {
    source: '<App><Button name="Starter" label="Starter" /></App>',
    taps: { Starter: 'starter' }
  },
  starter: {
    source: '<App><Button name="BABY Portfolio" label="BABY Portfolio" /></App>',
    taps: { 'text~=BABY': 'baby' }
  },
  baby: {
    source: '<App><StaticText name="BABY" label="BABY" /></App>',
    taps: {}
  }
};

const numericContainsGraph = {
  home: {
    source: '<App><Button name="Wallet" label="Wallet" /></App>',
    taps: { Wallet: 'cash' }
  },
  cash: {
    source: '<App><Button name="$100" label="$100" /></App>',
    taps: { 'text~=$100': 'selected' }
  },
  selected: {
    source: '<App><StaticText name="Selected" label="Selected" /></App>',
    taps: {}
  }
};

const scrollRouteGraph = {
  home: {
    source:
      '<App><StaticText name="Orders" label="Orders" />' +
      '<XCUIElementTypeOther name="Order #1001&#10;$42" label="Order #1001&#10;$42" enabled="true" visible="true" accessible="true" x="20" y="180" width="330" height="88" /></App>',
    scrolls: { down: 'older-orders' },
    taps: {}
  },
  'older-orders': {
    source:
      '<App><StaticText name="Older orders" label="Older orders" />' +
      '<Button name="Receipt #0998" label="Receipt #0998" x="20" y="420" width="240" height="56" /></App>',
    coordinateTaps: { '140,448': 'receipt' },
    taps: { 'text=Receipt #0998': 'receipt' }
  },
  receipt: {
    source: '<App><StaticText name="Receipt #0998 detail" label="Receipt #0998 detail" /></App>',
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

const liveResolvedTargetGraph = {
  home: {
    source: '<App><StaticText name="Deposit" label="Deposit" /></App>',
    liveTargets: ['Close'],
    taps: { Close: 'closed' }
  },
  closed: {
    source: '<App><StaticText name="Home" label="Home" /></App>',
    taps: {}
  }
};

const semanticAliasCoordinateGraph = {
  home: {
    source:
      '<App><XCUIElementTypeButton name="See all&#10;See all" label="See all&#10;See all" enabled="true" visible="true" accessible="true" x="322" y="319" width="60" height="26" /></App>',
    missingLiveTargets: ['See all'],
    coordinateTaps: { '352,332': 'all-premium' },
    taps: {}
  },
  'all-premium': {
    source: '<App><StaticText name="Top Premium investors" label="Top Premium investors" /></App>',
    taps: {}
  }
};

const inertFlutterSemanticGraph = {
  profile: {
    source:
      '<App><XCUIElementTypeButton name="Trade Activity&#10;Trade Activity" label="Trade Activity&#10;Trade Activity" enabled="true" visible="true" accessible="true" x="228" y="300" width="124" height="44" /></App>',
    liveTargets: ['Trade Activity'],
    coordinateTaps: { '290,322': 'activity' },
    taps: {}
  },
  activity: {
    source: '<App><StaticText name="Trade Activity" label="Trade Activity" /></App>',
    taps: {}
  }
};

const coordinateRouteGraph = {
  home: {
    source: '<App><StaticText name="Home" label="Home" /></App>',
    coordinateTaps: { '10,20': 'settings' },
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

const noEffectTapGraph = {
  home: {
    source: '<App><Button name="Starter" label="Starter" /></App>',
    taps: { Starter: 'home' }
  }
};

const transientLaunchGraph = {
  home: {
    source: [
      '<App><XCUIElementTypeImage x="0" y="244" width="402" height="402" /></App>',
      '<App><Button name="Premium" label="Premium" x="162" y="787" width="78" height="40" /></App>'
    ],
    coordinateTaps: { '201,807': 'premium' },
    taps: {}
  },
  premium: {
    source: '<App><StaticText name="Premium Investments" label="Premium Investments" /></App>',
    taps: {}
  }
};

const bottomNavCrawlGraph = {
  home: {
    source:
      '<App><Button name="Settings" label="Settings" x="0" y="73" width="350" height="34" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" />' +
      '<XCUIElementTypeOther name="Creator Card" label="Creator Card" x="20" y="200" width="160" height="120" /></App>',
    coordinateTaps: { '124,807': 'starter', '201,807': 'premium', '100,260': 'creator' },
    taps: {}
  },
  starter: {
    source:
      '<App><StaticText name="Starter Investments" label="Starter Investments" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" /></App>',
    coordinateTaps: { '48,807': 'home', '201,807': 'premium' },
    taps: {}
  },
  premium: {
    source:
      '<App><StaticText name="Premium Investments" label="Premium Investments" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" /></App>',
    coordinateTaps: { '48,807': 'home', '124,807': 'starter' },
    taps: {}
  },
  creator: {
    source: '<App><Button name="Back&#10;Creator&#10;Back" label="Back&#10;Creator&#10;Back" x="0" y="73" width="300" height="34" /></App>',
    coordinateTaps: { '40,90': 'home' },
    taps: {}
  }
};

const premiumInvestorCrawlGraph = {
  home: {
    source:
      '<App><StaticText name="Three ways to get started" label="Three ways to get started" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" /></App>',
    coordinateTaps: { '124,807': 'starter', '201,807': 'premium' },
    taps: {}
  },
  starter: {
    source:
      '<App><StaticText name="Starter Investments" label="Starter Investments" />' +
      '<XCUIElementTypeOther name="BABY&#10;Justin Bieber&#10;+190.98%" label="BABY&#10;Justin Bieber&#10;+190.98%" enabled="true" visible="true" accessible="true" x="20" y="220" width="350" height="100" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" /></App>',
    coordinateTaps: { '48,807': 'home', '124,807': 'starter', '201,807': 'premium', '195,270': 'baby' },
    taps: {}
  },
  premium: {
    source:
      '<App><StaticText name="Premium Investments" label="Premium Investments" />' +
      '<Button name="See all&#10;See all" label="See all&#10;See all" x="322" y="319" width="60" height="26" />' +
      '<XCUIElementTypeOther name="dub Extraordinary X&#10;Capital&#10;$29.9M" label="dub Extraordinary X&#10;Capital&#10;$29.9M" enabled="true" visible="true" accessible="true" x="20" y="350" width="350" height="110" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" /></App>',
    coordinateTaps: { '195,405': 'profile', '352,332': 'all-premium', '48,807': 'home', '124,807': 'starter' },
    taps: {}
  },
  profile: {
    source:
      '<App><Button name="Back&#10;@dub.team&#10;Back" label="Back&#10;@dub.team&#10;Back" x="0" y="73" width="300" height="34" />' +
      '<Button name="Portfolios (15)&#10;Portfolios (15)" label="Portfolios (15)&#10;Portfolios (15)" x="20" y="300" width="160" height="44" />' +
      '<Button name="Trade Activity (106)&#10;Trade Activity (106)" label="Trade Activity (106)&#10;Trade Activity (106)" x="180" y="300" width="180" height="44" /></App>',
    coordinateTaps: { '40,90': 'premium', '270,322': 'activity' },
    taps: {}
  },
  activity: {
    source:
      '<App><Button name="Back&#10;@dub.team&#10;Back" label="Back&#10;@dub.team&#10;Back" x="0" y="73" width="300" height="34" />' +
      '<StaticText name="Buy NKE" label="Buy NKE" />' +
      '<StaticText name="Sell DIS" label="Sell DIS" />' +
      '<Button name="Trade Activity (106)&#10;Trade Activity (106)" label="Trade Activity (106)&#10;Trade Activity (106)" x="180" y="300" width="180" height="44" /></App>',
    coordinateTaps: { '40,90': 'premium' },
    taps: {}
  },
  baby: {
    source: '<App><Button name="Back&#10;$BABYBABY&#10;Back" label="Back&#10;$BABYBABY&#10;Back" x="0" y="73" width="300" height="34" /></App>',
    coordinateTaps: { '40,90': 'starter' },
    taps: {}
  },
  'all-premium': {
    source: '<App><Button name="Back&#10;Top Premium investors&#10;Back" label="Back&#10;Top Premium investors&#10;Back" x="0" y="73" width="300" height="34" /></App>',
    coordinateTaps: { '40,90': 'premium' },
    taps: {}
  }
};

const virtualBottomNavGraph = {
  home: {
    source:
      '<App><StaticText name="Three ways to get started" label="Three ways to get started" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" /></App>',
    coordinateTaps: { '124,807': 'starter', '201,807': 'premium' },
    taps: {}
  },
  starter: {
    source:
      '<App><StaticText name="Starter Investments" label="Starter Investments" />' +
      '<Button name="BABY Portfolio" label="BABY Portfolio" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" /></App>',
    coordinateTaps: { '48,807': 'home', '201,807': 'premium' },
    taps: { 'text~=BABY': 'baby' }
  },
  baby: {
    source: '<App><Button name="Back&#10;$BABYBABY&#10;Back" label="Back&#10;$BABYBABY&#10;Back" x="0" y="73" width="300" height="34" /></App>',
    coordinateTaps: { '40,90': 'starter' },
    taps: {}
  },
  premium: {
    source:
      '<App><StaticText name="Premium Investments" label="Premium Investments" />' +
      '<XCUIElementTypeOther name="dub Extraordinary X&#10;Capital&#10;$29.9M" label="dub Extraordinary X&#10;Capital&#10;$29.9M" enabled="true" visible="true" accessible="true" x="20" y="430" width="234" height="112" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" /></App>',
    coordinateTaps: { '137,486': 'profile', '124,807': 'starter', '48,807': 'home' },
    taps: {}
  },
  profile: {
    source:
      '<App><Button name="Back&#10;@dub.team&#10;Back" label="Back&#10;@dub.team&#10;Back" x="0" y="73" width="300" height="34" />' +
      '<Button name="Trade Activity (106)&#10;Trade Activity (106)" label="Trade Activity (106)&#10;Trade Activity (106)" x="180" y="300" width="180" height="44" /></App>',
    coordinateTaps: { '40,90': 'premium', '270,322': 'activity' },
    taps: { 'text~=Trade Activity': 'activity' }
  },
  activity: {
    source:
      '<App><Button name="Back&#10;@dub.team&#10;Back" label="Back&#10;@dub.team&#10;Back" x="0" y="73" width="300" height="34" />' +
      '<StaticText name="Buy NKE" label="Buy NKE" /></App>',
    coordinateTaps: { '40,90': 'premium' },
    taps: {}
  }
};

const incidentalActivityMatchGraph = {
  home: {
    source:
      '<App><StaticText name="Three ways to get started" label="Three ways to get started" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" />' +
      '<Button name="Activity&#10;Activity" label="Activity&#10;Activity" x="316" y="787" width="77" height="40" /></App>',
    coordinateTaps: { '124,807': 'starter', '355,807': 'activity' },
    taps: {}
  },
  starter: {
    source:
      '<App><StaticText name="Starter Investments" label="Starter Investments" />' +
      '<XCUIElementTypeOther name="1&#10;BABY&#10;Justin Bieber&#10;+190.98%&#10;All-Time" label="1&#10;BABY&#10;Justin Bieber&#10;+190.98%&#10;All-Time" enabled="true" visible="true" accessible="true" x="7" y="671" width="363" height="74" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" />' +
      '<Button name="Activity&#10;Activity" label="Activity&#10;Activity" x="316" y="787" width="77" height="40" /></App>',
    coordinateTaps: { '48,807': 'home', '189,708': 'baby', '355,807': 'activity' },
    taps: { 'text~=BABY': 'baby' }
  },
  activity: {
    source:
      '<App><StaticText name="For You" label="For You" />' +
      '<XCUIElementTypeOther name="1&#10;BABY&#10;Justin Bieber&#10;+190.98%&#10;All-Time" label="1&#10;BABY&#10;Justin Bieber&#10;+190.98%&#10;All-Time" enabled="true" visible="true" accessible="true" x="7" y="671" width="363" height="74" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" />' +
      '<Button name="Activity&#10;Activity" label="Activity&#10;Activity" x="316" y="787" width="77" height="40" /></App>',
    coordinateTaps: { '48,807': 'home', '124,807': 'starter' },
    taps: { 'text~=BABY': 'activity-detail' }
  },
  baby: {
    source: '<App><StaticText name="BABY" label="BABY" /></App>',
    taps: {}
  },
  'activity-detail': {
    source: '<App><StaticText name="Activity detail" label="Activity detail" /></App>',
    taps: {}
  }
};

const sectionFirstGraph = {
  home: {
    source:
      '<App><StaticText name="Three ways to get started" label="Three ways to get started" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" /></App>',
    coordinateTaps: { '124,807': 'starter' },
    taps: {}
  },
  starter: {
    source:
      '<App><StaticText name="Starter Investments" label="Starter Investments" />' +
      '<XCUIElementTypeButton name="Top Starter investors&#10;Info&#10;Info" label="Top Starter investors&#10;Info&#10;Info" enabled="false" visible="true" accessible="true" x="7" y="317" width="296" height="30" />' +
      '<XCUIElementTypeOther name="1&#10;Investor One&#10;+210.00%&#10;All-Time" label="1&#10;Investor One&#10;+210.00%&#10;All-Time" enabled="true" visible="true" accessible="true" x="7" y="360" width="363" height="74" />' +
      '<XCUIElementTypeButton name="Top Starter portfolios&#10;Info&#10;Info" label="Top Starter portfolios&#10;Info&#10;Info" enabled="false" visible="true" accessible="true" x="7" y="625" width="296" height="30" />' +
      '<XCUIElementTypeButton name="See all&#10;See all" label="See all&#10;See all" enabled="true" visible="true" accessible="true" x="310" y="627" width="60" height="26" />' +
      '<XCUIElementTypeOther name="1&#10;First Portfolio&#10;Creator One&#10;+190.98%&#10;All-Time" label="1&#10;First Portfolio&#10;Creator One&#10;+190.98%&#10;All-Time" enabled="true" visible="true" accessible="true" x="7" y="671" width="363" height="74" />' +
      '<XCUIElementTypeOther name="2&#10;Second Portfolio&#10;Creator Two&#10;+80.12%&#10;All-Time" label="2&#10;Second Portfolio&#10;Creator Two&#10;+80.12%&#10;All-Time" enabled="true" visible="true" accessible="true" x="7" y="751" width="363" height="74" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" /></App>',
    coordinateTaps: { '48,807': 'home', '189,708': 'first-portfolio', '189,788': 'second-portfolio' },
    taps: {}
  },
  'first-portfolio': {
    source: '<App><StaticText name="First Portfolio detail" label="First Portfolio detail" /></App>',
    taps: {}
  },
  'second-portfolio': {
    source: '<App><StaticText name="Second Portfolio detail" label="Second Portfolio detail" /></App>',
    taps: {}
  }
};

const genericCommerceSectionGraph = {
  shop: {
    source:
      '<App><StaticText name="Shop" label="Shop" />' +
      '<Button name="Shop&#10;Shop" label="Shop&#10;Shop" x="9" y="787" width="96" height="40" />' +
      '<Button name="Catalog&#10;Catalog" label="Catalog&#10;Catalog" x="120" y="787" width="96" height="40" />' +
      '<Button name="Cart&#10;Cart" label="Cart&#10;Cart" x="231" y="787" width="96" height="40" /></App>',
    coordinateTaps: { '168,807': 'catalog', '279,807': 'cart' },
    taps: {}
  },
  catalog: {
    source:
      '<App><StaticText name="Catalog" label="Catalog" />' +
      '<XCUIElementTypeStaticText name="Featured products" label="Featured products" enabled="true" visible="true" accessible="true" x="20" y="160" width="180" height="28" />' +
      '<XCUIElementTypeOther name="Trail Jacket&#10;$120" label="Trail Jacket&#10;$120" enabled="true" visible="true" accessible="true" x="20" y="205" width="330" height="88" />' +
      '<XCUIElementTypeOther name="Canvas Tote&#10;$48" label="Canvas Tote&#10;$48" enabled="true" visible="true" accessible="true" x="20" y="305" width="330" height="88" />' +
      '<Button name="Shop&#10;Shop" label="Shop&#10;Shop" x="9" y="787" width="96" height="40" />' +
      '<Button name="Catalog&#10;Catalog" label="Catalog&#10;Catalog" x="120" y="787" width="96" height="40" />' +
      '<Button name="Cart&#10;Cart" label="Cart&#10;Cart" x="231" y="787" width="96" height="40" /></App>',
    coordinateTaps: { '57,807': 'shop', '185,249': 'trail-jacket', '185,349': 'canvas-tote' },
    taps: {}
  },
  cart: {
    source:
      '<App><StaticText name="Cart" label="Cart" />' +
      '<Button name="Shop&#10;Shop" label="Shop&#10;Shop" x="9" y="787" width="96" height="40" />' +
      '<Button name="Catalog&#10;Catalog" label="Catalog&#10;Catalog" x="120" y="787" width="96" height="40" />' +
      '<Button name="Cart&#10;Cart" label="Cart&#10;Cart" x="231" y="787" width="96" height="40" /></App>',
    coordinateTaps: { '57,807': 'shop', '168,807': 'catalog' },
    taps: {}
  },
  'trail-jacket': {
    source: '<App><StaticText name="Trail Jacket detail" label="Trail Jacket detail" /></App>',
    taps: {}
  },
  'canvas-tote': {
    source: '<App><StaticText name="Canvas Tote detail" label="Canvas Tote detail" /></App>',
    taps: {}
  }
};

function tabbedSource(body: string): string {
  return (
    '<App>' +
    body +
    '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="96" height="40" />' +
    '<Button name="Catalog&#10;Catalog" label="Catalog&#10;Catalog" x="120" y="787" width="96" height="40" />' +
    '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="231" y="787" width="96" height="40" />' +
    '</App>'
  );
}

const equivalentRestoreCrawlGraph = {
  home: {
    source: [
      tabbedSource(
        '<StaticText name="Home Feed" label="Home Feed" />' +
          '<StaticText name="Opening Snapshot A" label="Opening Snapshot A" />' +
          '<StaticText name="Opening Snapshot B" label="Opening Snapshot B" />' +
          '<StaticText name="Opening Snapshot C" label="Opening Snapshot C" />' +
          '<StaticText name="Opening Snapshot D" label="Opening Snapshot D" />' +
          '<StaticText name="Opening Snapshot E" label="Opening Snapshot E" />' +
          '<StaticText name="Opening Snapshot F" label="Opening Snapshot F" />' +
          '<StaticText name="Opening Snapshot G" label="Opening Snapshot G" />' +
          '<StaticText name="Opening Snapshot H" label="Opening Snapshot H" />'
      ),
      ...Array.from({ length: 6 }, () =>
        tabbedSource(
          '<StaticText name="Home Feed" label="Home Feed" />' +
            '<StaticText name="Refreshed Snapshot I" label="Refreshed Snapshot I" />' +
            '<StaticText name="Refreshed Snapshot J" label="Refreshed Snapshot J" />' +
            '<StaticText name="Refreshed Snapshot K" label="Refreshed Snapshot K" />' +
            '<StaticText name="Refreshed Snapshot L" label="Refreshed Snapshot L" />' +
            '<StaticText name="Refreshed Snapshot M" label="Refreshed Snapshot M" />' +
            '<StaticText name="Refreshed Snapshot N" label="Refreshed Snapshot N" />' +
            '<StaticText name="Refreshed Snapshot O" label="Refreshed Snapshot O" />' +
            '<StaticText name="Refreshed Snapshot P" label="Refreshed Snapshot P" />'
        )
      )
    ],
    coordinateTaps: { '168,807': 'catalog', '279,807': 'premium' },
    taps: {}
  },
  catalog: {
    source: tabbedSource('<StaticText name="Catalog Screen" label="Catalog Screen" />'),
    coordinateTaps: { '57,807': 'home', '279,807': 'premium' },
    taps: {}
  },
  premium: {
    source: tabbedSource('<StaticText name="Premium Screen" label="Premium Screen" />'),
    coordinateTaps: { '57,807': 'home', '168,807': 'catalog' },
    taps: {}
  }
};

const rootReplayRestoreCrawlGraph = {
  home: {
    source:
      tabbedSource(
        '<StaticText name="Dashboard Feed" label="Dashboard Feed" />' +
          '<StaticText name="Premium market note" label="Premium market note" />'
      ),
    coordinateTaps: { '168,807': 'catalog', '279,807': 'premium' },
    taps: {}
  },
  catalog: {
    source:
      tabbedSource(
        '<StaticText name="Catalog Screen" label="Catalog Screen" />' +
          '<XCUIElementTypeOther name="Trail Jacket&#10;$120" label="Trail Jacket&#10;$120" enabled="true" visible="true" accessible="true" x="20" y="205" width="330" height="88" />'
      ),
    coordinateTaps: { '185,249': 'product', '57,807': 'home', '279,807': 'premium' },
    taps: {}
  },
  product: {
    source:
      '<App><StaticText name="Trail Jacket detail" label="Trail Jacket detail" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="96" height="40" /></App>',
    coordinateTaps: { '57,807': 'home' },
    taps: {}
  },
  premium: {
    source: tabbedSource('<StaticText name="Premium Screen" label="Premium Screen" />'),
    coordinateTaps: { '57,807': 'home', '168,807': 'catalog' },
    taps: {}
  }
};

const settledDestinationCrawlGraph = {
  home: {
    source: tabbedSource('<StaticText name="Home Feed" label="Home Feed" />'),
    coordinateTaps: { '168,807': 'catalog' },
    taps: {}
  },
  catalog: {
    source: [
      '<App><StaticText name="Loading catalog" label="Loading catalog" /></App>',
      tabbedSource('<StaticText name="Catalog Ready" label="Catalog Ready" />')
    ],
    coordinateTaps: { '57,807': 'home' },
    taps: {}
  }
};

const hydratedDestinationCrawlGraph = {
  home: {
    source: tabbedSource('<StaticText name="Home Feed" label="Home Feed" />'),
    coordinateTaps: { '168,807': 'catalog' },
    taps: {}
  },
  catalog: {
    source: [
      tabbedSource('<StaticText name="Catalog Shell" label="Catalog Shell" />'),
      tabbedSource(
        '<StaticText name="Catalog Shell" label="Catalog Shell" />' +
          '<Button name="Loaded Details" label="Loaded Details" />'
      ),
      tabbedSource(
        '<StaticText name="Catalog Shell" label="Catalog Shell" />' +
          '<Button name="Loaded Details" label="Loaded Details" />'
      )
    ],
    coordinateTaps: { '57,807': 'home' },
    taps: { 'Loaded Details': 'detail' }
  },
  detail: {
    source: '<App><StaticText name="Loaded detail" label="Loaded detail" /></App>',
    taps: {}
  }
};

const scrollDiscoveryGraph = {
  home: {
    source:
      '<App><XCUIElementTypeScrollView name="Product list" label="Product list" enabled="true" visible="true" x="0" y="120" width="390" height="640" />' +
      '<StaticText name="Featured products" label="Featured products" x="20" y="590" width="240" height="28" /></App>',
    scrolls: { down: 'more' },
    taps: {}
  },
  more: {
    source:
      '<App><XCUIElementTypeScrollView name="Product list" label="Product list" enabled="true" visible="true" x="0" y="120" width="390" height="640" />' +
      '<Button name="Hidden CTA" label="Hidden CTA" x="20" y="620" width="300" height="56" /></App>',
    scrolls: { up: 'home' },
    coordinateTaps: { '170,648': 'detail' },
    taps: { 'Hidden CTA': 'detail' }
  },
  detail: {
    source:
      '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" />' +
      '<StaticText name="Hidden CTA detail" label="Hidden CTA detail" /></App>',
    coordinateTaps: { '40,90': 'more' },
    taps: { Back: 'more' }
  }
};

const scrollPriorityGraph = {
  home: {
    source:
      '<App><XCUIElementTypeScrollView enabled="true" visible="true" x="0" y="120" width="390" height="640" />' +
      '<Button name="Visible Card" label="Visible Card" x="20" y="220" width="300" height="56" /></App>',
    scrolls: { down: 'more' },
    coordinateTaps: { '170,248': 'visible-detail' },
    taps: { 'Visible Card': 'visible-detail' }
  },
  more: {
    source:
      '<App><XCUIElementTypeScrollView enabled="true" visible="true" x="0" y="120" width="390" height="640" />' +
      '<Button name="Hidden CTA" label="Hidden CTA" x="20" y="620" width="300" height="56" /></App>',
    scrolls: { up: 'home' },
    coordinateTaps: { '170,648': 'hidden-detail' },
    taps: { 'Hidden CTA': 'hidden-detail' }
  },
  'visible-detail': {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /></App>',
    coordinateTaps: { '40,90': 'home' },
    taps: { Back: 'home' }
  },
  'hidden-detail': {
    source: '<App><StaticText name="Hidden CTA detail" label="Hidden CTA detail" /></App>',
    taps: {}
  }
};

const repeatedPortfolioCardsGraph = {
  home: {
    source:
      '<App><StaticText name="Top portfolios" label="Top portfolios" x="20" y="150" width="220" height="30" />' +
      '<XCUIElementTypeOther name="1&#10;Alpha Growth&#10;Creator One&#10;+42%" label="1&#10;Alpha Growth&#10;Creator One&#10;+42%" enabled="true" visible="true" accessible="true" x="20" y="200" width="350" height="90" />' +
      '<XCUIElementTypeOther name="2&#10;Beta Income&#10;Creator Two&#10;+21%" label="2&#10;Beta Income&#10;Creator Two&#10;+21%" enabled="true" visible="true" accessible="true" x="20" y="310" width="350" height="90" />' +
      '<XCUIElementTypeOther name="3&#10;Gamma Value&#10;Creator Three&#10;+9%" label="3&#10;Gamma Value&#10;Creator Three&#10;+9%" enabled="true" visible="true" accessible="true" x="20" y="420" width="350" height="90" /></App>',
    coordinateTaps: {
      '195,245': 'alpha',
      '195,355': 'beta',
      '195,465': 'gamma'
    },
    taps: {}
  },
  alpha: {
    source:
      '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" />' +
      '<StaticText name="Alpha Growth" label="Alpha Growth" />' +
      '<Button name="Performance" label="Performance" x="20" y="260" width="150" height="44" />' +
      '<Button name="Activity" label="Activity" x="190" y="260" width="150" height="44" /></App>',
    coordinateTaps: { '40,90': 'home', '95,282': 'alpha-performance', '265,282': 'alpha-activity' },
    taps: {}
  },
  beta: {
    source:
      '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" />' +
      '<StaticText name="Beta Income" label="Beta Income" />' +
      '<Button name="Performance" label="Performance" x="20" y="260" width="150" height="44" />' +
      '<Button name="Activity" label="Activity" x="190" y="260" width="150" height="44" /></App>',
    coordinateTaps: { '40,90': 'home', '95,282': 'beta-performance', '265,282': 'beta-activity' },
    taps: {}
  },
  gamma: {
    source:
      '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" />' +
      '<StaticText name="Gamma Value" label="Gamma Value" />' +
      '<Button name="Performance" label="Performance" x="20" y="260" width="150" height="44" />' +
      '<Button name="Activity" label="Activity" x="190" y="260" width="150" height="44" /></App>',
    coordinateTaps: { '40,90': 'home', '95,282': 'gamma-performance', '265,282': 'gamma-activity' },
    taps: {}
  },
  'alpha-performance': {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /><StaticText name="Alpha performance" label="Alpha performance" /></App>',
    coordinateTaps: { '40,90': 'alpha' },
    taps: {}
  },
  'alpha-activity': {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /><StaticText name="Alpha activity" label="Alpha activity" /></App>',
    coordinateTaps: { '40,90': 'alpha' },
    taps: {}
  },
  'beta-performance': {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /><StaticText name="Beta performance" label="Beta performance" /></App>',
    coordinateTaps: { '40,90': 'beta' },
    taps: {}
  },
  'beta-activity': {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /><StaticText name="Beta activity" label="Beta activity" /></App>',
    coordinateTaps: { '40,90': 'beta' },
    taps: {}
  },
  'gamma-performance': {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /><StaticText name="Gamma performance" label="Gamma performance" /></App>',
    coordinateTaps: { '40,90': 'gamma' },
    taps: {}
  },
  'gamma-activity': {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /><StaticText name="Gamma activity" label="Gamma activity" /></App>',
    coordinateTaps: { '40,90': 'gamma' },
    taps: {}
  }
};

const activityActionAffordanceGraph = {
  activity: {
    source:
      '<App><StaticText name="Activity" label="Activity" x="20" y="92" width="160" height="30" />' +
      '<StaticText name="For You" label="For You" x="20" y="140" width="120" height="28" />' +
      '<XCUIElementTypeOther name="Feed Post&#10;Creator One&#10;Bought AAPL" label="Feed Post&#10;Creator One&#10;Bought AAPL" enabled="true" visible="true" accessible="true" x="20" y="190" width="350" height="180" />' +
      '<Button name="Like activity&#10;Like activity" label="Like activity&#10;Like activity" x="28" y="382" width="64" height="44" />' +
      '<Button name="Comment on activity&#10;Comment on activity" label="Comment on activity&#10;Comment on activity" x="112" y="382" width="92" height="44" />' +
      '<Button name="Share activity&#10;Share activity" label="Share activity&#10;Share activity" x="224" y="382" width="74" height="44" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Activity&#10;Activity" label="Activity&#10;Activity" x="316" y="787" width="77" height="40" /></App>',
    coordinateTaps: {},
    taps: {}
  }
};

const sectionFirstDuplicateVariantGraph = {
  ...sectionFirstGraph,
  'starter-duplicate': {
    source:
      '<App><StaticText name="Starter Investments" label="Starter Investments" />' +
      '<StaticText name="Duplicate snapshot marker" label="Duplicate snapshot marker" />' +
      '<XCUIElementTypeButton name="Top Starter portfolios&#10;Info&#10;Info" label="Top Starter portfolios&#10;Info&#10;Info" enabled="false" visible="true" accessible="true" x="7" y="625" width="296" height="30" />' +
      '<XCUIElementTypeButton name="See all&#10;See all" label="See all&#10;See all" enabled="true" visible="true" accessible="true" x="310" y="627" width="60" height="26" />' +
      '<XCUIElementTypeOther name="1&#10;First Portfolio Snapshot&#10;Creator One&#10;+190.98%&#10;All-Time" label="1&#10;First Portfolio Snapshot&#10;Creator One&#10;+190.98%&#10;All-Time" enabled="true" visible="true" accessible="true" x="7" y="671" width="363" height="74" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" /></App>',
    coordinateTaps: { '48,807': 'home' },
    taps: {}
  }
};

const sectionFirstIncidentalActivityGraph = {
  home: {
    source:
      '<App><StaticText name="Three ways to get started" label="Three ways to get started" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" />' +
      '<Button name="Activity&#10;Activity" label="Activity&#10;Activity" x="316" y="787" width="77" height="40" /></App>',
    coordinateTaps: { '124,807': 'starter', '355,807': 'activity' },
    taps: {}
  },
  starter: sectionFirstGraph.starter,
  activity: {
    source:
      '<App><StaticText name="For You" label="For You" />' +
      '<XCUIElementTypeButton name="Top Starter portfolios&#10;Info&#10;Info" label="Top Starter portfolios&#10;Info&#10;Info" enabled="false" visible="true" accessible="true" x="7" y="625" width="296" height="30" />' +
      '<XCUIElementTypeOther name="1&#10;Activity Echo Portfolio&#10;Creator Echo&#10;+190.98%&#10;All-Time" label="1&#10;Activity Echo Portfolio&#10;Creator Echo&#10;+190.98%&#10;All-Time" enabled="true" visible="true" accessible="true" x="7" y="671" width="363" height="74" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" />' +
      '<Button name="Activity&#10;Activity" label="Activity&#10;Activity" x="316" y="787" width="77" height="40" /></App>',
    coordinateTaps: { '48,807': 'home', '124,807': 'starter', '189,708': 'activity-echo-detail' },
    taps: {}
  },
  'first-portfolio': sectionFirstGraph['first-portfolio'],
  'activity-echo-detail': {
    source: '<App><StaticText name="Activity echo detail" label="Activity echo detail" /></App>',
    taps: {}
  }
};

const sectionFirstRouteControlGraph = {
  home: {
    source:
      '<App><StaticText name="Three ways to get started" label="Three ways to get started" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" />' +
      '<Button name="Activity&#10;Activity" label="Activity&#10;Activity" x="316" y="787" width="77" height="40" /></App>',
    coordinateTaps: { '124,807': 'starter', '355,807': 'activity-stale' },
    taps: {}
  },
  starter: sectionFirstGraph.starter,
  'activity-stale': {
    source:
      '<App><StaticText name="Starter Investments" label="Starter Investments" />' +
      '<StaticText name="Stale activity snapshot" label="Stale activity snapshot" />' +
      '<StaticText name="One more stale activity marker" label="One more stale activity marker" />' +
      '<XCUIElementTypeButton name="Top Starter portfolios&#10;Info&#10;Info" label="Top Starter portfolios&#10;Info&#10;Info" enabled="false" visible="true" accessible="true" x="7" y="625" width="296" height="30" />' +
      '<XCUIElementTypeOther name="1&#10;Activity Echo Portfolio&#10;Creator Echo&#10;+190.98%&#10;All-Time" label="1&#10;Activity Echo Portfolio&#10;Creator Echo&#10;+190.98%&#10;All-Time" enabled="true" visible="true" accessible="true" x="7" y="671" width="363" height="74" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" />' +
      '<Button name="Activity&#10;Activity" label="Activity&#10;Activity" x="316" y="787" width="77" height="40" /></App>',
    coordinateTaps: { '48,807': 'home', '124,807': 'starter', '189,708': 'activity-echo-detail' },
    taps: {}
  },
  'first-portfolio': sectionFirstGraph['first-portfolio'],
  'activity-echo-detail': {
    source: '<App><StaticText name="Activity echo detail" label="Activity echo detail" /></App>',
    taps: {}
  }
};

const sectionFirstShorterWrongTabGraph = {
  home: {
    source:
      '<App><StaticText name="Three ways to get started" label="Three ways to get started" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" />' +
      '<Button name="Activity&#10;Activity" label="Activity&#10;Activity" x="316" y="787" width="77" height="40" /></App>',
    coordinateTaps: { '124,807': 'starter-shell', '355,807': 'activity-stale' },
    taps: {}
  },
  'starter-shell': {
    source:
      '<App><StaticText name="Starter Investments" label="Starter Investments" />' +
      '<StaticText name="Starter shell without loaded section" label="Starter shell without loaded section" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" />' +
      '<Button name="Activity&#10;Activity" label="Activity&#10;Activity" x="316" y="787" width="77" height="40" /></App>',
    coordinateTaps: { '48,807': 'home', '124,807': 'starter' },
    taps: {}
  },
  starter: sectionFirstGraph.starter,
  'activity-stale': {
    source:
      '<App><StaticText name="Activity" label="Activity" />' +
      '<StaticText name="For You" label="For You" />' +
      '<XCUIElementTypeButton name="Top Starter portfolios&#10;Info&#10;Info" label="Top Starter portfolios&#10;Info&#10;Info" enabled="false" visible="true" accessible="true" x="7" y="625" width="296" height="30" />' +
      '<XCUIElementTypeOther name="1&#10;Activity Echo Portfolio&#10;Creator Echo&#10;+190.98%&#10;All-Time" label="1&#10;Activity Echo Portfolio&#10;Creator Echo&#10;+190.98%&#10;All-Time" enabled="true" visible="true" accessible="true" x="7" y="671" width="363" height="74" />' +
      '<Button name="Home&#10;Home" label="Home&#10;Home" x="9" y="787" width="77" height="40" />' +
      '<Button name="Starter&#10;Starter" label="Starter&#10;Starter" x="85" y="787" width="78" height="40" />' +
      '<Button name="Premium&#10;Premium" label="Premium&#10;Premium" x="162" y="787" width="78" height="40" />' +
      '<Button name="Activity&#10;Activity" label="Activity&#10;Activity" x="316" y="787" width="77" height="40" /></App>',
    coordinateTaps: { '48,807': 'home', '124,807': 'starter-shell', '189,708': 'activity-echo-detail' },
    taps: {}
  },
  'first-portfolio': sectionFirstGraph['first-portfolio'],
  'activity-echo-detail': {
    source: '<App><StaticText name="Activity echo detail" label="Activity echo detail" /></App>',
    taps: {}
  }
};

const crawlCandidateFilterGraph = {
  home: {
    source: [
      '<App>',
      '<XCUIElementTypeButton name="Top Starter portfolios&#10;Info&#10;Info" label="Top Starter portfolios&#10;Info&#10;Info" enabled="false" visible="true" accessible="true" x="20" y="120" width="295" height="30" />',
      '<XCUIElementTypeImage name="Premium creator badge" label="Premium creator badge" enabled="true" visible="true" accessible="true" x="200" y="120" width="15" height="15" />',
      '<XCUIElementTypeStaticText name="Capital" label="Capital" enabled="true" visible="true" accessible="true" x="20" y="160" width="80" height="20" />',
      '<XCUIElementTypeOther name="Portfolio Card&#10;Capital&#10;$1.0K" label="Portfolio Card&#10;Capital&#10;$1.0K" enabled="true" visible="true" accessible="true" x="20" y="200" width="160" height="120" />',
      '</App>'
    ].join(''),
    taps: { 'Portfolio Card\nCapital\n$1.0K': 'portfolio' },
    coordinateTaps: { '100,260': 'portfolio' }
  },
  portfolio: {
    source: '<App><XCUIElementTypeButton name="Back&#10;Portfolio Card&#10;Back" label="Back&#10;Portfolio Card&#10;Back" enabled="true" visible="true" accessible="true" x="0" y="73" width="300" height="34" /></App>',
    taps: { Back: 'home' },
    coordinateTaps: { '40,90': 'home' }
  }
};

const riskyIncludedCrawlGraph = {
  home: {
    source:
      '<App><Button name="Help" label="Help" x="20" y="140" width="150" height="44" />' +
      '<Button name="Delete" label="Delete" x="20" y="200" width="150" height="44" /></App>',
    taps: { Help: 'help', Delete: 'deleted' },
    coordinateTaps: { '95,162': 'help', '95,222': 'deleted' }
  },
  help: {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /></App>',
    taps: { Back: 'home' },
    coordinateTaps: { '40,90': 'home' }
  },
  deleted: {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /></App>',
    taps: { Back: 'home' },
    coordinateTaps: { '40,90': 'home' }
  }
};

const destructiveRiskyCrawlGraph = {
  home: {
    source:
      '<App><Button name="Delete" label="Delete" x="20" y="140" width="150" height="44" />' +
      '<Button name="Logout" label="Logout" x="20" y="200" width="150" height="44" />' +
      '<Button name="Purchase" label="Purchase" x="20" y="260" width="150" height="44" />' +
      '<Button name="Confirm" label="Confirm" x="20" y="320" width="150" height="44" /></App>',
    taps: { Delete: 'deleted', Logout: 'logged_out', Purchase: 'purchased', Confirm: 'confirmed' },
    coordinateTaps: { '95,162': 'deleted', '95,222': 'logged_out', '95,282': 'purchased', '95,342': 'confirmed' }
  },
  deleted: {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /></App>',
    taps: { Back: 'home' },
    coordinateTaps: { '40,90': 'home' }
  },
  logged_out: {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /></App>',
    taps: { Back: 'home' },
    coordinateTaps: { '40,90': 'home' }
  },
  purchased: {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /></App>',
    taps: { Back: 'home' },
    coordinateTaps: { '40,90': 'home' }
  },
  confirmed: {
    source: '<App><Button name="Back" label="Back" x="0" y="73" width="90" height="34" /></App>',
    taps: { Back: 'home' },
    coordinateTaps: { '40,90': 'home' }
  }
};

describe('app map execution', () => {
  it('annotates the current observed screen and merges source action metadata without executing it', async () => {
    const mapRoot = appMapDir();
    const adapter = new ScreenGraphAdapter(graph);
    const discovery = await discoverAppMap(adapter, {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.annotated',
      annotation: {
        screen: {
          label: 'App home',
          purpose: 'Provides entry points to the main app areas',
          description: 'The initial screen after launch',
          notes: ['Global navigation starts here']
        },
        actions: [
          {
            command: 'tap',
            args: { target: 'Settings' },
            label: 'Open app settings',
            intent: 'open_settings',
            safety: 'safe',
            description: 'Opens configuration controls',
            notes: ['Safe to inspect']
          }
        ]
      }
    });

    expect(discovery).toMatchObject({
      annotation: {
        screen_applied: true,
        actions_inserted: 0,
        actions_updated: 0,
        actions_merged: 1
      }
    });
    expect(adapter.actions).toEqual(['source:home']);

    const snapshot = mapDebugSnapshot(mapRoot, 'ios', 'com.example.annotated') as {
      screens: Array<Record<string, unknown>>;
      variants: Array<{ actions: Array<Record<string, unknown>> } & Record<string, unknown>>;
    };
    expect(snapshot.screens[0]).toMatchObject({
      label: 'App home',
      purpose: 'Provides entry points to the main app areas'
    });
    expect(snapshot.variants[0]).toMatchObject({
      label: 'App home',
      purpose: 'Provides entry points to the main app areas',
      description: 'The initial screen after launch',
      notes: ['Global navigation starts here']
    });
    expect(snapshot.variants[0]?.actions[0]).toMatchObject({
      command: 'tap',
      args: { target: 'Settings' },
      label: 'Open app settings',
      intent: 'open_settings',
      safety: 'safe',
      description: 'Opens configuration controls',
      notes: ['Safe to inspect'],
      source: { tag: 'Button' }
    });
  });

  it('stores unmatched risky actions as ordinary map facts without executing them', async () => {
    const mapRoot = appMapDir();
    const adapter = new ScreenGraphAdapter(graph);
    const discovery = await discoverAppMap(adapter, {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.risky-annotation',
      annotation: {
        actions: [
          {
            command: 'tap',
            args: { target: 'text=Delete account' },
            label: 'Delete account',
            intent: 'delete_account',
            safety: 'risky',
            notes: ['Requires explicit user authorization']
          }
        ]
      }
    });

    expect(discovery).toMatchObject({
      annotation: {
        screen_applied: false,
        actions_inserted: 1,
        actions_updated: 0,
        actions_merged: 0
      }
    });
    expect(adapter.actions).toEqual(['source:home']);

    const snapshot = mapDebugSnapshot(mapRoot, 'ios', 'com.example.risky-annotation') as {
      variants: Array<{ actions: Array<Record<string, unknown>> }>;
    };
    expect(snapshot.variants[0]?.actions).toContainEqual({
      command: 'tap',
      args: { target: 'text=Delete account' },
      label: 'Delete account',
      intent: 'delete_account',
      safety: 'risky',
      notes: ['Requires explicit user authorization']
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/provenance|matched|agent_supplied/);
  });

  it('preserves annotations across observations and applies idempotent semantic updates', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.annotation-updates'
    };
    const firstAnnotation = {
      screen: {
        label: 'App home',
        purpose: 'Provides entry points to the app'
      },
      actions: [
        {
          command: 'tap' as const,
          args: { target: 'Settings' },
          label: 'Open settings',
          intent: 'open_settings',
          safety: 'safe' as const,
          description: 'Opens configuration controls',
          notes: ['Global action']
        }
      ]
    };

    await discoverAppMap(new ScreenGraphAdapter(graph), { ...mapOptions, annotation: firstAnnotation });
    await discoverAppMap(new ScreenGraphAdapter(graph), mapOptions);
    const update = await discoverAppMap(new ScreenGraphAdapter(graph), {
      ...mapOptions,
      annotation: {
        actions: [
          {
            command: 'tap',
            args: { target: 'Settings' },
            label: 'Open app settings',
            intent: 'open_app_settings',
            safety: 'safe'
          }
        ]
      }
    });
    const retry = await discoverAppMap(new ScreenGraphAdapter(graph), {
      ...mapOptions,
      annotation: {
        actions: [
          {
            command: 'tap',
            args: { target: 'Settings' },
            label: 'Open app settings',
            intent: 'open_app_settings',
            safety: 'safe'
          }
        ]
      }
    });

    expect(update).toMatchObject({
      annotation: {
        actions_inserted: 0,
        actions_updated: 1,
        actions_merged: 0
      }
    });
    expect(retry).toMatchObject({
      annotation: {
        actions_inserted: 0,
        actions_updated: 0,
        actions_merged: 0
      }
    });

    const snapshot = mapDebugSnapshot(mapRoot, 'ios', 'com.example.annotation-updates') as {
      screens: Array<Record<string, unknown>>;
      variants: Array<{ actions: Array<Record<string, unknown>> } & Record<string, unknown>>;
    };
    expect(snapshot.screens[0]).toMatchObject({
      label: 'App home',
      purpose: 'Provides entry points to the app'
    });
    expect(snapshot.variants[0]).toMatchObject({
      label: 'App home',
      purpose: 'Provides entry points to the app'
    });
    expect(snapshot.variants[0]?.actions).toHaveLength(1);
    expect(snapshot.variants[0]?.actions[0]).toMatchObject({
      label: 'Open app settings',
      intent: 'open_app_settings',
      description: 'Opens configuration controls',
      notes: ['Global action'],
      source: { tag: 'Button' }
    });
  });

  it('redacts annotation text and removes value-bearing action arguments', async () => {
    const mapRoot = appMapDir();
    await discoverAppMap(new ScreenGraphAdapter(privateFormGraph), {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.private-annotation',
      annotation: {
        screen: {
          label: 'Account for person@example.com',
          purpose: 'Collect contact details for +1 (212) 555-0100',
          notes: ['Never retain 4111 1111 1111 1111']
        },
        actions: [
          {
            command: 'act',
            args: {
              name: 'type',
              target: 'Email',
              value: 'private@example.com'
            },
            label: 'Enter person@example.com',
            intent: 'enter_contact_email',
            safety: 'needs-input'
          }
        ]
      }
    });

    const snapshot = mapDebugSnapshot(mapRoot, 'ios', 'com.example.private-annotation') as {
      variants: Array<{ actions: Array<Record<string, unknown>> }>;
    };
    const persisted = JSON.stringify(snapshot);
    expect(persisted).toContain('<redacted-email>');
    expect(persisted).toContain('<redacted-phone>');
    expect(persisted).toContain('<redacted-card>');
    expect(persisted).not.toContain('person@example.com');
    expect(persisted).not.toContain('private@example.com');
    expect(persisted).not.toContain('212) 555-0100');
    expect(persisted).not.toContain('4111 1111 1111 1111');
    expect(snapshot.variants[0]?.actions).toContainEqual(
      expect.objectContaining({
        command: 'act',
        args: {
          name: 'type',
          target: 'Email'
        },
        label: 'Enter <redacted-email>'
      })
    );
  });

  it('promotes stable semantics to similar variants but not materially different screens', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.logical-screen'
    };

    await discoverAppMap(new ScreenGraphAdapter(annotatedVariantGraph, 'loaded'), {
      ...mapOptions,
      annotation: {
        screen: {
          label: 'Account settings',
          purpose: 'Configures account preferences'
        }
      }
    });
    await discoverAppMap(new ScreenGraphAdapter(annotatedVariantGraph, 'error'), mapOptions);
    await discoverAppMap(new ScreenGraphAdapter(annotatedVariantGraph, 'payment'), mapOptions);

    const snapshot = mapDebugSnapshot(mapRoot, 'ios', 'com.example.logical-screen') as {
      screens: Array<Record<string, unknown>>;
      variants: Array<Record<string, unknown>>;
    };
    expect(snapshot.screens).toHaveLength(2);
    expect(snapshot.variants).toHaveLength(3);
    expect(snapshot.variants[0]?.screen_id).toBe(snapshot.variants[1]?.screen_id);
    expect(snapshot.variants[1]).toMatchObject({
      label: 'Account settings',
      purpose: 'Configures account preferences'
    });
    expect(snapshot.variants[2]?.screen_id).not.toBe(snapshot.variants[0]?.screen_id);
    expect(snapshot.variants[2]).not.toHaveProperty('label');
    expect(snapshot.variants[2]).not.toHaveProperty('purpose');
  });

  it('keeps conflicting sibling semantics variant-specific instead of overwriting the logical screen', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.variant-specific-semantics'
    };
    await discoverAppMap(new ScreenGraphAdapter(annotatedVariantGraph, 'loaded'), {
      ...mapOptions,
      annotation: {
        screen: {
          label: 'Account settings',
          purpose: 'Configures account preferences'
        }
      }
    });
    await discoverAppMap(new ScreenGraphAdapter(annotatedVariantGraph, 'error'), mapOptions);
    await discoverAppMap(new ScreenGraphAdapter(annotatedVariantGraph, 'error'), {
      ...mapOptions,
      annotation: {
        screen: {
          label: 'Account settings error',
          purpose: 'Retry account settings after a failed load'
        }
      }
    });

    const snapshot = mapDebugSnapshot(mapRoot, 'ios', 'com.example.variant-specific-semantics') as {
      screens: Array<Record<string, unknown>>;
      variants: Array<Record<string, unknown>>;
    };
    expect(snapshot.screens).toHaveLength(1);
    expect(snapshot.screens[0]).toMatchObject({
      label: 'Account settings',
      purpose: 'Configures account preferences'
    });
    expect(snapshot.variants[0]).toMatchObject({
      label: 'Account settings',
      purpose: 'Configures account preferences'
    });
    expect(snapshot.variants[1]).toMatchObject({
      label: 'Account settings error',
      purpose: 'Retry account settings after a failed load'
    });
  });

  it('binds annotations to the initial observation before an optional crawl changes screens', async () => {
    const mapRoot = appMapDir();
    const discovery = await discoverAppMap(new ScreenGraphAdapter(graph), {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.annotate-before-crawl',
      crawl: true,
      crawlDepth: 1,
      crawlLimit: 1,
      crawlSettleMs: 0,
      annotation: {
        screen: {
          label: 'App home',
          purpose: 'Provides the app entry point'
        }
      }
    });

    expect(discovery).toMatchObject({
      screen: { variant_id: 'variant_1' },
      annotation: { screen_applied: true },
      crawl: { enabled: true, actions: 1 }
    });
    const snapshot = mapDebugSnapshot(mapRoot, 'ios', 'com.example.annotate-before-crawl') as {
      variants: Array<Record<string, unknown>>;
    };
    expect(snapshot.variants[0]).toMatchObject({
      id: 'variant_1',
      label: 'App home',
      purpose: 'Provides the app entry point'
    });
    expect(snapshot.variants[1]).not.toHaveProperty('label');
  });

  it('adds annotations to a pre-annotation map without losing existing map records', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.pre-annotation-map'
    };
    const context = createAppMapContext(new ScreenGraphAdapter(graph), mapOptions);
    expect(context).not.toBeNull();
    const legacyFixture = fs.readFileSync(
      new URL('./fixtures/pre-annotation-app-map.json', import.meta.url),
      'utf8'
    );
    fs.writeFileSync(context!.filePath, legacyFixture, 'utf8');
    const before = JSON.parse(legacyFixture) as {
      screens: unknown[];
      variants: unknown[];
      edges: unknown[];
    };

    await discoverAppMap(new ScreenGraphAdapter(graph), {
      ...mapOptions,
      annotation: {
        screen: {
          label: 'App home',
          purpose: 'Provides the app entry point'
        }
      }
    });
    const after = mapDebugSnapshot(mapRoot, 'ios', 'com.example.pre-annotation-map') as {
      screens: Array<Record<string, unknown>>;
      variants: unknown[];
      edges: unknown[];
    };

    expect(after.screens).toHaveLength(before.screens.length);
    expect(after.variants).toHaveLength(before.variants.length);
    expect(after.edges).toHaveLength(before.edges.length);
    expect(after.edges).toContainEqual(expect.objectContaining({ id: 'edge_legacy_home_settings' }));
    expect(after.screens[0]).toMatchObject({
      label: 'App home',
      purpose: 'Provides the app entry point'
    });
  });

  it('crawls safe controls during discovery so later runs can route through them', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.crawl',
      crawl: true,
      crawlDepth: 2
    };

    const crawlAdapter = new ScreenGraphAdapter(graph);
    const discovery = await discoverAppMap(crawlAdapter, mapOptions);

    expect(discovery).toMatchObject({
      action: 'discover',
      crawl: {
        enabled: true,
        actions: 2
      }
    });

    const routedAdapter = new ScreenGraphAdapter(graph);
    const routedRun = await runScenario(
      scenarioWithTap('Advanced'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'tap:Settings',
      'source:settings',
      'tap:Advanced',
      'source:advanced'
    ]);
    expect(routedRun.map?.used).toBe(true);
  });

  it('crawls enabled tappable cards but ignores disabled headings and static media', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.crawl-filter',
      crawl: true,
      crawlDepth: 1,
      crawlLimit: 4,
      crawlSettleMs: 0
    };

    const adapter = new ScreenGraphAdapter(crawlCandidateFilterGraph);
    const discovery = await discoverAppMap(adapter, mapOptions);

    expect(discovery).toMatchObject({
      crawl: {
        actions: 1
      }
    });
    expect(adapter.actions).toEqual([
      'source:home',
      'tap:100,260',
      'source:portfolio',
      'tap:40,90',
      'source:home'
    ]);
  });

  it('honors app-map crawl include and risky opt-in options through public APIs', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.risky-included-crawl',
      crawl: true,
      crawlDepth: 1,
      crawlLimit: 4,
      crawlSettleMs: 0,
      crawlInclude: ['Delete'],
      crawlAllowRisky: true
    };

    const context = createAppMapContext(new ScreenGraphAdapter(riskyIncludedCrawlGraph), mapOptions);
    expect(context?.options).toMatchObject({
      crawlInclude: ['Delete'],
      crawlAllowRisky: true
    });

    const adapter = new ScreenGraphAdapter(riskyIncludedCrawlGraph);
    const discovery = await discoverAppMap(adapter, mapOptions);

    expect(discovery).toMatchObject({
      crawl: {
        actions: 1
      }
    });
    expect(adapter.actions).toEqual([
      'source:home',
      'tap:95,222',
      'source:deleted',
      'tap:40,90',
      'source:home'
    ]);
  });

  it('does not crawl destructive controls unless risky crawling is explicitly allowed', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.destructive-risky-crawl',
      crawl: true,
      crawlDepth: 1,
      crawlLimit: 4,
      crawlSettleMs: 0
    };

    const defaultAdapter = new ScreenGraphAdapter(destructiveRiskyCrawlGraph);
    const defaultDiscovery = await discoverAppMap(defaultAdapter, mapOptions);

    expect(defaultDiscovery).toMatchObject({
      crawl: {
        actions: 0
      }
    });
    expect(defaultAdapter.actions).toEqual(['source:home']);

    const optedInAdapter = new ScreenGraphAdapter(destructiveRiskyCrawlGraph);
    const optedInDiscovery = await discoverAppMap(optedInAdapter, {
      ...mapOptions,
      appId: 'com.example.destructive-risky-crawl-opt-in',
      crawlAllowRisky: true,
      crawlInclude: ['Confirm']
    });

    expect(optedInDiscovery).toMatchObject({
      crawl: {
        actions: 1
      }
    });
    expect(optedInAdapter.actions).toEqual([
      'source:home',
      'tap:95,342',
      'source:confirmed',
      'tap:40,90',
      'source:home'
    ]);
  });

  it('persists and uses coordinate exit recipes for Flutter-style back controls', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.exit-recipes',
      crawl: true,
      crawlDepth: 1,
      crawlLimit: 1,
      crawlSettleMs: 0
    };

    const adapter = new ScreenGraphAdapter(crawlCandidateFilterGraph);
    const discovery = await discoverAppMap(adapter, mapOptions);
    const crawl = discovery.crawl as {
      restore_diagnostics?: Array<{
        attempts: Array<{ strategy: string; target?: string; command?: string }>;
      }>;
    };

    expect(crawl.restore_diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempts: expect.arrayContaining([
            expect.objectContaining({
              strategy: 'exit-recipe',
              command: 'tap',
              target: 'x=40,y=90'
            })
          ])
        })
      ])
    );

    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const persisted = JSON.parse(fs.readFileSync(path.join(mapRoot, mapFile), 'utf8')) as {
      variants: Array<{
        exit_recipes?: Array<{ command: string; target?: string; args: Record<string, unknown> }>;
      }>;
    };
    const exitRecipes = persisted.variants.flatMap((variant) => variant.exit_recipes ?? []);

    expect(exitRecipes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'tap',
          target: 'x=40,y=90',
          args: { x: 40, y: 90 }
        })
      ])
    );
    expect(adapter.actions).not.toContain('act:back');
  });

  it('returns observation metadata for mapped direct and scenario actions', async () => {
    const directContext = createAppMapContext(
      new ScreenGraphAdapter(graph),
      {
        enabled: true,
        rootDir: appMapDir(),
        appId: 'com.example.direct-observation'
      }
    );
    const directDetails = await runMappedCommand(directContext!, 'tap', { target: 'Settings' });

    expect(directDetails.observation).toMatchObject({
      screen_changed: true,
      current: {
        variant_id: 'variant_2',
        screen_id: 'screen_2'
      },
      visible_text_count: 1
    });
    expect(directDetails.observation).not.toHaveProperty('visible_text');
    expect((directDetails.observation as { before_fingerprint?: unknown }).before_fingerprint).toEqual(expect.any(String));
    expect((directDetails.observation as { after_fingerprint?: unknown }).after_fingerprint).toEqual(expect.any(String));

    const scenarioRun = await runScenario(
      scenarioWithTap('Settings'),
      new ScreenGraphAdapter(graph),
      'simulator',
      undefined,
      undefined,
      true,
      {
        enabled: true,
        rootDir: appMapDir(),
        appId: 'com.example.scenario-observation'
      }
    );

    expect(scenarioRun.status).toBe('ok');
    expect(scenarioRun.steps[0]?.details.observation).toMatchObject({
      screen_changed: true,
      current: {
        variant_id: 'variant_2',
        screen_id: 'screen_2'
      },
      visible_text_count: 1
    });
    expect(scenarioRun.steps[0]?.details.observation).not.toHaveProperty('visible_text');
  });

  it('prioritizes bottom navigation during crawl and restores through target tabs', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.bottom-nav-crawl',
      crawl: true,
      crawlDepth: 1,
      crawlLimit: 2,
      crawlSettleMs: 0
    };

    const adapter = new ScreenGraphAdapter(bottomNavCrawlGraph);
    const discovery = await discoverAppMap(adapter, mapOptions);

    expect(discovery).toMatchObject({
      crawl: {
        actions: 2,
        stopped_reason: 'limit'
      }
    });
    expect(adapter.actions).toEqual([
      'source:home',
      'tap:124,807',
      'source:starter',
      'tap:48,807',
      'source:home',
      'tap:201,807',
      'source:premium',
      'tap:48,807',
      'source:home'
    ]);
  });

  it('prioritizes content cards on discovered tab pages so routes can reach nested targets', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.premium-investor-crawl',
      crawl: true,
      crawlDepth: 2,
      crawlLimit: 4,
      crawlSettleMs: 0
    };

    const discoveryAdapter = new ScreenGraphAdapter(premiumInvestorCrawlGraph);
    const discovery = await discoverAppMap(discoveryAdapter, mapOptions);

    expect(discovery).toMatchObject({
      crawl: {
        stopped_reason: 'limit'
      }
    });
    expect(discoveryAdapter.actions).toEqual([
      'source:home',
      'tap:124,807',
      'source:starter',
      'tap:195,270',
      'source:baby',
      'tap:40,90',
      'source:starter',
      'tap:48,807',
      'source:home',
      'tap:201,807',
      'source:premium',
      'tap:195,405',
      'source:profile',
      'tap:40,90',
      'source:premium',
      'tap:48,807',
      'source:home'
    ]);

    const routedAdapter = new ScreenGraphAdapter(premiumInvestorCrawlGraph);
    const routedRun = await runScenario(
      scenarioWithTap('text~=Trade Activity'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'tap:201,807',
      'source:premium',
      'tap:195,405',
      'source:profile',
      'tap:270,322',
      'source:activity'
    ]);
    expect(routedRun.map?.used).toBe(true);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [
        { command: 'tap', target: 'x=201,y=807' },
        { command: 'tap', target: 'x=195,y=405' }
      ]
    });
  });

  it('continues crawling when restore lands on an equivalent refreshed variant', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.equivalent-restore-crawl',
      crawl: true,
      crawlDepth: 1,
      crawlLimit: 2
    };

    const adapter = new ScreenGraphAdapter(equivalentRestoreCrawlGraph);
    const discovery = await discoverAppMap(adapter, mapOptions);
    const crawl = discovery.crawl as {
      actions: number;
      stopped_reason: string;
      restore_diagnostics?: Array<{ result: string; accepted_by?: string }>;
    };

    expect(crawl).toMatchObject({
      actions: 2,
      stopped_reason: 'complete'
    });
    expect(crawl.restore_diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: 'restored',
          accepted_by: 'contract'
        })
      ])
    );
    expect(adapter.actions).toEqual(expect.arrayContaining(['tap:168,807', 'tap:279,807']));
  });

  it('recovers a nested restore by resetting to the root tab and replaying the path', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.root-replay-restore-crawl',
      crawl: true,
      crawlDepth: 2,
      crawlLimit: 3
    };

    const adapter = new ScreenGraphAdapter(rootReplayRestoreCrawlGraph);
    const discovery = await discoverAppMap(adapter, mapOptions);
    const crawl = discovery.crawl as {
      actions: number;
      stopped_reason: string;
      restore_diagnostics?: Array<{ result: string; accepted_by?: string }>;
    };

    expect(crawl).toMatchObject({
      actions: 3,
      stopped_reason: 'limit'
    });
    expect(crawl.restore_diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: 'restored',
          accepted_by: 'root-route'
        })
      ])
    );
    expect(adapter.actions).toEqual(
      expect.arrayContaining(['tap:168,807', 'tap:185,249', 'tap:57,807', 'tap:279,807'])
    );
  });

  it('waits past loading source captures before recording a crawled destination', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.settled-destination-crawl',
      crawl: true,
      crawlDepth: 1,
      crawlLimit: 1,
      crawlSettleMs: 1,
      crawlSettlePollMs: 1
    };

    const adapter = new ScreenGraphAdapter(settledDestinationCrawlGraph);
    const discovery = await discoverAppMap(adapter, mapOptions);

    expect(discovery).toMatchObject({
      crawl: {
        actions: 1,
        stopped_reason: 'limit'
      }
    });

    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const persisted = JSON.parse(fs.readFileSync(path.join(mapRoot, mapFile), 'utf8')) as {
      variants: Array<{ id: string; elements: Array<{ labels: string[] }> }>;
      edges: Array<{ target?: string; to_variant_id: string }>;
    };
    const catalogEdge = persisted.edges.find((edge) => edge.target === 'x=168,y=807');
    const destination = persisted.variants.find((variant) => variant.id === catalogEdge?.to_variant_id);
    const labels = destination?.elements.flatMap((element) => element.labels) ?? [];

    expect(labels).toContain('Catalog Ready');
  });

  it('waits for generic destination hydration during crawl before recording edges', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.hydrated-destination-crawl',
      crawl: true,
      crawlDepth: 1,
      crawlLimit: 1,
      crawlSettleMs: 1,
      crawlSettlePollMs: 1
    };

    const adapter = new ScreenGraphAdapter(hydratedDestinationCrawlGraph);
    const discovery = await discoverAppMap(adapter, mapOptions);

    expect(discovery).toMatchObject({
      crawl: {
        actions: 1,
        stopped_reason: 'limit'
      }
    });

    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const persisted = JSON.parse(fs.readFileSync(path.join(mapRoot, mapFile), 'utf8')) as {
      variants: Array<{ id: string; elements: Array<{ labels: string[] }> }>;
      edges: Array<{ target?: string; to_variant_id: string }>;
    };
    const catalogEdge = persisted.edges.find((edge) => edge.target === 'x=168,y=807');
    const destination = persisted.variants.find((variant) => variant.id === catalogEdge?.to_variant_id);
    const labels = destination?.elements.flatMap((element) => element.labels) ?? [];

    expect(labels).toContain('Loaded Details');
  });

  it('discovers scroll-revealed controls and routes through the learned scroll edge', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.scroll-discovery',
      crawl: true,
      crawlDepth: 2,
      crawlLimit: 2,
      crawlSettleMs: 1,
      crawlSettlePollMs: 1
    };

    const discoveryAdapter = new ScreenGraphAdapter(scrollDiscoveryGraph);
    const discovery = await discoverAppMap(discoveryAdapter, mapOptions);

    expect(discovery).toMatchObject({
      crawl: {
        actions: 2
      }
    });
    expect(discoveryAdapter.actions).toEqual(
      expect.arrayContaining(['scroll:down', 'tap:170,648', 'scroll:up'])
    );

    const routedAdapter = new ScreenGraphAdapter(scrollDiscoveryGraph);
    const routedRun = await runScenario(
      scenarioWithTap('Hidden CTA'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'scroll:down',
      'source:more',
      'tap:Hidden CTA',
      'source:detail'
    ]);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'scroll', target: 'scroll=down,percent=70' }]
    });
  });

  it('prioritizes scroll discovery on scrollable screens before visible cards exhaust the crawl budget', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.scroll-priority',
      crawl: true,
      crawlDepth: 1,
      crawlLimit: 1,
      crawlSettleMs: 1,
      crawlSettlePollMs: 1
    };

    const discoveryAdapter = new ScreenGraphAdapter(scrollPriorityGraph);
    const discovery = await discoverAppMap(discoveryAdapter, mapOptions);

    expect(discovery).toMatchObject({
      crawl: {
        actions: 1,
        stopped_reason: 'limit'
      }
    });
    expect(discoveryAdapter.actions).toEqual(expect.arrayContaining(['scroll:down']));
    expect(discoveryAdapter.actions).not.toContain('tap:170,248');

    const routedAdapter = new ScreenGraphAdapter(scrollPriorityGraph);
    const routedRun = await runScenario(
      scenarioWithTap('Hidden CTA'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'scroll:down',
      'source:more',
      'tap:Hidden CTA',
      'source:hidden-detail'
    ]);
  });

  it('skips sibling content cards once a representative detail template has been crawled', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.repeated-portfolio-cards',
      crawl: true,
      crawlDepth: 2,
      crawlLimit: 12,
      crawlSettleMs: 0
    };

    const adapter = new ScreenGraphAdapter(repeatedPortfolioCardsGraph);
    const discovery = await discoverAppMap(adapter, mapOptions);

    expect(discovery).toMatchObject({
      crawl: {
        actions: 3,
        stopped_reason: 'complete'
      }
    });
    expect(adapter.actions).toEqual([
      'source:home',
      'tap:195,245',
      'source:alpha',
      'tap:265,282',
      'source:alpha-activity',
      'tap:40,90',
      'source:alpha',
      'tap:40,90',
      'source:home'
    ]);
    expect(adapter.actions).not.toContain('tap:195,355');
    expect(adapter.actions).not.toContain('tap:195,465');
  });

  it('persists screen action affordances with content scope for feed controls', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.activity-actions'
    };

    await discoverAppMap(new ScreenGraphAdapter(activityActionAffordanceGraph, 'activity'), mapOptions);

    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const persisted = JSON.parse(fs.readFileSync(path.join(mapRoot, mapFile), 'utf8')) as {
      variants: Array<{
        actions?: Array<{
          intent: string;
          command: string;
          label: string;
          target?: string;
          navigation_target?: string;
          scope?: { kind: string; label?: string };
        }>;
      }>;
    };
    const actions = persisted.variants.flatMap((variant) => variant.actions ?? []);

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          intent: 'like',
          command: 'tap',
          label: 'Like activity',
          target: 'x=60,y=404',
          navigation_target: 'activity',
          scope: expect.objectContaining({
            kind: 'content',
            label: expect.stringContaining('Feed Post')
          })
        }),
        expect.objectContaining({
          intent: 'comment',
          label: 'Comment on activity',
          scope: expect.objectContaining({ kind: 'content' })
        }),
        expect.objectContaining({
          intent: 'share',
          label: 'Share activity',
          scope: expect.objectContaining({ kind: 'content' })
        })
      ])
    );
  });

  it('persists categorized on-screen items for replay and review tooling', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.persisted-items'
    };

    await discoverAppMap(new ScreenGraphAdapter(activityActionAffordanceGraph, 'activity'), mapOptions);

    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const persisted = JSON.parse(fs.readFileSync(path.join(mapRoot, mapFile), 'utf8')) as {
      variants: Array<{
        items?: Array<{
          category: string;
          label?: string;
          targets: string[];
          rect?: { x: number | null; y: number | null; width: number | null; height: number | null };
          enabled: boolean;
          visible: boolean;
          clickable: boolean;
        }>;
      }>;
    };
    const items = persisted.variants.flatMap((variant) => variant.items ?? []);

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'text',
          label: 'Activity',
          targets: expect.arrayContaining(['Activity', 'text=Activity']),
          visible: true
        }),
        expect.objectContaining({
          category: 'container',
          label: expect.stringContaining('Feed Post'),
          rect: {
            x: 20,
            y: 190,
            width: 350,
            height: 180
          }
        }),
        expect.objectContaining({
          category: 'button',
          label: 'Like activity',
          targets: expect.arrayContaining(['Like activity']),
          enabled: true,
          clickable: false
        })
      ])
    );
  });

  it('reuses learned bottom navigation destinations from a new tabbed screen variant', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.virtual-bottom-nav'
    };

    await runScenario(
      scenarioWithCoordinateTapAt(124, 807),
      new ScreenGraphAdapter(virtualBottomNavGraph, 'premium'),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    await runScenario(
      scenarioWithCoordinateTapAt(137, 486),
      new ScreenGraphAdapter(virtualBottomNavGraph, 'premium'),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const starterAdapter = new ScreenGraphAdapter(virtualBottomNavGraph);
    const starterRun = await runScenario(
      scenarioWithTap('text~=BABY'),
      starterAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(starterRun.status).toBe('ok');
    expect(starterAdapter.actions).toEqual([
      'source:home',
      'tap:124,807',
      'source:starter',
      'tap:text~=BABY',
      'source:baby'
    ]);
    expect(starterRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'x=124,y=807' }]
    });

    const premiumAdapter = new ScreenGraphAdapter(virtualBottomNavGraph);
    const premiumRun = await runScenario(
      scenarioWithTap('text~=Trade Activity'),
      premiumAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(premiumRun.status).toBe('ok');
    expect(premiumAdapter.actions).toEqual([
      'source:home',
      'tap:201,807',
      'source:premium',
      'tap:137,486',
      'source:profile',
      'tap:270,322',
      'source:activity'
    ]);
    expect(premiumRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [
        { command: 'tap', target: 'x=201,y=807' },
        { command: 'tap', target: 'x=137,y=486' }
      ]
    });
  });

  it('prefers a section destination over an incidental activity feed text match', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.incidental-activity-match'
    };

    await runScenario(
      scenarioWithCoordinateTapAt(124, 807),
      new ScreenGraphAdapter(incidentalActivityMatchGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    await runScenario(
      scenarioWithCoordinateTapAt(355, 807),
      new ScreenGraphAdapter(incidentalActivityMatchGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const routedAdapter = new ScreenGraphAdapter(incidentalActivityMatchGraph);
    const routedRun = await runScenario(
      scenarioWithTap('text~=BABY'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'tap:124,807',
      'source:starter',
      'tap:189,708',
      'source:baby'
    ]);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'x=124,y=807' }]
    });
  });

  it('routes a first-in-section target and taps the first item below that section heading', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.section-first'
    };

    await runScenario(
      scenarioWithCoordinateTapAt(124, 807),
      new ScreenGraphAdapter(sectionFirstGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const routedAdapter = new ScreenGraphAdapter(sectionFirstGraph);
    const routedRun = await runScenario(
      scenarioWithTap('first-in-section=Top Starter portfolios'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'tap:124,807',
      'source:starter',
      'tap:189,708',
      'source:first-portfolio'
    ]);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'x=124,y=807' }]
    });
  });

  it('learns non-Dub tab destinations for section-relative targets', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.generic-commerce-section'
    };

    await runScenario(
      scenarioWithCoordinateTapAt(168, 807),
      new ScreenGraphAdapter(genericCommerceSectionGraph, 'shop'),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const routedAdapter = new ScreenGraphAdapter(genericCommerceSectionGraph, 'shop');
    const routedRun = await runScenario(
      scenarioWithTap('first-in-section=Featured products'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:shop',
      'tap:168,807',
      'source:catalog',
      'tap:185,249',
      'source:trail-jacket'
    ]);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'x=168,y=807' }]
    });
  });

  it('prefers a real bottom-nav edge over a duplicate virtual section destination', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.section-first-duplicate'
    };

    await discoverAppMap(
      new ScreenGraphAdapter(sectionFirstDuplicateVariantGraph, 'starter-duplicate'),
      mapOptions
    );
    await runScenario(
      scenarioWithCoordinateTapAt(124, 807),
      new ScreenGraphAdapter(sectionFirstDuplicateVariantGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const routedAdapter = new ScreenGraphAdapter(sectionFirstDuplicateVariantGraph);
    const routedRun = await runScenario(
      scenarioWithTap('first-in-section=Top Starter portfolios'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'tap:124,807',
      'source:starter',
      'tap:189,708',
      'source:first-portfolio'
    ]);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'x=124,y=807' }]
    });
  });

  it('prefers the section tab over an incidental activity variant for first-in-section targets', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.section-first-incidental-activity'
    };

    await discoverAppMap(new ScreenGraphAdapter(sectionFirstIncidentalActivityGraph, 'starter'), mapOptions);
    await discoverAppMap(new ScreenGraphAdapter(sectionFirstIncidentalActivityGraph, 'activity'), mapOptions);

    const routedAdapter = new ScreenGraphAdapter(sectionFirstIncidentalActivityGraph);
    const routedRun = await runScenario(
      scenarioWithTap('first-in-section=Top Starter portfolios'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'tap:124,807',
      'source:starter',
      'tap:189,708',
      'source:first-portfolio'
    ]);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'x=124,y=807' }]
    });
  });

  it('prefers a route whose nav control matches the requested section', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.section-first-route-control'
    };

    await runScenario(
      scenarioWithCoordinateTapAt(124, 807),
      new ScreenGraphAdapter(sectionFirstRouteControlGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    await runScenario(
      scenarioWithCoordinateTapAt(355, 807),
      new ScreenGraphAdapter(sectionFirstRouteControlGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const routedAdapter = new ScreenGraphAdapter(sectionFirstRouteControlGraph);
    const routedRun = await runScenario(
      scenarioWithTap('first-in-section=Top Starter portfolios'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'tap:124,807',
      'source:starter',
      'tap:189,708',
      'source:first-portfolio'
    ]);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'x=124,y=807' }]
    });
  });

  it('explains selected and rejected mapped route candidates', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.section-first-route-diagnostics'
    };

    await runScenario(
      scenarioWithCoordinateTapAt(124, 807),
      new ScreenGraphAdapter(sectionFirstRouteControlGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    await runScenario(
      scenarioWithCoordinateTapAt(355, 807),
      new ScreenGraphAdapter(sectionFirstRouteControlGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const routedRun = await runScenario(
      scenarioWithTap('first-in-section=Top Starter portfolios'),
      new ScreenGraphAdapter(sectionFirstRouteControlGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const diagnostics = routedRun.steps[0]?.details.map?.diagnostics as {
      target: string;
      route_candidates: Array<{
        selected: boolean;
        score: number;
        route: Array<{ command: string; target?: string }>;
        rejected_reason?: string;
      }>;
    };

    expect(routedRun.status).toBe('ok');
    expect(diagnostics).toMatchObject({
      target: 'first-in-section=Top Starter portfolios'
    });
    expect(diagnostics.route_candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          selected: true,
          route: [expect.objectContaining({ command: 'tap', target: 'x=124,y=807' })]
        }),
        expect.objectContaining({
          selected: false,
          rejected_reason: expect.any(String)
        })
      ])
    );
    expect(diagnostics.route_candidates.every((candidate) => typeof candidate.score === 'number')).toBe(true);
  });

  it('ignores shorter section matches from a conflicting tab', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.section-first-shorter-wrong-tab'
    };

    await discoverAppMap(new ScreenGraphAdapter(sectionFirstShorterWrongTabGraph, 'starter-shell'), mapOptions);
    await runScenario(
      scenarioWithCoordinateTapAt(124, 807),
      new ScreenGraphAdapter(sectionFirstShorterWrongTabGraph, 'starter-shell'),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    await discoverAppMap(new ScreenGraphAdapter(sectionFirstShorterWrongTabGraph, 'activity-stale'), mapOptions);

    const routedAdapter = new ScreenGraphAdapter(sectionFirstShorterWrongTabGraph);
    const routedRun = await runScenario(
      scenarioWithTap('first-in-section=Top Starter portfolios'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'tap:124,807',
      'source:starter-shell',
      'tap:124,807',
      'source:starter',
      'tap:189,708',
      'source:first-portfolio'
    ]);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [
        { command: 'tap', target: 'x=124,y=807' },
        { command: 'tap', target: 'x=124,y=807' }
      ]
    });
  });

  it('continues when a stale route contract still lands on the requested section target', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.section-first-stale-contract'
    };

    await runScenario(
      scenarioWithCoordinateTapAt(124, 807),
      new ScreenGraphAdapter(sectionFirstGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const mapPath = path.join(mapRoot, mapFile);
    const persisted = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as {
      edges: Array<{
        target?: string;
        destination_contract: {
          variant_id: string;
          required_targets: string[];
          normalized_fingerprint: string;
        };
      }>;
    };
    const starterEdge = persisted.edges.find((edge) => edge.target === 'x=124,y=807');
    expect(starterEdge).toBeDefined();
    starterEdge!.destination_contract = {
      variant_id: 'variant_missing',
      required_targets: ['text=Definitely Missing'],
      normalized_fingerprint: 'missing'
    };
    fs.writeFileSync(mapPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

    const routedAdapter = new ScreenGraphAdapter(sectionFirstGraph);
    const routedRun = await runScenario(
      scenarioWithTap('first-in-section=Top Starter portfolios'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'tap:124,807',
      'source:starter',
      'tap:189,708',
      'source:first-portfolio'
    ]);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'x=124,y=807' }]
    });
  });

  it('taps a live-visible target even when the stored screen variant omits it', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.live-visible'
    };

    const adapter = new ScreenGraphAdapter(liveResolvedTargetGraph);
    const run = await runScenario(
      scenarioWithTap('Close'),
      adapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(run.status).toBe('ok');
    expect(adapter.actions).toEqual(['source:home', 'tap:Close', 'source:closed']);
    expect(run.steps[0]?.details.map).toMatchObject({
      routed: false,
      repaired: false
    });
  });

  it('waits past transient source captures before declaring a target unreachable', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.transient-source'
    };

    const adapter = new ScreenGraphAdapter(transientLaunchGraph);
    const run = await runScenario(
      scenarioWithTap('Premium'),
      adapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(run.status).toBe('ok');
    expect(adapter.actions).toEqual(['source:home', 'source:home', 'tap:201,807', 'source:premium']);
  });

  it('uses source coordinates for on-screen semantic aliases that the live selector cannot resolve', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.semantic-coordinate'
    };

    const adapter = new ScreenGraphAdapter(semanticAliasCoordinateGraph);
    const run = await runScenario(
      scenarioWithTap('See all'),
      adapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(run.status).toBe('ok');
    expect(adapter.actions).toEqual(['source:home', 'tap:352,332', 'source:all-premium']);
    expect(run.steps[0]?.details.map).toMatchObject({
      routed: false,
      repaired: false
    });

    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const persisted = JSON.parse(fs.readFileSync(path.join(mapRoot, mapFile), 'utf8')) as {
      edges: Array<{ target?: string; args: Record<string, unknown> }>;
    };
    expect(persisted.edges).toContainEqual(
      expect.objectContaining({
        target: 'x=352,y=332',
        args: { x: 352, y: 332 }
      })
    );
  });

  it('prefers observed action coordinates over inert Flutter semantic tap targets', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.inert-flutter-label'
    };

    const adapter = new ScreenGraphAdapter(inertFlutterSemanticGraph, 'profile');
    const run = await runScenario(
      scenarioWithTap('Trade Activity'),
      adapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(run.status).toBe('ok');
    expect(adapter.actions).toEqual(['source:profile', 'tap:290,322', 'source:activity']);
    expect(run.steps[0]?.details.map).toMatchObject({
      routed: false,
      repaired: false
    });
  });

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

  it('fails mapped taps that leave the observed screen unchanged', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.no-effect'
    };

    const adapter = new ScreenGraphAdapter(noEffectTapGraph);
    const run = await runScenario(
      scenarioWithTap('Starter'),
      adapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(run.status).toBe('fail');
    expect(adapter.actions).toEqual(['source:home', 'tap:Starter', 'source:home']);
    expect(run.steps[0]?.error?.likely_cause).toContain('no effect');
  });

  it('reuses a learned route to tap a target from a different screen', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.settings',
      repair: true
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

  it('routes explicit contains text targets through the app map', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.contains-text'
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

    const adapter = new ScreenGraphAdapter(graph);
    const run = await runScenario(
      scenarioWithTap('text~=Adv'),
      adapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(run.status).toBe('ok');
    expect(adapter.actions).toEqual([
      'source:home',
      'tap:Settings',
      'source:settings',
      'tap:text~=Adv',
      'source:advanced'
    ]);
    expect(run.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'Settings' }]
    });
  });

  it('routes contains text targets case-insensitively through the app map', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.contains-text-case'
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

    const adapter = new ScreenGraphAdapter(graph);
    const run = await runScenario(
      scenarioWithTap('text~=adv'),
      adapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(run.status).toBe('ok');
    expect(adapter.actions).toEqual([
      'source:home',
      'tap:Settings',
      'source:settings',
      'tap:Advanced',
      'source:advanced'
    ]);
    expect(run.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'Settings' }]
    });
  });

  it('reuses discovered scroll transitions to reach off-screen targets', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.scroll-route'
    };

    const learningRun = await runScenario(
      scenarioWithScroll('down'),
      new ScreenGraphAdapter(scrollRouteGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(learningRun.status).toBe('ok');

    const routedAdapter = new ScreenGraphAdapter(scrollRouteGraph);
    const routedRun = await runScenario(
      scenarioWithTap('text=Receipt #0998'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'scroll:down',
      'source:older-orders',
      'tap:140,448',
      'source:receipt'
    ]);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'scroll', target: 'scroll=down' }]
    });
  });

  it('routes to the nearest reachable contains-text destination instead of failing on a deeper duplicate', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.nested-duplicate-text'
    };

    await runScenario(
      scenarioWithTap('Starter'),
      new ScreenGraphAdapter(nestedDuplicateTextGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );
    await runScenario(
      scenarioWithTap('text~=BABY'),
      new ScreenGraphAdapter(nestedDuplicateTextGraph, 'starter'),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const routedAdapter = new ScreenGraphAdapter(nestedDuplicateTextGraph);
    const routedRun = await runScenario(
      scenarioWithTap('text~=BABY'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'tap:Starter',
      'source:starter',
      'tap:text~=BABY',
      'source:baby'
    ]);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'Starter' }]
    });
  });

  it('disables map reads and writes in no-map mode', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.settings',
      repair: true
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
      appId: 'com.example.settings',
      repair: true
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
      appId: 'com.example.disappearing-control',
      repair: true
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

  it('does not explore missing targets by default', async () => {
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
    expect(deadEndAdapter.actions).toEqual(['source:home']);
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
      appId: 'com.example.cold-determinism',
      repair: true
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

  it('scrubs legacy typed values and CLI transport options when loading a map', async () => {
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
    legacyMap.edges.push({
      id: 'edge_legacy_map_dir',
      from_variant_id: fromVariant?.id ?? 'variant_1',
      to_variant_id: toVariant?.id ?? 'variant_2',
      command: 'tap',
      args: { target: 'Continue', 'map-dir': '/tmp/private-map-location' },
      target: 'Continue',
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
    expect(fs.readFileSync(mapPath, 'utf8')).toContain('/tmp/private-map-location');

    const loadOnlyRun = await runScenario(
      scenarioWithWait(),
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
    expect(fs.readFileSync(mapPath, 'utf8')).not.toContain('/tmp/private-map-location');
  });

  it('fails scenario wait steps when the predicate times out', async () => {
    const run = await runScenario(
      scenarioWithWaitFor('text=Ready'),
      new ScreenGraphAdapter({
        home: {
          source: '<App><StaticText name="Loading" label="Loading" /></App>',
          taps: {}
        }
      }),
      'simulator',
      undefined,
      undefined,
      true,
      { enabled: false }
    );

    expect(run.status).toBe('fail');
    expect(run.steps[0]).toMatchObject({
      command: 'wait',
      status: 'fail',
      details: {
        args: {
          for: 'text=Ready',
          matched: false
        }
      },
      error: {
        code: 'ACTION_ERROR',
        likely_cause: expect.stringContaining('matched:false')
      }
    });
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

  it('does not route low-specificity contains text targets off screen', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.numeric-contains'
    };

    await runScenario(
      scenarioWithTap('Wallet'),
      new ScreenGraphAdapter(numericContainsGraph),
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    const offscreenAdapter = new ScreenGraphAdapter(numericContainsGraph);
    const offscreenRun = await runScenario(
      scenarioWithTap('text~=$100'),
      offscreenAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(offscreenRun.status).toBe('fail');
    expect(offscreenAdapter.actions).toEqual(['source:home']);
    expect(offscreenRun.steps[0]?.error?.likely_cause).toContain('not reachable');

    const onscreenAdapter = new ScreenGraphAdapter(numericContainsGraph, 'cash');
    const onscreenRun = await runScenario(
      scenarioWithTap('text~=$100'),
      onscreenAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(onscreenRun.status).toBe('ok');
    expect(onscreenRun.map?.used).toBe(false);
    expect(onscreenAdapter.actions).toEqual([
      'source:cash',
      'tap:text~=$100',
      'source:selected'
    ]);
  });

  it('records coordinate tap transitions as routeable map edges', async () => {
    const mapRoot = appMapDir();
    const mapOptions = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.coordinates'
    };

    const coordinateAdapter = new ScreenGraphAdapter(coordinateRouteGraph);
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
    expect(coordinateAdapter.actions).toEqual(['source:home', 'tap:10,20', 'source:settings']);
    const [mapFile] = fs.readdirSync(mapRoot).filter((file) => file.endsWith('.json'));
    const mapPath = path.join(mapRoot, mapFile);
    const persisted = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as {
      edges: Array<{ command: string; target?: string; args: Record<string, unknown> }>;
    };
    expect(persisted.edges).toContainEqual(
      expect.objectContaining({
        command: 'tap',
        target: 'x=10,y=20',
        args: { x: 10, y: 20 }
      })
    );

    const routedAdapter = new ScreenGraphAdapter(coordinateRouteGraph);
    const routedRun = await runScenario(
      scenarioWithTap('Advanced'),
      routedAdapter,
      'simulator',
      undefined,
      undefined,
      true,
      mapOptions
    );

    expect(routedRun.status).toBe('ok');
    expect(routedAdapter.actions).toEqual([
      'source:home',
      'tap:10,20',
      'source:settings',
      'tap:Advanced',
      'source:advanced'
    ]);
    expect(routedRun.map?.used).toBe(true);
    expect(routedRun.steps[0]?.details.map).toMatchObject({
      routed: true,
      route: [{ command: 'tap', target: 'x=10,y=20' }]
    });
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

  it('creates compact agent memory from a brand-new map without persisting raw UI content', async () => {
    const mapRoot = appMapDir();
    const adapter = new ScreenGraphAdapter({
      home: {
        source:
          '<App><Button name="Settings" label="Settings" />' +
          '<StaticText name="$343.24&#10;Buying Power" label="$343.24&#10;Buying Power" />' +
          '<StaticText name="Signed in account name" label="Signed in account name" /></App>',
        taps: {}
      }
    });

    const result = await discoverAppMap(adapter, {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.fresh'
    });

    expect(result.memory).toMatchObject({
      schema: 'visor.agent-memory.v1',
      current_screen: {
        id: 'screen_1',
        variant_id: 'variant_1',
        actions: [
          expect.objectContaining({
            command: 'tap',
            args: { target: 'Settings' },
            safety: 'safe'
          })
        ]
      },
      gaps: [expect.objectContaining({ screen_id: 'screen_1', reason: 'needs_semantics' })]
    });

    const memoryPath = String((result.map as Record<string, unknown>).agent_path);
    expect(memoryPath).toMatch(/\/agent\/[^/]+\.json$/);
    expect(fs.existsSync(memoryPath)).toBe(true);
    const persisted = fs.readFileSync(memoryPath, 'utf8');
    expect(persisted).not.toContain('<App>');
    expect(persisted).not.toContain('$343.24');
    expect(persisted).not.toContain('Signed in account name');
    expect(persisted).not.toContain('"elements"');
  });

  it('annotates the exact discovery observation token without reading the device again', async () => {
    const mapRoot = appMapDir();
    const adapter = new ScreenGraphAdapter({
      home: {
        source: '<App><Button name="Settings" label="Settings" /></App>',
        taps: {}
      }
    });
    const options = {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.observation-token'
    };

    const first = await discoverAppMap(adapter, options);
    const token = String(first.observation_token);
    expect(token).toMatch(/^variant_1\.[a-f0-9]{16}$/);

    const annotated = await discoverAppMap(adapter, {
      ...options,
      annotationToken: token,
      annotation: {
        screen: {
          label: 'Account settings',
          purpose: 'Manage account preferences'
        }
      }
    });

    expect(adapter.actions).toEqual(['source:home']);
    expect(annotated).toMatchObject({
      observation_token: token,
      annotation: { screen_applied: true },
      screen: {
        screen_id: 'screen_1',
        variant_id: 'variant_1'
      },
      memory: {
        current_screen: {
          label: 'Account settings',
          purpose: 'Manage account preferences'
        }
      }
    });
  });

  it('tries an eligible alternate route after the preferred path fails', async () => {
    const mapRoot = appMapDir();
    const adapter = new ScreenGraphAdapter({
      home: {
        source:
          '<App><StaticText name="Home screen" label="Home screen" />' +
          '<Button name="Broken" label="Broken" /><Button name="Settings" label="Settings" /></App>',
        taps: { Settings: 'settings' }
      },
      settings: {
        source: '<App><StaticText name="Settings screen" label="Settings screen" /></App>',
        taps: {}
      }
    });
    const plan: RoutePlan = {
      goal: 'settings',
      rediscover: true,
      paths: [
        {
          id: 'preferred',
          from: { selector: 'Home screen' },
          steps: [
            {
              id: 'broken-control',
              command: 'tap',
              args: { target: 'Broken' },
              safety: 'safe',
              expect: { screen: 'settings', selector: 'Settings screen', timeout_ms: 25 }
            }
          ]
        },
        {
          id: 'fallback',
          from: { selector: 'Home screen' },
          steps: [
            {
              id: 'working-control',
              command: 'tap',
              args: { target: 'Settings' },
              safety: 'safe',
              expect: { screen: 'settings', selector: 'Settings screen', timeout_ms: 25 }
            }
          ]
        }
      ]
    };

    const result = await executeRoutePlan(adapter, plan, {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.routes'
    });

    expect(result).toMatchObject({
      action: 'route',
      status: 'completed',
      goal: 'settings',
      selected_path: 'fallback',
      attempts: [
        {
          path_id: 'preferred',
          status: 'failed',
          steps: [expect.objectContaining({ id: 'broken-control', outcome: 'runtime_failure' })]
        },
        {
          path_id: 'fallback',
          status: 'completed',
          steps: [expect.objectContaining({ id: 'working-control', outcome: 'success' })]
        }
      ]
    });
    expect(adapter.actions).toContain('tap:Broken');
    expect(adapter.actions).toContain('tap:Settings');
    expect(fs.readdirSync(mapRoot)).toContainEqual(expect.stringMatching(/\.json$/));
  });

  it('checkpoints an unexpected screen and continues through an eligible recovery path', async () => {
    const mapRoot = appMapDir();
    const adapter = new ScreenGraphAdapter({
      home: {
        source:
          '<App><StaticText name="Home screen" label="Home screen" />' +
          '<Button name="Surprise" label="Surprise" /></App>',
        taps: { Surprise: 'unknown' }
      },
      unknown: {
        source:
          '<App><StaticText name="Unexpected interstitial" label="Unexpected interstitial" />' +
          '<Button name="Recover" label="Recover" /></App>',
        taps: { Recover: 'settings' }
      },
      settings: {
        source: '<App><StaticText name="Settings screen" label="Settings screen" /></App>',
        taps: {}
      }
    });
    const plan: RoutePlan = {
      goal: 'settings',
      rediscover: true,
      paths: [
        {
          id: 'preferred',
          from: { selector: 'Home screen' },
          steps: [
            {
              id: 'unexpected-transition',
              command: 'tap',
              args: { target: 'Surprise' },
              safety: 'safe',
              expect: { screen: 'settings', selector: 'Settings screen', timeout_ms: 25 }
            }
          ]
        },
        {
          id: 'recover-interstitial',
          from: { selector: 'Unexpected interstitial' },
          steps: [
            {
              id: 'recover',
              command: 'tap',
              args: { target: 'Recover' },
              safety: 'safe',
              expect: { screen: 'settings', selector: 'Settings screen', timeout_ms: 25 }
            }
          ]
        }
      ]
    };

    const result = await executeRoutePlan(adapter, plan, {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.unknown-route'
    });

    expect(result).toMatchObject({
      status: 'completed',
      selected_path: 'recover-interstitial',
      attempts: [
        {
          path_id: 'preferred',
          steps: [expect.objectContaining({ outcome: 'verification_failure' })]
        },
        {
          path_id: 'recover-interstitial',
          steps: [expect.objectContaining({ outcome: 'success' })]
        }
      ]
    });
    const persisted = mapDebugSnapshot(mapRoot, 'ios', 'com.example.unknown-route') as {
      screens: unknown[];
      edges: Array<{ candidate: boolean; target?: string }>;
    };
    expect(persisted.screens).toHaveLength(3);
    expect(persisted.edges).toContainEqual(
      expect.objectContaining({ candidate: true, target: 'Surprise' })
    );
  });

  it('returns compact discovery context when no recovery path matches an unknown screen', async () => {
    const mapRoot = appMapDir();
    const adapter = new ScreenGraphAdapter({
      home: {
        source: '<App><Button name="Continue" label="Continue" /></App>',
        taps: { Continue: 'unknown' }
      },
      unknown: {
        source:
          '<App><StaticText name="Permission explanation" label="Permission explanation" />' +
          '<Button name="Not now" label="Not now" /></App>',
        taps: {}
      }
    });
    const plan: RoutePlan = {
      goal: 'dashboard',
      rediscover: true,
      paths: [
        {
          id: 'continue',
          steps: [
            {
              id: 'continue',
              command: 'tap',
              args: { target: 'Continue' },
              safety: 'safe',
              expect: { screen: 'dashboard', selector: 'Dashboard', timeout_ms: 25 }
            }
          ]
        }
      ]
    };

    const result = await executeRoutePlan(adapter, plan, {
      enabled: true,
      rootDir: mapRoot,
      appId: 'com.example.discovery-required'
    });

    expect(result).toMatchObject({
      status: 'needs_discovery',
      attempts: [
        {
          path_id: 'continue',
          steps: [expect.objectContaining({ outcome: 'verification_failure' })]
        }
      ],
      rediscovery: {
        next_action: 'annotate_current',
        observation_token: expect.stringMatching(/^variant_2\.[a-f0-9]{16}$/),
        current_screen: {
          id: 'screen_2',
          variant_id: 'variant_2',
          actions: [expect.objectContaining({ args: { target: 'Not now' } })]
        },
        gaps: expect.arrayContaining([
          expect.objectContaining({ screen_id: 'screen_2', reason: 'needs_semantics' })
        ])
      }
    });
    expect(fs.existsSync(String((result.rediscovery as Record<string, unknown>).agent_path))).toBe(true);
    expect(fs.existsSync(String(result.checkpoint_path))).toBe(true);
  });

  it('observes the current screen when every supplied path is skipped', async () => {
    const mapRoot = appMapDir();
    const adapter = new ScreenGraphAdapter({
      home: {
        source: '<App><StaticText name="Unmapped home" label="Unmapped home" /></App>',
        taps: {}
      }
    });

    const result = await executeRoutePlan(
      adapter,
      {
        goal: 'settings',
        rediscover: true,
        paths: [
          {
            id: 'known-state-only',
            from: { selector: 'Known settings' },
            steps: [
              {
                id: 'open',
                command: 'tap',
                args: { target: 'Settings' },
                safety: 'safe',
                expect: { screen: 'settings', selector: 'Settings', timeout_ms: 25 }
              }
            ]
          }
        ]
      },
      { enabled: true, rootDir: mapRoot, appId: 'com.example.all-skipped' }
    );

    expect(result).toMatchObject({
      status: 'needs_discovery',
      rediscovery: {
        observation_token: expect.stringMatching(/^variant_1\.[a-f0-9]{16}$/),
        current_screen: { id: 'screen_1', variant_id: 'variant_1' }
      }
    });
  });

  it('records an unexpected destination as a candidate without strengthening the known edge', async () => {
    const mapRoot = appMapDir();
    const appId = 'com.example.route-contract-failure';
    const source =
      '<App><StaticText name="Home" label="Home" /><Button name="Settings" label="Settings" /></App>';
    const plan: RoutePlan = {
      goal: 'settings',
      rediscover: true,
      paths: [
        {
          id: 'settings',
          steps: [
            {
              id: 'open-settings',
              command: 'tap',
              args: { target: 'Settings' },
              safety: 'safe',
              expect: { screen: 'settings', selector: 'Settings screen', timeout_ms: 25 }
            }
          ]
        }
      ]
    };

    await executeRoutePlan(
      new ScreenGraphAdapter({
        home: { source, taps: { Settings: 'settings' } },
        settings: {
          source: '<App><StaticText name="Settings screen" label="Settings screen" /></App>',
          taps: {}
        }
      }),
      plan,
      { enabled: true, rootDir: mapRoot, appId }
    );

    await executeRoutePlan(
      new ScreenGraphAdapter({
        home: { source, taps: { Settings: 'unknown' } },
        unknown: {
          source: '<App><StaticText name="Unexpected screen" label="Unexpected screen" /></App>',
          taps: {}
        }
      }),
      plan,
      { enabled: true, rootDir: mapRoot, appId }
    );

    const snapshot = mapDebugSnapshot(mapRoot, 'ios', appId) as {
      edges: Array<{
        to_variant_id: string;
        candidate: boolean;
        successes: number;
        failures: number;
        confidence: number;
      }>;
    };
    const known = snapshot.edges.find((edge) => !edge.candidate);
    const candidate = snapshot.edges.find((edge) => edge.candidate);
    expect(known).toMatchObject({ to_variant_id: 'variant_2', successes: 1, failures: 1 });
    expect(known?.confidence).toBeLessThan(1);
    expect(candidate).toMatchObject({ to_variant_id: 'variant_3', successes: 0, failures: 0 });
  });

  it('demotes a known locator when a route action has no visible effect', async () => {
    const mapRoot = appMapDir();
    const appId = 'com.example.route-no-effect';
    const source =
      '<App><StaticText name="Home" label="Home" /><Button name="Settings" label="Settings" /></App>';
    const plan: RoutePlan = {
      goal: 'settings',
      rediscover: true,
      paths: [
        {
          id: 'settings',
          steps: [
            {
              id: 'open-settings',
              command: 'tap',
              args: { target: 'Settings' },
              safety: 'safe',
              expect: { screen: 'settings', selector: 'Settings screen', timeout_ms: 25 }
            }
          ]
        }
      ]
    };

    await executeRoutePlan(
      new ScreenGraphAdapter({
        home: { source, taps: { Settings: 'settings' } },
        settings: {
          source: '<App><StaticText name="Settings screen" label="Settings screen" /></App>',
          taps: {}
        }
      }),
      plan,
      { enabled: true, rootDir: mapRoot, appId }
    );
    await executeRoutePlan(
      new ScreenGraphAdapter({ home: { source, taps: { Settings: 'home' } } }),
      plan,
      { enabled: true, rootDir: mapRoot, appId }
    );

    const snapshot = mapDebugSnapshot(mapRoot, 'ios', appId) as {
      edges: Array<{ target?: string; successes: number; failures: number; confidence: number }>;
    };
    expect(snapshot.edges.find((edge) => edge.target === 'Settings')).toMatchObject({
      successes: 1,
      failures: 1,
      confidence: 0.65
    });
  });

  it('excludes dynamic route arguments from compact agent memory', async () => {
    for (const [index, dynamicTarget] of [
      '$343.24 Buying Power',
      '343.24 Buying Power',
      'Aleks Kapera'
    ].entries()) {
      const mapRoot = appMapDir();
      const appId = `com.example.dynamic-route-memory-${index}`;
      const result = await executeRoutePlan(
        new ScreenGraphAdapter({
          home: {
            source: `<App><Button name="${dynamicTarget}" label="${dynamicTarget}" /></App>`,
            taps: { [dynamicTarget]: 'details' }
          },
          details: {
            source: '<App><StaticText name="Buying power details" label="Buying power details" /></App>',
            taps: {}
          }
        }),
        {
          goal: 'details',
          rediscover: true,
          paths: [
            {
              id: 'dynamic',
              steps: [
                {
                  id: 'open',
                  command: 'tap',
                  args: { target: dynamicTarget },
                  safety: 'safe',
                  expect: { screen: 'details', selector: 'Buying power details', timeout_ms: 25 }
                }
              ]
            }
          ]
        },
        { enabled: true, rootDir: mapRoot, appId }
      );

      const memoryPath = String((result.map as Record<string, unknown>).agent_path);
      expect(fs.readFileSync(memoryPath, 'utf8')).not.toContain(dynamicTarget);

      const destinationMapRoot = appMapDir();
      const destinationResult = await executeRoutePlan(
        new ScreenGraphAdapter({
          home: {
            source: '<App><Button name="Open details" label="Open details" /></App>',
            taps: { 'Open details': 'details' }
          },
          details: {
            source: `<App><StaticText name="${dynamicTarget}" label="${dynamicTarget}" /></App>`,
            taps: {}
          }
        }),
        {
          goal: 'details',
          rediscover: true,
          paths: [
            {
              id: 'dynamic-destination',
              steps: [
                {
                  id: 'open',
                  command: 'tap',
                  args: { target: 'Open details' },
                  safety: 'safe',
                  expect: { screen: 'details', selector: dynamicTarget, timeout_ms: 25 }
                }
              ]
            }
          ]
        },
        { enabled: true, rootDir: destinationMapRoot, appId: `${appId}-destination` }
      );
      const destinationMemoryPath = String(
        (destinationResult.map as Record<string, unknown>).agent_path
      );
      expect(fs.readFileSync(destinationMemoryPath, 'utf8')).not.toContain(dynamicTarget);
    }
  });

  it('checkpoints the route plan, current observation, and resume position', async () => {
    const mapRoot = appMapDir();
    const result = await executeRoutePlan(
      new ScreenGraphAdapter({
        home: {
          source: '<App><StaticText name="Home" label="Home" /><Button name="Continue" label="Continue" /></App>',
          taps: { Continue: 'unknown' }
        },
        unknown: {
          source: '<App><StaticText name="Unknown" label="Unknown" /></App>',
          taps: {}
        }
      }),
      {
        goal: 'dashboard',
        rediscover: true,
        paths: [
          {
            id: 'continue',
            steps: [
              {
                id: 'continue',
                command: 'tap',
                args: { target: 'Continue' },
                safety: 'safe',
                expect: { screen: 'dashboard', selector: 'Dashboard', timeout_ms: 25 }
              }
            ]
          }
        ]
      },
      { enabled: true, rootDir: mapRoot, appId: 'com.example.resumable-checkpoint' }
    );

    const checkpoint = JSON.parse(fs.readFileSync(String(result.checkpoint_path), 'utf8'));
    expect(checkpoint).toMatchObject({
      plan: { goal: 'dashboard', paths: [{ id: 'continue' }] },
      current: {
        observation_token: expect.stringMatching(/^variant_2\.[a-f0-9]{16}$/),
        screen_id: 'screen_2',
        variant_id: 'variant_2'
      },
      resume: { requires_discovery: true }
    });
  });
});
