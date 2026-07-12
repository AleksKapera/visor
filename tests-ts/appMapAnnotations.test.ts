import { parseAppMapAnnotation } from '../src/appMapAnnotations.js';

describe('app-map annotation schema', () => {
  it('parses screen and action semantics in the supported command shape', () => {
    expect(parseAppMapAnnotation(JSON.stringify({
      screen: {
        label: 'Checkout',
        purpose: 'Completes an order',
        description: 'Shipping step',
        notes: ['Requires cart contents']
      },
      actions: [
        {
          command: 'tap',
          args: { target: 'text=Continue' },
          label: 'Continue to payment',
          intent: 'advance_checkout',
          safety: 'safe'
        }
      ]
    }))).toEqual({
      screen: {
        label: 'Checkout',
        purpose: 'Completes an order',
        description: 'Shipping step',
        notes: ['Requires cart contents']
      },
      actions: [
        {
          command: 'tap',
          args: { target: 'text=Continue' },
          label: 'Continue to payment',
          intent: 'advance_checkout',
          safety: 'safe'
        }
      ]
    });
  });

  it.each([
    ['empty document', '', 'empty'],
    ['malformed JSON', '{', 'invalid'],
    ['missing annotation content', '{}', 'screen or at least one action'],
    [
      'unknown screen field',
      JSON.stringify({ screen: { label: 'Checkout', purpose: 'Complete checkout', unsupported: true } }),
      'screen.unsupported'
    ],
    [
      'invalid screen field type',
      JSON.stringify({ screen: { label: 42, purpose: 'Explain this screen' } }),
      'screen.label'
    ],
    ['invalid actions type', JSON.stringify({ actions: {} }), 'actions must be an array'],
    [
      'unsupported command',
      JSON.stringify({
        actions: [{ command: 'launch', args: {}, label: 'Launch', intent: 'launch_app', safety: 'safe' }]
      }),
      'command'
    ],
    [
      'invalid action args type',
      JSON.stringify({
        actions: [{ command: 'tap', args: [], label: 'Continue', intent: 'continue', safety: 'safe' }]
      }),
      'actions[0].args'
    ],
    [
      'missing tap target or coordinates',
      JSON.stringify({
        actions: [{ command: 'tap', args: {}, label: 'Continue', intent: 'continue', safety: 'safe' }]
      }),
      'tap requires'
    ],
    [
      'invalid scroll direction type',
      JSON.stringify({
        actions: [{ command: 'scroll', args: { direction: 7 }, label: 'Scroll', intent: 'scroll', safety: 'safe' }]
      }),
      'direction'
    ],
    [
      'missing navigation destination',
      JSON.stringify({
        actions: [{ command: 'navigate', args: {}, label: 'Navigate', intent: 'navigate', safety: 'safe' }]
      }),
      'args.to'
    ],
    [
      'type action with drag-only fields',
      JSON.stringify({
        actions: [{
          command: 'act',
          args: { name: 'type', startX: 'bad' },
          label: 'Type',
          intent: 'type',
          safety: 'needs-input'
        }]
      }),
      'startX is not supported'
    ],
    [
      'back action with a value',
      JSON.stringify({
        actions: [{
          command: 'act',
          args: { name: 'back', value: 42 },
          label: 'Go back',
          intent: 'go_back',
          safety: 'safe'
        }]
      }),
      'value is not supported'
    ],
    [
      'wait without a mode',
      JSON.stringify({
        actions: [{ command: 'wait', args: {}, label: 'Wait', intent: 'wait', safety: 'safe' }]
      }),
      'exactly one'
    ],
    [
      'wait with multiple modes',
      JSON.stringify({
        actions: [{
          command: 'wait',
          args: { ms: 10, stable: true },
          label: 'Wait',
          intent: 'wait',
          safety: 'safe'
        }]
      }),
      'exactly one'
    ],
    [
      'unsupported safety',
      JSON.stringify({
        actions: [{
          command: 'tap',
          args: { target: 'Continue' },
          label: 'Continue',
          intent: 'continue',
          safety: 'dangerous'
        }]
      }),
      'safety'
    ]
  ])('rejects %s', (_name, input, cause) => {
    expect(() => parseAppMapAnnotation(input)).toThrow(cause);
  });
});
