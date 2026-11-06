# Harnesses

A harness runs one agent's loop: it calls the model, runs tools, and repeats
until the work is done. AgSDL does not define harnesses. It defines standard
agent properties, and **harness modules** say how each harness supports them.

One flow can mix harnesses: a Codex agent can hand work to a Claude Code agent.
Each agent runs in exactly one harness.

## Harness modules

A module is a JSON data file. It contains no code: validators read it, they
never run it. Modules are maintained in this repository under
[`harnesses/`](../harnesses/README.md) and follow the
[module schema](../schema/harness-module.schema.json).

```json
{
  "name": "codex",
  "title": "Codex",
  "version": "1.0.0",
  "contract": "agsdl-0.3.0",
  "harnessVersions": ">=0.152.0 <1.0.0",
  "sources": ["https://learn.chatgpt.com/docs/config-file/config-reference"],
  "properties": {
    "model.effort": { "support": "native", "suggestions": ["low", "medium", "high", "xhigh"] },
    "plan": { "support": "native", "note": "Maps to update_plan." },
    "delivery.steer": { "support": "native" }
  },
  "permissions": {
    "write": { "allow": "sandbox", "deny": "sandbox", "ask": "harness" }
  },
  "settings": {
    "type": "object",
    "properties": { "approvalsReviewer": { "type": "string", "enum": ["user", "auto_review"] } },
    "additionalProperties": false
  }
}
```

| Field | Content |
| --- | --- |
| `name` | The harness name used in `agents.*.harness`. |
| `title` | Optional. A display name. |
| `version` | The module's own version, independent of AgSDL. |
| `contract` | The AgSDL contract the module targets. |
| `harnessVersions` | The harness versions the module covers. The range ends before the next major version, or before `1.0.0` for a harness in `0.x`: a module covers a new major version only once it has been checked against it. |
| `sources` | The code and documentation each claim rests on. Optional for the schema, expected for every module maintained here. |
| `properties` | Support for each standard property. |
| `permissions` | Enforcement of each permission action and effect. |
| `settings` | A [value schema](agents.md#value-schemas) for `harnessSettings`. |

A module only says whether and how its harness supports a property. It never
changes what a standard property means.

### Support levels

Each entry of `properties` has a `support` level:

| Level | Meaning |
| --- | --- |
| `native` | The harness does exactly what the property says. |
| `approximate` | The harness does something close. `note` explains the difference. |
| `absent` | The harness does not do it. |

An entry MAY also have:

- `values`: the accepted values of a closed vocabulary, such as the effort
  levels of Claude Code;
- `suggestions`: known values of an open property, such as model names or the
  effort levels of a harness whose models define their own, for editors only;
- `versions`: the harness versions in which the support applies;
- `note`: an explanation shown with diagnostics.

A property missing from `properties` is `absent`.

### Standard property keys

| Key | Property |
| --- | --- |
| `resources` | [Identity](agents.md#identity) |
| `model.name`, `model.effort` | [Model](agents.md#model) |
| `skills`, `mcpServers` | [Skills](document.md#skills) and [MCP servers](document.md#mcp-servers) |
| `plan`, `planFirst.auto`, `planFirst.ask` | [Conducting the work](agents.md#conducting-the-work) |
| `reviewer.person`, `reviewer.model` | [Reviewer](agents.md#reviewer): who answers `ask` actions |
| `directories` | [Zone](agents.md#zone): directories added to it |
| `instance.new` | [Instances](agents.md#definitions-and-instances): a fresh instance per work |
| `delivery.steer` | [Delivery](flow.md#delivery): joining a current work |

Modules do not declare the other agent properties:

- `instructions` reach every harness.
- `results`, `instructs`, `maxCorrections` and `completionCheck` rely on the
  [result tool](agents.md#the-result-tool), which the host gives every agent,
  through an MCP server or a tool of the harness's own.
- `answerTimeoutMs` and `delivery.queue` rely on the host alone: it answers
  the requests it presents, and keeps waiting messages.
- `harnessSettings` are checked against the module's `settings`.

### Permission enforcement

Each entry of `permissions` gives, for one action, how each effect is
enforced, and MAY add a `note`, shown with diagnostics:

| Value | Meaning |
| --- | --- |
| `sandbox` | Enforced by the operating system, around everything the agent runs. MCP servers are not part of it: an `mcp` permission covers what they do. |
| `harness` | Enforced by the harness's own rules before each action. |
| `absent` | Not enforced. For `allow`, the harness has no such action at all. |

A `deny` or `ask` declared as `sandbox` or `harness` holds for every rule of
that action, with or without `match`, and for the presets, except for the
`shell` patterns that a `"match": "prefix"` entry excludes, below.

The `shell` entry MAY add `"match": "prefix"`: the harness matches a command
by its leading words only. A `deny` or `ask` then holds only for a pattern
made of words, alone or followed by ` *`, such as `git push *`; on words
alone, it also covers them with arguments. On any other pattern, such as
`git push * --force` or `rm*`, it is not enforced. A host
never widens an `allow` to fit the harness: what the harness cannot express,
the host does not grant. A harness whose rules match the command text
expresses a final ` *` with two rules: the words alone, and the words
followed by any arguments.

`harness` rules act on the harness's own tools. A shell command can read,
write or reach the network without them, so for `read`, `write`, `network`
and reads outside the zone, `harness` enforcement holds only when the agent
can run no shell command: its permissions deny every shell command, or the
harness has no shell (`shell.allow` is `absent`). Otherwise it counts as
`absent`. A `sandbox` covers shell commands too.

An `ask` declared as `sandbox` means that the operating system denies shell
commands what the rule covers, so only the harness's tools, which ask, can
reach it. Denying a way around the request keeps the guarantee that nothing
happens without an answer.

The `read` entry MAY add `"outside"`, with the same values: how the harness
denies reads outside the zone. An agent whose `outside` is `"deny"` needs it.

There is no approximate enforcement: a permission is guaranteed or it is not.

## Modules and versions

- A module has its own semantic version. A **minor** version adjusts support or
  covered harness versions; documents valid before stay valid. A **major**
  version may make a valid document invalid, for example when a harness removes
  a feature.
- A document names the harness (`"harness": "codex"`). It MAY restrict the
  harness version (`"harnessVersion": ">=0.60.0"`). Validators use the module
  they ship with.
- A harness without a module can still be used. The agent is not verified, and
  validators say so.

Code that turns a document into a harness's native files (an exporter), or
that runs an agent and connects it to a flow (an adapter), lives in the
projects that need it, such as hosts. It is not part of the specification.

## Diagnostic policy

Problems surface at three moments, each knowing more than the last:

| Moment | Who checks | What is known |
| --- | --- | --- |
| Writing | The validator, without running anything | The document and the modules |
| Launch | The host, just before running | The actual harness version and the models available |
| Run | The harness | What it actually refuses: a refusal fails the step with `HARNESS_REFUSED` |

There are two levels. An **error** means the document cannot run as written
without betraying its meaning; the document is invalid. A **warning** means it
can run, but something is not exact or not verified; the document stays valid.

The module declares support; this specification fixes the severity:

| Situation | Code | Writing | Launch |
| --- | --- | --- | --- |
| Property `absent` | `HARNESS_UNSUPPORTED` | error | error |
| Value outside the module's closed vocabulary | `HARNESS_VALUE` | error | error |
| Property `approximate` | `HARNESS_APPROXIMATE` | warning | warning |
| Support limited to some harness versions | `HARNESS_VERSION` | warning | error or nothing, for the actual version |
| `harnessSettings` violate the module schema, or the module defines no settings | `HARNESS_SETTINGS` | error | error |
| Permission effect not enforced, or enforced only by harness rules that shell commands bypass | `HARNESS_UNSUPPORTED` | error | error |
| No module for the harness | `HARNESS_UNVERIFIED` | warning | the host decides |
| Actual harness version outside the module's range | `HARNESS_VERSION` | — | warning |
| Open value unavailable, such as an unknown model | — | — | error |

Two refinements follow from [Agents](agents.md):

- `planFirst: "auto"` accepts an approximate lock with a warning;
  `planFirst: "ask"` needs an enforced lock, so a module declares
  `planFirst.ask` only as `native` or `absent`.
- Open values, such as model names and open effort levels, are never errors
  at writing time. Module suggestions serve editors only.

A host such as Macro shows these diagnostics with the agent's details, not on
the flow diagram.
