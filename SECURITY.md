# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/AleksKapera/visor/security/advisories/new) instead.

Include:

- the affected Visor version and platform;
- the security impact and conditions required to reproduce it;
- a minimal reproduction or proof of concept;
- any suggested mitigation, if known.

Do not include real credentials, access tokens, personal data, private screenshots, or unredacted UI source. You should receive an acknowledgement through GitHub after the report is reviewed.

## Supported versions

Security fixes target the latest npm release and the `main` branch. Upgrade to the latest `visor-ai` version before reporting a problem that may already be fixed.

## Safe operation

Visor can interact with running apps and record UI-derived evidence. Use dedicated test accounts and non-production data whenever possible, keep `.visor/` and run artifacts private, and grant agents only the device actions required for the task.
