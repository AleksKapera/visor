---
name: visor-discovery
description: Build and repair compact AI-only navigation memory for a running mobile app with Visor. Use when an agent starts without a map, needs to learn meaningful screens and safe actions, or must recover a deterministic route after an unknown state.
---

# Visor agent discovery

Build semantic interaction memory with agent reasoning. Do not treat the accessibility tree as the product map, and do not use generic crawling as the default discovery strategy.

## Establish one target

1. Confirm Node.js 20+, Visor, Appium drivers, one booted target, the installed app id, and any required test account.
2. Run `visor status`; start Visor when needed.
3. Keep one app and session alive with explicit `--device`, `--app-id`, and `--attach` values.
4. Use the same `--map-dir` on every discovery, action, and route command.

For a provably fresh run, create an empty temporary directory and do not read any other map:

```bash
MAP_DIR="$(mktemp -d)"
visor discover --device <id> --app-id <id> --attach --map-dir "$MAP_DIR"
```

The first response provides:

- `data.observation_token`: immutable reference to that observation;
- `data.memory.current_screen`: compact current screen and meaningful action candidates;
- `data.memory.routes`: relevant learned routes only;
- `data.memory.gaps`: screens that still need semantics;
- `data.map.agent_path`: persistent compact agent memory.

Do not read the runtime index at `data.map.path`. It contains internal source evidence and is not agent context.

## Annotate the exact observation

Give the current screen a stable product identity and enrich only meaningful actions. Do not include user identity, feed text, financial values, credentials, or other dynamic content.

```json
{
  "screen": {
    "label": "Activity feed",
    "purpose": "Review community updates and enter profile-level destinations"
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

Apply it with the token from the original response:

```bash
visor discover \
  --device <id> --app-id <id> --attach --map-dir "$MAP_DIR" \
  --annotate-current <annotation.json> \
  --observation-token <data.observation_token>
```

Tokenized annotation does not read the device again. Delete the temporary annotation only after `data.annotation` confirms the update.

## Explore agentically

Repeat this loop:

1. Read only the compact current-screen memory.
2. Choose one safe action with high discovery value.
3. Execute it through Visor with the same map directory.
4. Run `discover` once on the resulting stable state.
5. Annotate that observation token before taking another action.
6. Checkpoint gaps immediately.

Prioritize:

- launch, authentication, permission, loading, empty, error, and validation states;
- global navigation and reliable back/close behavior;
- every safe top-level destination;
- one representative nested path per hub;
- materially different dialogs, tabs, and role/environment states.

Execute only `safe` actions. Record `needs-input`, `risky`, and `unknown` actions without executing them. Stop when remaining actions are unsafe, repetitive, low-value, or blocked. Report gaps explicitly.

Use screenshots or source only when compact observation cannot disambiguate a control or state. Never capture them after every successful action.

Treat selectors as executable data, not prose:

- copy recognizers from compact memory exactly, including whitespace and line breaks;
- prefer a screen-specific recognizer for `from.selector` over generic labels such as `Settings`;
- mark a composite or unusually large accessibility container `unknown` until a precise safe target is verified;
- keep stale estimates as `unknown` rather than silently replacing their safety evidence.

`discover --crawl` remains a diagnostic compatibility tool. Do not run it by default and do not let crawl output author semantic memory.

## Execute known routes

Build a route plan from compact agent memory. Supply preferred and recovery paths in deterministic order. Every step must be safe and must include an executable destination selector.

Use only selectors and coordinates that discovery verified on the live screen. A route expectation proves the destination, so copy its selector verbatim from that destination's compact recognizers instead of guessing a human-readable label.

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

Run the whole plan through one daemon request:

```bash
visor route <plan.json|-> \
  --device <id> --app-id <id> --attach --map-dir "$MAP_DIR"
```

Accept `status=completed` without routine screenshots. Visor checkpoints every step and tries the next eligible supplied path after failure.

## Recover unknown states

When route status is `needs_discovery`:

1. Read `data.rediscovery.current_screen`, `gaps`, and `observation_token`.
2. Annotate that exact token.
3. Decide whether a safe recovery exists.
4. Add a path whose `from.selector` matches the unknown state.
5. Resubmit the complete plan.

Do not guess a consequential action. If no safe recovery exists, stop with the checkpoint path and a precise gap reason.

## Finish

Report:

- app, device, platform, and agent-memory path;
- semantic screens and meaningful actions learned;
- known paths and recovery paths verified;
- typed route failures and session recovery;
- risky and input-dependent functions not executed;
- unknown states and exact gap reasons;
- whether the run started from an empty map directory;
- temporary files that still require cleanup.

Never claim exhaustive discovery.
