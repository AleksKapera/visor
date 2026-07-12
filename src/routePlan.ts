import { COMMAND_NAMES } from './types.js';
import type { CommandName } from './types.js';

export interface RouteExpectation {
  screen: string;
  selector: string;
  timeout_ms: number;
}

export interface RoutePlanStep {
  id: string;
  command: CommandName;
  args: Record<string, unknown>;
  safety: 'safe';
  expect: RouteExpectation;
}

export interface RoutePlanPath {
  id: string;
  from?: { selector: string };
  steps: RoutePlanStep[];
}

export interface RoutePlan {
  goal: string;
  rediscover: boolean;
  paths: RoutePlanPath[];
}

const ROUTE_COMMANDS = new Set<CommandName>(['tap', 'navigate', 'act', 'scroll']);

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field '${unknown[0]}'`);
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function expectation(value: unknown, label: string): RouteExpectation {
  const candidate = requireObject(value, label);
  exactKeys(candidate, ['screen', 'selector', 'timeout_ms'], label);
  const timeout = candidate.timeout_ms ?? 30000;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > 300000) {
    throw new Error(`${label}.timeout_ms must be between 1 and 300000`);
  }
  return {
    screen: requireNonEmptyString(candidate.screen, `${label}.screen`),
    selector: requireNonEmptyString(candidate.selector, `${label}.selector`),
    timeout_ms: timeout
  };
}

function parseRouteStep(value: unknown, pathIndex: number, stepIndex: number): RoutePlanStep {
  const label = `paths[${pathIndex}].steps[${stepIndex}]`;
  const candidate = requireObject(value, label);
  exactKeys(candidate, ['id', 'command', 'args', 'safety', 'expect'], label);
  const command = requireNonEmptyString(candidate.command, `${label}.command`) as CommandName;
  if (!COMMAND_NAMES.includes(command) || !ROUTE_COMMANDS.has(command)) {
    throw new Error(`${label}.command must be tap, navigate, act, or scroll`);
  }
  if (candidate.safety !== 'safe') {
    throw new Error(`${label}.safety must be 'safe'`);
  }
  return {
    id: requireNonEmptyString(candidate.id, `${label}.id`),
    command,
    args: structuredClone(requireObject(candidate.args, `${label}.args`)),
    safety: 'safe',
    expect: expectation(candidate.expect, `${label}.expect`)
  };
}

function parseRoutePath(value: unknown, index: number): RoutePlanPath {
  const label = `paths[${index}]`;
  const candidate = requireObject(value, label);
  exactKeys(candidate, ['id', 'from', 'steps'], label);
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) {
    throw new Error(`${label}.steps must be a non-empty array`);
  }
  const from = candidate.from === undefined ? undefined : requireObject(candidate.from, `${label}.from`);
  if (from) {
    exactKeys(from, ['selector'], `${label}.from`);
  }
  return {
    id: requireNonEmptyString(candidate.id, `${label}.id`),
    ...(from
      ? { from: { selector: requireNonEmptyString(from.selector, `${label}.from.selector`) } }
      : {}),
    steps: candidate.steps.map((value, stepIndex) => parseRouteStep(value, index, stepIndex))
  };
}

export function parseRoutePlan(input: string): RoutePlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`Route plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidate = requireObject(parsed, 'route plan');
  exactKeys(candidate, ['goal', 'rediscover', 'paths'], 'route plan');
  if (!Array.isArray(candidate.paths) || candidate.paths.length === 0) {
    throw new Error('route plan paths must be a non-empty array');
  }
  if (candidate.rediscover !== undefined && typeof candidate.rediscover !== 'boolean') {
    throw new Error('route plan rediscover must be a boolean');
  }
  const paths = candidate.paths.map(parseRoutePath);
  const pathIds = paths.map((entry) => entry.id);
  if (new Set(pathIds).size !== pathIds.length) {
    throw new Error('route plan path ids must be unique');
  }
  return {
    goal: requireNonEmptyString(candidate.goal, 'route plan goal'),
    rediscover: candidate.rediscover !== false,
    paths
  };
}
