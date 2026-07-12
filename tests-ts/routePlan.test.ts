import { describe, expect, it } from 'vitest';

import { parseRoutePlan } from '../src/routePlan.js';

describe('route plan parser', () => {
  it('parses ordered safe paths and applies defaults', () => {
    expect(
      parseRoutePlan(
        JSON.stringify({
          goal: 'account.settings',
          paths: [
            {
              id: 'primary',
              from: { selector: 'accessibility=Activity' },
              steps: [
                {
                  id: 'open-settings',
                  command: 'tap',
                  args: { x: 35, y: 90 },
                  safety: 'safe',
                  expect: { screen: 'account.settings', selector: 'text=Back\nBack' }
                }
              ]
            }
          ]
        })
      )
    ).toMatchObject({
      goal: 'account.settings',
      rediscover: true,
      paths: [
        {
          id: 'primary',
          steps: [{ expect: { timeout_ms: 30000 } }]
        }
      ]
    });
  });

  it.each([
    ['malformed JSON', '{'],
    [
      'unsafe step',
      JSON.stringify({
        goal: 'delete',
        paths: [
          {
            id: 'unsafe',
            steps: [
              {
                id: 'delete',
                command: 'tap',
                args: { target: 'Delete' },
                safety: 'risky',
                expect: { screen: 'deleted', selector: 'Deleted' }
              }
            ]
          }
        ]
      })
    ],
    [
      'unsupported command',
      JSON.stringify({
        goal: 'capture',
        paths: [
          {
            id: 'capture',
            steps: [
              {
                id: 'source',
                command: 'source',
                args: {},
                safety: 'safe',
                expect: { screen: 'same', selector: 'App' }
              }
            ]
          }
        ]
      })
    ]
  ])('rejects %s', (_label, input) => {
    expect(() => parseRoutePlan(input)).toThrow();
  });
});
