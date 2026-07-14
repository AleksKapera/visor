# Contributing to Visor

Thanks for helping improve Visor. Bug reports, focused fixes, documentation corrections, and small feature proposals are welcome.

## Before you start

- Search [existing issues](https://github.com/AleksKapera/visor/issues) before opening a new one.
- Open an issue before starting a large behavior or architecture change.
- Report security problems privately by following [SECURITY.md](SECURITY.md).
- Remove credentials, personal data, app source dumps, and private screenshots from examples and logs.

## Local setup

Visor requires Node.js `20.19+`, `22.12+`, or `24+`, and npm `10+`.

```bash
git clone https://github.com/AleksKapera/visor.git
cd visor
npm install
npm run verify
```

Run source commands with `npm run dev -- <command>`. Build before checking the installed CLI shape:

```bash
npm run dev -- validate scenarios/checkout-smoke.json
npm run build
node dist/main.js --help
```

## Making changes

- Keep each pull request focused on one problem.
- Add or update the smallest Vitest that captures a user-visible behavior change.
- Use the checked-in files under `scenarios/` for smoke-level CLI validation.
- Keep public documentation aligned with the current CLI and schema.
- Do not commit generated run artifacts, Appium logs, daemon state, or `.visor/` data.

For small changes, run the narrowest relevant test first. Before opening a pull request, run:

```bash
npm run verify
npm pack --dry-run
```

Documentation changes live under `docs/`. Preview them from that directory with `mint dev`, and run `mint broken-links` when navigation or links change.

## Pull requests

Describe the problem, the behavior after your change, and the verification you ran. Include screenshots or run artifacts when visible mobile behavior changes, but redact user data and secrets first.
