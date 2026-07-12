---
title: Visor discovery skill and app-map annotations
status: superseded
---

This specification is superseded by [Agent-first discovery and deterministic routes](./agent-discovery-and-deterministic-routes.md). The newer contract removes generic crawl from the default discovery workflow, adds compact agent memory and exact observation tokens, and introduces deterministic multi-path route execution.

## Problem Statement

Visor can observe the current mobile screen and crawl safe controls into its app map, but source-derived labels do not always explain what a screen or action means to a person. This makes the map less useful to an agent that needs to choose a route or command quickly. Clients also lack a reusable agent workflow for systematically touring an app, describing its screens and functionality, avoiding unsafe interactions, and reporting what could not be discovered.

The discovery workflow must enrich the app map during the same app tour. It must not require a second pass through the app or a separately reviewed annotation artifact. The persisted app map is the reviewable source of truth.

## Solution

Ship a client-facing `visor-discovery` skill together with CLI support for applying semantic annotations to the screen observed by `visor discover`.

The skill guides a Codex or Claude Code agent through a structured app tour, using normal Visor commands and frequent `visor discover` observations. When the agent has new or improved semantic information, it writes a short-lived JSON annotation file and passes it to `visor discover --annotate-current <file|->`. Visor observes the current screen, associates the annotation with that observed variant, merges stable screen semantics onto the logical screen when appropriate, and persists the result in the main app map. The agent deletes a temporary annotation file after a successful command.

The agent explores safe, representative paths first and runs a bounded crawl afterward to fill likely coverage gaps. Risky actions are described and stored but are not executed by default. Completion is based on a coverage checklist plus explicit unresolved gaps, not an unverifiable claim of complete coverage.

## User Stories

1. As a client developer, I want to invoke a reusable Visor discovery skill from Codex or Claude Code, so that I do not have to invent an app-discovery prompt.
2. As a client developer, I want the skill to use the supported Visor CLI, so that discovery follows the same runtime and device behavior as the rest of Visor.
3. As a client developer, I want the skill and required CLI support released together, so that the documented workflow works immediately.
4. As a client developer, I want discovery annotations stored in the main app map, so that I have one artifact to review.
5. As a client developer, I want temporary annotation files removed after successful use, so that discovery does not leave working files in my app repository.
6. As a client developer, I want the skill to report temporary files that could not be applied or removed, so that failed work is not silently lost.
7. As a client developer, I want one structured tour of the app, so that discovery does not repeat every navigation flow merely to add descriptions.
8. As a client developer, I want a bounded crawl after the structured tour, so that Visor can find safe branches the agent did not identify manually.
9. As a client developer, I want discovery to avoid risky actions by default, so that it does not submit, purchase, delete, send, log out, or make other consequential changes.
10. As a client developer, I want risky actions recorded even when they are not executed, so that the app map still represents important functionality.
11. As a client developer, I want blocked and risky areas listed as gaps, so that I understand the map's practical limits.
12. As a client developer, I want authentication walls identified, so that later agents know why a route was not explored.
13. As a client developer, I want input-dependent flows identified without persisting private values, so that the map remains useful and safe to inspect.
14. As a client developer, I want screenshots and source dumps used only when useful, so that routine discovery does not create unnecessary artifacts.
15. As a client developer, I want the skill to inspect distinct screen states and variants, so that dialogs, tabs, drawers, empty states, loading states, and validation states are not flattened into one screen.
16. As a client developer, I want scrollable and nested content considered during discovery, so that functionality below the initial viewport is represented.
17. As a client developer, I want global and local navigation identified, so that later agents can distinguish app-wide routes from screen-specific controls.
18. As a client developer, I want labels to describe what an action does rather than merely repeat visible text, so that ambiguous controls become understandable.
19. As a client developer, I want action intents stored in a normalized, descriptive form, so that later agents can choose commands by purpose.
20. As a client developer, I want screen labels and purposes stored, so that later agents can understand the role of each screen without reconstructing it from raw UI source.
21. As a client developer, I want annotations attached to the screen actually observed by the command, so that semantic data cannot drift onto a stale screen.
22. As a client developer, I want stable screen semantics shared across closely related variants, so that repeated variants remain understandable without redundant annotation.
23. As a client developer, I want variant-specific semantics preserved when states differ materially, so that promotion does not erase meaningful distinctions.
24. As a client developer, I want to improve an existing annotation during the same or a later discovery session, so that the map can become more precise over time.
25. As a client developer, I want repeated annotation input to be idempotent, so that retrying a command does not create duplicate actions.
26. As a client developer, I want an agent-described action stored even when Visor cannot match it to a source-derived action, so that semantic knowledge is not discarded.
27. As a client developer, I want matched source-derived and agent-described actions merged, so that selectors and geometry can coexist with better labels and intents.
28. As a client developer, I want annotation provenance omitted, so that consumers can treat all stored actions as first-class app-map facts.
29. As a client developer, I want annotation input accepted from a file or standard input, so that agents can choose the most practical command construction.
30. As a client developer, I want malformed or unsupported annotations rejected before device discovery or daemon work begins, so that input mistakes fail quickly and safely.
31. As a client developer, I want a successful response to confirm what was annotated, so that an agent can safely remove its temporary file.
32. As a client developer, I want existing app maps to survive the annotation feature upgrade, so that prior discovery work is not discarded.
33. As a client developer, I want sensitive content redacted from annotations under the same rules as observed UI data, so that semantic enrichment does not weaken app-map privacy.
34. As a client developer, I want discovery completion to include a concrete coverage inventory, so that I can assess whether another targeted pass is worthwhile.
35. As a client developer, I want every unresolved gap to include a reason, so that authentication, safety, environment, ambiguity, and budget limits are distinguishable.
36. As an agent using the map later, I want actions represented as Visor command names and arguments, so that I can turn semantic understanding into commands quickly.
37. As an agent using the map later, I want `label` and `intent` to carry the semantic meaning of an action, so that I do not need separate expected-result metadata.
38. As an agent using the map later, I want an action's safety classification available, so that I can avoid executing consequential actions without authorization.
39. As an agent using the map later, I want the map to retain source-derived selectors when available, so that a descriptive annotation does not reduce execution reliability.
40. As a Visor maintainer, I want the discovery skill to rely only on public CLI behavior, so that it remains portable and supportable.
41. As a Visor maintainer, I want annotation behavior covered at existing public seams, so that tests remain stable during internal refactoring.
42. As a Visor maintainer, I want the skill to distinguish observation from execution, so that semantic coverage does not imply that every action was performed.

## Implementation Decisions

- Add a portable agent skill named `visor-discovery` under the documentation skills area. Its frontmatter and instructions must be usable by both Codex and Claude Code clients. Repository ignore rules must continue to ignore local root-level skill state while allowing the documented client skill to be tracked.
- The skill and annotation-capable CLI are one release unit. The skill may assume the annotation option exists and must not present it as future or optional functionality.
- Extend `visor discover` with `--annotate-current <file|->`. A path reads UTF-8 JSON from that file; `-` reads one JSON value from standard input. Do not add a separate annotation command in this version.
- Annotation input is read and validated before device selection, daemon communication, or app observation. Invalid JSON, an unreadable file, an empty document, unknown fields, invalid field types, unsupported commands, or an annotation with neither screen nor actions returns an `INPUT_ERROR` response.
- The annotation document has only two top-level domains: `screen` and `actions`. At least one must be present. Route and edge annotations are not accepted.
- A screen annotation contains a concise `label` and `purpose`, with optional `description` and `notes`. Labels identify the screen; purposes explain what the user can accomplish there.
- An action annotation contains `command`, `args`, `label`, `intent`, and `safety`, with optional `description` and `notes`. `command` and `args` use the normal Visor direct-command shape. `label` is a human-readable action description, while `intent` is a stable semantic phrase suitable for agent selection.
- Action safety uses the app map's existing classifications: `safe`, `needs-input`, `risky`, and `unknown`. The skill executes only actions it can classify as safe. It records risky actions without executing them. Input-dependent actions must not embed user secrets or real form values in the map.
- An annotation is applied only after `discover` has observed and upserted the current screen. This binds the annotation to the current observed variant rather than a screen identifier supplied by the caller. Apply the current-screen annotation before any optional crawl changes the live app state.
- Store screen semantics on the observed variant. Visor may promote or merge stable `label` and `purpose` values onto the logical screen when its existing similarity evidence shows that sibling variants represent the same conceptual screen. Materially different variant semantics remain variant-specific.
- Reapplying a screen annotation updates the provided semantic fields. Reapplying an action with the same canonical `command` and `args` updates its semantic fields instead of appending a duplicate. Omitted optional fields remain unchanged; explicit deletion is not part of this version.
- Canonical action identity is based on the command plus normalized arguments, not label or intent. This allows an agent to improve semantic text without losing the source-derived execution target.
- When an annotated action matches a source-derived action, merge the annotation's semantic fields with the existing selector, target, scope, and source geometry. When it does not match, persist the annotated action as a standalone first-class action instead of rejecting it.
- Do not record whether an action came from source analysis or an agent. Do not persist a match/mismatch flag. Once stored, both forms are ordinary app-map facts.
- Preserve existing privacy behavior for annotation text and arguments. Redact sensitive values and do not persist value-bearing command arguments that the app map already excludes. Semantic labels should describe the field or operation, not captured user data.
- Evolve the schema without losing valid existing maps. Maps created before annotation support must load with empty semantic fields where needed and retain their screens, variants, actions, and edges.
- A successful discover response keeps the existing map and screen data and adds a compact annotation result containing whether a screen annotation was applied and how many actions were inserted, updated, or merged. This acknowledgement is the signal the skill uses before deleting a temporary file.
- The persisted app map remains the only durable review artifact. The CLI does not copy the submitted annotation document into the repository or create a separate annotation history.
- The skill defaults to a throwaway temporary JSON file because it is easy for an agent to construct, inspect after a failure, pass as one CLI argument, and remove after acknowledgement. Standard input remains available for environments where it is more efficient.
- The skill performs a structured tour before bounded crawl. It observes the initial state, inventories global navigation, visits representative safe routes, inspects distinct states and scrollable content, annotates only when semantic information is new or improved, and then uses crawl to search remaining safe branches.
- The skill must not require a second complete traversal for annotation. It applies annotations while positioned on each screen during the original tour. Calling `discover` again while the screen remains current is acceptable; replaying the navigation path solely to annotate it is not.
- `visor discover` is the default observation tool. The skill may use a screenshot or UI source dump to resolve ambiguity, inspect visual-only content, or diagnose a failure, but neither is a mandatory precursor to every annotation.
- The skill maintains a coverage checklist during the tour. It covers entry and authentication states, top-level destinations, nested screens, navigation controls, actionable controls, tabs, menus, drawers, dialogs, scroll-revealed content, empty/error/validation states, input-dependent flows, risky actions, and environment-specific branches where reachable.
- Discovery is complete when the structured checklist has been attempted, the bounded crawl has finished or reported its stopping reason, the map has persisted all gathered semantics, and every known gap is reported with a reason. The skill must not claim literal 100% coverage.
- The skill's final report summarizes mapped screens, variants, actions, edges, risky or input-dependent functionality, crawl stopping reason, and explicit gaps. It points the client to the persisted map rather than asking them to review temporary annotation files.
- Intent-based automatic navigation is not added in this work. The semantic map is designed so a later agent can inspect it and choose existing Visor commands faster; changes to the route planner can build on this contract separately.

## Testing Decisions

- Use test-driven development for the CLI behavior. Tests assert public command responses, daemon request data, and persisted map output rather than private helper functions.
- Use two existing high-level seams because the current architecture separates host CLI input from device-side app-map persistence. The CLI command execution seam covers parsing, validation, file and standard-input loading, error envelopes, daemon transport, and annotation acknowledgement. The public app-map discovery seam with the fake platform adapter covers observation, current-variant binding, merge behavior, persistence, and later map reads.
- Extend the existing CLI app-map tests with a valid file case, a standard-input case, malformed JSON, missing files, schema validation failures, and proof that invalid input fails before device selection and daemon communication.
- Test that the CLI sends structured annotations through the existing discover daemon request and preserves existing crawl options in the same request.
- Extend the existing app-map end-to-end tests to prove that screen and action annotations are written to the variant observed by the same discovery call.
- Test repeat application and updates: identical input is idempotent, changed semantic fields update the matching action, and omitted optional fields are retained.
- Test matching and non-matching actions: a matching source-derived action retains executable source metadata while gaining semantic fields, and an unmatched action is still persisted.
- Test logical-screen promotion with similar variants and non-promotion when variants are materially different.
- Test safety and privacy: risky actions are storable without being executed, sensitive labels or arguments are redacted, and value-bearing inputs do not enter the persisted map.
- Test backward compatibility with a pre-annotation app map so the upgrade retains existing screens, variants, actions, and edges.
- Test discover with both annotation and crawl enabled to prove the annotation stays attached to the initially observed variant and crawl behavior remains bounded.
- Keep real Appium verification focused on the existing device/session boundary. The annotation feature should be proven deterministically without a real device unless implementation changes Appium capabilities, session management, or adapter behavior.
- Review the skill as an operational contract: every documented command must match CLI help, the temporary-file lifecycle must wait for positive acknowledgement, risky actions must not be executed by default, and the completion report must include explicit gaps.
- Run the narrow CLI and app-map suites first, then the repository's standard verification gate. Documentation-only linting is sufficient for the skill content once the implemented CLI behavior is covered.

## Out of Scope

- Route-level or edge-level annotations.
- Expected destination, expected result, or postcondition fields on actions; `label` and `intent` carry the required semantics for this version.
- Provenance fields distinguishing agent annotations from source-derived facts.
- Recording whether an annotated action matched a source-derived action.
- A separate `visor annotate` command.
- A persistent annotation workspace or a required `.visor-discovery` directory in the client repository.
- Human review or approval of each temporary annotation document before persistence.
- Executing risky actions during discovery without separate, explicit authorization.
- Persisting real credentials, payment data, personal data, or other form values to make input actions directly replayable.
- Deleting annotations through the discovery input. Corrections and enrichment are supported; explicit removal can be designed later.
- Automatically navigating by semantic intent inside Visor's route planner.
- Guaranteeing exhaustive discovery of server-controlled, role-gated, platform-gated, time-dependent, or destructive flows.
- Storing screenshots inside the app map.

## Further Notes

- The current app map already stores schema-versioned logical screens, variants, source-derived action affordances, navigation edges, confidence evidence, and safety classifications. This feature enriches that model instead of introducing a parallel map.
- The current `discover` command already observes the current screen and supports bounded crawling. The implementation should extend that command path so annotation and observation share the same runtime/session lifecycle.
- Existing source-derived actions are tap affordances with selectors or coordinates and semantic labels inferred from UI source. Agent annotations must preserve those execution details when enriching a match.
- A typical skill pass is: start or verify Visor, establish the app and device, tour and annotate reachable safe states, run a bounded crawl for remaining branches, inspect the persisted map summary, and report coverage plus gaps.
- The checked-in skill is a client artifact, while this document is an implementation spec. Public CLI reference material should describe the annotation option only when the supporting code ships.
