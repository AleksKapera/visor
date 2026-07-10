import fs from 'node:fs';

import { commandArgumentErrors } from './commandArgs.js';
import { COMMAND_NAMES } from './types.js';
import type {
  Assertion,
  ParseValidationResult,
  Scenario,
  Step,
  ValidationIssue
} from './types.js';

const ALLOWED_TOP = new Set(['meta', 'config', 'steps', 'assertions', 'output']);
const ALLOWED_META = new Set(['name', 'version', 'platform', 'tags']);
const ALLOWED_CONFIG = new Set(['timeoutMs', 'seed', 'artifactsDir']);
const ALLOWED_STEP = new Set(['id', 'command', 'args']);
const ALLOWED_ASSERT = new Set(['id', 'type', 'target']);
const ALLOWED_OUTPUT = new Set(['report']);
const SUPPORTED_COMMANDS = new Set<string>(COMMAND_NAMES);

function validationIssue(
  severity: 'error' | 'warning',
  code: string,
  message: string,
  issuePath: string
): ValidationIssue {
  return { severity, code, message, path: issuePath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unknownFields(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  issuePath: string
): ValidationIssue[] {
  return Object.keys(obj)
    .filter((key) => !allowed.has(key))
    .map((key) =>
      validationIssue(
        'error',
        'UNKNOWN_FIELD',
        `Unknown field '${key}'`,
        issuePath ? `${issuePath}.${key}` : key
      )
    );
}

function requiredFields(
  obj: Record<string, unknown>,
  fields: string[],
  issuePath: string
): ValidationIssue[] {
  return fields
    .filter((field) => !(field in obj))
    .map((field) =>
      validationIssue('error', 'MISSING_REQUIRED', `Missing required field '${field}'`, issuePath)
    );
}

export function parseAndValidate(filePath: string): ParseValidationResult {
  const issues: ValidationIssue[] = [];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;

  if (!isRecord(raw)) {
    return {
      scenario: null,
      issues: [validationIssue('error', 'TYPE_ERROR', 'Scenario root must be object', '$')]
    };
  }

  issues.push(...unknownFields(raw, ALLOWED_TOP, '$'));
  issues.push(...requiredFields(raw, ['meta', 'config', 'steps'], '$'));

  const metaRaw = raw.meta;
  const configRaw = raw.config;
  const stepsRaw = raw.steps;
  const assertionsRaw = raw.assertions ?? [];
  const outputRaw = raw.output ?? {};

  let meta: Scenario['meta'] | null = null;
  if (isRecord(metaRaw)) {
    issues.push(...unknownFields(metaRaw, ALLOWED_META, '$.meta'));
    issues.push(...requiredFields(metaRaw, ['name', 'version'], '$.meta'));

    if (
      metaRaw.platform !== undefined &&
      metaRaw.platform !== 'ios' &&
      metaRaw.platform !== 'android'
    ) {
      issues.push(
        validationIssue('error', 'INPUT_ERROR', 'meta.platform must be ios|android', '$.meta.platform')
      );
    }

    if (typeof metaRaw.name === 'string' && typeof metaRaw.version === 'string') {
      meta = {
        ...metaRaw,
        name: metaRaw.name,
        version: metaRaw.version
      };
    }
  } else {
    issues.push(validationIssue('error', 'TYPE_ERROR', 'meta must be object', '$.meta'));
  }

  const config = isRecord(configRaw) ? configRaw : {};
  if (isRecord(configRaw)) {
    issues.push(...unknownFields(configRaw, ALLOWED_CONFIG, '$.config'));
  } else {
    issues.push(validationIssue('error', 'TYPE_ERROR', 'config must be object', '$.config'));
  }

  if (!Object.hasOwn(config, 'seed')) {
    issues.push(validationIssue('warning', 'DETERMINISM_WARNING', 'config.seed is missing', '$.config'));
  }

  const steps: Step[] = [];
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    issues.push(validationIssue('error', 'TYPE_ERROR', 'steps must be non-empty list', '$.steps'));
  } else {
    for (const [index, rawStep] of stepsRaw.entries()) {
      const issuePath = `$.steps[${index}]`;
      if (!isRecord(rawStep)) {
        issues.push(validationIssue('error', 'TYPE_ERROR', 'step must be object', issuePath));
        continue;
      }

      issues.push(...unknownFields(rawStep, ALLOWED_STEP, issuePath));
      issues.push(...requiredFields(rawStep, ['id', 'command', 'args'], issuePath));

      const command = rawStep.command;
      const args = rawStep.args;
      if (typeof command === 'string' && !SUPPORTED_COMMANDS.has(command)) {
        issues.push(
          validationIssue(
            'error',
            'UNSUPPORTED_COMMAND',
            `Unsupported command '${command}'`,
            `${issuePath}.command`
          )
        );
      }

      if (typeof command === 'string' && SUPPORTED_COMMANDS.has(command) && isRecord(args)) {
        issues.push(
          ...commandArgumentErrors(command as Step['command'], args, { allowUnknownFields: true })
            .map((message) => validationIssue('error', 'ARG_ERROR', message, `${issuePath}.args`))
        );
      }

      if (command === 'screenshot' && isRecord(args) && !Object.hasOwn(args, 'label')) {
        issues.push(
          validationIssue(
            'warning',
            'DETERMINISM_WARNING',
            'screenshot missing label may reduce determinism',
            `${issuePath}.args`
          )
        );
      }

      if (
        typeof rawStep.id === 'string' &&
        typeof command === 'string' &&
        SUPPORTED_COMMANDS.has(command) &&
        isRecord(args)
      ) {
        steps.push({
          id: rawStep.id,
          command: command as Step['command'],
          args
        });
      }
    }
  }

  const assertions: Assertion[] = [];
  if (Array.isArray(assertionsRaw)) {
    for (const [index, rawAssertion] of assertionsRaw.entries()) {
      const issuePath = `$.assertions[${index}]`;
      if (!isRecord(rawAssertion)) {
        issues.push(validationIssue('error', 'TYPE_ERROR', 'assertion must be object', issuePath));
        continue;
      }

      issues.push(...unknownFields(rawAssertion, ALLOWED_ASSERT, issuePath));
      issues.push(...requiredFields(rawAssertion, ['id', 'type', 'target'], issuePath));

      if (
        typeof rawAssertion.id === 'string' &&
        typeof rawAssertion.type === 'string' &&
        typeof rawAssertion.target === 'string'
      ) {
        assertions.push({
          id: rawAssertion.id,
          type: rawAssertion.type,
          target: rawAssertion.target
        });
      }
    }
  } else {
    issues.push(validationIssue('error', 'TYPE_ERROR', 'assertions must be list', '$.assertions'));
  }

  const output = isRecord(outputRaw) ? outputRaw : {};
  if (isRecord(outputRaw)) {
    issues.push(...unknownFields(outputRaw, ALLOWED_OUTPUT, '$.output'));
  } else {
    issues.push(validationIssue('error', 'TYPE_ERROR', 'output must be object', '$.output'));
  }

  if (issues.some((issue) => issue.severity === 'error') || meta === null) {
    return {
      scenario: null,
      issues
    };
  }

  return {
    scenario: {
      meta,
      config,
      steps,
      assertions,
      output
    },
    issues
  };
}
