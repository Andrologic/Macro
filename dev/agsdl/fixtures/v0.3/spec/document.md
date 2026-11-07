# Document

## Shape

A document is a JSON object:

```json
{
  "contract": "agsdl-0.3.0",
  "id": "code-review",
  "title": "Code review",
  "agents": { "...": {} },
  "flow": { "entry": "...", "steps": { "...": {} } }
}
```

| Field | Required | Content |
| --- | --- | --- |
| `$schema` | no | The URI of a JSON Schema, for editors, such as `https://raw.githubusercontent.com/Andrologic/AgSDL/v0.3.0/schema/agsdl.schema.json`. It has no effect on behavior. |
| `contract` | yes | Exactly `agsdl-0.3.0`. |
| `id` | yes | Document identifier, a [name](#names). |
| `title`, `description` | no | Text for people. They have no effect on behavior. |
| `content` | no | Named content sources, reused through `ref`. |
| `skills` | no | Named skills that agents can load. |
| `mcpServers` | no | Named MCP servers that agents and calls can use. |
| `agents` | yes | Agent definitions. See [Agents](agents.md). |
| `flow` | no | The flow of work. See [Flow](flow.md). |
| `compositions` | no | Reusable flow fragments. See [Compositions](flow.md#compositions). |

A document without `flow` is valid: it defines agents that a host can run and
message directly. See [Agents without a flow](flow.md#agents-without-a-flow).

Unknown fields are invalid, except inside `harnessSettings` and inside literal
`value` content. Omitted maps and lists are empty.

## JSON input

A document is UTF-8 JSON as defined by
[RFC 8259](https://www.rfc-editor.org/rfc/rfc8259). Readers MUST reject a byte
order mark, duplicate object keys, invalid UTF-8, unpaired surrogate escapes
and values that are not JSON, such as `NaN`. Readers keep numbers exact.

## Names

Document identifiers, agent names, step names, result names, content names,
skill names, MCP server names, instance names, composition names, output names
and parameter names match:

```text
^[A-Za-z][A-Za-z0-9_-]{0,63}$
```

**Choices** are routing identifiers produced by agents. They are lowercase
`snake_case`, so that models produce them reliably and every tool API accepts
them:

```text
^[a-z][a-z0-9_]{0,63}$
```

`step`, `output` and `message` are reserved: they are not valid choices or
composition outputs, because a route object uses them as fields.

Agent names and step names have separate scopes. A step may have the same
name as an agent.

## Content

A **content source** is one of:

| Form | Meaning |
| --- | --- |
| `{ "value": ..., "mediaType": "..." }` | Inline content. A string is text; any other JSON value is data. |
| `{ "uri": "...", "mediaType": "..." }` | Content by reference. |
| `{ "ref": "name" }` | The named entry of the document `content` map. |

`mediaType` is optional. The default is `text/plain` for a string value and
`application/json` for any other value. A URI source without `mediaType`
leaves the format to the consumer.

The host reads a URI source used as instructions or as a prompt and gives the
harness its content. A harness never reads these URIs itself.

Entries of the `content` map are inline or URI sources; they cannot contain
`ref`, so references never form cycles.

An object inside `value` is literal data. A key spelled `uri` or `ref` inside
it is not a reference.

### URIs

A `uri` is an absolute URI or a relative reference
([RFC 3986](https://www.rfc-editor.org/rfc/rfc3986)). A relative reference
resolves against the location the document was read from. Validators check URI
syntax only. They do not fetch content, and a valid URI proves neither that the
content exists nor that the host may read it.

## Skills

A skill is a reusable procedure in the
[Agent Skills](https://agentskills.io) format: a directory with a `SKILL.md`
file whose front matter gives `name` and `description`.

```json
"skills": {
  "security-review": { "uri": "skills/security-review/SKILL.md" }
}
```

An agent lists the skills it may use. The harness shows the agent each skill's
name and description, and loads the full instructions only when the agent
decides to use the skill. Skills add instructions and files; they grant no
permission.

## MCP servers

Servers declared here can be given to agents and used by
[call steps](flow.md#call).

```json
"mcpServers": {
  "github": { "url": "https://mcp.example.com/github" },
  "tests":  { "command": ["node", "tools/test-server.js"] }
}
```

| Field | Content |
| --- | --- |
| `command` | A local server: the program, a nonempty string, then its arguments, as a list of strings. |
| `url` | A remote server, reached over MCP Streamable HTTP. |

A server has exactly one of `command` or `url`. Credentials are not part of a
document; the host supplies them. Declaring a server grants nothing: an agent
needs an `mcp` [permission](agents.md#permissions) to use it, and the host
decides whether to start it.
