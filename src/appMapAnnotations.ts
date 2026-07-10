import { COMMAND_NAMES, MAP_ACTION_SAFETY_VALUES } from './types.js';
import { commandArgumentErrors } from './commandArgs.js';
import type {
  AppMapActionAnnotation,
  AppMapAnnotation,
  AppMapScreenAnnotation,
  CommandName,
  MapActionSafety
} from './types.js';

const COMMANDS = new Set<string>(COMMAND_NAMES);
const SAFETY_VALUES = new Set<string>(MAP_ACTION_SAFETY_VALUES);

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function knownFields(value: Record<string, unknown>, allowed: string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((field) => !allowedSet.has(field));
  if (unknown) {
    throw new Error(`${path}.${unknown} is not supported`);
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredString(value, path);
}

function optionalNotes(value: unknown, path: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  return value.map((note, index) => requiredString(note, `${path}[${index}]`));
}

function parseScreen(value: unknown): AppMapScreenAnnotation {
  const screen = requireRecord(value, 'screen');
  knownFields(screen, ['label', 'purpose', 'description', 'notes'], 'screen');
  const description = optionalString(screen.description, 'screen.description');
  const notes = optionalNotes(screen.notes, 'screen.notes');
  return {
    label: requiredString(screen.label, 'screen.label'),
    purpose: requiredString(screen.purpose, 'screen.purpose'),
    ...(description ? { description } : {}),
    ...(notes ? { notes } : {})
  };
}

function parseAction(value: unknown, index: number): AppMapActionAnnotation {
  const path = `actions[${index}]`;
  const action = requireRecord(value, path);
  knownFields(action, ['command', 'args', 'label', 'intent', 'safety', 'description', 'notes'], path);
  const command = requiredString(action.command, `${path}.command`) as CommandName;
  if (!COMMANDS.has(command)) {
    throw new Error(`${path}.command '${command}' is not supported`);
  }
  const safety = requiredString(action.safety, `${path}.safety`) as MapActionSafety;
  if (!SAFETY_VALUES.has(safety)) {
    throw new Error(`${path}.safety '${safety}' is not supported`);
  }
  const args = requireRecord(action.args, `${path}.args`);
  const argumentErrors = commandArgumentErrors(command, args, { allowOmittedTypeValue: true });
  if (argumentErrors[0]) {
    throw new Error(`${path}.args: ${argumentErrors[0]}`);
  }
  const description = optionalString(action.description, `${path}.description`);
  const notes = optionalNotes(action.notes, `${path}.notes`);
  return {
    command,
    args: structuredClone(args),
    label: requiredString(action.label, `${path}.label`),
    intent: requiredString(action.intent, `${path}.intent`),
    safety,
    ...(description ? { description } : {}),
    ...(notes ? { notes } : {})
  };
}

export function parseAppMapAnnotation(input: string): AppMapAnnotation {
  if (input.trim() === '') {
    throw new Error('Annotation document is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch (error) {
    throw new Error(`Annotation JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const annotation = requireRecord(parsed, 'annotation');
  knownFields(annotation, ['screen', 'actions'], 'annotation');
  const screen = annotation.screen === undefined ? undefined : parseScreen(annotation.screen);
  const actions = annotation.actions === undefined
    ? undefined
    : Array.isArray(annotation.actions)
      ? annotation.actions.map(parseAction)
      : (() => { throw new Error('actions must be an array'); })();

  if (!screen && (!actions || actions.length === 0)) {
    throw new Error('Annotation must contain screen or at least one action');
  }

  return {
    ...(screen ? { screen } : {}),
    ...(actions ? { actions } : {})
  };
}
