# Conformance

Cases are documents with the diagnostics a validator must report. Run
scenarios are scripted runs with what a host must do. They let another
implementation check that it reads and runs AgSDL 0.3.0 as the specification
says.

## Cases

| Path | Content |
| --- | --- |
| `cases/*.json` | One document per case. Some are deliberately not valid JSON. |
| `expected.json` | For each case: a description, and the sorted, distinct error and warning codes. |
| `modules/` | Two fictional harness modules, `example` and `limited`, used by the cases. |

A case passes when a validator, using the modules in `modules/` only, reports
exactly the expected set of error codes and the expected set of warning
codes. A document is valid when it has no error. Paths and messages are not
compared: implementations may word and locate diagnostics differently.

The reference validator runs every case in its tests:

```sh
cd ../tooling
python3 -m unittest discover -s tests
```

To see one case's diagnostics:

```sh
python3 -m agsdl --modules ../conformance/modules ../conformance/cases/join-open-fork.json
```

When you add a case, give it a name that says what it tests, add its
expectation, and keep it as small as the rule allows.

## Run scenarios

Cases check what a validator reports. Run scenarios check what a host does:
each one scripts a run of a valid document and states what the specification
requires of the host in it. This repository runs no flow. Its tests check that
each scenario is well formed, that its document is valid, and that every step
it names exists. A host checks itself by replaying the scenarios.

| Path | Content |
| --- | --- |
| `runs/*.json` | One scenario per file, following the [scenario schema](../schema/run-scenario.schema.json). |

A scenario has a `document`, a path relative to this directory or the
document itself, an optional `entry` message, a `timeline` and an `expect`.

### Replaying the timeline

The host starts the run with the `entry` message, then takes the events in
order. Before each event, and after the last one, it does everything it can
without a further event: it routes outputs, starts and cancels works, decides
joins and answers expired requests. Then:

| Event | Meaning |
| --- | --- |
| `{ "work": "fix", "returns": {...} }` | The running work of `fix` ends with this output, an agent's or an approval's. |
| `{ "work": "tests", "command": { "exitCode": 1, "stdout": "...", "stderr": "..." } }` | The command of the call ended so. The host derives the call's output. |
| `{ "work": "open-issue", "tool": { "content": {...}, "isError": false } }` | The MCP tool of the call returned this result. |
| `{ "work": "fix", "fails": "AGENT_FAILED" }` | The work fails with this code. |
| `{ "work": "release", "request": "ask" }` | The work opens a request that the host puts to a person: an `ask`, a `plan` or a `question`. |
| `{ "work": "release", "answer": "yes" }` | A person answers the work's oldest open request. |
| `{ "elapse": 60000 }` | That many milliseconds pass, for every work running or waiting for a person. Each time limit counts them as the specification says: `timeoutMs` not while a person is asked, `answerTimeoutMs` and an approval's `timeoutMs` only then. |
| `{ "running": [{ "step": "fix", "item": 0 }] }` | A check: exactly these works are running, or waiting for a person, now. |

`work` names a step, or a composition body step by the names leading to it,
joined with `/`, such as `"review/vote"`. `item` is the index of the element
whose path runs the work, in a fan-out. An event names exactly one running
work; a host for which it names none, or several, fails the scenario.

### Expectations

| Field | What the host must have done |
| --- | --- |
| `run` | Ended the run as `"succeeded"` or `"failed"`. |
| `starts` | Started exactly this many works per step; a step not listed starts none. A message that joins a current work with `steer` starts none. |
| `messages` | Delivered these messages. `nth` counts the messages to the step, and `item` selects a fan-out path. `prompt`, `resources`, `element`, the message's `item`, and `comments` are what the message holds. |
| `joins` | Made exactly these join decisions, in timeline order. |
| `failures` | Reported exactly these failures, in any order. |
| `cancelled` | Cancelled exactly these works for a group that decided, closed or failed, in any order. A work that runs out of its `timeoutMs` is a failure, not listed here. |
| `answers` | Answered these requests itself, after `answerTimeoutMs`. |

Fields that are absent are not checked. In `messages`, only the fields given
are compared, and in `resources` and join `branches`, only the names given.
Those values are patterns: an object matches when each key it gives matches,
so `{ "error": { "code": "TIMEOUT" } }` matches whatever the error's message;
a list matches a list of the same length whose elements match in order; any
other value matches only itself. Parallel works may start in any order, so
no scenario checks one.
