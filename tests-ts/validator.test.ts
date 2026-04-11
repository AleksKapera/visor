import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseAndValidate } from '../src/validator.js';

function writeScenario(scenario: Record<string, unknown>): string {
  const filePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'visor-validator-')),
    'scenario.json'
  );
  fs.writeFileSync(filePath, JSON.stringify(scenario, null, 2));
  return filePath;
}

describe('scenario validator', () => {
  it('accepts scroll steps with direction and percent', () => {
    const scenarioPath = writeScenario({
      meta: { name: 'scroll-valid', version: '1' },
      config: { seed: 1 },
      steps: [{ id: 's1', command: 'scroll', args: { direction: 'down', percent: 70 } }],
      assertions: [],
      output: {}
    });

    const result = parseAndValidate(scenarioPath);

    expect(result.scenario).not.toBeNull();
    expect(result.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it('accepts legacy meta platform when valid', () => {
    const scenarioPath = writeScenario({
      meta: { name: 'scroll-valid', version: '1', platform: 'android' },
      config: { seed: 1 },
      steps: [{ id: 's1', command: 'scroll', args: { direction: 'down', percent: 70 } }],
      assertions: [],
      output: {}
    });

    const result = parseAndValidate(scenarioPath);

    expect(result.scenario).not.toBeNull();
    expect(result.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it('rejects scroll steps without a direction', () => {
    const scenarioPath = writeScenario({
      meta: { name: 'scroll-missing-direction', version: '1', platform: 'android' },
      config: { seed: 1 },
      steps: [{ id: 's1', command: 'scroll', args: { percent: 70 } }],
      assertions: [],
      output: {}
    });

    const result = parseAndValidate(scenarioPath);

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ARG_ERROR',
          message: 'scroll requires args.direction'
        })
      ])
    );
  });

  it('rejects unsupported scroll directions and percent values', () => {
    const scenarioPath = writeScenario({
      meta: { name: 'scroll-invalid', version: '1', platform: 'android' },
      config: { seed: 1 },
      steps: [{ id: 's1', command: 'scroll', args: { direction: 'left', percent: 101 } }],
      assertions: [],
      output: {}
    });

    const result = parseAndValidate(scenarioPath);

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ARG_ERROR',
          message: "scroll args.direction must be 'up' or 'down'"
        }),
        expect.objectContaining({
          code: 'ARG_ERROR',
          message: 'scroll args.percent must be a number between 1 and 100'
        })
      ])
    );
  });
});
