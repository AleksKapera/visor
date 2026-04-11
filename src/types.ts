export type Status = 'ok' | 'fail';

export type ErrorCode =
  | 'INPUT_ERROR'
  | 'TARGET_ERROR'
  | 'ACTION_ERROR'
  | 'ASSERTION_ERROR'
  | 'SYSTEM_ERROR';

export type Platform = 'android' | 'ios';

export type CommandName =
  | 'tap'
  | 'navigate'
  | 'act'
  | 'scroll'
  | 'screenshot'
  | 'wait'
  | 'source';

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  likely_cause: string;
  next_step: string;
}

export interface CommandResponse<T = Record<string, unknown>> {
  status: Status;
  command_id: string;
  started_at: string;
  ended_at: string;
  artifacts: string[];
  next_action: string;
  error?: ErrorPayload;
  data: T;
}

export interface Step {
  id: string;
  command: CommandName;
  args: Record<string, unknown>;
}

export interface Assertion {
  id: string;
  type: string;
  target: string;
}

export interface Scenario {
  meta: {
    name: string;
    version: string;
    platform?: Platform;
    tags?: string[];
    [key: string]: unknown;
  };
  config: Record<string, unknown>;
  steps: Step[];
  assertions: Assertion[];
  output: Record<string, unknown>;
}

export interface StepResult {
  id: string;
  command: CommandName;
  status: Status;
  duration_ms: number;
  details: Record<string, unknown>;
  error?: ErrorPayload;
}

export interface AssertionResult {
  id: string;
  type: string;
  target: string;
  status: 'passed' | 'failed';
  details: string;
}

export interface RunResult {
  run_id: string;
  platform: Platform;
  device: string;
  started_at: string;
  ended_at: string;
  status: Status;
  steps: StepResult[];
  assertions: AssertionResult[];
  artifacts: string[];
  determinism_signature: string;
  seed?: number;
  error?: ErrorPayload;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path: string;
}

export interface ParseValidationResult {
  scenario: Scenario | null;
  issues: ValidationIssue[];
}

export interface AdapterCapability {
  platform: Platform;
  commands: CommandName[];
}

export interface PlatformAdapter {
  capability(): AdapterCapability;
  navigate(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  tap(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  act(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  scroll(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  screenshot(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  wait(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  source(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  exists(target: string): Promise<boolean>;
  close(): Promise<void>;
}
