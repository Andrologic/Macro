# Support

Macro is in the 0.1 release line. Support is focused on the local-first desktop workflow and on keeping releases usable for early adopters.

## Supported for 0.1

The maintainers prioritize issues related to:

- installing dependencies and running the app locally;
- building the frontend and Tauri desktop app;
- configuring AI providers and local provider keys;
- core Architect, Implement, and Chat workflows;
- local Git, worktree, review, and commit flows;
- keychain-backed provider secret storage;
- signed and notarized macOS Apple Silicon release artifacts.

## Best-Effort Areas

The following areas are useful to report but may not receive immediate fixes during 0.1:

- Linux and Windows desktop packaging;
- weekly prerelease builds;
- remote transport and browser-only operation;
- headless kernel workflows;
- custom provider edge cases;
- uncommon Git branch conventions or repository layouts.

## Where to Ask

- Use GitHub issues for reproducible bugs and narrowly scoped feature requests.
- Use pull requests for small fixes, docs improvements, and agreed implementation work.
- Use GitHub Security Advisories for vulnerabilities. Do not post security details in public issues.

## Good Bug Reports

Helpful reports include:

- Macro version or commit;
- operating system and architecture;
- whether you are running Vite, Tauri dev, a packaged app, or headless mode;
- provider type if the issue involves AI;
- concise reproduction steps;
- expected and actual behavior;
- relevant logs with secrets, tokens, local private paths, and proprietary code removed.
