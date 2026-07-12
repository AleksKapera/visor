export type Status = 'ok' | 'fail';

export type ErrorCode =
  | 'INPUT_ERROR'
  | 'TARGET_ERROR'
  | 'ACTION_ERROR'
  | 'ASSERTION_ERROR'
  | 'SYSTEM_ERROR';

export type Platform = 'android' | 'ios';

export const COMMAND_NAMES = [
  'tap',
  'navigate',
  'act',
  'scroll',
  'screenshot',
  'wait',
  'source'
] as const;

export type CommandName = typeof COMMAND_NAMES[number];

export const MAP_ACTION_SAFETY_VALUES = ['safe', 'needs-input', 'risky', 'unknown'] as const;

export type MapActionSafety = typeof MAP_ACTION_SAFETY_VALUES[number];

export interface AppMapScreenAnnotation {
  label: string;
  purpose: string;
  description?: string;
  notes?: string[];
}

export interface AppMapActionAnnotation {
  command: CommandName;
  args: Record<string, unknown>;
  label: string;
  intent: string;
  safety: MapActionSafety;
  description?: string;
  notes?: string[];
}

export interface AppMapAnnotation {
  screen?: AppMapScreenAnnotation;
  actions?: AppMapActionAnnotation[];
}

export type CliCommandName = CommandName | 'discover';

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

export interface MapRouteStep {
  command: CommandName;
  target?: string;
  confidence: number;
}

export interface MapExecutionSummary {
  enabled: boolean;
  used: boolean;
  updated: boolean;
  repaired: boolean;
  repairs: number;
  schema_version?: number;
  path?: string;
  identity?: string;
  summary?: {
    schema_version?: number;
    identity?: string;
    app_id?: string;
    platform?: Platform;
    screens: number;
    variants: number;
    edges: number;
    actions: number;
    auth_required_variants: number;
    updated_at?: string;
  };
}

export interface MapExecutionOptions {
  enabled?: boolean;
  rootDir?: string;
  appId?: string;
  repairDepth?: number;
  repairTimeoutMs?: number;
  repair?: boolean;
  crawl?: boolean;
  crawlDepth?: number;
  crawlLimit?: number;
  crawlSettleMs?: number;
  crawlSettlePollMs?: number;
  crawlInclude?: string[];
  crawlAllowRisky?: boolean;
  annotation?: AppMapAnnotation;
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
  map?: MapExecutionSummary;
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
