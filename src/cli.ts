import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_SERVER_URL } from './adapters.js';
import {
  DaemonOperationError,
  DaemonRequestTimeoutError,
  DaemonUnavailableError,
  runDaemonAction,
  runDaemonDiscover,
  runDaemonScenario,
  startVisorDaemon,
  statusVisorDaemon,
  stopVisorDaemon
} from './daemon.js';
import { DeviceSelectionError, resolveRunningDevice } from './devices.js';
import { makeError } from './errors.js';
import { LocalRuntimeAdapter } from './localRuntime.js';
import { writeReports } from './report.js';
import { determinismCheck, runScenario } from './runner.js';
import type {
  CommandName,
  CommandResponse,
  ErrorCode,
  MapExecutionOptions,
  Platform,
  Scenario,
  ValidationIssue
} from './types.js';
import { errorMessage, makeId, utcNowIso } from './utils.js';
import { parseAndValidate } from './validator.js';

type OptionType = 'string' | 'number' | 'boolean';
type ParsedOptions = Record<string, string | number | boolean | undefined>;

interface ParsedCommand {
  command: string;
  options: ParsedOptions;
  positionals: string[];
}

interface CommandResult {
  code: number;
  response: CommandResponse;
}

interface RuntimeOptions {
  platform: Platform;
  device: string;
  timeout?: number;
  output_dir: string;
  server_url: string;
  app_id?: string;
  attach_to_running: boolean;
  map: MapExecutionOptions;
}

interface LocalRuntimeOptions {
  device: string;
  timeout?: number;
  output_dir: string;
}

interface HelpData {
  usageText: string;
  commands: string[];
  examples: string[];
}

interface VersionData {
  version: string;
  versionText: string;
}

type JsonRecord = Record<string, unknown>;

interface RecordedFlowStep {
  id: string;
  command: CommandName;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
}

interface RecordedFlow {
  schema_version: 1;
  name: string;
  active: boolean;
  record_values?: boolean;
  created_at: string;
  updated_at: string;
  steps: RecordedFlowStep[];
}

function packageVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unmatchedWaitArgs(payload: Record<string, unknown>): Record<string, unknown> | null {
  const args = objectRecord(payload.args);
  if (!args || args.matched !== false) {
    return null;
  }

  if (typeof args.for === 'string' || args.stable === true) {
    return args;
  }

  return null;
}

function describeUnmatchedWait(args: Record<string, unknown>): string {
  if (typeof args.for === 'string') {
    return `wait predicate timed out for '${args.for}' (matched:false)`;
  }
  if (args.stable === true) {
    return 'wait stable timed out (matched:false)';
  }
  return 'wait predicate timed out (matched:false)';
}

function assertMatchedWaitPayload(payload: Record<string, unknown>, label = 'wait'): void {
  const args = unmatchedWaitArgs(payload);
  if (!args) {
    return;
  }

  throw new Error(label === 'post-action wait'
    ? `post-action ${describeUnmatchedWait(args)}`
    : describeUnmatchedWait(args));
}

function flowDir(): string {
  return path.join(process.cwd(), '.visor', 'flows');
}

function assertFlowName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('Flow name may contain only letters, numbers, dots, dashes, and underscores');
  }
}

function flowPath(name: string): string {
  assertFlowName(name);
  return path.join(flowDir(), `${name}.json`);
}

function flowResponse(flow: RecordedFlow, action = 'record'): JsonRecord {
  return {
    action,
    name: flow.name,
    active: flow.active,
    record_values: flow.record_values === true,
    steps: flow.steps.length,
    path: flowPath(flow.name)
  };
}

function readFlow(name: string): RecordedFlow | null {
  const targetPath = flowPath(name);
  if (!fs.existsSync(targetPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(targetPath, 'utf8')) as RecordedFlow;
}

function writeFlow(flow: RecordedFlow): void {
  fs.mkdirSync(flowDir(), { recursive: true });
  fs.writeFileSync(flowPath(flow.name), `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
}

function activeFlows(): RecordedFlow[] {
  const dir = flowDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as RecordedFlow;
        return parsed.active ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function replayableRecordedArgs(
  command: CommandName,
  fallbackArgs: Record<string, unknown>,
  payloadArgs: Record<string, unknown> | null,
  recordValues: boolean
): Record<string, unknown> {
  if (command === 'screenshot' || command === 'source') {
    const label = fallbackArgs.label ?? payloadArgs?.label;
    const recorded: Record<string, unknown> =
      typeof label === 'string' && label.length > 0 ? { label } : {};
    if (typeof fallbackArgs.settleMs === 'number') {
      recorded.settleMs = fallbackArgs.settleMs;
    } else if (fallbackArgs.settle === true) {
      recorded.settle = true;
    }
    return recorded;
  }

  if (command === 'wait') {
    const recorded: Record<string, unknown> = {};
    for (const key of ['ms', 'for', 'stable', 'timeout', 'pollMs']) {
      if (fallbackArgs[key] !== undefined) {
        recorded[key] = fallbackArgs[key];
      }
    }
    return recorded;
  }

  const candidate =
    command === 'tap' &&
    payloadArgs &&
    typeof payloadArgs.x === 'number' &&
    typeof payloadArgs.y === 'number'
      ? payloadArgs
      : fallbackArgs;
  if (command === 'tap' && typeof candidate.x === 'number' && typeof candidate.y === 'number') {
    return {
      x: candidate.x,
      y: candidate.y,
      ...(candidate.normalized === true ? { normalized: true } : {})
    };
  }

  const cloned = structuredClone(candidate);
  delete cloned.tap_method;
  if (command === 'act' && String(cloned.name ?? '') === 'type' && !recordValues) {
    delete cloned.value;
  }
  return cloned;
}

function appendActiveRecordings(command: CommandName, args: Record<string, unknown>, payload: Record<string, unknown>): JsonRecord[] {
  const flows = activeFlows();
  const recorded: JsonRecord[] = [];
  for (const flow of flows) {
    const stepNumber = flow.steps.length + 1;
    const payloadArgs = payload.args;
    const recordValues = flow.record_values === true;
    const recordedArgs =
      payloadArgs && typeof payloadArgs === 'object' && !Array.isArray(payloadArgs)
        ? replayableRecordedArgs(command, args, payloadArgs as Record<string, unknown>, recordValues)
        : replayableRecordedArgs(command, args, null, recordValues);
    flow.steps.push({
      id: `${String(stepNumber).padStart(3, '0')}-${command}`,
      command,
      args: recordedArgs
    });
    flow.updated_at = utcNowIso();
    writeFlow(flow);
    recorded.push({
      name: flow.name,
      path: flowPath(flow.name),
      steps: flow.steps.length
    });
  }
  return recorded;
}

function parseReplayParams(options: ParsedOptions): Record<string, string> {
  const params: Record<string, string> = {};
  const raw = options.param;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return params;
  }

  const separator = raw.indexOf('=');
  if (separator <= 0) {
    throw new Error("--param must use the form key=value");
  }
  params[raw.slice(0, separator)] = raw.slice(separator + 1);
  return params;
}

function substituteParams(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key: string) => params[key] ?? match);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteParams(item, params));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, substituteParams(item, params)])
    );
  }
  return value;
}

function scenarioFromFlow(flow: RecordedFlow, params: Record<string, string>): Scenario {
  return {
    meta: {
      name: `replay:${flow.name}`,
      version: '1',
      tags: ['replay']
    },
    config: {},
    steps: flow.steps.map((step) => ({
      id: step.id,
      command: step.command,
      args: substituteParams(step.args, params) as Record<string, unknown>
    })),
    assertions: [],
    output: {}
  };
}

const ACTION_COMMANDS = new Set<CommandName>([
  'tap',
  'navigate',
  'act',
  'scroll',
  'screenshot',
  'wait',
  'source'
]);
const ALL_COMMANDS = new Set<string>([
  ...ACTION_COMMANDS,
  'validate',
  'run',
  'discover',
  'benchmark',
  'report',
  'record',
  'replay',
  'start',
  'status',
  'stop'
]);

const GLOBAL_SPEC: Record<string, OptionType> = {
  device: 'string',
  timeout: 'number',
  output: 'string',
  format: 'string',
  seed: 'number',
  'server-url': 'string',
  'app-id': 'string',
  attach: 'boolean',
  'no-map': 'boolean',
  repair: 'boolean',
  verbose: 'boolean'
};

const ACTION_SPEC: Record<string, OptionType> = {
  ...GLOBAL_SPEC,
  target: 'string',
  x: 'number',
  y: 'number',
  'start-x': 'number',
  'start-y': 'number',
  'end-x': 'number',
  'end-y': 'number',
  direction: 'string',
  percent: 'number',
  normalized: 'boolean',
  to: 'string',
  name: 'string',
  value: 'string',
  'start-value': 'number',
  label: 'string',
  ms: 'number',
  path: 'string',
  for: 'string',
  'wait-for': 'string',
  'poll-ms': 'number',
  stable: 'boolean',
  settle: 'boolean',
  'settle-ms': 'number'
};

const COMMAND_SPECS: Record<string, Record<string, OptionType>> = {
  validate: { format: 'string' },
  run: {
    device: 'string',
    timeout: 'number',
    output: 'string',
    format: 'string',
    runtime: 'string',
    'server-url': 'string',
    'app-id': 'string',
    attach: 'boolean',
    'no-map': 'boolean',
    repair: 'boolean',
    crawl: 'boolean',
    'crawl-depth': 'number',
    'crawl-limit': 'number',
    'crawl-include': 'string',
    'crawl-allow-risky': 'boolean'
  },
  discover: {
    device: 'string',
    timeout: 'number',
    format: 'string',
    'server-url': 'string',
    'app-id': 'string',
    attach: 'boolean',
    'no-map': 'boolean',
    repair: 'boolean',
    crawl: 'boolean',
    'crawl-depth': 'number',
    'crawl-limit': 'number',
    'crawl-include': 'string',
    'crawl-allow-risky': 'boolean'
  },
  benchmark: {
    runs: 'number',
    threshold: 'number',
    device: 'string',
    timeout: 'number',
    output: 'string',
    format: 'string',
    'server-url': 'string',
    'app-id': 'string',
    attach: 'boolean',
    'no-map': 'boolean',
    repair: 'boolean',
    'compare-map': 'boolean'
  },
  report: { format: 'string' },
  record: {
    format: 'string',
    stop: 'boolean',
    'record-values': 'boolean',
    force: 'boolean'
  },
  replay: {
    device: 'string',
    timeout: 'number',
    output: 'string',
    format: 'string',
    'server-url': 'string',
    'app-id': 'string',
    attach: 'boolean',
    'no-map': 'boolean',
    repair: 'boolean',
    param: 'string'
  },
  start: {
    'server-url': 'string',
    'appium-cmd': 'string',
    format: 'string'
  },
  status: {
    'server-url': 'string',
    format: 'string'
  },
  stop: {
    'server-url': 'string',
    force: 'boolean',
    format: 'string'
  },
  tap: ACTION_SPEC,
  navigate: ACTION_SPEC,
  act: ACTION_SPEC,
  scroll: ACTION_SPEC,
  screenshot: ACTION_SPEC,
  wait: ACTION_SPEC,
  source: ACTION_SPEC
};

const ACTION_ARG_OPTION_NAMES: Record<string, string> = {
  'start-x': 'startX',
  'start-y': 'startY',
  'end-x': 'endX',
  'end-y': 'endY',
  'start-value': 'startValue',
  'poll-ms': 'pollMs',
  'settle-ms': 'settleMs'
};

function helpText(): string {
  return [
    'Visor TypeScript CLI',
    '',
    'Usage:',
    '  visor <command> [options]',
    '  visor --help | -h',
    '  visor --version | -v',
    '',
    'Commands:',
    '  validate <scenario>',
    '  run <scenario> [--output <dir>] [--runtime appium|local]',
    '  benchmark <scenario> [--runs <n>] [--threshold <percent>]',
    '  discover [--app-id <id>]',
    '  report [path]',
    '  record <name> [--stop|--force|--record-values]',
    '  replay <name> [--param key=value]',
    '  start [--server-url <url>] [--appium-cmd <cmd>]',
    '  status [--server-url <url>]',
    '  stop [--server-url <url>] [--force]',
    '  tap|navigate|act|scroll|screenshot|wait|source',
    '',
    'Examples:',
    '  visor validate scenarios/checkout-smoke.json',
    '  visor run path/to/scenario.json --runtime local --output artifacts-local',
    '  visor start --server-url http://127.0.0.1:4723',
    '  visor run scenarios/checkout-smoke.json --output artifacts-test',
    '  visor run scenarios/checkout-smoke.json --no-map',
    '  visor discover --app-id com.example.app',
    '  visor record checkout',
    '  visor replay checkout --param item=shoes',
    '  visor scroll --device emulator-5554 --direction down',
    '  visor status'
  ].join('\n');
}

function commandHelpText(command: string): { usageText: string; examples: string[] } {
  const postActionWaitOptions = [
    '  --wait-for <selector>     Wait for a selector after the action',
    '  --timeout <ms>            Timeout for runtime action or --wait-for',
    '  --poll-ms <ms>            Poll interval for --wait-for'
  ];

  if (command === 'tap') {
    const examples = [
      'visor tap --target accessibility=Continue',
      'visor tap --target text=Continue',
      'visor tap --target text~=Settings',
      'visor tap --target "first-in-section=Featured products"',
      'visor tap --x 120 --y 640',
      'visor tap --x 0.5 --y 0.92 --normalized'
    ];
    return {
      usageText: [
        'Visor tap',
        '',
        'Usage:',
        '  visor tap --target <selector> [runtime options]',
        '  visor tap --x <points> --y <points> [--normalized] [runtime options]',
        '',
        'Options:',
        '  --target <selector>       Selector to tap',
        '  --x <points>              X coordinate in screen points, or fraction with --normalized',
        '  --y <points>              Y coordinate in screen points, or fraction with --normalized',
        '  --normalized              Treat x/y as fractions of current screen size',
        ...postActionWaitOptions,
        '  --no-map                  Disable app-map reads and writes',
        '  --repair                  Allow opt-in exploratory app-map repair'
      ].join('\n'),
      examples
    };
  }

  if (command === 'discover') {
    const examples = [
      'visor discover --app-id com.example.app',
      'visor discover --app-id com.example.app --crawl --crawl-depth 2 --crawl-limit 24'
    ];
    return {
      usageText: [
        'Visor discover',
        '',
        'Usage:',
        '  visor discover [--app-id <id>] [--crawl] [runtime options]',
        '',
        'Options:',
        '  --crawl                   Explore safe controls and record app-map edges',
        '  --crawl-depth <n>         Maximum crawl depth, default 2',
        '  --crawl-limit <n>         Maximum crawl actions, default 24',
        '  --crawl-include <text>    Only crawl controls matching this text',
        '  --crawl-allow-risky       Include risky controls when crawling sandbox/dev builds',
        '  --no-map                  Disable app-map reads and writes'
      ].join('\n'),
      examples
    };
  }

  if (command === 'act') {
    const examples = [
      'visor act --name back',
      'visor act --name reset --app-id com.example.app',
      'visor act --name drag --start-x 120 --start-y 640 --end-x 320 --end-y 640',
      'visor act --name slider --target accessibility=Amount --value 0.5'
    ];
    return {
      usageText: [
        'Visor act',
        '',
        'Usage:',
        '  visor act --name <type|back|home|reset|drag|slider> [options]',
        '',
        'Options:',
        '  --name <operation>        Helper action name',
        '  --target <selector>      Target selector for type or slider; optional for focused type',
        '  --value <value>          Text value for type, or 0..1 slider value',
        '  --start-x <points>       Drag start x coordinate',
        '  --start-y <points>       Drag start y coordinate',
        '  --end-x <points>         Drag end x coordinate',
        '  --end-y <points>         Drag end y coordinate',
        '  --start-value <0..1>     Slider starting value, default 0.5',
        '  --normalized             Treat drag coordinates as viewport fractions',
        ...postActionWaitOptions
      ].join('\n'),
      examples
    };
  }

  if (command === 'scroll') {
    const examples = [
      'visor scroll --direction down',
      'visor scroll --direction up --percent 50',
      'visor scroll --direction down --wait-for text=Loaded --timeout 8000 --poll-ms 250'
    ];
    return {
      usageText: [
        'Visor scroll',
        '',
        'Usage:',
        '  visor scroll --direction <up|down> [options]',
        '',
        'Options:',
        '  --direction <up|down>    Scroll direction',
        '  --percent <1..100>       Scroll distance percentage, default 70',
        ...postActionWaitOptions,
        '  --no-map                 Disable app-map reads and writes',
        '  --repair                 Allow opt-in exploratory app-map repair'
      ].join('\n'),
      examples
    };
  }

  if (command === 'screenshot' || command === 'source') {
    const isScreenshot = command === 'screenshot';
    const title = isScreenshot ? 'Visor screenshot' : 'Visor source';
    const extension = isScreenshot ? 'png' : 'xml';
    const noun = isScreenshot ? 'PNG screenshot' : 'UI source XML';
    const defaultLabel = isScreenshot ? 'capture' : 'source';
    const examples = [
      `visor ${command} --label checkout`,
      `visor ${command} --path /tmp/checkout.${extension}`,
      `visor ${command} --label checkout --output artifacts`,
      `visor ${command} --settle-ms 500`
    ];
    return {
      usageText: [
        title,
        '',
        'Usage:',
        `  visor ${command} [--label <name>|--path <file>] [capture options]`,
        '',
        'Options:',
        `  --label <name>           Label for the ${noun}; default ${defaultLabel}`,
        `  --path <file>            Write the ${noun} to an exact file path`,
        `  --output <dir>           Write to <dir>/<label>.${extension} when --path is omitted`,
        '  --settle                 Wait briefly before capture',
        '  --settle-ms <ms>         Milliseconds to wait before capture'
      ].join('\n'),
      examples
    };
  }

  if (command === 'wait') {
    const examples = [
      'visor wait --ms 500',
      'visor wait --for "text=Ready" --timeout 8000',
      'visor wait --stable --timeout 2000'
    ];
    return {
      usageText: [
        'Visor wait',
        '',
        'Usage:',
        '  visor wait --ms <milliseconds>',
        '  visor wait --for <selector> [--timeout <ms>] [--poll-ms <ms>]',
        '  visor wait --stable [--timeout <ms>] [--poll-ms <ms>]',
        '',
        'Options:',
        '  --ms <milliseconds>      Sleep duration',
        '  --for <selector>         Poll until selector exists',
        '  --stable                 Poll until UI source stops changing',
        '  --timeout <ms>           Wait timeout',
        '  --poll-ms <ms>           Poll interval'
      ].join('\n'),
      examples
    };
  }

  if (command === 'benchmark') {
    const examples = [
      'visor benchmark scenarios/checkout-smoke.json --runs 20',
      'visor benchmark scenarios/checkout-smoke.json --runs 5 --compare-map'
    ];
    return {
      usageText: [
        'Visor benchmark',
        '',
        'Usage:',
        '  visor benchmark <scenario> [--runs <n>] [--threshold <percent>] [--compare-map]',
        '',
        'Options:',
        '  --runs <n>               Number of runs, default 20',
        '  --threshold <percent>    Required determinism score, default 95',
        '  --compare-map            Run no-map and app-map variants for A/B comparison'
      ].join('\n'),
      examples
    };
  }

  if (command === 'record') {
    const examples = [
      'visor record checkout',
      'visor tap --target Continue',
      'visor record checkout --stop'
    ];
    return {
      usageText: [
        'Visor record',
        '',
        'Usage:',
        '  visor record <name> [--force] [--record-values]',
        '  visor record <name> --stop',
        '',
        'Options:',
        '  --stop                    Stop recording and keep the replay file',
        '  --force                   Overwrite an existing flow with the same name',
        '  --record-values           Persist typed text values for replay'
      ].join('\n'),
      examples
    };
  }

  if (command === 'replay') {
    const examples = [
      'visor replay checkout',
      'visor replay search --param query=shoes'
    ];
    return {
      usageText: [
        'Visor replay',
        '',
        'Usage:',
        '  visor replay <name> [--param key=value] [runtime options]',
        '',
        'Options:',
        '  --param <key=value>       Substitute {{key}} placeholders in recorded args',
        '  --output <dir>            Base output directory for replay artifacts',
        '  --no-map                  Disable app-map reads and writes',
        '  --repair                  Allow opt-in exploratory app-map repair'
      ].join('\n'),
      examples
    };
  }

  return {
    usageText: [
      `Visor ${command}`,
      '',
      'Usage:',
      `  visor ${command} [options]`,
      '',
      'Run visor --help for the full command list.'
    ].join('\n'),
    examples: []
  };
}

function envelopeOk(
  commandId: string,
  startedAt: string,
  artifacts: string[] = [],
  nextAction = ''
): CommandResponse {
  return {
    status: 'ok',
    command_id: commandId,
    started_at: startedAt,
    ended_at: utcNowIso(),
    artifacts,
    next_action: nextAction,
    data: {}
  };
}

function envelopeFail(
  commandId: string,
  startedAt: string,
  code: ErrorCode,
  message: string,
  cause: string,
  nextStep: string
): CommandResponse {
  return {
    status: 'fail',
    command_id: commandId,
    started_at: startedAt,
    ended_at: utcNowIso(),
    artifacts: [],
    next_action: nextStep,
    error: makeError(code, message, cause, nextStep),
    data: {}
  };
}

function parseOptions(tokens: string[], spec: Record<string, OptionType>): { options: ParsedOptions; positionals: string[] } {
  const options: ParsedOptions = {};
  const positionals: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const optionName = token.slice(2);
    const optionType = spec[optionName];
    if (!optionType) {
      throw new Error(`Unknown option '--${optionName}'`);
    }

    if (optionType === 'boolean') {
      options[optionName] = true;
      continue;
    }

    const rawValue = tokens[index + 1];
    if (rawValue === undefined || rawValue.startsWith('--')) {
      throw new Error(`Option '--${optionName}' requires a value`);
    }

    options[optionName] = optionType === 'number' ? Number(rawValue) : rawValue;
    index += 1;
  }

  return { options, positionals };
}

function parseCommand(argv: string[]): ParsedCommand {
  const commandIndex = argv.findIndex((token) => ALL_COMMANDS.has(token));
  if (commandIndex === -1) {
    throw new Error('Missing command');
  }

  const globalTokens = argv.slice(0, commandIndex);
  const command = argv[commandIndex];
  const commandTokens = argv.slice(commandIndex + 1);
  const globalParsed = parseOptions(globalTokens, GLOBAL_SPEC);
  const commandParsed = parseOptions(commandTokens, COMMAND_SPECS[command] ?? {});

  return {
    command,
    options: {
      ...globalParsed.options,
      ...commandParsed.options
    },
    positionals: [...globalParsed.positionals, ...commandParsed.positionals]
  };
}

function warningIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((issue) => issue.severity === 'warning');
}

function crawlIncludeValues(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function resolvedRuntime(options: ParsedOptions): Promise<RuntimeOptions> {
  const selectedDevice = await resolveRunningDevice(
    typeof options.device === 'string' ? options.device : undefined
  );
  const crawlInclude = crawlIncludeValues(options['crawl-include']);

  return {
    platform: selectedDevice.platform,
    device: selectedDevice.id,
    timeout:
      typeof options.timeout === 'number'
        ? options.timeout
        : 2500,
    output_dir: String(options.output ?? 'artifacts'),
    server_url: String(options['server-url'] ?? DEFAULT_SERVER_URL),
    app_id: typeof options['app-id'] === 'string' ? options['app-id'] : undefined,
    attach_to_running: Boolean(options.attach),
    map: {
      enabled: !Boolean(options['no-map']),
      ...(options.repair === true ? { repair: true } : {}),
      ...(options.crawl === true ? { crawl: true } : {}),
      ...(typeof options['crawl-depth'] === 'number' ? { crawlDepth: options['crawl-depth'] } : {}),
      ...(typeof options['crawl-limit'] === 'number' ? { crawlLimit: options['crawl-limit'] } : {}),
      ...(crawlInclude.length > 0 ? { crawlInclude } : {}),
      ...(options['crawl-allow-risky'] === true ? { crawlAllowRisky: true } : {})
    }
  };
}

function actionArgs(command: CommandName, options: ParsedOptions): Record<string, unknown> {
  const commonIgnored = new Set([
    'device',
    'format',
    'output',
    'timeout',
    'verbose',
    'server-url',
    'seed',
    'runtime',
    'app-id',
    'attach',
    'no-map',
    'repair'
  ]);
  const args = Object.entries(options).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (command !== 'wait' && ['for', 'wait-for', 'poll-ms'].includes(key)) {
      return acc;
    }
    if (!commonIgnored.has(key) && value !== undefined) {
      acc[ACTION_ARG_OPTION_NAMES[key] ?? key] = value;
    }
    return acc;
  }, {});

  if (command === 'source' && args.label === undefined) {
    args.label = 'source';
  }
  if (command === 'wait' && typeof options.timeout === 'number') {
    args.timeout = options.timeout;
  }
  if ((command === 'screenshot' || command === 'source') && typeof options.output === 'string' && args.path === undefined) {
    const label = String(args.label ?? (command === 'source' ? 'source' : 'capture'));
    const extension = command === 'source' ? 'xml' : 'png';
    args.path = path.join(options.output, `${label}.${extension}`);
  }

  return args;
}

function postActionWaitArgs(command: CommandName, options: ParsedOptions): Record<string, unknown> | null {
  if (!['tap', 'act', 'scroll'].includes(command)) {
    return null;
  }
  if (typeof options['wait-for'] !== 'string' || options['wait-for'].trim() === '') {
    return null;
  }

  return {
    for: options['wait-for'],
    ...(typeof options.timeout === 'number' ? { timeout: options.timeout } : {}),
    ...(typeof options['poll-ms'] === 'number' ? { pollMs: options['poll-ms'] } : {})
  };
}

function unsupportedRuntimeResult(commandId: string, startedAt: string, runtime: unknown): CommandResult {
  const response = envelopeFail(
    commandId,
    startedAt,
    'INPUT_ERROR',
    'Unsupported runtime',
    `Unsupported runtime '${String(runtime)}'`,
    'Use --runtime appium or --runtime local'
  );
  return { code: 1, response };
}

function isTargetInitializationError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes('Failed to create WebdriverIO Appium session') ||
    message.includes('CoreSimulatorService') ||
    message.includes('Could not find a driver for automationName')
  );
}

function targetInitializationNextStep(error: unknown): string {
  const message = errorMessage(error);
  if (message.includes('CoreSimulatorService') || message.includes('simctl')) {
    return 'Run `xcrun simctl list` from the same shell. If it fails, restart Simulator/CoreSimulator and ensure Appium is not running from a sandboxed process.';
  }

  if (message.includes('Could not find a driver for automationName')) {
    return 'Install the matching Appium driver, verify it with `appium driver list --installed`, then restart `visor start`.';
  }

  if (message.includes('bundle identifier') && message.includes('unknown')) {
    return 'Verify the iOS bundle id is installed on the selected simulator/device, launch it first when using `--attach`, then retry.';
  }

  return 'Verify Appium driver setup, target device state, and app id, then retry.';
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function mapArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mapActionCount(variants: unknown[]): number {
  let total = 0;
  for (const variant of variants) {
    if (!isRecord(variant)) {
      continue;
    }
    total += mapArray(variant.actions).length;
  }
  return total;
}

function appMapSummaryFromPath(mapPath: string): JsonRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }

    const variants = mapArray(parsed.variants);
    return {
      schema_version: typeof parsed.schema_version === 'number' ? parsed.schema_version : undefined,
      identity: optionalString(parsed.identity),
      app_id: optionalString(parsed.app_id),
      platform: optionalString(parsed.platform),
      screens: mapArray(parsed.screens).length,
      variants: variants.length,
      edges: mapArray(parsed.edges).length,
      actions: mapActionCount(variants),
      auth_required_variants: variants.filter((variant) => isRecord(variant) && variant.auth_required === true).length,
      updated_at: optionalString(parsed.updated_at)
    };
  } catch {
    return undefined;
  }
}

function addDiscoverMapSummary(result: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(result.map)) {
    return result;
  }

  const map = result.map;
  if (map.summary !== undefined || typeof map.path !== 'string') {
    return result;
  }

  const summary = appMapSummaryFromPath(map.path);
  if (!summary) {
    return result;
  }

  return {
    ...result,
    map: {
      ...map,
      summary
    }
  };
}

function cmdHelp(command?: string): CommandResult {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  const response = envelopeOk(commandId, startedAt, [], 'validate');
  const commandHelp = command ? commandHelpText(command) : undefined;
  response.data = {
    usageText: commandHelp?.usageText ?? helpText(),
    commands: command ? [command] : Array.from(ALL_COMMANDS),
    examples: commandHelp?.examples ?? [
      'visor validate scenarios/checkout-smoke.json',
      'visor run path/to/scenario.json --runtime local --output artifacts-local',
      'visor start --server-url http://127.0.0.1:4723',
      'visor run scenarios/checkout-smoke.json --output artifacts-test',
      'visor scroll --device emulator-5554 --direction down',
      'visor status'
    ]
  } satisfies HelpData;
  return { code: 0, response };
}

function cmdVersion(): CommandResult {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  const version = packageVersion();
  const response = envelopeOk(commandId, startedAt, [], 'none');
  response.data = {
    version,
    versionText: version
  } satisfies VersionData;
  return { code: 0, response };
}

export async function cmdValidate(parsed: ParsedCommand): Promise<CommandResult> {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  const scenarioPath = parsed.positionals[0];

  try {
    if (!scenarioPath) {
      throw new Error('validate requires a scenario path');
    }

    const { scenario, issues } = parseAndValidate(scenarioPath);
    const response = envelopeOk(commandId, startedAt, [], 'run');
    response.data = {
      valid: scenario !== null,
      issues
    };
    return {
      code: scenario ? 0 : 1,
      response
    };
  } catch (error) {
    const response = envelopeFail(
      commandId,
      startedAt,
      'INPUT_ERROR',
      'Validation failed',
      errorMessage(error),
      'Fix scenario JSON and rerun validate'
    );
    return { code: 1, response };
  }
}

async function cmdRunLocal(
  commandId: string,
  startedAt: string,
  scenario: Scenario,
  warnings: ValidationIssue[],
  runtime: LocalRuntimeOptions
): Promise<CommandResult> {
  const result = await runScenario(
    scenario,
    new LocalRuntimeAdapter(),
    runtime.device,
    runtime.timeout,
    runtime.output_dir
  );
  const outputs = writeReports(result, runtime.output_dir);
  const response = result.status === 'ok'
    ? envelopeOk(commandId, startedAt, Object.values(outputs), 'report')
    : envelopeFail(
        commandId,
        startedAt,
        result.error?.code ?? 'ACTION_ERROR',
        result.error?.message ?? 'Local runtime scenario failed',
        result.error?.likely_cause ?? 'The deterministic local runtime did not satisfy the scenario',
        result.error?.next_step ?? 'Inspect local runtime scenario artifacts and retry'
      );
  response.artifacts = Object.values(outputs);
  response.data = {
    run: result,
    warnings
  };
  return { code: result.status === 'ok' ? 0 : 2, response };
}

export async function cmdRun(parsed: ParsedCommand): Promise<CommandResult> {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  const scenarioPath = parsed.positionals[0];
  const { scenario, issues } = parseAndValidate(String(scenarioPath ?? ''));

  if (!scenario) {
    const response = envelopeFail(
      commandId,
      startedAt,
      'INPUT_ERROR',
      'Scenario validation failed',
      'One or more schema violations',
      'Run `visor validate <file>` and resolve errors'
    );
    response.data = { issues };
    return { code: 1, response };
  }

  if (
    parsed.options.runtime !== undefined &&
    parsed.options.runtime !== 'appium' &&
    parsed.options.runtime !== 'local'
  ) {
    return unsupportedRuntimeResult(commandId, startedAt, parsed.options.runtime);
  }

  if (parsed.options.runtime === 'local') {
    const runtime: LocalRuntimeOptions = {
      device: 'local',
      timeout:
        typeof parsed.options.timeout === 'number'
          ? parsed.options.timeout
          : typeof scenario.config.timeoutMs === 'number'
            ? scenario.config.timeoutMs
            : undefined,
      output_dir:
        String(
          parsed.options.output ??
          (typeof scenario.config.artifactsDir === 'string' ? scenario.config.artifactsDir : 'artifacts')
        )
    };
    return cmdRunLocal(commandId, startedAt, scenario, warningIssues(issues), runtime);
  }

  let runtime: RuntimeOptions;
  try {
    runtime = await resolvedRuntime({
      ...parsed.options,
      timeout:
        typeof parsed.options.timeout === 'number'
          ? parsed.options.timeout
          : typeof scenario.config.timeoutMs === 'number'
            ? scenario.config.timeoutMs
            : undefined,
      output:
        parsed.options.output ??
        (typeof scenario.config.artifactsDir === 'string' ? scenario.config.artifactsDir : undefined)
    });
  } catch (error) {
    if (!(error instanceof DeviceSelectionError)) {
      throw error;
    }
    const response = envelopeFail(
      commandId,
      startedAt,
      'TARGET_ERROR',
      'Device selection failed',
      error.message,
      'Start one target device or rerun with --device <device-id>'
    );
    response.data = { devices: error.devices };
    return { code: 1, response };
  }

  try {
    const result = await runDaemonScenario(
      {
        platform: runtime.platform,
        server_url: runtime.server_url,
        device: runtime.device,
        app_id: runtime.app_id,
        attach_to_running: runtime.attach_to_running
      },
      scenario,
      runtime.device,
      runtime.timeout,
      runtime.output_dir,
      {
        ...runtime.map,
        appId: runtime.app_id
      }
    );
    const outputs = writeReports(result, runtime.output_dir);

    if (result.status === 'fail' && result.error) {
      const response = envelopeFail(
        commandId,
        startedAt,
        result.error.code,
        result.error.message,
        result.error.likely_cause,
        result.error.next_step
      );
      response.artifacts = Object.values(outputs);
      response.data = {
        run: result,
        warnings: warningIssues(issues)
      };
      return { code: 2, response };
    }

    const response = envelopeOk(commandId, startedAt, Object.values(outputs), 'report');
    response.data = {
      run: result,
      warnings: warningIssues(issues)
    };
    return { code: 0, response };
  } catch (error) {
    const isDaemonUnavailable = error instanceof DaemonUnavailableError;
    const isDaemonTimeout = error instanceof DaemonRequestTimeoutError;
    const response = envelopeFail(
      commandId,
      startedAt,
      'TARGET_ERROR',
      isDaemonUnavailable
        ? 'Run requires visor start'
        : isDaemonTimeout
          ? 'Timed out waiting for Visor daemon'
          : 'Failed to initialize platform target',
      errorMessage(error),
      isDaemonUnavailable
        ? 'Run `visor start`, verify the target emulator/simulator is booted, and retry.'
        : isDaemonTimeout
          ? 'Inspect .visor/daemon/daemon.log and .visor/appium/*.log, then retry or run `visor stop --force` before restarting.'
          : 'Verify the target emulator/simulator and Appium driver setup, then retry.'
    );
    return { code: 1, response };
  }
}

export async function cmdDiscover(parsed: ParsedCommand): Promise<CommandResult> {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  let runtime: RuntimeOptions;
  try {
    runtime = await resolvedRuntime(parsed.options);
  } catch (error) {
    if (!(error instanceof DeviceSelectionError)) {
      throw error;
    }
    const response = envelopeFail(
      commandId,
      startedAt,
      'TARGET_ERROR',
      'Device selection failed',
      error.message,
      'Start one target device or rerun with --device <device-id>'
    );
    response.data = { devices: error.devices };
    return { code: 1, response };
  }

  try {
    const result = await runDaemonDiscover(
      {
        platform: runtime.platform,
        server_url: runtime.server_url,
        device: runtime.device,
        app_id: runtime.app_id,
        attach_to_running: runtime.attach_to_running
      },
      {
        ...runtime.map,
        appId: runtime.app_id
      }
    );
    const response = envelopeOk(commandId, startedAt, [], 'run');
    response.data = addDiscoverMapSummary(result);
    return { code: 0, response };
  } catch (error) {
    const isDaemonUnavailable = error instanceof DaemonUnavailableError;
    const isDaemonTimeout = error instanceof DaemonRequestTimeoutError;
    const response = envelopeFail(
      commandId,
      startedAt,
      isDaemonUnavailable || isDaemonTimeout ? 'TARGET_ERROR' : 'ACTION_ERROR',
      isDaemonUnavailable
        ? 'discover requires visor start'
        : isDaemonTimeout
          ? 'discover timed out waiting for Visor daemon'
          : 'discover failed',
      errorMessage(error),
      isDaemonUnavailable
        ? 'Run `visor start`, verify the target emulator/simulator is booted, and retry.'
        : isDaemonTimeout
          ? 'Inspect .visor/daemon/daemon.log and .visor/appium/*.log, then retry or run `visor stop --force` before restarting.'
          : 'Check target app state and retry'
    );
    return { code: 1, response };
  }
}

export async function cmdBenchmark(parsed: ParsedCommand): Promise<CommandResult> {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  const scenarioPath = parsed.positionals[0];
  const { scenario, issues } = parseAndValidate(String(scenarioPath ?? ''));

  if (!scenario) {
    const response = envelopeFail(
      commandId,
      startedAt,
      'INPUT_ERROR',
      'Scenario validation failed',
      'Invalid scenario',
      'Fix schema errors before benchmark'
    );
    response.data = { issues };
    return { code: 1, response };
  }

  let runtime: RuntimeOptions;
  try {
    runtime = await resolvedRuntime({
      ...parsed.options,
      timeout:
        typeof parsed.options.timeout === 'number'
          ? parsed.options.timeout
          : typeof scenario.config.timeoutMs === 'number'
            ? scenario.config.timeoutMs
            : undefined,
      output:
        parsed.options.output ??
        (typeof scenario.config.artifactsDir === 'string' ? scenario.config.artifactsDir : undefined)
    });
  } catch (error) {
    if (!(error instanceof DeviceSelectionError)) {
      throw error;
    }
    const response = envelopeFail(
      commandId,
      startedAt,
      'TARGET_ERROR',
      'Device selection failed',
      error.message,
      'Start one target device or rerun with --device <device-id>'
    );
    response.data = { devices: error.devices };
    return { code: 1, response };
  }
  const runs = typeof parsed.options.runs === 'number' ? parsed.options.runs : 20;
  const threshold = typeof parsed.options.threshold === 'number' ? parsed.options.threshold : 95;
  const runtimeRequest = {
    platform: runtime.platform,
    server_url: runtime.server_url,
    device: runtime.device,
    app_id: runtime.app_id,
    attach_to_running: runtime.attach_to_running
  };
  const runVariant = async (
    name: string,
    mapEnabled: boolean,
    mapOptions: MapExecutionOptions
  ): Promise<{ variant: JsonRecord } | { error: CommandResult }> => {
    const signatures: string[] = [];
    const runIds: string[] = [];
    let failures = 0;

    for (let index = 0; index < runs; index += 1) {
      try {
        const result = await runDaemonScenario(
          runtimeRequest,
          scenario,
          runtime.device,
          runtime.timeout,
          runtime.output_dir,
          mapOptions
        );
        writeReports(result, runtime.output_dir);
        signatures.push(result.determinism_signature);
        runIds.push(result.run_id);
        if (result.status !== 'ok') {
          failures += 1;
        }
      } catch (error) {
        if (error instanceof DaemonUnavailableError) {
          const response = envelopeFail(
            commandId,
            startedAt,
            'TARGET_ERROR',
            'Benchmark requires visor start',
            errorMessage(error),
            'Run `visor start`, verify the target emulator/simulator is booted, and retry.'
          );
          return { error: { code: 1, response } };
        }
        if (error instanceof DaemonRequestTimeoutError) {
          const response = envelopeFail(
            commandId,
            startedAt,
            'TARGET_ERROR',
            'Timed out waiting for Visor daemon',
            errorMessage(error),
            'Inspect .visor/daemon/daemon.log and .visor/appium/*.log, then retry or run `visor stop --force` before restarting.'
          );
          return { error: { code: 1, response } };
        }
        failures += 1;
      }
    }

    const score = determinismCheck(signatures);
    return {
      variant: {
        name,
        mapEnabled,
        runs,
        threshold,
        determinismScore: score,
        pass: score >= threshold && failures === 0,
        failures,
        runIds
      }
    };
  };

  if (parsed.options['compare-map'] === true) {
    const variants: JsonRecord[] = [];
    for (const variantConfig of [
      { name: 'no-map', mapEnabled: false },
      { name: 'map', mapEnabled: true }
    ]) {
      const outcome = await runVariant(
        variantConfig.name,
        variantConfig.mapEnabled,
        {
          ...runtime.map,
          enabled: variantConfig.mapEnabled,
          appId: runtime.app_id
        }
      );
      if ('error' in outcome) {
        return outcome.error;
      }
      variants.push(outcome.variant);
    }

    const failures = variants.reduce((total, variant) => total + Number(variant.failures ?? 0), 0);
    const score = Math.min(...variants.map((variant) => Number(variant.determinismScore ?? 0)));
    const passGate = variants.every((variant) => variant.pass === true);
    const runIds = variants.flatMap((variant) => Array.isArray(variant.runIds) ? variant.runIds : []);

    const response = envelopeOk(commandId, startedAt, [], 'report');
    response.data = {
      runs,
      threshold,
      determinismScore: score,
      pass: passGate,
      failures,
      runIds,
      variants,
      warnings: warningIssues(issues)
    };
    return { code: passGate ? 0 : 3, response };
  }

  const outcome = await runVariant('benchmark', runtime.map.enabled !== false, {
    ...runtime.map,
    appId: runtime.app_id
  });
  if ('error' in outcome) {
    return outcome.error;
  }

  const score = Number(outcome.variant.determinismScore ?? 0);
  const failures = Number(outcome.variant.failures ?? 0);
  const passGate = outcome.variant.pass === true;
  const runIds = Array.isArray(outcome.variant.runIds) ? outcome.variant.runIds : [];

  const response = envelopeOk(commandId, startedAt, [], 'report');
  response.data = {
    runs,
    threshold,
    determinismScore: score,
    pass: passGate,
    failures,
    runIds,
    warnings: warningIssues(issues)
  };
  return { code: passGate ? 0 : 3, response };
}

export async function cmdReport(parsed: ParsedCommand): Promise<CommandResult> {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  const reportPath = parsed.positionals[0] ?? 'artifacts';
  const response = envelopeOk(commandId, startedAt, [], 'none');
  response.data = {
    message: `Use output under ${reportPath}/<run-id>/summary.txt|summary.json|junit.xml|report.html`,
    path: reportPath,
    format: parsed.options.format ?? 'json'
  };
  return { code: 0, response };
}

export async function cmdRecord(parsed: ParsedCommand): Promise<CommandResult> {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  const name = parsed.positionals[0];

  try {
    if (!name) {
      throw new Error('record requires a flow name');
    }

    if (parsed.options.stop === true) {
      const existing = readFlow(name);
      if (!existing) {
        throw new Error(`No recorded flow named '${name}'`);
      }
      existing.active = false;
      existing.updated_at = utcNowIso();
      writeFlow(existing);
      const response = envelopeOk(commandId, startedAt, [], 'replay');
      response.data = flowResponse(existing);
      return { code: 0, response };
    }

    const now = utcNowIso();
    const existing = readFlow(name);
    if (existing && parsed.options.force !== true) {
      throw new Error(`Recorded flow '${name}' already exists; use --force to overwrite it`);
    }
    const flow: RecordedFlow = {
      schema_version: 1,
      name,
      active: true,
      ...(parsed.options['record-values'] === true ? { record_values: true } : {}),
      created_at: now,
      updated_at: now,
      steps: []
    };
    writeFlow(flow);
    const response = envelopeOk(commandId, startedAt, [], 'tap');
    response.data = flowResponse(flow);
    return { code: 0, response };
  } catch (error) {
    const response = envelopeFail(
      commandId,
      startedAt,
      'INPUT_ERROR',
      'Record failed',
      errorMessage(error),
      'Use `visor record <name>` to start or `visor record <name> --stop` to finish'
    );
    return { code: 1, response };
  }
}

export async function cmdReplay(parsed: ParsedCommand): Promise<CommandResult> {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  const name = parsed.positionals[0];

  try {
    if (!name) {
      throw new Error('replay requires a flow name');
    }
    const flow = readFlow(name);
    if (!flow) {
      throw new Error(`No recorded flow named '${name}'`);
    }
    if (flow.active) {
      throw new Error(`Flow '${name}' is still recording; stop it before replay`);
    }

    const runtime = await resolvedRuntime(parsed.options);
    const params = parseReplayParams(parsed.options);
    const scenario = scenarioFromFlow(flow, params);
    const result = await runDaemonScenario(
      {
        platform: runtime.platform,
        server_url: runtime.server_url,
        device: runtime.device,
        app_id: runtime.app_id,
        attach_to_running: runtime.attach_to_running
      },
      scenario,
      runtime.device,
      runtime.timeout,
      runtime.output_dir,
      {
        ...runtime.map,
        appId: runtime.app_id
      }
    );
    const outputs = writeReports(result, runtime.output_dir);
    const response = result.status === 'ok'
      ? envelopeOk(commandId, startedAt, Object.values(outputs), 'report')
      : envelopeFail(
          commandId,
          startedAt,
          result.error?.code ?? 'ACTION_ERROR',
          result.error?.message ?? 'Replay failed',
          result.error?.likely_cause ?? `Recorded flow '${name}' did not complete`,
          result.error?.next_step ?? 'Inspect replay artifacts and retry'
        );
    response.artifacts = Object.values(outputs);
    response.data = {
      action: 'replay',
      name,
      steps: flow.steps.length,
      run: result,
      param_keys: Object.keys(params)
    };
    return { code: result.status === 'ok' ? 0 : 2, response };
  } catch (error) {
    if (error instanceof DeviceSelectionError) {
      const response = envelopeFail(
        commandId,
        startedAt,
        'TARGET_ERROR',
        'Device selection failed',
        error.message,
        'Start one target device or rerun with --device <device-id>'
      );
      response.data = { devices: error.devices };
      return { code: 1, response };
    }
    if (error instanceof DaemonUnavailableError) {
      const response = envelopeFail(
        commandId,
        startedAt,
        'TARGET_ERROR',
        'Replay requires visor start',
        errorMessage(error),
        'Run `visor start`, verify the target emulator/simulator is booted, and retry.'
      );
      return { code: 1, response };
    }
    if (error instanceof DaemonRequestTimeoutError) {
      const response = envelopeFail(
        commandId,
        startedAt,
        'TARGET_ERROR',
        'Timed out waiting for Visor daemon',
        errorMessage(error),
        'Inspect .visor/daemon/daemon.log and .visor/appium/*.log, then retry or run `visor stop --force` before restarting.'
      );
      return { code: 1, response };
    }

    const response = envelopeFail(
      commandId,
      startedAt,
      'INPUT_ERROR',
      'Replay failed',
      errorMessage(error),
      'Use `visor record <name>` to create a flow, then retry replay'
    );
    return { code: 1, response };
  }
}

export async function cmdAction(command: CommandName, parsed: ParsedCommand): Promise<CommandResult> {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  let options: RuntimeOptions;
  try {
    options = await resolvedRuntime(parsed.options);
  } catch (error) {
    if (!(error instanceof DeviceSelectionError)) {
      throw error;
    }
    const response = envelopeFail(
      commandId,
      startedAt,
      'TARGET_ERROR',
      'Device selection failed',
      error.message,
      'Start one target device or rerun with --device <device-id>'
    );
    response.data = { devices: error.devices };
    return { code: 1, response };
  }

  let payload: Record<string, unknown> = {};
  let artifacts: string[] = [];
  let actionError: unknown;
  const runtimeInput = {
    platform: options.platform,
    server_url: options.server_url,
    device: options.device,
    app_id: options.app_id,
    attach_to_running: options.attach_to_running
  };
  const mapOptions = {
    ...options.map,
    appId: options.app_id
  };
  const primaryArgs = actionArgs(command, parsed.options);

  try {
    payload = await runDaemonAction(
      runtimeInput,
      command,
      primaryArgs,
      mapOptions
    );
    if (command === 'wait') {
      assertMatchedWaitPayload(payload);
    }
    const waitArgs = postActionWaitArgs(command, parsed.options);
    if (waitArgs) {
      payload.wait = await runDaemonAction(runtimeInput, 'wait', waitArgs, mapOptions);
      assertMatchedWaitPayload(payload.wait as Record<string, unknown>, 'post-action wait');
    }
    const actionPayload = payload.args;
    if (actionPayload && typeof actionPayload === 'object' && !Array.isArray(actionPayload)) {
      const maybePath = (actionPayload as Record<string, unknown>).path;
      if (typeof maybePath === 'string') {
        artifacts = [maybePath];
      }
    }
  } catch (error) {
    if (error instanceof DaemonOperationError && error.data) {
      payload = error.data;
    }
    actionError = error;
  }

  if (actionError) {
    const isDaemonUnavailable = actionError instanceof DaemonUnavailableError;
    const isDaemonTimeout = actionError instanceof DaemonRequestTimeoutError;
    const isTargetInitialization = isTargetInitializationError(actionError);
    const response = envelopeFail(
      commandId,
      startedAt,
      isDaemonUnavailable || isDaemonTimeout || isTargetInitialization ? 'TARGET_ERROR' : 'ACTION_ERROR',
      isDaemonUnavailable
        ? `${command} requires visor start`
        : isDaemonTimeout
          ? `${command} timed out waiting for Visor daemon`
          : isTargetInitialization
            ? `${command} failed to initialize platform target`
            : `${command} failed`,
      errorMessage(actionError),
      isDaemonUnavailable
        ? 'Run `visor start`, verify the target emulator/simulator is booted, and retry.'
        : isDaemonTimeout
          ? 'Inspect .visor/daemon/daemon.log and .visor/appium/*.log, then retry or run `visor stop --force` before restarting.'
          : isTargetInitialization
            ? targetInitializationNextStep(actionError)
            : 'Check command args and retry'
    );
    response.data = payload;
    return { code: 1, response };
  }

  const response = envelopeOk(commandId, startedAt, artifacts, 'run');
  const recorded = appendActiveRecordings(command, primaryArgs, payload);
  const waitPayload = payload.wait;
  if (waitPayload && typeof waitPayload === 'object' && !Array.isArray(waitPayload)) {
    const waitRecorded = appendActiveRecordings('wait', postActionWaitArgs(command, parsed.options) ?? {}, waitPayload as Record<string, unknown>);
    recorded.push(...waitRecorded);
  }
  if (recorded.length > 0) {
    payload.recording = recorded;
  }
  response.data = payload;
  return { code: 0, response };
}

export async function cmdStart(parsed: ParsedCommand): Promise<CommandResult> {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();

  try {
    const status = await startVisorDaemon(
      String(parsed.options['server-url'] ?? DEFAULT_SERVER_URL),
      typeof parsed.options['appium-cmd'] === 'string' ? parsed.options['appium-cmd'] : undefined
    );
    const response = envelopeOk(commandId, startedAt, [], 'run');
    response.data = status;
    return { code: 0, response };
  } catch (error) {
    const response = envelopeFail(
      commandId,
      startedAt,
      'TARGET_ERROR',
      'Failed to start Visor daemon',
      errorMessage(error),
      'Install Node deps, check --appium-cmd, and inspect .visor/daemon/*.log'
    );
    return { code: 1, response };
  }
}

export async function cmdStatus(parsed: ParsedCommand): Promise<CommandResult> {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  const status = await statusVisorDaemon(String(parsed.options['server-url'] ?? DEFAULT_SERVER_URL));
  const daemon = status.daemon as Record<string, unknown> | undefined;
  const response = envelopeOk(
    commandId,
    startedAt,
    [],
    daemon?.running ? 'run' : daemon?.unresponsive ? 'stop' : 'start'
  );
  response.data = status;
  return { code: 0, response };
}

export async function cmdStop(parsed: ParsedCommand): Promise<CommandResult> {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();

  try {
    const result = await stopVisorDaemon(
      String(parsed.options['server-url'] ?? DEFAULT_SERVER_URL),
      Boolean(parsed.options.force)
    );
    const response = envelopeOk(commandId, startedAt, [], 'none');
    response.data = result;
    return { code: 0, response };
  } catch (error) {
    const response = envelopeFail(
      commandId,
      startedAt,
      'TARGET_ERROR',
      'Failed to stop Visor daemon',
      errorMessage(error),
      'Retry with --force or check process state manually'
    );
    return { code: 1, response };
  }
}

export async function executeCommand(argv: string[]): Promise<CommandResult> {
  const requestedHelp = argv[0] === 'help' || argv.includes('--help') || argv.includes('-h');
  if (requestedHelp) {
    const helpCommand = argv.find((token) => ALL_COMMANDS.has(token));
    return cmdHelp(helpCommand);
  }

  if (
    argv.length === 0
  ) {
    return cmdHelp();
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    return cmdVersion();
  }

  const parsed = parseCommand(argv);

  if (parsed.command === 'validate') {
    return cmdValidate(parsed);
  }
  if (parsed.command === 'run') {
    return cmdRun(parsed);
  }
  if (parsed.command === 'discover') {
    return cmdDiscover(parsed);
  }
  if (parsed.command === 'benchmark') {
    return cmdBenchmark(parsed);
  }
  if (parsed.command === 'report') {
    return cmdReport(parsed);
  }
  if (parsed.command === 'record') {
    return cmdRecord(parsed);
  }
  if (parsed.command === 'replay') {
    return cmdReplay(parsed);
  }
  if (parsed.command === 'start') {
    return cmdStart(parsed);
  }
  if (parsed.command === 'status') {
    return cmdStatus(parsed);
  }
  if (parsed.command === 'stop') {
    return cmdStop(parsed);
  }
  if (ACTION_COMMANDS.has(parsed.command as CommandName)) {
    return cmdAction(parsed.command as CommandName, parsed);
  }

  throw new Error(`Unsupported command '${parsed.command}'`);
}
