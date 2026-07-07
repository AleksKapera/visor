import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { discoverAppMap } from '../src/appMap.js';
import { runScenario } from '../src/runner.js';
import { writeReports } from '../src/report.js';
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

describe('app map execution', () => {
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
});
