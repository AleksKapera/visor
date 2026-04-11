import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { makeError } from './errors.js';
import type {
  Assertion,
  AssertionResult,
  PlatformAdapter,
  RunResult,
  Scenario,
  StepResult
} from './types.js';
import { makeId, signatureFor, utcNowIso } from './utils.js';

async function runStep(
  adapter: PlatformAdapter,
  command: Scenario['steps'][number]['command'],
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  switch (command) {
    case 'tap':
      return adapter.tap(args);
    case 'navigate':
      return adapter.navigate(args);
    case 'act':
      return adapter.act(args);
    case 'scroll':
      return adapter.scroll(args);
    case 'screenshot':
      return adapter.screenshot(args);
    case 'wait':
      return adapter.wait(args);
    case 'source':
      return adapter.source(args);
  }
}

async function evaluateAssertions(
  adapter: PlatformAdapter,
  assertions: Assertion[]
): Promise<{ results: AssertionResult[]; ok: boolean; failedTargets: string[] }> {
  const results: AssertionResult[] = [];
  let ok = true;
  const failedTargets: string[] = [];

  for (const assertion of assertions) {
    let status: AssertionResult['status'] = 'passed';
    let details = '';

    if (assertion.type === 'visible') {
      const visible = await adapter.exists(assertion.target);
      if (!visible) {
        status = 'failed';
        details = `Target not visible: ${assertion.target}`;
        ok = false;
        failedTargets.push(assertion.target);
      }
    } else {
      status = 'failed';
      details = `Unsupported assertion type: ${assertion.type}`;
      ok = false;
      failedTargets.push(assertion.target);
    }

    results.push({
      id: assertion.id,
      type: assertion.type,
      target: assertion.target,
      status,
      details
    });
  }

  return { results, ok, failedTargets };
}

function signatureSafeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const safe = structuredClone(details);
  const args = safe.args;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    delete (args as Record<string, unknown>).path;
  }
  return safe;
}

export async function runScenario(
  scenario: Scenario,
  adapter: PlatformAdapter,
  device = 'local',
  timeoutMs?: number,
  artifactBaseDir?: string,
  closeAdapter = true
): Promise<RunResult> {
  const started_at = utcNowIso();
  const run_id = makeId('run');
  const platform = scenario.meta.platform;
  const stepResults: StepResult[] = [];
  const artifacts: string[] = [];
  let topError: RunResult['error'];

  let screenshotDir: string | undefined;
  let sourceDir: string | undefined;
  if (artifactBaseDir) {
    screenshotDir = path.join(artifactBaseDir, run_id, 'screenshots');
    sourceDir = path.join(artifactBaseDir, run_id, 'sources');
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
  }

  try {
    for (const step of scenario.steps) {
      const started = performance.now();

      try {
        const stepArgs = { ...step.args };
        if (step.command === 'screenshot' && screenshotDir) {
          const label = String(stepArgs.label ?? step.id);
          stepArgs.path = path.join(screenshotDir, `${label}.png`);
        }
        if (step.command === 'source' && sourceDir) {
          const label = String(stepArgs.label ?? step.id);
          stepArgs.path = path.join(sourceDir, `${label}.xml`);
        }

        const details = await runStep(adapter, step.command, stepArgs);
        const durationMs = Math.round(performance.now() - started);
        const result: StepResult = {
          id: step.id,
          command: step.command,
          status: 'ok',
          duration_ms: durationMs,
          details
        };

        if (step.command === 'screenshot' || step.command === 'source') {
          const args = details.args;
          if (args && typeof args === 'object' && !Array.isArray(args)) {
            const artifactPath =
              typeof (args as Record<string, unknown>).path === 'string'
                ? ((args as Record<string, unknown>).path as string)
                : typeof (args as Record<string, unknown>).file === 'string'
                  ? ((args as Record<string, unknown>).file as string)
                  : '';
            if (artifactPath) {
              artifacts.push(artifactPath);
            }
          }
        }

        if (timeoutMs && durationMs > timeoutMs) {
          result.status = 'fail';
          result.error = makeError(
            'ACTION_ERROR',
            `Step '${step.id}' exceeded timeout`,
            'Device/app was too slow for configured timeout',
            'Increase --timeout or optimize target action'
          );
        }

        stepResults.push(result);
      } catch (error) {
        const durationMs = Math.round(performance.now() - started);
        stepResults.push({
          id: step.id,
          command: step.command,
          status: 'fail',
          duration_ms: durationMs,
          details: {},
          error: makeError(
            'ACTION_ERROR',
            `Step '${step.id}' failed`,
            error instanceof Error ? error.message : String(error),
            'Inspect step args and platform adapter support'
          )
        });
      }
    }

    const assertionEvaluation = await evaluateAssertions(adapter, scenario.assertions);
    const stepsOk = stepResults.every((step) => step.status === 'ok');

    if (!stepsOk) {
      topError = makeError(
        'ACTION_ERROR',
        'Run failed due to one or more action step failures',
        'At least one command execution step returned failure',
        'Inspect failed step error payloads in run.steps and retry'
      );
    }

    if (!assertionEvaluation.ok) {
      const firstFailedTarget = assertionEvaluation.failedTargets[0] ?? 'unknown target';
      topError = makeError(
        'ASSERTION_ERROR',
        'Run failed due to assertion failure',
        `Expected UI target was not satisfied: ${firstFailedTarget}`,
        'Verify selector correctness and app state before assertion step'
      );
    }

    const allPass = stepsOk && assertionEvaluation.ok;
    const ended_at = utcNowIso();
    const signatureInput = {
      platform,
      steps: stepResults.map((step) => ({
        id: step.id,
        command: step.command,
        status: step.status,
        details: signatureSafeDetails(step.details)
      })),
      assertions: assertionEvaluation.results
    };

    return {
      run_id,
      platform,
      device,
      started_at,
      ended_at,
      status: allPass ? 'ok' : 'fail',
      steps: stepResults,
      assertions: assertionEvaluation.results,
      artifacts,
      determinism_signature: signatureFor(signatureInput),
      seed: typeof scenario.config.seed === 'number' ? scenario.config.seed : undefined,
      error: topError
    };
  } finally {
    if (closeAdapter) {
      await adapter.close();
    }
  }
}

export function determinismCheck(signatures: string[]): number {
  if (signatures.length === 0) {
    return 0;
  }

  const baseline = signatures[0];
  const same = signatures.filter((signature) => signature === baseline).length;
  return Math.round((same / signatures.length) * 10000) / 100;
}
