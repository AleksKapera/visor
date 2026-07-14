# Visor

[![npm version](https://img.shields.io/npm/v/visor-ai.svg)](https://www.npmjs.com/package/visor-ai)
[![CI](https://github.com/AleksKapera/visor/actions/workflows/ci.yml/badge.svg)](https://github.com/AleksKapera/visor/actions/workflows/ci.yml)
[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Visor gives AI coding agents verified control over running iOS and Android apps.

Instead of inferring UI behavior from source code, an agent can use Visor to operate the live app, remember reliable navigation paths, assert what is visible, and return screenshots, UI source, and structured run artifacts for review.

## Why Visor

- Verify rendered behavior on a real device, simulator, or emulator.
- Reuse compact semantic navigation memory instead of rediscovering every screen.
- Execute known multi-step routes through one warm Appium session.
- Capture screenshots and UI source only when the task needs evidence.
- Turn repeatable scenarios into JSON, JUnit, timeline, and HTML reports.
- Measure whether a scenario stays deterministic across repeated runs.

## Install

Visor requires Node.js `20.19+`, `22.12+`, or `24+`, and npm `10+`.

```bash
npm install --save-dev visor-ai@latest
```

Install the Appium driver for your target platform:

```bash
npx appium driver install uiautomator2
# macOS only, for iOS:
npx appium driver install xcuitest
```

For agent-driven setup, install the repository skill as well:

```bash
npx --yes skills@latest add AleksKapera/visor \
  --skill visor-discovery --copy --yes
```

Alternatively, paste the [agent setup prompt](https://www.visorai.dev/docs/quickstart) into Codex or Claude Code. The agent will install the appropriate Appium driver, connect to your running app, add a device-specialist Navigator agent, and build the first semantic app map.

## Quick CLI tour

Boot one mobile target and install your app before starting Visor. Pass `--device` when more than one target is running.

```bash
npx visor start
npx visor discover --device <device-id> --app-id <bundle-or-package-id> --attach
npx visor screenshot --device <device-id> --app-id <bundle-or-package-id> --attach
```

Runtime commands return structured JSON. Visor keeps the Appium session warm between commands and stores private map and daemon state under `.visor/`; keep that directory out of version control.

For repeatable verification, save a scenario as `visor-smoke.json`:

```json
{
  "meta": { "name": "visor-smoke", "version": "1", "tags": ["smoke"] },
  "config": { "timeoutMs": 15000, "seed": 42, "artifactsDir": "./artifacts" },
  "steps": [
    { "id": "capture", "command": "screenshot", "args": { "label": "app-opened" } }
  ],
  "assertions": [],
  "output": { "report": ["summary", "json", "junit", "html"] }
}
```

Then validate and run it against the app you attached above:

```bash
npx visor validate visor-smoke.json
npx visor run visor-smoke.json --device <device-id> --app-id <bundle-or-package-id> --attach --output artifacts/smoke
npx visor stop
```

A run can produce `summary.txt`, `summary.json`, `junit.xml`, `timeline.log`, `report.html`, screenshots, and UI source dumps.

## How it works

1. `visor start` launches Appium and a local daemon that owns warm driver sessions.
2. `visor discover` observes the current screen and updates compact semantic memory.
3. Direct actions or deterministic route plans operate the live app.
4. Assertions evaluate observed UI state rather than source-code intent.
5. Reports preserve the result for humans, CI, and other agents.

## Scope

Visor currently supports Android through UiAutomator2 and iOS through XCUITest. It works with installed apps on real devices, emulators, and simulators.

Web and desktop apps, built-in device provisioning, multi-app orchestration, and assertion types beyond visibility checks are not supported yet.

## Documentation

Read the [agent setup guide](https://www.visorai.dev/docs/quickstart), browse the [complete documentation](https://www.visorai.dev/docs), or use the [CLI reference](https://www.visorai.dev/docs/reference/command-reference).

## Development

```bash
npm install
npm run verify
npm pack --dry-run
```

`npm run verify` builds the CLI, runs the Vitest suite, and executes the deterministic local E2E harness. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and [SECURITY.md](SECURITY.md) when reporting a vulnerability.

Visor is available under the [MIT License](LICENSE).
