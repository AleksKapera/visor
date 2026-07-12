---
name: visor-discovery
description: Operate running iOS and Android apps with Visor using compact semantic maps and deterministic routes. Use when an agent must set up Visor in a repository, perform initial discovery, navigate or inspect a mobile app, reuse an existing map, repair unknown or stale paths, or capture targeted evidence efficiently.
---

# Use Visor efficiently

Treat the installed repository skill as durable operating guidance and `.visor/maps` as private local memory. Prefer semantic map reads and deterministic route execution over repeated screenshots, source dumps, or generic crawling.

## Establish project state

1. Work from the mobile app repository root.
2. Use the repository's local Visor binary, for example `npm exec -- visor`. When setup created an isolated non-Node runtime, use `.visor/runtime/node_modules/.bin/visor`. Do not depend on a global installation.
3. Keep one explicit device, app id, and `--attach` setting throughout a task.
4. Use the same persistent `--map-dir`, normally `.visor/maps`, for every discovery, action, and route command.
5. Run `visor status`; run `visor start` only when the daemon is not ready.

If `.visor/maps` already exists, preserve it. Never erase a map to repair one route unless the user explicitly requests a clean-room run.

## Agree on exploration authority

Before the first app interaction or any expansion of an existing map, ask one concise permission question. Establish:

- `safe-only`: explore only actions already classified `safe`; use this default when the user does not answer;
- `scoped`: follow the user's explicit allowed and forbidden actions;
- `full-test-access`: exercise risky, destructive, and input-dependent actions only when the user explicitly grants that authority for this specific test app, environment, and account.

Also ask how to handle authentication: let the user sign in manually, use a dedicated test account through an approved secret-sharing method, or register a new test account with permission. If the user already supplied these answers, do not ask again.

Treat the scope literally. Full test access does not authorize actions in another environment, external system, real customer account, or real-money flow. Preserve each action's factual `safe`, `risky`, `needs-input`, or `unknown` classification even when the user authorizes execution.

Never store credentials, session tokens, identity values, or registration secrets in annotations, route plans, compact memory, screenshots, source dumps, or reports. Prefer manual sign-in for secrets. When login blocks discovery, pause and ask for authentication or permission to create a test account instead of guessing credentials.

## Read agent memory first

Run one `discover` when the current state is unknown:

```bash
npm exec -- visor discover \
  --device <device-id> --app-id <app-id> --attach \
  --map-dir .visor/maps
```

Use these fields:

- `data.observation_token`: immutable reference to the exact observation;
- `data.memory.current_screen`: compact semantic state and action candidates;
- `data.memory.routes`: relevant known routes;
- `data.memory.gaps`: states that still need meaning;
- `data.map.agent_path`: complete compact memory for later tasks.

Do not read `data.map.path` into agent context. It is a private runtime index containing source-level evidence. Read `data.map.agent_path` only when the current response lacks enough route context.

## Annotate an exact observation

Give a new screen a stable product label and purpose. Add only meaningful actions, and classify their safety before executing them.

```json
{
  "screen": {
    "label": "Activity feed",
    "purpose": "Review updates and open account-level destinations"
  },
  "actions": [
    {
      "command": "tap",
      "args": { "target": "Activity" },
      "label": "Open activity",
      "intent": "open_activity",
      "safety": "safe"
    }
  ]
}
```

Apply it with the token returned by the original observation:

```bash
npm exec -- visor discover \
  --device <device-id> --app-id <app-id> --attach \
  --map-dir .visor/maps \
  --annotate-current <annotation.json> \
  --observation-token <observation-token>
```

Tokenized annotation does not read the device again. Exclude credentials, identity values, feed content, financial values, and other dynamic text.

## Perform initial discovery

Populate the map through AI-assisted semantic discovery. Never run `discover --crawl` for initial discovery or map expansion, even when the user grants full test access. The generic crawler does not assign product meaning or reason about the user's permission boundaries.

Repeat this narrow loop yourself:

1. Read the compact current-screen memory.
2. Select one high-value action classified `safe`.
3. Execute it with the same target and map directory.
4. Observe the resulting stable state once.
5. Annotate its observation token immediately.
6. Continue with global navigation and one representative nested path per hub.

Prioritize launch, authentication, permission, loading, empty, error, validation, global navigation, and reliable back or close states.

Under `safe-only`, do not execute `risky`, `needs-input`, or `unknown` actions. Under `scoped` or `full-test-access`, execute only actions covered by the user's explicit authority and preserve their original risk classification.

Deterministic route plans accept only `safe` steps. Execute an authorized risky, dangerous, destructive, or input-dependent action directly, one action at a time, then observe and checkpoint the resulting state immediately. Never hide it inside a safe route.

Stop and report a gap when the current permission policy does not authorize the next useful action.

Use screenshots or source only when compact memory cannot disambiguate a state or control. Never capture them after every successful action.

Never promote an `unknown` action to `safe` because another compact observation shows the same control. When the user needs that path, inspect targeted evidence, verify the precise control and consequence, ask for user input when risk remains, and only then update its annotation.

## Reuse the map for interaction

Before interacting, answer four questions from compact memory:

1. Which semantic screen is current?
2. Which verified safe action expresses the goal?
3. Which screen should it reach?
4. Which exact recognizer proves that destination?

For one known action, execute its stored command and arguments directly. For multiple known steps or alternate paths, send one `visor route` request rather than starting one CLI process per step.

Copy selectors exactly, including whitespace and line breaks. Prefer screen-specific recognizers for path eligibility. Treat a composite or unusually large accessibility container as `unknown` until a precise safe coordinate or selector is verified.

## Execute deterministic routes

Create ordered preferred and recovery paths. Mark every step `safe` and prove each destination with an executable selector from compact memory.

```json
{
  "goal": "account.settings",
  "rediscover": true,
  "paths": [
    {
      "id": "activity-settings",
      "from": { "selector": "accessibility=Activity" },
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

```bash
npm exec -- visor route <plan.json|-> \
  --device <device-id> --app-id <app-id> --attach \
  --map-dir .visor/maps
```

Accept `status=completed` without routine visual recapture. Inspect `attempts` and `checkpoint_path` when a route does not complete.

## Recover deliberately

Handle route outcomes by type:

- `runtime_failure`: inspect session or Appium health; let Visor perform its one safe session retry before intervening.
- `verification_failure`: trust the observed current state, not the intended destination; use the next eligible supplied path.
- `needs_discovery`: read `data.rediscovery`, annotate its exact token, add a safe recovery path, and resubmit the plan.
- `INPUT_ERROR`: repair the plan before touching the device.

Do not guess a consequential action. Do not reduce a runtime failure to locator evidence. Preserve stale or disproven estimates as `unknown` instead of silently making them safe.

## Keep memory efficient

- Keep the daemon alive while reasoning so the driver session stays warm.
- Prefer one route request for a multi-step goal.
- Read compact memory before requesting screenshot or source.
- Let normal successful actions update reliability evidence.
- Keep `.visor/` ignored and local; do not commit runtime indexes, compact maps, screenshots, source dumps, or checkpoints.
- Keep `.agents/skills/visor-discovery` and `skills-lock.json` in the repository so later agents receive the same operating rules.

## Finish

Leave the app on a stable known screen. Report the device, app id, map directory, agent-memory path, screens and routes learned or used, typed failures, remaining gaps, and any risky or input-dependent actions not executed.

Never claim exhaustive discovery.
