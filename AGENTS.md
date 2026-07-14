# AGENTS.md

## Project

Visor is a TypeScript CLI for verified interaction with running mobile apps. The CLI validates scenario JSON, talks to mobile apps through Appium/WebDriverIO, executes ordered scenario steps, evaluates visibility assertions, and writes reviewable run artifacts.

Work from the real repo state. Do not assume a planned harness, CLI option, or scenario fixture still exists until you have checked the current files.

## Setup

- Use Node.js 20.19+, 22.12+, or 24+, and npm 10+.
- Install dependencies with `npm install`.
- Run source commands with `npm run dev -- <command>`.
- Build first when validating the published CLI shape, then run `node dist/main.js <command>`.
- Use the checked-in scenario fixtures under `scenarios/` for smoke-level CLI validation.
- `.codex/environments/environment.toml` is intentionally versioned so Codex can offer the repo-specific setup and verification actions.

Useful commands:

```bash
npm install
npm run dev -- validate scenarios/checkout-smoke.json
npm run build
node dist/main.js --help
```

## Verification

Default checks:

```bash
npm run build
npm run test
npm run test:e2e:local
npm run verify
npm run check
```

`npm run verify` is the default AI-harness gate because it runs the TypeScript build, the Vitest suite, and the deterministic local E2E harness. `npm run check` remains the legacy build-plus-test gate. For small changes, prefer the narrowest meaningful check first, such as:

```bash
npm test -- tests-ts/validator.test.ts
npm test -- tests-ts/cli.test.ts
```

Do not run broad or device-backed checks for documentation-only changes unless the documentation claim needs live proof.

## TDD And Harness Expectations

Use TDD for CLI behavior changes:

- Write or update the smallest failing Vitest that captures the user-visible contract.
- Prefer tests in `tests-ts/` over ad hoc scripts.
- Add or update scenario fixtures only when the behavior needs an end-to-end scenario shape.
- Keep schema, command parsing, daemon/runtime, and report-writing assertions separate enough that failures point to the broken layer.

The local fake E2E harness and the real Appium E2E path have different jobs:

- Local fake E2E is the hermetic harness for CLI orchestration, scenario execution, assertions, determinism, and report materialization. It must not require Appium, a daemon, an emulator, a simulator, or a real app. Exercise it with `npm run test:e2e:local`, `npm run dev -- run scenarios/local-fake-smoke.json --runtime local --output <tmp-dir>`, or the matching `tests-ts/cli.test.ts` coverage. If that path is absent or drifting, restore it test-first before relying on it.
- Real Appium E2E is the proof path for device/session behavior. Use it when changing Appium capabilities, device selection, daemon lifecycle, session caching, real action commands, or docs that promise real mobile behavior. Start with `visor start`, use a booted Android emulator or iOS simulator, pass `--device` when multiple targets are running, and stop the daemon with `visor stop` when finished.

Never treat fake E2E as proof that Appium capabilities work. Never make routine unit tests depend on a real device.

## Artifacts And Reports

Scenario runs and benchmarks write output under `artifacts/` or the directory passed with `--output`. A run directory normally contains:

- `summary.txt`
- `summary.json`
- `junit.xml`
- `timeline.log`
- `report.html`
- copied screenshots under `screenshots/`
- copied UI source dumps under `sources/`

Use temporary output directories in tests and remove them after success. Keep failed-run artifacts only when they are needed for debugging or review. Do not commit generated run artifacts, daemon logs, Appium logs, or `.visor/` runtime state unless the user explicitly asks for a fixture or docs asset.

When reporting verification, include the command you ran and the important artifact path or run id if one was produced.

## Docs

Docs live under `docs/` and have their own instructions in `docs/AGENTS.md`.

Keep CLI docs grounded in current implementation:

- Check `src/cli.ts`, `src/types.ts`, `src/validator.ts`, and the relevant tests before documenting commands, options, schemas, or response fields.
- Public docs should describe the real Appium-backed product behavior. Keep local fake harness details in repo/developer guidance unless the CLI exposes that workflow to users.
- For docs-only edits, run Mintlify checks only when needed and from `docs/`.

## Change Discipline

- Keep edits scoped to the requested files.
- Do not edit generated files, lockfiles, package metadata, source, tests, or `.codex/` unless the user explicitly asks.
- Preserve unrelated work in the tree. If a file already has user changes, work with them instead of reverting.
