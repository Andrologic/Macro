# Security Policy

Macro is a local-first, agentic development tool. It can read and write files, run terminal commands, operate on Git repositories, call configured AI providers, store provider credentials in the system keyring, and expose a localhost tool host protected by a bearer token.

Please treat security reports with care and do not open public issues for vulnerabilities.

## Supported Versions

Security fixes are prioritized for:

- the latest public `0.1.x` release;
- the active main development branch.

Release candidates, weekly builds, and older builds are best-effort unless the issue also affects the latest supported release line.

## Reporting a Vulnerability

Report vulnerabilities through GitHub Security Advisories for this repository.

Do not include exploit details, secrets, logs with tokens, or proof-of-concept payloads in public issues, pull requests, or discussions. If GitHub Security Advisories are unavailable to you, open a minimal public issue asking for a private security channel without disclosing technical details.

Please include, when possible:

- affected Macro version or commit;
- operating system and architecture;
- whether the issue requires user approval, local workspace access, a malicious repository, a malicious AI/tool response, or network access;
- concise reproduction steps;
- impact and any known mitigations.

## Response Expectations

The maintainers aim to acknowledge valid security reports within 7 days. Triage and fixes depend on severity, reproducibility, and release timing.

We ask reporters to coordinate disclosure until a fix, mitigation, or advisory is available.

## Security Model Notes

Macro is designed for trusted local development workspaces. Its core workflows intentionally provide powerful capabilities:

- file access is scoped by workspace policy in normal tool flows, with explicit exceptions for configured or user-selected paths;
- terminal and Git operations can change local repositories and working trees;
- AI providers may receive prompts, selected source context, tool traces, and user-provided content;
- provider API keys and linked-provider sessions are stored through the OS keyring when available;
- the local tool host binds to `127.0.0.1` and requires a bearer token, but local processes on the same machine are part of the relevant threat model.

Reports are especially useful when they show a way to bypass user intent, workspace boundaries, approval policy, secret handling, or localhost authentication.
