# Documentation instructions

These docs are the Mintlify site for Visor, a TypeScript CLI for mobile app verification through Appium.

## Local docs workflow

- Edit MDX pages in this `docs/` directory.
- Keep YAML frontmatter on public pages.
- Update `docs.json` when adding, moving, or removing pages.
- Preview from this directory with `mint dev`.
- Check links from this directory with `mint broken-links` when navigation or links change.

## Visor terminology

- Use `Visor` for the product and `visor` for the CLI command.
- Use `scenario` for JSON verification flows.
- Use `run` for one scenario execution and `benchmark` for repeated runs.
- Use `artifact` for screenshots, UI source dumps, summaries, JUnit output, timeline logs, and HTML reports written to disk.
- Use `Appium`, `WebDriverIO`, `UiAutomator2`, and `XCUITest` with those spellings.

## Content rules

- Document current CLI behavior only. Check `../src/cli.ts`, `../src/types.ts`, `../src/validator.ts`, and relevant tests before changing command, schema, response, or runtime docs.
- Keep public docs focused on real mobile verification through Appium. Do not document internal fake runtimes or test harnesses unless they become supported user workflows.
- When discussing reports, keep the standard files aligned with implementation: `summary.txt`, `summary.json`, `junit.xml`, `timeline.log`, `report.html`, `screenshots/`, and `sources/`.
- Prefer short task-oriented sections with concrete commands and examples.
- Use active voice and address the reader as `you`.
- Format commands, paths, fields, file names, selectors, and environment variables as code.
