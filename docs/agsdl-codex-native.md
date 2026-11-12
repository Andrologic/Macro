# Native Codex for AgSDL

An AgSDL Agent can explicitly bind `macro/agent-engine` version `1` to
`openai/codex` version `1`. Its Model must be an observed `codex-native` Edition.
The `codex-native` provider identifier is reserved for this adapter. Macro never
substitutes its HTTP transport when the native engine is unavailable. Existing
Macro agents retain their captured engine and tool policy.

The current adapter qualifies the official Codex CLI **0.167.x on macOS ARM64
and Linux ARM64**. Other
versions and platforms are unavailable until qualified. Install that CLI on
Macro's PATH. Macro checks its version and executable digest; it incorporates
no private SDK or fork. The native model catalogue comes from this profile's
`model/list`, with no fallback model. `maxTurns` and Macro tool aliases on a
native Agent are unsupported.

## Private login

Open an Agent's Codex configuration once so Macro creates and validates its
private directories. The diagnostic distinguishes an absent CLI, unsupported
version/platform, an invalid profile, and a required login. Opening this panel
creates no model thread. It runs a local sandbox probe before asking for login.

Let `MACRO_ROOT` be Macro's actual configuration root. An explicit absolute
`MACRO_CONFIG_DIR` takes precedence; the Linux desktop default is
`${XDG_CONFIG_HOME:-$HOME/.config}/com.macro.desktop`, and the macOS default is
`$HOME/Library/Application Support/com.macro.desktop`. A development or QA
application identifier has its own root. Use the root of the application that
will execute the Agent.

The native profile is `MACRO_ROOT/native-engines/codex-v1`. Its `home` and
`codex` directories are private, owned by the current user, and mode `0700`.
The empty, durable context directory is
`MACRO_ROOT/native-contexts/codex-v1`. Macro records its identity. Replacing,
removing, adding files to, or redirecting this directory makes the profile
unavailable. Keep this profile outside every workspace used by its Agents.

Run the official login in a terminal using only these private directories. Set
`MACRO_ROOT` and `CODEX_BIN` to absolute paths, and check `CODEX_BIN --version`
returns `codex-cli 0.167.x`. Do not copy an existing `auth.json` or create an API
key. This profile supports a ChatGPT account whose stable account and routing
identity Codex can attest through `account/read`.

```sh
MACRO_ROOT=/absolute/path/to/macro-config
CODEX_BIN=/absolute/path/to/native/codex
NATIVE_PROFILE="$MACRO_ROOT/native-engines/codex-v1"
cd "$MACRO_ROOT/native-contexts/codex-v1"
env -i PATH=/usr/local/bin:/usr/bin:/bin \
  HOME="$NATIVE_PROFILE/home" CODEX_HOME="$NATIVE_PROFILE/codex" \
  XDG_CONFIG_HOME="$NATIVE_PROFILE/home/.config" \
  XDG_DATA_HOME="$NATIVE_PROFILE/home/.local/share" LANG=C.UTF-8 \
  "$CODEX_BIN" \
  -c 'cli_auth_credentials_store="file"' \
  -c 'project_root_markers=[]' -c 'project_doc_max_bytes=0' \
  -c 'notify=[]' -c 'allow_login_shell=false' \
  -c 'features={plugins=false,remote_plugin=false,apps=false,hooks=false,shell_snapshot=false,shell_snapshot_v2=false,memories=false,goals=false,code_mode=false,image_generation=false,multi_agent=false,multi_agent_v2=false}' \
  -c 'agents={enabled=false}' \
  -c 'skills={include_instructions=false,bundled={enabled=false}}' \
  -c 'cloud={skills={enabled=false}}' \
  -c 'shell_environment_policy={inherit="none",experimental_use_profile=false}' \
  -c 'web_search="disabled"' -c 'approval_policy="never"' \
  login --device-auth
```

Follow the official terminal prompt privately. Keep codes, tokens and account
information outside source control and reports. Refresh the configuration panel
after login. Macro's own ChatGPT connection and Codex's default home are separate
sessions. Signing into one does not authenticate this profile. Changing the
profile's account after capture refuses continuation; a token refresh alone
does not change the captured account identity.

## AgSDL 0.3 execution

Architect exposes Start and Stop for the qualified Codex slice. It supports
agent work, text/JSON resources, validated result submissions, corrections on the
same thread, choice routes and visit limits. Local command and stdio MCP calls,
human flow choices and deadlines, steer, shared/named instances, parallel work
joins, nested compositions and step/flow error handlers use the production
supervisor. Expanded step addresses have separate visit counters across one run;
re-entering a composition does not reset its body's counters. Limits fail before
an additional work starts, and leaving a body does not bypass physical cleanup.
Remote MCP calls and other unconnected capabilities remain unavailable. The host permission ceiling defaults to read-only;
preflight announces when host or project settings restrict an agent requesting
workspace writes. A workspace does not require Git and never inherits an
ancestor repository's metadata.

Results use the final agent message's `text` field as an envelope containing
`text` and `submissionJson`. The production controller validates the inner
submission and returns correction diagnostics for another turn on the same
thread. Resources are separate `additionalContext` entries marked untrusted.
Stop joins the owned app-server and its descendants. After an application
restart, unfinished runs are marked interrupted and are never resumed.

### Action approvals and planning

Flow approvals choose the next mission. They do not grant an agent permission
to act. Their successor retains the received prompt's existing provenance and
the person's comments. Agent action approvals use Codex's native server requests and the same
human request controls, ownership checks and clock as other human waits.

The adapter supports this deliberately limited write policy:

```json
{
  "preset": "workspace",
  "reviewer": "person",
  "rules": [{ "action": "write", "effect": "ask" }]
}
```

The underlying workspace stays read-only. A person can approve one native
command's write grant for one existing regular workspace file. The native
request must identify the command, thread, turn, item and exact file grant.
The human request displays the exact command, working directory and file before
the decision; the original protocol payload remains available in the details.
Directories, new files, symlinks, hard links, hidden paths, extra read or
network grants, session-wide grants and incomplete requests are refused.
Other write methods can remain unavailable. There is no automatic approval or
grant for a subsequent command. A refusal, including an answer timeout, is sent
to Codex and the agent continues. Comments remain in the human request record;
the native command response carries the approval decision, not a comment.
The qualified registry describes this sandbox enforcement separately from the
unchanged upstream module, which describes generic Codex patch approvals.
Upstream declaration-only diagnostics do not qualify the installed adapter.

Host and project ceilings still apply. Macro checks them again before sending
the response, under the existing admission gate shared with Stop. Retired work,
revoked ownership and consumed answers cannot authorize an action. A mission,
result or reviewer cannot increase a grant. Omitting `reviewer` selects a person
for this subset. Native `auto_review` exists in Codex 0.167.0, but it can grant
access without a client callback. This adapter therefore refuses
`reviewer: "model"` before launch and admission; it does not silently substitute
a reviewer or start a flow agent. Patterned write rules and `ask` for read,
shell, network, MCP or delegation also remain refused. Native shell prefix
rules are not equivalent to arbitrary AgSDL command patterns.

`planFirst: "auto"` asks Codex to present the current work's plan with its
native `update_plan` tool. The adapter passes the attributed plan event to the
production work controller, which accepts it automatically. The launch dialog
warns that this is an instruction-based aid: changes may precede the plan.
Missing or foreign plan events do not unlock the work's result submission.
This is not a permission guarantee. `planFirst: "ask"` remains refused before
launch and admission because the adapter has no complete native plan lock.

### Completion checks, content and skills

On macOS ARM64, a `completionCheck` uses the captured project command before
acceptance. Its native reservation is consumed once under the work's current
ownership and permission ceiling. The existing confined command executor caps
it at 30 seconds and 65,536 returned bytes. It joins the process tree and streams
before reporting the result. Stop and work deadlines remain available while
the check runs. A failed check returns its output on the same thread and uses
`maxFailures`, separately from invalid submissions and `maxCorrections`.
The optional `choices` filter can exempt a submission from the check.
Checks inherit the confined runtime's filesystem restrictions. In particular,
a logical `cd` through unreadable ancestors can fail; use physical `cd -P`
within the approved workspace. The check returns the real error output.

The native file reader supports absolute local file URIs for instructions,
missions and resources on macOS ARM64 with macOS 14.4 or later. Reads stay inside
the recipient's approved project data scope, exclude private host metadata and
recheck the host ceiling. Text and JSON bytes, including exact number tokens,
are retained. Each source is limited to 256 KiB and the work's content snapshots
to 1,000,000 bytes. Native reader cleanup is attached to the work's existing
physical owner. Relative URIs have no native document origin in this adapter
and are refused. Network URIs and non-text/non-JSON media are also refused.
The TypeScript route helper only carries Sources to the native recipient; it
performs no file or network IO. Resources remain untrusted `additionalContext`,
with the existing approximation warning.

Selected local skills are qualified on Codex 0.167.0 and currently require a
folder containing only `SKILL.md`, with at most 32 selections per agent and the
same source and aggregate content bounds.
The native reader captures that authorized file. The adapter advertises only
the selected names and descriptions. Codex can load the exact captured bytes
through the native dynamic tool `agsdl_load_skill`. The tool checks the current
thread, turn, selection and host ceiling, and accepts no file path. The native
filesystem profile stays unchanged. Live project skill roots are not passed to
Codex because its discovery can follow symbolic links outside them.
Skills with resources, scripts or other folder entries remain refused, as do
extra directory grants not represented by the adapter. Skills add no permission.

Agent MCP equipment remains refused: this adapter has not qualified native MCP
human waits, their correlation to the current work, and physical completion.
This does not affect the existing confined stdio MCP flow-call port, including
its form questions and deadlines. Remote MCP calls remain refused.

## Legacy 0.2 execution boundary

Macro captures the executable, effective policy, account/routing fingerprint,
model, configuration, initialization, mode and workspace before Start. It
rechecks them before each activation. The captured permission ceiling remains
in force after a configuration edit. Codex's native tools run under its named
sandbox profile, with approvals set to `never`, network disabled, and write
access limited to the captured workspace in Implement mode. Other modes and
read-only projects grant workspace reads. The profile denies the workspace's
`.macro` directory and private authentication/session directory. Codex's
metadata protections keep `.git`, `.codex` and `.agents` read-only. Native tools
can read project files as explicit task data. A Git worktree whose `.git` file
redirects outside that workspace receives no extra metadata grant; native Git
commands requiring that external directory can fail. Macro does not widen the
sandbox to repair this limitation.

The native context cwd stays at the empty private bootstrap. Workspace paths
are supplied separately for tool effects. Macro disables project instruction
loading, ancestor markers, shell snapshots, login shells, hooks, plugins, cloud
skills, bundled skills, memories and native sub-agents. It verifies effective
config, an empty skills inventory without errors, and the cwd, runtime roots
and instruction sources returned by thread creation/resume. An existing
`/etc/codex/skills` makes this host ineligible. This is an observed context
condition, checked before capture and continuation; it does not claim a kernel
deny against host reads or immunity to an administrator changing files during a
turn.

Codex owns its native tool policy. Macro's per-tool approval dialog and tool
journal govern Macro tools; they do not intercept each native Codex tool. Macro
still owns Agent FIFO admission, fencing epochs, durable input admission,
private thread/turn references, exact response collection, validation of the
AgSDL publication, and the final terminal transaction. A native publication is
returned through an output schema containing a JSON string, preserving exact
JSON number tokens for Macro's trusted validator.

One Agent instance retains one native thread across activations. Distinct
instances have separate threads. Codex memory uses `macro-codex-memory/1`; Macro
memory is never silently converted. The private journal persists
`possiblySent` before each thread/turn request. A missing receipt forbids an
automatic replay, even after restart or Stop. A conclusively failed or
interrupted turn becomes a failed Agent outcome only after physical end. A
transport or correlation failure remains uncertain.

Stop requests physical termination of the owned app-server and its descendants.
Only a correlated native end receipt permits response closure, a stopped
checkpoint and terminal validation. A JavaScript stop flag or stdio EOF is
insufficient. No successor delivery occurs before physical end and trusted
validation. Stop does not restore files already modified, and local process end
does not prove cancellation of remote provider work.

## Qualification

Synthetic protocol tests exercise continuity, instance separation, exact
publication, non-replay and failure windows. Physical local tests exercise the
real CLI's effective configuration, filesystem/network restrictions and process
termination without a model or login. These are distinct from an authenticated
model turn. The 0.3 write/review path, correction after a rejected result, Stop with a
live descendant, restart interruption, and native workspace/read-only grants
have also been exercised with an explicitly connected private profile on macOS
ARM64. This qualification does not replace each installation's native preflight;
neither a successful initialize nor a visible model catalogue proves a model
turn or additional capabilities.
