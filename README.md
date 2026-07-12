# Visor

Visor is a TypeScript CLI for verified interaction with running mobile apps.

Instead of inferring UI behavior from code alone, Visor captures evidence from the live app: interactions, screenshots, UI source, assertions, and run artifacts.

## What Visor does

- interacts with iOS and Android apps through Appium
- captures screenshots and UI source from live app state
- executes repeatable scenarios with ordered steps
- evaluates visibility assertions after execution
- writes artifacts and reports for review and automation
- measures determinism across repeated runs

## Why teams use it

- reduce guesswork in agent-driven UI work
- verify real app behavior instead of code intent alone
- keep reproducible evidence for debugging and review
- add a repeatable verification layer around mobile UI changes

## Scope

Visor is focused on mobile app verification.

Supported today:

- Android
- iOS
- real Appium-backed runs

## Agent setup

Visor ships as the npm package `visor-ai` and requires Node `20` or later.

```bash
npm install --save-dev visor-ai@latest
npx --yes skills@latest add AleksKapera/visor \
  --skill visor-discovery --copy --yes
```

Paste the [agent setup prompt](https://www.visorai.dev/docs/quickstart) into your coding agent to install the required Appium driver, connect to the running app, and build the initial semantic map.

The setup also installs project-scoped Navigator agents for Codex and Claude Code. Parent agents delegate every mobile device operation to Navigator, which reuses compact map memory, executes deterministic routes, recovers from typed failures, and updates new or stale map knowledge as the live app proves it.

## Documentation

Comprehensive product documentation lives in [the docs site](https://www.visorai.dev/docs).

## Releases

Create a release by running one of:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

Each command runs `npm run check`, bumps the version, creates the matching `vX.Y.Z` git tag, and pushes the commit and tag upstream with `git push --follow-tags`.
