---
title: Agent-first discovery and deterministic routes
status: accepted
---

## Problem

The original discovery workflow asks Visor to inventory a large UI tree and finish with generic crawling. Real-device testing against a representative development app showed that this produces noisy, dynamic maps, broad coordinate targets, transitional snapshots, and slow crawls that cannot assign product meaning reliably.

Agents need a much smaller memory that answers four questions:

1. Which semantic screen is current?
2. Which safe actions matter on that screen?
3. Which destination should each action reach?
4. Which executable selector proves that destination?

Known navigation also needs one daemon request. Starting a CLI process for every step wastes time, lets Appium sessions expire while the agent reasons, and can leave the agent without a structured result even when the app reached the right screen.

## Product shape

Visor separates two artifacts:

- The runtime index keeps source fingerprints, raw elements, variants, and execution evidence that Visor needs internally.
- Agent memory contains compact semantic screens, meaningful safe actions, executable destination selectors, routes, typed reliability evidence, and explicit unknowns. Discovery responses expose this memory and persist it beside the runtime index.

The discovery agent owns semantic exploration. Generic crawling does not define the map and does not run as a required final step. Visor supplies compact observation, safe interaction, atomic persistence, session recovery, and validation primitives.

The route executor accepts an agent-authored route plan with one or more ordered paths. Each path contains safe action steps and an expected destination selector. Visor executes one path sequentially inside the daemon, checkpoints every outcome, and tries another eligible path after a failure.

## Discovery behavior

- A brand-new agent can start with an empty map directory and `visor discover`.
- The response includes the current semantic-memory slice, executable action candidates, an observation token, and gaps that still need agent meaning.
- The agent annotates screens and safe actions during the first tour. It does not repeat a route solely to annotate it.
- The persistent agent-memory file excludes raw elements, raw source, screenshots, dynamic feed text, identity values, and financial values.
- Normal routes update reliability evidence opportunistically.
- The agent uses screenshot or source only when compact observation cannot resolve an ambiguity.
- The agent explores one safe action at a time and checkpoints immediately. It stops when remaining actions are risky, input-dependent, repetitive, or low value.
- Generic `discover --crawl` remains available as a diagnostic compatibility tool, but the discovery skill does not invoke it by default.

## Route-plan format

A route plan is JSON read from a file or standard input:

```json
{
  "goal": "account.settings",
  "rediscover": true,
  "paths": [
    {
      "id": "activity-settings",
      "from": { "selector": "accessibility=Post" },
      "steps": [
        {
          "id": "open-settings",
          "command": "tap",
          "args": { "x": 35, "y": 90 },
          "safety": "safe",
          "expect": {
            "screen": "account.settings",
            "selector": "accessibility=Your Account",
            "timeout_ms": 30000
          }
        }
      ]
    }
  ]
}
```

Visor rejects malformed plans before device selection. It only executes steps explicitly marked `safe`.

## Multiple paths

Visor evaluates paths in document order. A path may declare a `from.selector`; Visor skips the path when the current screen does not match it. After a step fails, Visor observes and persists the current state, then evaluates the next path against that state. This lets an agent provide a preferred route plus recovery routes without hidden nondeterministic exploration.

## Unknown states and rediscovery

When a step reaches an unexpected state, Visor:

1. records a typed verification failure;
2. observes and checkpoints the new state;
3. refreshes compact agent memory;
4. tries the next eligible supplied path;
5. returns `needs_discovery` with the compact current-screen slice if no supplied path applies.

Visor never guesses a consequential action. The discovery agent can annotate the unknown screen, add a safe recovery path, and resubmit the plan.

## Typed outcomes

Each step produces exactly one outcome:

- `success`: the command ran and the expected selector matched;
- `runtime_failure`: Visor could not complete the command or lost the device session;
- `verification_failure`: the command ran but the expected selector did not match;
- `skipped`: the path's starting selector did not match;
- `unsafe`: the plan did not mark the step safe.

Runtime failures do not reduce locator confidence. Verification failures affect the route contract, while an action that visibly had no effect affects locator confidence.

## Session and response guarantees

- The Appium idle timeout must be configurable and default to at least ten minutes for agent workflows.
- One route request uses one cached driver session.
- The CLI returns one structured response and terminates after the daemon responds.
- The route result includes selected path, attempts, per-step duration, observed screen, compact rediscovery state, and checkpoint path.
- A partial or failed route checkpoint includes the validated plan, current observation token, and next execution position so it remains reviewable and resumable.

## Acceptance scenarios

1. Empty map: a fresh-context agent discovers and annotates a real app without reading prior files.
2. Cached route: a fresh agent uses compact memory and reaches a known destination without screenshots or source dumps.
3. Multiple paths: the first supplied path fails and the second eligible path succeeds.
4. Unknown state with recovery: a step reaches a new screen, Visor checkpoints it, and a supplied recovery path completes.
5. Unknown state without recovery: Visor returns `needs_discovery` with compact current-screen context instead of throwing an opaque error.
6. Runtime failure: Visor returns a typed partial result without lowering locator confidence.
7. Unsafe step: Visor rejects the plan before touching the device.
8. Real iPhone: all scenarios that the representative development app can express run against a booted iOS simulator, with no fake-E2E claim substituted for Appium proof.
