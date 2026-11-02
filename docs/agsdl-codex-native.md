# Native Codex for AgSDL

An AgSDL Agent can explicitly bind `macro/agent-engine` version `1` to
`openai/codex` version `1`. Its Model must be an observed `codex-native` Edition.
The `codex-native` provider identifier is reserved for this adapter. Macro never
substitutes its HTTP transport when the native engine is unavailable. Existing
Macro agents retain their captured engine and tool policy.

This adapter targets the official Codex CLI **0.163.0 on Linux ARM64**. Other
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
`${XDG_CONFIG_HOME:-$HOME/.config}/com.macro.desktop`. A development or QA
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
returns `codex-cli 0.163.0`. Do not copy an existing `auth.json` or create an API
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

## Execution boundary

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
model turn. Model execution remains unqualified until tested with an explicitly
authorized private test account; neither a successful initialize nor a visible
model catalogue proves that path.
