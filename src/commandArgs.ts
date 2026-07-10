import type { CommandName } from './types.js';

interface CommandArgumentValidationOptions {
  allowOmittedTypeValue?: boolean;
  allowUnknownFields?: boolean;
}

function unknownFieldErrors(
  args: Record<string, unknown>,
  allowed: string[],
  command: CommandName,
  allowUnknownFields: boolean
): string[] {
  if (allowUnknownFields) {
    return [];
  }
  const allowedSet = new Set(allowed);
  return Object.keys(args)
    .filter((field) => !allowedSet.has(field))
    .map((field) => `${command} args.${field} is not supported`);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function validateTapArgs(
  args: Record<string, unknown>,
  allowUnknownFields: boolean
): string[] {
  const errors = unknownFieldErrors(args, ['target', 'x', 'y', 'normalized'], 'tap', allowUnknownFields);
  const hasTarget = args.target !== undefined;
  const hasX = args.x !== undefined;
  const hasY = args.y !== undefined;
  if (hasTarget) {
    if (hasX || hasY) {
      errors.push('tap cannot mix args.target with args.x/args.y');
    } else if (!nonEmptyString(args.target)) {
      errors.push('tap args.target must be a non-empty string');
    }
  } else if (hasX || hasY) {
    if (!(hasX && hasY)) {
      errors.push('tap coordinate mode requires both args.x and args.y');
    } else if (!finiteNumber(args.x) || !finiteNumber(args.y)) {
      errors.push('tap args.x and args.y must be finite numbers');
    }
  } else {
    errors.push('tap requires args.target or args.x/args.y');
  }
  if (args.normalized !== undefined && typeof args.normalized !== 'boolean') {
    errors.push('tap args.normalized must be boolean');
  }
  return errors;
}

function validateNavigateArgs(
  args: Record<string, unknown>,
  allowUnknownFields: boolean
): string[] {
  const errors = unknownFieldErrors(args, ['to'], 'navigate', allowUnknownFields);
  if (!nonEmptyString(args.to)) {
    errors.push('navigate requires args.to as a non-empty string');
  }
  return errors;
}

function validateActArgs(
  args: Record<string, unknown>,
  options: Required<CommandArgumentValidationOptions>
): string[] {
  const name = nonEmptyString(args.name) ? args.name : '';
  if (!['type', 'back', 'home', 'reset', 'drag', 'slider'].includes(name)) {
    return [`act args.name '${name}' is not supported`];
  }

  const allowedByName: Record<string, string[]> = {
    type: ['name', 'target', 'value'],
    back: ['name'],
    home: ['name'],
    reset: ['name'],
    drag: ['name', 'startX', 'startY', 'endX', 'endY', 'normalized'],
    slider: ['name', 'target', 'value', 'startValue']
  };
  const errors = unknownFieldErrors(args, allowedByName[name] ?? ['name'], 'act', options.allowUnknownFields);

  if (name === 'type') {
    if (args.target !== undefined && !nonEmptyString(args.target)) {
      errors.push('act type args.target must be a non-empty string');
    }
    if (!options.allowOmittedTypeValue && !nonEmptyString(args.value)) {
      errors.push('act type requires args.value as a non-empty string');
    } else if (args.value !== undefined && typeof args.value !== 'string') {
      errors.push('act type args.value must be a string');
    }
  } else if (name === 'drag') {
    for (const field of ['startX', 'startY', 'endX', 'endY']) {
      if (!finiteNumber(args[field])) {
        errors.push(`act drag args.${field} must be a finite number`);
      }
    }
    if (args.normalized !== undefined && typeof args.normalized !== 'boolean') {
      errors.push('act drag args.normalized must be boolean');
    }
  } else if (name === 'slider') {
    if (!nonEmptyString(args.target)) {
      errors.push('act slider requires args.target as a non-empty string');
    }
    if (!finiteNumber(args.value) || args.value < 0 || args.value > 1) {
      errors.push('act slider args.value must be a number between 0 and 1');
    }
    if (
      args.startValue !== undefined &&
      (!finiteNumber(args.startValue) || args.startValue < 0 || args.startValue > 1)
    ) {
      errors.push('act slider args.startValue must be a number between 0 and 1');
    }
  }
  return errors;
}

function validateScrollArgs(
  args: Record<string, unknown>,
  allowUnknownFields: boolean
): string[] {
  const errors = unknownFieldErrors(args, ['direction', 'percent'], 'scroll', allowUnknownFields);
  if (args.direction === undefined) {
    errors.push('scroll requires args.direction');
  } else if (!nonEmptyString(args.direction) || !['up', 'down'].includes(args.direction.toLowerCase())) {
    errors.push("scroll args.direction must be 'up' or 'down'");
  }
  if (
    args.percent !== undefined &&
    (!finiteNumber(args.percent) || args.percent < 1 || args.percent > 100)
  ) {
    errors.push('scroll args.percent must be a number between 1 and 100');
  }
  return errors;
}

function validateCaptureArgs(
  command: 'screenshot' | 'source',
  args: Record<string, unknown>,
  allowUnknownFields: boolean
): string[] {
  const errors = unknownFieldErrors(args, ['label', 'path', 'settle', 'settleMs'], command, allowUnknownFields);
  for (const field of ['label', 'path']) {
    if (args[field] !== undefined && !nonEmptyString(args[field])) {
      errors.push(`${command} args.${field} must be a non-empty string`);
    }
  }
  if (args.settle !== undefined && typeof args.settle !== 'boolean') {
    errors.push(`${command} args.settle must be boolean`);
  }
  if (args.settleMs !== undefined && (!finiteNumber(args.settleMs) || args.settleMs < 0)) {
    errors.push(`${command} args.settleMs must be a non-negative number`);
  }
  return errors;
}

function validateWaitArgs(
  args: Record<string, unknown>,
  allowUnknownFields: boolean
): string[] {
  const errors = unknownFieldErrors(args, ['ms', 'for', 'stable', 'timeout', 'pollMs'], 'wait', allowUnknownFields);
  const modes = ['ms', 'for', 'stable'].filter((field) => args[field] !== undefined);
  if (modes.length !== 1) {
    errors.push('wait requires exactly one of args.ms, args.for, or args.stable');
  }
  if (args.ms !== undefined && (!finiteNumber(args.ms) || args.ms < 0)) {
    errors.push('wait args.ms must be a non-negative number');
  }
  if (args.for !== undefined && !nonEmptyString(args.for)) {
    errors.push('wait args.for must be a non-empty string');
  }
  if (args.stable !== undefined && args.stable !== true) {
    errors.push('wait args.stable must be true');
  }
  for (const field of ['timeout', 'pollMs']) {
    if (args[field] !== undefined && (!finiteNumber(args[field]) || args[field] < 0)) {
      errors.push(`wait args.${field} must be a non-negative number`);
    }
  }
  return errors;
}

export function commandArgumentErrors(
  command: CommandName,
  args: Record<string, unknown>,
  options: CommandArgumentValidationOptions = {}
): string[] {
  const resolvedOptions: Required<CommandArgumentValidationOptions> = {
    allowOmittedTypeValue: options.allowOmittedTypeValue === true,
    allowUnknownFields: options.allowUnknownFields === true
  };
  if (command === 'tap') {
    return validateTapArgs(args, resolvedOptions.allowUnknownFields);
  }
  if (command === 'navigate') {
    return validateNavigateArgs(args, resolvedOptions.allowUnknownFields);
  }
  if (command === 'act') {
    return validateActArgs(args, resolvedOptions);
  }
  if (command === 'scroll') {
    return validateScrollArgs(args, resolvedOptions.allowUnknownFields);
  }
  if (command === 'screenshot' || command === 'source') {
    return validateCaptureArgs(command, args, resolvedOptions.allowUnknownFields);
  }
  return validateWaitArgs(args, resolvedOptions.allowUnknownFields);
}
