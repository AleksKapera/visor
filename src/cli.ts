import { DEFAULT_SERVER_URL, getAdapter } from './adapters.js';
import {
  DaemonUnavailableError,
  runDaemonAction,
  runDaemonScenario,
  startVisorDaemon,
  statusVisorDaemon,
  stopVisorDaemon
} from './daemon.js';
import { makeError } from './errors.js';
import { writeReports } from './report.js';
import { determinismCheck, runScenario } from './runner.js';
import type {
  CommandName,
  CommandResponse,
  ErrorCode,
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
  use_mock: boolean;
  app_id?: string;
  attach_to_running: boolean;
}

interface HelpData {
  usageText: string;
  commands: string[];
  examples: string[];
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
  'benchmark',
  'report',
  'start',
  'status',
  'stop'
]);

const GLOBAL_SPEC: Record<string, OptionType> = {
  platform: 'string',
  device: 'string',
  timeout: 'number',
  output: 'string',
  format: 'string',
  seed: 'number',
  'server-url': 'string',
  'app-id': 'string',
  attach: 'boolean',
  mock: 'boolean',
  verbose: 'boolean'
};

const ACTION_SPEC: Record<string, OptionType> = {
  ...GLOBAL_SPEC,
  target: 'string',
  x: 'number',
  y: 'number',
  direction: 'string',
  percent: 'number',
  normalized: 'boolean',
  to: 'string',
  name: 'string',
  value: 'string',
  label: 'string',
  ms: 'number',
  path: 'string'
};

const COMMAND_SPECS: Record<string, Record<string, OptionType>> = {
  validate: { format: 'string' },
  run: {
    platform: 'string',
    device: 'string',
    timeout: 'number',
    output: 'string',
    format: 'string',
    'server-url': 'string',
    'app-id': 'string',
    attach: 'boolean',
    mock: 'boolean'
  },
  benchmark: {
    runs: 'number',
    threshold: 'number',
    platform: 'string',
    device: 'string',
    timeout: 'number',
    output: 'string',
    format: 'string',
    'server-url': 'string',
    'app-id': 'string',
    attach: 'boolean',
    mock: 'boolean'
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

function helpText(): string {
  return [
    'Visor TypeScript CLI',
    '',
    'Usage:',
    '  visor <command> [options]',
    '  visor --help',
    '',
    'Commands:',
    '  validate <scenario>',
    '  run <scenario> [--mock] [--output <dir>]',
    '  benchmark <scenario> [--runs <n>] [--threshold <percent>]',
    '  report [path]',
    '  start [--server-url <url>] [--appium-cmd <cmd>]',
    '  status [--server-url <url>]',
    '  stop [--server-url <url>] [--force]',
    '  tap|navigate|act|scroll|screenshot|wait|source',
    '',
    'Examples:',
    '  visor validate scenarios/checkout-smoke.json',
    '  visor start --server-url http://127.0.0.1:4723',
    '  visor run scenarios/checkout-smoke.json --mock --output artifacts-test',
    '  visor scroll --platform android --mock --direction down',
    '  node dist/main.js status'
  ].join('\n');
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

function resolvedRuntime(options: ParsedOptions, scenario: Scenario): RuntimeOptions {
  const platform = String(options.platform ?? scenario.meta.platform) as Platform;
  const defaultDevice = platform === 'android' ? 'emulator-5554' : 'iPhone 17 Pro';
  scenario.meta.platform = platform;

  return {
    platform,
    device: String(options.device ?? defaultDevice),
    timeout:
      typeof options.timeout === 'number'
        ? options.timeout
        : typeof scenario.config.timeoutMs === 'number'
          ? scenario.config.timeoutMs
          : 2500,
    output_dir: String(options.output ?? scenario.config.artifactsDir ?? 'artifacts'),
    server_url: String(options['server-url'] ?? DEFAULT_SERVER_URL),
    use_mock: Boolean(options.mock),
    app_id: typeof options['app-id'] === 'string' ? options['app-id'] : undefined,
    attach_to_running: Boolean(options.attach)
  };
}

function actionArgs(command: CommandName, options: ParsedOptions): Record<string, unknown> {
  const commonIgnored = new Set([
    'platform',
    'device',
    'format',
    'output',
    'timeout',
    'verbose',
    'server-url',
    'mock',
    'seed',
    'app-id',
    'attach'
  ]);
  const args = Object.entries(options).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (!commonIgnored.has(key) && value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {});

  if (command === 'source' && args.label === undefined) {
    args.label = 'source';
  }

  return args;
}

function cmdHelp(): CommandResult {
  const commandId = makeId('cmd');
  const startedAt = utcNowIso();
  const response = envelopeOk(commandId, startedAt, [], 'validate');
  response.data = {
    usageText: helpText(),
    commands: Array.from(ALL_COMMANDS),
    examples: [
      'visor validate scenarios/checkout-smoke.json',
      'visor start --server-url http://127.0.0.1:4723',
      'visor run scenarios/checkout-smoke.json --mock --output artifacts-test',
      'visor scroll --platform android --mock --direction down',
      'node dist/main.js status'
    ]
  } satisfies HelpData;
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

  const runtime = resolvedRuntime(parsed.options, scenario);

  try {
    const result = runtime.use_mock
      ? await runScenario(
          scenario,
          await getAdapter(
            runtime.platform,
            runtime.server_url,
            runtime.device,
            true,
            runtime.app_id,
            runtime.attach_to_running
          ),
          runtime.device,
          runtime.timeout,
          runtime.output_dir
        )
      : await runDaemonScenario(
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
          runtime.output_dir
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
    const response = envelopeFail(
      commandId,
      startedAt,
      'TARGET_ERROR',
      'Failed to initialize platform target',
      errorMessage(error),
      'Run `visor start`, verify the target emulator/simulator is booted, and retry.'
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

  const runtime = resolvedRuntime(parsed.options, scenario);
  const runs = typeof parsed.options.runs === 'number' ? parsed.options.runs : 20;
  const threshold = typeof parsed.options.threshold === 'number' ? parsed.options.threshold : 95;
  const signatures: string[] = [];
  const runIds: string[] = [];
  let failures = 0;

  for (let index = 0; index < runs; index += 1) {
    try {
      const result = runtime.use_mock
        ? await runScenario(
            scenario,
            await getAdapter(
              runtime.platform,
              runtime.server_url,
              runtime.device,
              true,
              runtime.app_id,
              runtime.attach_to_running
            ),
            runtime.device,
            runtime.timeout,
            runtime.output_dir
          )
        : await runDaemonScenario(
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
            runtime.output_dir
          );
      writeReports(result, runtime.output_dir);
      signatures.push(result.determinism_signature);
      runIds.push(result.run_id);
      if (result.status !== 'ok') {
        failures += 1;
      }
    } catch (error) {
      if (!runtime.use_mock && error instanceof DaemonUnavailableError) {
        const response = envelopeFail(
          commandId,
          startedAt,
          'TARGET_ERROR',
          'Benchmark requires visor start',
          errorMessage(error),
          'Run `visor start`, verify the target emulator/simulator is booted, and retry.'
        );
        return { code: 1, response };
      }
      failures += 1;
    }
  }

  const score = determinismCheck(signatures);
  const passGate = score >= threshold && failures === 0;

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
  const options = {
    platform: String(parsed.options.platform ?? 'android') as Platform,
    device: typeof parsed.options.device === 'string' ? parsed.options.device : undefined,
    server_url: String(parsed.options['server-url'] ?? DEFAULT_SERVER_URL),
    use_mock: Boolean(parsed.options.mock),
    app_id: typeof parsed.options['app-id'] === 'string' ? parsed.options['app-id'] : undefined,
    attach_to_running: Boolean(parsed.options.attach)
  };

  let payload: Record<string, unknown> = {};
  let artifacts: string[] = [];
  let actionError: unknown;
  let adapter;

  try {
    if (options.use_mock) {
      adapter = await getAdapter(
        options.platform,
        options.server_url,
        options.device,
        true,
        options.app_id,
        options.attach_to_running
      );
      payload = await adapter[command](actionArgs(command, parsed.options));
    } else {
      payload = await runDaemonAction(
        {
          platform: options.platform,
          server_url: options.server_url,
          device: options.device ?? (options.platform === 'android' ? 'emulator-5554' : 'iPhone 17 Pro'),
          app_id: options.app_id,
          attach_to_running: options.attach_to_running
        },
        command,
        actionArgs(command, parsed.options)
      );
    }
    const actionPayload = payload.args;
    if (actionPayload && typeof actionPayload === 'object' && !Array.isArray(actionPayload)) {
      const maybePath = (actionPayload as Record<string, unknown>).path;
      if (typeof maybePath === 'string') {
        artifacts = [maybePath];
      }
    }
  } catch (error) {
    actionError = error;
  } finally {
    if (adapter) {
      await adapter.close();
    }
  }

  if (actionError) {
    const isDaemonUnavailable = actionError instanceof DaemonUnavailableError;
    const response = envelopeFail(
      commandId,
      startedAt,
      isDaemonUnavailable ? 'TARGET_ERROR' : 'ACTION_ERROR',
      isDaemonUnavailable ? `${command} requires visor start` : `${command} failed`,
      errorMessage(actionError),
      isDaemonUnavailable
        ? 'Run `visor start`, verify the target emulator/simulator is booted, and retry.'
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
  const response = envelopeOk(commandId, startedAt, [], daemon?.running ? 'run' : 'start');
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
  if (
    argv.length === 0 ||
    argv[0] === 'help' ||
    argv.includes('--help') ||
    argv.includes('-h')
  ) {
    return cmdHelp();
  }

  const parsed = parseCommand(argv);

  if (parsed.command === 'validate') {
    return cmdValidate(parsed);
  }
  if (parsed.command === 'run') {
    return cmdRun(parsed);
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
