import fs from 'node:fs';

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
  path: 'string'
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
    'crawl-limit': 'number'
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
    'crawl-limit': 'number'
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
  'start-value': 'startValue'
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
    '  visor scroll --device emulator-5554 --direction down',
    '  visor status'
  ].join('\n');
}

function commandHelpText(command: string): { usageText: string; examples: string[] } {
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
        '  --target <selector>      Target selector for type or slider',
        '  --value <value>          Text value for type, or 0..1 slider value',
        '  --start-x <points>       Drag start x coordinate',
        '  --start-y <points>       Drag start y coordinate',
        '  --end-x <points>         Drag end x coordinate',
        '  --end-y <points>         Drag end y coordinate',
        '  --start-value <0..1>     Slider starting value, default 0.5',
        '  --normalized             Treat drag coordinates as viewport fractions'
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

async function resolvedRuntime(options: ParsedOptions): Promise<RuntimeOptions> {
  const selectedDevice = await resolveRunningDevice(
    typeof options.device === 'string' ? options.device : undefined
  );

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
      ...(typeof options['crawl-limit'] === 'number' ? { crawlLimit: options['crawl-limit'] } : {})
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
    if (!commonIgnored.has(key) && value !== undefined) {
      acc[ACTION_ARG_OPTION_NAMES[key] ?? key] = value;
    }
    return acc;
  }, {});

  if (command === 'source' && args.label === undefined) {
    args.label = 'source';
  }

  return args;
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

  try {
    payload = await runDaemonAction(
      {
        platform: options.platform,
        server_url: options.server_url,
        device: options.device,
        app_id: options.app_id,
        attach_to_running: options.attach_to_running
      },
      command,
      actionArgs(command, parsed.options),
      {
        ...options.map,
        appId: options.app_id
      }
    );
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
