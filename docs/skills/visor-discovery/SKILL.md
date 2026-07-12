---
name: visor-discovery
description: Discover and semantically annotate a running mobile app with Visor. Use when an agent needs to inventory app screens, variants, navigation, controls, content, safe representative flows, risky or input-dependent functionality, and coverage gaps into Visor's persisted app map.
---

# Visor Discovery

Build a useful semantic app map during one supervised tour. Observe often, annotate only new or improved meaning, execute safe actions only, and finish with bounded crawl plus explicit gaps.

## Establish the target

1. Confirm Node.js 20+, the Visor CLI, Appium drivers, a booted target, the installed app id, and any required test account or seed data.
2. Run `visor status`. Start the daemon with `visor start` when needed.
3. Keep one app/session alive. Use `--device <id>`, `--app-id <id>`, and `--attach` when the app is already running and its state must be preserved.
4. Run plain discovery before navigating:

```bash
visor discover --device <id> --app-id <id> --attach
```

Inspect `data.screen`, `data.map.summary`, and the persisted map at `data.map.path`. Read the current variant's elements and actions. Use `visor screenshot` or `visor source` only when visual hierarchy, duplicate controls, source quality, or target identity is ambiguous.

## Annotate the current screen

Do not navigate between observation and annotation. Reuse the exact `command` and `args` already stored on a source action when enriching it. Visor also accepts a standalone action that has no source match.

Create one throwaway JSON file per annotation update:

```json
{
  "screen": {
    "label": "Checkout shipping address",
    "purpose": "Collect delivery details before payment",
    "description": "Optional variant-specific detail",
    "notes": ["Optional operational note"]
  },
  "actions": [
    {
      "command": "tap",
      "args": { "target": "text=Continue" },
      "label": "Continue to payment",
      "intent": "advance_checkout",
      "safety": "safe",
      "description": "Optional clarification",
      "notes": ["Optional constraint"]
    }
  ]
}
```

`screen` and `actions` are optional individually, but provide at least one screen or action. A screen requires `label` and `purpose`. Every action requires `command`, `args`, `label`, `intent`, and `safety`. Safety is `safe`, `needs-input`, `risky`, or `unknown`. Do not add route annotations, expected destinations, provenance, real credentials, personal data, payment values, or typed input values.

Apply the file while the intended screen is still current:

```bash
visor discover --device <id> --app-id <id> --attach --annotate-current <temporary-json-file>
```

Use `--annotate-current -` when piping one JSON value through standard input is easier. Prefer a temporary file when shell quoting nested JSON would be fragile.

Delete the temporary file only after `status` is `ok`, `data.annotation` acknowledges the update, and `data.screen.variant_id` is the intended current variant. On failure, retain it only long enough to fix/retry, then remove it. The app map is the sole durable review artifact.

## Tour before crawling

Repeat plain discovery, meaningful annotation, and safe navigation without replaying routes solely to annotate them.

1. Inventory the launch, authentication, permission, loading, empty, error, and validation states that are reachable.
2. Identify global navigation: tabs, drawers, menus, back/close behavior, profile, and settings.
3. Visit every safe top-level destination. Give each a stable screen label and purpose.
4. Follow one representative safe happy path from each hub into meaningful nested/detail screens.
5. Inspect dialogs, overlays, tab variants, scroll-revealed content, repeated cards, forms, and environment- or role-specific branches.
6. Label actions by product meaning, not by repeating visible text. Keep `intent` short, stable, and purpose-oriented.
7. Execute only actions classified `safe`. Annotate `needs-input`, `risky`, and `unknown` actions without executing them. Never use `--crawl-allow-risky` unless the user separately authorizes the specific consequential behavior in a safe sandbox.
8. After the structured tour, run bounded crawl from useful hub screens:

```bash
visor discover --device <id> --app-id <id> --attach --crawl --crawl-depth 2 --crawl-limit 24
```

Use a smaller budget or `--crawl-include <text>` when scope or state is sensitive. Record the crawl stopping reason. Do not claim exhaustive coverage.

## Finish and report

Stop when the checklist has been attempted, bounded crawl completed or stopped with a reason, semantic updates are persisted, and remaining gaps are explicit.

Report:

- app id, device, platform, and persisted map path
- logical screens, variants, actions, edges, and authentication-required states from the final map summary
- top-level destinations and representative happy paths covered
- risky, unknown, and input-dependent functionality annotated but not executed
- crawl budget, actions, variants, stopping reason, and restore failures
- gaps with a reason: credentials, missing seed data, permission, risky action, external service, role/platform gating, environment failure, ambiguity, or budget
- any temporary file or command failure that still needs cleanup or retry

Point the user to the persisted app map for review. Never report literal 100% discovery.
