# Native Codex for AgSDL

An AgSDL 0.3 agent declares `harness: "codex"` and a supported permission
profile. Its model name comes from the qualified native catalogue. Macro never
substitutes its HTTP transport when the native harness is unavailable. Macro
agent tools outside AgSDL retain their own captured engine and tool policy.

The current adapter qualifies the official Codex CLI **0.167.x on macOS ARM64
and Linux ARM64**. Other
versions and platforms are unavailable until qualified. Install that CLI on
Macro's PATH. Macro checks its version and executable digest; it incorporates
no private SDK or fork. The native model catalogue comes from this profile's
`model/list`, with no fallback model. `maxTurns` and Macro tool aliases on a
native Agent are unsupported.

## Private login

Install the **complete official CLI package from one release**, including the
`codex`, `codex-code-mode-host` and `codex-exec-server` executables. The two
helpers must be regular executable siblings of the resolved native `codex`.
Use the matching platform archives and verify their published digests. A lone
`codex` binary can authenticate and list models while later tool execution fails.
The native precheck reports `CODEX_PACKAGE_INCOMPLETE` for missing, unreadable or
non-executable helpers. Their observed digests join the captured profile identity,
so replacing a helper invalidates that capture. Presence and hashes alone do not
qualify provenance, a new CLI patch or the real write-review recipe.

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

## Explicit existing-file authentication

The private login above remains the default. A native host can explicitly opt
into reading an existing ChatGPT **file** session without loading that session's
configuration. This experimental path is limited to the official **0.167.0**
executable and the existing platform gates. A working ordinary 0.169 session
does not qualify 0.169 as an AgSDL execution engine. Product qualification of
this new authentication path still requires the real UI and standalone recipes.

Set `ARGENTIC_CODEX_EXECUTABLE` to the absolute executable path when the qualified package is installed alongside another Codex version. The native adapter checks the version, sibling executables and profile.

For Macro, set `ARGENTIC_CODEX_AUTH_FILE` only in the process launching the QA
application. For the standalone operator, use `--codex-auth-file FILE`; embedding
hosts use `HostContext::with_codex_auth_file`. The source is native host
configuration, never an AgSDL field or model-selected path. Select the qualified
executable using that host process's `PATH`, without changing the ordinary CLI
installation. For example:

```sh
env ARGENTIC_CODEX_EXECUTABLE=/absolute/qualified-codex-0.167.0/codex \
  ARGENTIC_CODEX_AUTH_FILE=/absolute/ordinary-codex-home/auth.json \
  /absolute/qa-application
```

The selected source must be a canonical absolute, owned, private regular file
outside the workspace and execution profile. Symlinks, hard links, group/other
access and files over 128 KiB are refused. Only a ChatGPT record with a usable
access token and selected account ID is supported. Keyring/encrypted stores,
other credential modes and missing/expired tokens are refused. The private
execution profile must have no stored `codex/auth.json`; use a distinct QA data
root instead of moving or deleting an existing session.

The native client uses the internal, unstable `chatgptAuthTokens` app-server API.
It transmits credentials only in memory over the contained CLI's private stdin.
It never copies an auth file, sends credentials to the frontend/model, or writes
or renews the ordinary session. Hooks, MCP, skills, rules, executables and other
ordinary configuration are not imported. The execution profile and per-action
human grants stay in force. Each server verifies its actual `account/read`
workspace routing against the captured identity before work can proceed.

On a native 401 callback, the client can reread a token already renewed by the
ordinary CLI for the same account. It rechecks native account/routing before
releasing replies. It does not perform OAuth refresh. An unchanged rejected
token, changed account/routing, invalid source or deadline stops the operation
with a fixed diagnostic, never an automatic login, fallback or replay.

| Diagnostic | Required follow-up |
| --- | --- |
| `CODEX_AUTH_SOURCE_UNAVAILABLE` / `CODEX_AUTH_SOURCE_UNSUPPORTED` | Check the host-selected file source and supported storage format privately. |
| `CODEX_AUTH_EXPIRED` / `CODEX_AUTH_REFRESH_REQUIRED` | No usable renewed token is available. Keep the work stopped; this host cannot refresh it. |
| `CODEX_AUTH_ACCOUNT_CHANGED` | Refuse continuation under the captured identity. |
| `CODEX_AUTH_PROFILE_CONFLICT` / `CODEX_AUTH_VERSION_UNQUALIFIED` | Select a separate empty execution profile and the exact qualified executable. |
| `CODEX_AUTH_FAILED` / `CODEX_AUTH_TIMEOUT` | Inspect the fixed diagnostic and physical Stop/drain state; no credential detail is retained in the error. |

## AgSDL 0.3 execution

Architect exposes Start and Stop for the qualified Codex slice. It supports
agent work, text/JSON resources, validated result submissions, corrections on the
same thread, choice routes and visit limits. Local command and stdio MCP calls,
human flow choices and deadlines, steer, shared/named instances, parallel work,
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

## Retired 0.2 execution

The former 0.2 scheduler and adapter are removed. Opening a 0.2 document reports
an unsupported edition. The shared Codex client, profile observations and 0.3
qualification above remain; no old execution or document conversion is used.

## Bounded requalification

A supported `0.167.x` version string is only an admission prerequisite. For a new
patch or changed executable, record the exact CLI version/digest, platform, host
commit/tree, runtime schema revision and private profile diagnostic. Use an
official isolated login in the profile belonging to that host, or the explicit
existing-file opt-in above when qualifying that exact authentication mode. Keep credentials,
login codes and account details out of the evidence. A login-required diagnostic
leaves the real recipe open.

Record the complete package's same-release helper digests as well as the main
CLI digest. Preserve incomplete-package failures in the evidence; adding the
official helpers is an installation repair, not a passing product qualification.

Run the existing default Rust suites and 37 official scenarios in file and
memory modes. Preserve their support classifications; synthetic peers do not
qualify a provider. Then, in a disposable workspace with an existing regular
`sentinel.txt`, exercise the write-review source in
[write-review fixture](https://github.com/Andrologic/argentic/blob/15d4b47609d760dc3cb31d9e6a44a9add061a971/crates/argentic-runtime/examples/fixtures/write-review.json) through both the UI
and the standalone host documented in
[HOST.md](https://github.com/Andrologic/argentic/blob/15d4b47609d760dc3cb31d9e6a44a9add061a971/crates/argentic-runtime/HOST.md). Use an observed model; never invent
a qualified registry or bypass a refused capability.

Check the real native request before deciding: the exact command, cwd, thread,
turn/item and single existing-file grant must match. Test success, refusal and
Stop while waiting; verify actual file contents, validated result and reviewer
output. Check physical drainage, an incomplete-close retry without resumed
admissions, and interruption without replay after restart. A broader request,
new file, linked file, model reviewer, unsupported version/platform or missing
capability must remain refused. Only record checks actually performed.

The work journal retains its existing `AGENT_FAILED` terminal code. A separate
JSON lines on stderr, kind `argentic.nativeAgentFailure`, carry a fixed category,
a fixed native `stage`, and the actual attempt identity/generation. A failure
can produce several lines as it propagates; retain their order and correlate
them by attempt. Successful boundaries emit nothing.

| Stage | Failing native boundary |
| --- | --- |
| `session`, `ask` | Owned Codex session, or its command approval port |
| `brokerAttach`, `brokerAdmit`, `brokerOwner`, `brokerOpen` | Human broker attachment, admission, owner check, request creation |
| `brokerPump`, `brokerWait`, `brokerResolution` | Durable human-clock evaluation, resolution wait, reservation |
| `brokerInspect`, `brokerPolicy`, `brokerDeliver`, `brokerReply` | Current capture, policy lease, guarded delivery, physical native reply |
| `workEvent`, `workSubmit`, `workCheck` | Runtime work event, result submission, completion-check port |
| `executor`, `executorStop` | Executor return, or its terminal failure event |

`CODEX_RPC_SERVER_REQUEST_UNQUALIFIED` identifies an unavailable callback
during an RPC wait. `CODEX_APPROVAL_METHOD_UNQUALIFIED` identifies an unsupported
approval method; `CODEX_TURN_FAILED_AFTER_SCOPE_DECLINE` records a failed turn
after an automatic scope refusal, without asserting causation. `CODEX_TURN_*`
categories come only from correlated native error metadata, with
`CODEX_TURN_FAILED` for unknown detail. Known auth/profile/request and content
failures keep their fixed codes. Engine guard and conversion categories use
fixed `ENGINE_*` codes, including `ENGINE_STORAGE`, `ENGINE_AUTHORITY`,
`ENGINE_RUNTIME_UNAVAILABLE`, `ENGINE_PERMISSION` and `ENGINE_STOP_PENDING`;
correlation remains `AGENT_CORRELATION`. An unrecognized category becomes
`UNCLASSIFIED_FAILURE`, never a copy of its original code. SQL errors have
already lost their raw details in the existing `EngineFailure` conversion.
Native messages, pointers, work payloads,
additional details, credentials and callback bodies are never emitted as
diagnostics. A fixed category is evidence for diagnosis, not authority or proof
that the real approval path passed.

Restore the disposable file and product source through their normal owners after
drainage. A failure remains a failure or a narrower support boundary; it does not
justify widening permissions, faking physical receipts or silently promoting a
patch, platform or harness. Real-provider and UI evidence belong to the parent
qualification, separately from source extraction, unit tests and build evidence.
