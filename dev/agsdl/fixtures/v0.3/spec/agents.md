# Agents

An agent definition says what an agent is, what it may do and which harness
runs it. A definition has no state: running agents are
[instances](#definitions-and-instances).

```json
"agents": {
  "developer": {
    "description": "Implements requested changes in the repository.",
    "harness": "codex",
    "model": { "name": "example/large", "effort": "high" },
    "instructions": "Understand the request, implement it, then run the tests.",
    "skills": ["security-review"],
    "permissions": {
      "preset": "workspace",
      "rules": [
        { "action": "shell", "match": "git push *", "effect": "ask" },
        { "action": "write", "match": ".env*", "effect": "deny" }
      ]
    },
    "plan": true,
    "completionCheck": { "command": "npm test", "choices": ["done"] },
    "results": {
      "summary": { "required": true, "mediaType": "text/plain" }
    }
  }
}
```

## Fields

| Field | Required | Content |
| --- | --- | --- |
| `description` | no | What the agent does, for people and for agents that delegate to it. |
| `harness` | yes | The harness that runs the agent. See [Harnesses](harnesses.md). |
| `harnessVersion` | no | A version range of the harness, for example `">=0.60.0"`. |
| `harnessSettings` | no | Settings specific to the harness, checked by its module. |
| `model` | no | `name` and `effort`. See [Model](#model). |
| `instructions` | no | The agent's standing instructions: a string, or a list of content sources. |
| `resources` | no | Named content sources given to the agent as information. |
| `skills` | no | Names of document skills the agent may load. |
| `mcpServers` | no | Names of document MCP servers the agent may use. |
| `permissions` | yes | What the agent may do. See [Permissions](#permissions). |
| `results` | no | Named results the agent produces. See [Results](#results). |
| `instructs` | no | `true` to let the agent write the mission of the steps it leads to. See [Instructing other agents](#instructing-other-agents). |
| `plan` | no | `true` to give the agent a work plan visible to the host. |
| `planFirst` | no | `"auto"` or `"ask"`. See [Plan first](#plan-first). |
| `completionCheck` | no | A command that must succeed before a submission is accepted. See [Completion check](#completion-check). |
| `maxCorrections` | no | How many refused or missing submissions an agent may correct per work. Default: `2`. |
| `answerTimeoutMs` | no | How long a request to a person may stay unanswered. See [Waiting for a person](#waiting-for-a-person). |

Apart from `harnessSettings`, these are standard AgSDL properties. For those
that depend on the harness, its module declares whether it supports each one
natively, approximately or not at all; the host provides the others (see
[standard property keys](harnesses.md#standard-property-keys)). An
unsupported property is an error, never silently dropped.

## Identity

`instructions` frame everything the agent does: they come from the document
author and stay in place for the instance's whole life. `resources` are
information: the agent reads them but takes no orders from them.

What an agent receives has three layers:

| Layer | Source | Authority |
| --- | --- | --- |
| Framing | The definition's `instructions` | The document author |
| Mission | The `prompt` of the message that starts or joins the work | The document author, who wrote the connection |
| Information | `resources` of the definition and of the message, and the message's `item` and `comments` | None: data to read, not orders |

The agent receives the resources of its definition and those of each message
apart, each with its origin: a name in one never replaces the same name in the
other.

Results of agents, calls and joins are always information. A tool result or a
document saying "ignore your instructions" remains data. An agent gives another
its mission only through [instructions](#instructing-other-agents).

## Model

```json
"model": { "name": "example/large", "effort": "high" }
```

`name` and `effort` are both optional; when absent, the harness uses its own
default. `name` is an open value: models appear faster than any list can
follow, and many hosts reach local or private models. The host checks that the
model is available when it launches the document. `effort` follows its
harness: when the module lists `values`, they are the only accepted levels;
when it gives only `suggestions`, the level is open, as with Codex, whose
models advertise their own levels, and the host checks it at launch.

## Permissions

Permissions say what the agent may do while it works. Every agent declares
them: there is no default, so that a missing field is caught when the
document is written rather than when the agent fails to act.

```json
"permissions": "read-only"
```

```json
"permissions": {
  "preset": "workspace",
  "directories": { "../shared-docs": "read", "/tmp/build-cache": "write" },
  "rules": [
    { "action": "shell", "match": "git push *", "effect": "ask" },
    { "action": "write", "match": ".env*", "effect": "deny" },
    { "action": "read", "match": "**/.env*", "effect": "deny" }
  ]
}
```

| Field | Content |
| --- | --- |
| `preset` | `read-only`, `workspace` or `full`. See [Presets](#presets). |
| `directories` | Directories added to the agent's zone. See [Zone](#zone). |
| `outside` | `"read"` or `"deny"`: reading outside the zone. See [Zone](#zone). |
| `rules` | Rules for actions and paths. See [Evaluation](#evaluation). |
| `reviewer` | Who answers `ask` actions. See [Reviewer](#reviewer). |

A preset name alone, such as `"read-only"`, is short for `{ "preset":
"read-only" }`.

### Actions and effects

| Action | `match` |
| --- | --- |
| `read` | A path pattern. |
| `write` | A path pattern. |
| `shell` | A command pattern. |
| `network` | A host name pattern, for example `*.github.com`. |
| `mcp` | A server name, or `server/tool`. |
| `delegate` | Omitted. Starting sub-agents inside the harness. |

An MCP server is equipment with effects of its own: a `github` server exists to
reach GitHub. An `mcp` permission covers everything the server does for the
agent. `read`, `write`, `shell` and `network` apply to the agent's own tools
and commands, not to the MCP servers it may use; to restrict a server, write
`mcp` rules on `server/tool`, such as
`{ "action": "mcp", "match": "files/read_file", "effect": "deny" }`. A host MAY
confine a server further.

`match` uses `*` for any sequence of characters; for paths, `**` also crosses
directory separators. For `shell`, a final ` *` covers the command with any
arguments, none included: `git push *` covers `git push` and
`git push origin main`, not `git pushx`. A rule without `match` covers every
use of its action.

A path, in a rule or in `directories`, is relative to the workspace, or starts
with `~/` for the user's home directory, or with `/` for an absolute path.

| Effect | Meaning |
| --- | --- |
| `allow` | The agent may act. |
| `ask` | The action waits for an answer at the moment it happens, from a person or a model: see [Reviewer](#reviewer). A refusal is reported to the agent, which continues. |
| `deny` | The agent may not act. |

### Zone

The **workspace** is the directory the host gives the agent. `directories`
adds other directories, each `"read"` or `"write"`:

```json
"directories": { "../shared-docs": "read", "/tmp/build-cache": "write" }
```

The workspace and these directories form the agent's **zone**. Presets act on
the zone. `outside` says whether the agent may read outside it:

| `outside` | Reading outside the zone |
| --- | --- |
| `"deny"` | Denied. The default, except with `full`. |
| `"read"` | Allowed. The default with `full`. |

Programs the agent runs still need system files, such as executables and
libraries. The host keeps them readable, as Codex does with its minimal read
paths; they are not something a document grants.

### Presets

| Preset | `read` | `write` | `shell` | `network` | `mcp` | `delegate` |
| --- | --- | --- | --- | --- | --- | --- |
| `read-only` | allow in the zone | deny | deny | deny | deny | deny |
| `workspace` | allow in the zone | allow in the zone, except `"read"` directories | allow | deny | allow | allow |
| `full` | allow | allow | allow | allow | allow | allow |

Outside the zone, `outside` decides reads, and the preset decides writes:
denied with `read-only` and `workspace`, allowed with `full`. With
`read-only`, a `"write"` directory is an error: the preset never writes.

Without a preset, every action is denied unless a rule allows it;
`directories` and `outside` only shape where a preset applies.

Only `deny` and `ask` need enforcement. A harness that allows less than
requested is acceptable: the agent simply has fewer rights.

### Evaluation

For an action, the rules that match it decide: a rule overrides the preset and
the zone, as an `allow` rule for `network` does with `workspace`. When several
rules match, the most restrictive effect wins: `deny`, then `ask`, then
`allow`. A rule therefore cannot carve an exception out of another rule's
denial. When no rule matches, the preset and the zone decide.

### Reviewer

`reviewer` says who answers the agent's `ask` actions:

```json
"permissions": { "preset": "workspace", "reviewer": "model" }
```

| Value | Who answers |
| --- | --- |
| absent | The host decides. |
| `"person"` | A person. |
| `"model"` | A reviewing model of the harness, such as Codex auto-review or the Claude Code auto mode classifier. |

`reviewer` applies to every `ask` of the agent; it does not change `allow` or
`deny`. A model's answer is a policy, not a guarantee: modules declare
`reviewer.person` and `reviewer.model` as properties, with support levels,
not as permission enforcement. A host MAY have a person answer instead of a
model, never the reverse.

### Waiting for a person

A person may take hours to answer an `ask` or to review a plan. That time is
not the machine's, and a step's [`timeoutMs`](flow.md#time-limits) does not
count it. `answerTimeoutMs`, a positive integer, bounds it: a request the host
has put to a person for this agent's work, left unanswered that long, gets the
answer "no". An `ask` is refused, and the agent continues, as after any
refusal. A `planFirst: "ask"` plan is refused without comment, which fails the
work with `PLAN_REJECTED`. Without `answerTimeoutMs`, the host waits for the
person. A request that counts for several works, because the harness does not
say which one it is for (see [Time limits](flow.md#time-limits)), gets "no"
after the shortest `answerTimeoutMs` among those works that declare one.

```json
"releaser": {
  "harness": "codex",
  "permissions": { "preset": "workspace", "reviewer": "person", "rules": [{ "action": "shell", "match": "npm publish *", "effect": "ask" }] },
  "answerTimeoutMs": 3600000
}
```

The host presents these requests and answers them for the person, so
`answerTimeoutMs` asks nothing new of the harness.

### Rules for hosts

1. **The document asks, the host grants.** Permissions in a document are a
   requested ceiling. A host MAY grant less. It MUST NOT grant more.
2. **A message never changes permissions.** No prompt, resource or result can
   widen what an agent may do.
3. **A sub-agent can only narrow.** When a harness lets an agent delegate, the
   sub-agent never has more rights than the agent.
4. **No false guarantee.** Each harness module declares how its harness
   enforces each action and effect: by an operating-system sandbox, by harness
   rules, or not at all. Permissions are enforced or they are not; there is no
   approximate enforcement. A `deny` or `ask` that the harness cannot enforce
   is an error, including one that the agent's shell commands could bypass (see
   [Permission enforcement](harnesses.md#permission-enforcement)). An agent
   without MCP servers needs no `mcp` enforcement: the host gives it none.

The `ask` effect acts on one action during the agent's work. It is distinct
from an [approval step](flow.md#approval), which lets a person choose how the
flow continues.

## Results

An agent declares the named results it produces. They are submitted with the
[result tool](#the-result-tool).

```json
"results": {
  "summary": { "required": true, "mediaType": "text/plain" },
  "findings": {
    "schema": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "file": { "type": "string" },
          "severity": { "type": "string", "enum": ["low", "high"] }
        },
        "required": ["file", "severity"]
      }
    }
  },
  "diagram": { "mediaType": "image/png" }
}
```

| Field | Content |
| --- | --- |
| `required` | `true` if every accepted submission must include it. Default: `false`. |
| `mediaType` | Default: `application/json`. |
| `description` | Text for people and for the agent: what the result holds. |
| `schema` | A [value schema](#value-schemas), only for a JSON media type. |

A result cannot be named `text`: that name is used by the
[default message](flow.md#messages).

A JSON media type is `application/json` or a type with the `+json` suffix
([RFC 6839](https://www.rfc-editor.org/rfc/rfc6839)), such as
`application/geo+json`. For a JSON media type, the result is a JSON value. For
a `text/*` media type, it is a string. For any other media type, it is an
absolute URI that points to the produced file, for example
`file:///workspace/out/diagram.png`.

### Value schemas

A value schema is a closed subset of JSON Schema. Every node has `type`: one of
`null`, `boolean`, `number`, `integer`, `string`, `array` or `object`.

| Keyword | Allowed on | Meaning |
| --- | --- | --- |
| `enum` | any type | A nonempty list of distinct allowed values, each of the node's type. |
| `items` | `array` | The schema of every element. |
| `minItems`, `maxItems` | `array` | The least and the most elements, non-negative integers; `minItems` does not exceed `maxItems`. |
| `properties` | `object` | Schemas of named properties. |
| `required` | `object` | Distinct names of declared properties that must be present. |
| `additionalProperties` | `object` | `false` to reject undeclared properties. Default: `true`. |
| `description` | any type | Text for people and models. |

No other keyword is allowed. Numbers compare exactly; an integer-valued number
satisfies `integer`. Strings are never parsed or coerced.

### The result tool

Agents submit their result with a standard tool:

| | |
| --- | --- |
| Name | `agsdl_submit_result` |
| `results` | An object: result name to value. |
| `choice` | One of the current step's [choices](flow.md#choices), when the step routes by choice. |
| `instructions` | A string: the mission for the next step, when the agent [instructs](#instructing-other-agents). A list of strings, one mission per element, when the chosen route [fans out](flow.md#fan-out) over them. |

The host provides the tool to every agent, through MCP or natively. A harness
module MAY use the harness's native structured output instead, if it gives the
same guarantees: the result is checked before it is accepted, and the agent
can correct it.

The host checks a submission immediately and refuses it, with a precise error
that the agent sees in its conversation, when it has an unknown result name, a
missing required result, a value that violates its schema or media type, or a
missing or unknown choice. It also refuses missing instructions that the
chosen route expects, and instructions that are not a list when the route fans
out over them, or a list when it does not. The agent can then submit again.

A submission is required when the step routes by choice, when the agent
declares a required result, when the agent has a `completionCheck`, or when
the step's route expects the agent's instructions. In other cases, the work
also completes when the agent ends its turn without submitting.

The output of an agent's work is:

```json
{ "text": "...", "results": { "...": "..." }, "choice": "...", "instructions": "..." }
```

`text` is the user-visible text the agent wrote during this work, excluding
reasoning and raw tool exchanges. `results` holds the accepted results.
`choice` is present when the step routes by choice, and `instructions` when
the agent submitted them.

### Corrections

When a submission is refused, or when the agent ends its turn without a
required submission, the agent receives a **correction**: the error, in its
own conversation. A failed [completion check](#completion-check) is also a
correction. The work continues in the same instance; nothing restarts.

Two counters bound corrections, because their causes differ: a refused
submission is a mistake in using the result tool, while a failed check means
the work itself is not finished yet.

| Counter | Counts | Default | When exceeded |
| --- | --- | --- | --- |
| `maxCorrections` | Refused or missing submissions | `2` | The work fails with `OUTPUT_INVALID`. |
| `completionCheck.maxFailures` | Failed completion checks | `3` | The work fails with `CHECK_FAILED`. |

Both count per work. When one more correction of a kind would be needed, the
work fails and the step follows its [`onError`](flow.md#failures).

### Instructing other agents

Everything an agent produces is information, except the instructions of an
agent that **instructs**. Only the document author, and the agents the author
configures with `"instructs": true`, write missions.

```json
"architect": { "harness": "codex", "permissions": "read-only", "instructs": true }
```

Such an agent submits its instructions apart from its results:

```json
{ "choice": "ready",
  "instructions": "Implement the cache layer described in resources.plan.",
  "results": { "plan": "..." } }
```

Its instructions are the prompt of the default message on the routes that
leave its step, and a route's message can select them with
`"prompt": { "from": ["instructions"] }`. A route that uses them **expects**
them: when the agent's choice leads to such a route, a submission without
`instructions` is refused, as a [correction](#corrections). Which prompt a
step finally receives is set out in
[The mission of a step](flow.md#the-mission-of-a-step).

To start several workers with different missions, the agent submits a list,
and the route fans out over it with `"each": ["instructions"]`. Each element
is the mission of one path:

```json
{ "choice": "split",
  "instructions": ["Add the orders table.", "Write the POST /orders endpoint."] }
```

Instructions carry the authority the document gives them, never more:

- They never change the receiving agent's permissions, harness settings or
  standing `instructions`, which prevail over any prompt.
- They set the mission of one work. A later work of the same instance
  receives its own prompt.
- When they reach an instance that is already working, the step's
  [`delivery`](flow.md#delivery) applies, as for any message: `steer` adds
  them to the current work, `queue` makes them the mission of the next.
- Selected into `resources`, they are information like any other.

## Conducting the work

Planning, executing and checking a mission happen inside one agent, in one
conversation. A flow does not split them into steps. Four properties shape how
an agent conducts its work.

### Instructions

The method goes in `instructions`, for example "Understand the request,
implement it, then run the tests." Every harness accepts instructions, so
modules do not declare them.

### Plan

`"plan": true` gives the agent a work plan tool and sends its progress to the
host, so that a host can show what happens inside the agent. The module maps it
to the harness's native tool, such as Codex `update_plan` or Claude Code
`TodoWrite`. A harness without such a tool does not support `plan`.

The agent owns its plan. AgSDL cannot force a model to keep it.

### Plan first

`planFirst` keeps the agent from changing anything until it has presented a
plan for the current work.

| Value | Effect |
| --- | --- |
| absent | No lock. |
| `"auto"` | The agent works read-only until it presents its plan. The plan is then accepted at once. This helps small models explore before they act. |
| `"ask"` | The agent works read-only until the host accepts its plan, usually by asking a person. |

While locked, the agent cannot modify the workspace or any external system.
Its accepted plan does not change its permissions; the lock only removes the
ability to act before the plan.

With `"ask"`, a refusal with a comment returns the comment to the agent, which
revises its plan. A refusal without comment fails the work with
`PLAN_REJECTED`.

With `"ask"`, a person relies on nothing changing before approval: the lock
MUST be enforced like a permission. With `"auto"`, the lock is a working aid,
and a lock kept by instructions only is acceptable with a warning.

### Completion check

```json
"completionCheck": { "command": "npm test", "choices": ["done"], "maxFailures": 5 }
```

When the agent submits a result through the
[result tool](#the-result-tool), the host runs `command` in the agent's
workspace before accepting the result. The check belongs to the host, like
the validation of the result, so it works the same way with every harness.

- If the command exits with status 0, the result is accepted.
- Otherwise, the result is not accepted. The agent receives the command's
  output as a [correction](#corrections) and continues. This counts toward
  `maxFailures`, not `maxCorrections`.
- `maxFailures`, an integer of at least `0`, limits failed checks per work.
  Default: `3`. One more failure fails the work with `CHECK_FAILED`.

`choices` limits the check to submissions with one of these choices. Each of
them must be a choice of a step that uses the agent. Without
`choices`, every submission is checked. A choice left out of `choices`, such
as `blocked`, is accepted without the check, so the agent can report that the
work cannot be done.

The command runs code the agent may have written, so it MUST run with no more
rights than the agent: the host confines it to the agent's permissions, and a
host that cannot do so MUST NOT run the agent. The effective `shell`
permission for the command MUST NOT be `deny`. The host sets the time limit and
how much output it returns to the agent.

A completion check is mechanical: it reads an exit status. Judging a result is
the work of another agent, placed in the flow.

## Definitions and instances

A definition is configuration. An **instance** is a running agent with its own
conversation. Steps designate a definition and, optionally, an instance:

| Step `instance` | Instance used |
| --- | --- |
| absent | The definition's shared instance. |
| a name, such as `"pro"` | A separate named instance of the definition. |
| `"new"` | A fresh instance for this work only, discarded when the work ends. |

Two steps that designate the same definition and the same instance share one
conversation. This is how one mission continues across steps, for example a
writer receiving corrections in a loop. Two different missions use two
different definitions, or two named instances.

- The shared instance and named instances are created on first use and live
  until the run ends.
- A step never modifies a definition. Every instance of a definition has the
  same configuration.
- The same rule applies in [compositions](flow.md#compositions): using a
  composition creates no instance of its own.
- `"instance": "new"` needs a harness that can create a fresh instance per
  work: a module that does not declare `instance.new` supported makes it an
  error.

When a message reaches an instance that is already working, the step's
[`delivery`](flow.md#delivery) decides what happens.
