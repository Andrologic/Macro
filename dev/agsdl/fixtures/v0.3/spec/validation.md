# Validation

A validator checks a document without running it. A valid document is
well-formed and consistent, and its harnesses declare support for what it
asks. Validity does not prove that the harnesses are installed, that models
exist, that the host grants the permissions, or that the flow terminates.

## Order of checks

1. **Parse**: the input is JSON as required by
   [Document](document.md#json-input).
2. **Shape**: the document matches the [schema](../schema/agsdl.schema.json).
   A shape failure stops the checks.
3. **Semantics**: references, routes, messages, joins, compositions,
   permissions.
4. **Harnesses**: each agent against its harness module.

## Report

A report is a JSON object:

```json
{
  "contract": "agsdl-0.3.0",
  "valid": false,
  "diagnostics": [
    {
      "severity": "error",
      "code": "HARNESS_VALUE",
      "path": "/agents/reviewer/model/effort",
      "message": "claude-code accepts low, medium, high, xhigh, max; got \"minimal\"."
    }
  ],
  "joins": {
    "merge": { "origin": "analyze", "branches": ["security", "performance"] }
  }
}
```

- `valid` is `false` when at least one diagnostic has severity `error`.
- `path` is a JSON Pointer into the document. Diagnostics about a body step of
  an expanded composition also give `step`, the list of step names leading to
  it.
- `joins` reports the deduced origin and branches of every join in the flow.
  Steps inside compositions are addressed by their step path joined with `/`,
  for example `review/vote`; names cannot contain `/`.
- `message` is for people. Programs rely on `code`.

## Diagnostic codes

### Errors

| Code | Condition |
| --- | --- |
| `PARSE` | The input is not acceptable JSON. |
| `SHAPE` | The document does not match the schema or the contract marker. |
| `REFERENCE` | A name refers to nothing: agent, step, content, skill, MCP server, composition, parameter, output, choice. |
| `DUPLICATE` | A target appears twice in one route. |
| `ROUTES` | A route does not fit its step: wrong outcome keys, an approval without choices, a message or a fan-out to a step that cannot receive one, `concurrency` or `max` without `each`, a message on an output target, an output outside a composition, an entry that is a join. |
| `UNREACHABLE` | A step cannot be reached from the entry, or from the flow's `onError`. |
| `MESSAGE_PATH` | A selection or operand path does not exist in the declared output it reads, a fan-out reads a declared value that is not a list, a selection reads `item` outside a fan-out, a prompt selects something other than instructions, or a route fans out over instructions while another of its targets uses them as one prompt. |
| `PROMPT` | An agent step receives a prompt on some routes but not on others, and has no default prompt. |
| `DELIVERY` | `delivery` is used with `"instance": "new"`. |
| `JOIN` | A join breaks a [shape rule](flow.md#shape-rules). |
| `COMPOSITION` | Parameters, outputs or nesting of a composition are inconsistent, a compose step's `agents` or `next` keys differ from the composition's parameters or outputs, a body fork does not start the branches of one join, or compositions form a cycle. |
| `SCHEMA` | A value schema is inconsistent: a keyword on the wrong type, an `enum` value of the wrong type or repeated, a `required` name that is not a declared property, `minItems` above `maxItems`; or a result has a schema without a JSON media type. An unknown keyword is a `SHAPE` error. |
| `PERMISSIONS` | A completion check command is denied by the agent's own permissions, or a `read-only` agent has a `"write"` directory. |
| `RESULT_NAME` | An agent declares a result named `text`, which collides with the default message. |
| `HARNESS_UNSUPPORTED` | The agent uses a property, or needs a permission effect enforced, that its harness module declares absent. Or the module enforces that effect only by harness rules that the agent's shell commands could bypass. Or a `deny` or `ask` uses a `shell` pattern that the harness cannot match. |
| `HARNESS_VALUE` | A value is outside the module's closed vocabulary. |
| `HARNESS_SETTINGS` | `harnessSettings` violate the module's settings schema, or the module defines no settings. |

### Warnings

| Code | Condition |
| --- | --- |
| `HARNESS_APPROXIMATE` | The harness supports a property approximately. The module's note is given. |
| `HARNESS_VERSION` | Support depends on the harness version. |
| `HARNESS_UNVERIFIED` | No module is known for the agent's harness. |
| `FANOUT_VISITS` | A step in the paths of a fan-out has a `maxVisits` below the fan-out's `max`, or has one while the fan-out has no `max`: each element is a visit. |
| `SHARED_INSTANCE_PARALLEL` | Two steps that can run at the same time share an instance, or one step can run in several paths of a fan-out, and no step involved declares `delivery`; or a step after a join with `remaining: "finish"` shares an instance with one of its branches and does not declare `delivery: "queue"`. |

## What validators do not check

- Whether content behind a URI exists or is readable.
- Whether a model name is available. The host checks it at launch.
- Whether a selection path exists below an undeclared value. Paths into
  results without a schema, call data and composition outputs are checked as
  far as declarations go.
- Whether loops terminate.
- Whether a harness actually behaves as its module declares. Modules are
  maintained against harness documentation and code; they are claims, not
  proofs.
