# AgSDL 0.4.0 specification

Status: **published 2026-11-20, not stable.** The contract marker is
`agsdl-0.4.0`. The 0.3.0 edition is available at its
[Git tag](https://github.com/Andrologic/AgSDL/tree/v0.3.0).
The document fields carry over from 0.3.0. Hosts adopting 0.4.0 also
implement the [delivery](flow.md#confirming-a-steer) and
[run termination](flow.md#stopping-and-recovering-a-run) rules.

AgSDL describes **agents** and the **flows** that connect them. A document
says what each agent is, what it may do, which harness runs it, and how work
moves between agents. A harness is the program that runs an agent: Codex,
Claude Code, opencode, pi and others.

AgSDL documents are data. Readers validate them; they never run them.

## Chapters

| Chapter | Content |
| --- | --- |
| [Document](document.md) | Document shape, names, content, skills, MCP servers. |
| [Agents](agents.md) | Agent definitions, model, permissions, results, how an agent conducts its work, instances. |
| [Flow](flow.md) | Execution model, steps, routes, fan-out, messages, delivery, joins, compositions, approvals, failures, run stops and recovery. |
| [Harnesses](harnesses.md) | Harness modules, support levels and the diagnostic policy. |
| [Validation](validation.md) | Static checks, diagnostic codes and the report format. |
| [Open questions](open-questions.md) | Design questions not settled in this edition. |

The [JSON Schema](../schema/agsdl.schema.json) enforces the shapes described
here. It creates no meaning on its own: when the schema and this text
disagree, this text wins and the schema is a defect.

## Principles

1. **The graph links missions; the agent conducts its mission.** A flow step
   gives a mission to an agent. Planning, executing and checking that mission
   happen inside the agent. Different missions are different agents. Agents
   share files and messages, never their conversation.
2. **A step works or routes. A router never judges.** Agents, calls,
   approvals and compositions do work. Routing reads only explicit,
   mechanical signals: an agent's declared choice, a person's choice in an
   approval, a join outcome, or a call's outcome.
3. **The document asks, the host grants.** A document may come from anyone.
   It requests permissions; the host that runs it decides what to grant.
   Nothing in a document or in a message can grant itself rights.
4. **No false guarantee.** When a harness cannot do what a document asks, the
   validator says so. Harness support is declared by
   [harness modules](harnesses.md), never assumed.
5. **AgSDL covers what harnesses actually do.** Agent properties standardize
   features that exist in real harnesses, even in only one of them. AgSDL does
   not invent harness features.

## Conventions

The key words MUST, MUST NOT, SHOULD and MAY are used as in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

- **Document**: one JSON file with contract `agsdl-0.4.0`.
- **Host**: the software that runs a document, for example Macro.
- **Harness**: the software that runs one agent's loop.
- **Validator**: software that checks a document without running it.
- **Agent definition**: an entry of `agents`. It is configuration, without
  state.
- **Instance**: a running agent, with its own conversation.
- **Step**: an entry of a flow or composition `steps` map.
- **Work**: what one step does once a message starts it, until it ends. For an
  agent step, one activation of its instance.

JSON examples in this specification are illustrative. Model and harness names
such as `example/large` are fictional.
