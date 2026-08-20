# Macro

<p align="center">
  <img src="public/logo.svg" alt="Macro logo" width="96" />
</p>

<p align="center">
  <strong>An AI development environment for planning, running, and reviewing software work across projects.</strong>
</p>

<p align="center">
  <a href="https://macro.andrologic.ai">Website</a>
  |
  <a href="https://github.com/Andrologic/Macro/releases/latest"><strong>Download the latest release</strong></a>
  |
  <a href="INSTALL.md">Install from source</a>
  |
  <a href="CHANGELOG.md">Changelog</a>
  |
  <a href="SUPPORT.md">Support</a>
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/github/license/Andrologic/Macro" />
  <img alt="Latest release" src="https://img.shields.io/github/v/release/Andrologic/Macro?include_prereleases" />
  <img alt="Built with Tauri" src="https://img.shields.io/badge/built%20with-Tauri-24c8db" />
</p>

Macro is a desktop development platform built for AI agents and the developers
who supervise them. It coordinates projects, plans, worktrees, terminals,
reviews, commits, and shared context so AI-assisted engineering can move faster
without turning into an unreviewable stream of changes.

Instead of giving an agent one repository and hoping it keeps the whole system
in mind, Macro gives the work a structure: projects are grouped, plans can span
multiple repositories, tasks run in isolated worktrees, and every result comes
back through human review.

Use Macro when you need to:

- give AI agents shared context across several repositories;
- supervise one plan that executes across multiple projects;
- run multiple implementation tasks without one dirty working tree;
- keep the planning and execution trail available after the code is committed.

## What Makes Macro Different

- **Multi-project context by design.** Group related repositories into one
  workspace so an AI agent can understand how a frontend, backend, mobile app,
  shared package, or companion tool fit together.
- **Plans can span projects.** Architect mode can turn one product intent into a
  strategy that touches multiple repositories while keeping the work visible as
  one coordinated plan.
- **Parallel task execution with worktrees.** Macro prepares task branches and
  worktrees so several AI tasks can progress on the same project without
  fighting over one working directory.
- **Review-first implementation.** Implement mode is built around tasks,
  blockers, diffs, terminals, commits, and merge flow, not just chat messages.
- **Auditable AI workflow metadata.** Macro keeps planning and execution context
  in a dedicated `@macro` metadata flow so the reasoning behind the work can be
  restored, reviewed, and synchronized separately from product code.

## How It Works

1. **Group your projects.** Open one repository or connect several related
   repositories as a single product workspace.
2. **Plan with Architect.** Describe the change, answer focused questions when
   useful, then explicitly generate a strategy from the plan conversation,
   inspected code, and selected projects.
3. **Run tasks with Implement.** Start implementation tasks manually, let AI
   agents work in prepared branches and worktrees, and keep terminal/test output
   close to the task.
4. **Review before accepting.** Inspect file changes, resolve blockers, generate
   commits, and integrate task work back through the plan.
5. **Keep context with `@macro`.** Plans, conversations, strategy, runtime state, and
   chat transcript snapshots are stored as Macro metadata so the workflow has an
   audit trail beyond the final code diff.

## The `@macro` Metadata Branch

Macro uses a dedicated `@macro` Git metadata flow to separate product code from
workflow state.

That branch exists to store the information that normal Git history does not
capture well:

- which plan created the work;
- which conversation and strategy shaped the work before execution;
- which tasks belong to which branches and projects;
- what runtime state is needed to resume or audit the plan;
- which conversations and plan snapshots explain the implementation context.

Keeping this metadata separate has practical advantages. Product branches stay
focused on code, while Macro can still preserve the coordination layer that made
the code possible. In multi-project work, the same plan metadata can be present
where it is needed so each repository keeps enough context to remain auditable.
The separate sync flow also prepares Macro for remote and multi-machine
supervision without mixing workflow state into application commits.

## Get Macro

Start with the latest published release:

[Download the latest Macro release](https://github.com/Andrologic/Macro/releases/latest)

For source builds, platform requirements, provider notes, and validation
commands, read [INSTALL.md](INSTALL.md).

## Documentation

- [INSTALL.md](INSTALL.md) - install Macro or build it from source.
- [DEVELOPMENT.md](DEVELOPMENT.md) - local development, scripts, environment
  variables, and validation commands.
- [RELEASES.md](RELEASES.md) - versioning and the multiplatform release
  process.
- [HEADLESS.md](HEADLESS.md) - internal experimental notes for a possible future remote runtime.
- [docs/configuration.md](docs/configuration.md) - JSON configuration files,
  scopes, schemas, agent tools, skills, and security rules.
- [CONTRIBUTING.md](CONTRIBUTING.md) - contribution guidelines.
- [SECURITY.md](SECURITY.md) - security reporting and security model notes.
- [SUPPORT.md](SUPPORT.md) - supported workflows for the current release line.
- [CHANGELOG.md](CHANGELOG.md) - release history.

Product and architecture reference documents live in [docs/](docs/).

## License

Macro is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).

You may use the software for free. If you modify Macro, redistribute it, or use
a modified version to provide a network service, the corresponding source code
must be made available under the same license.
