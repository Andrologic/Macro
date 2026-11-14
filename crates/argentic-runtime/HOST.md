# Standalone host

`argentic-host` is a local JSON-lines operator over the production runtime. It
uses no Tauri, Macro source checkout or Bun. Opening it does not observe a
provider. Codex preflight and Start require both `--codex` and an explicit command.
It offers no HTTP fallback, automatically approved action or fabricated native
receipt. Default tests use synthetic inputs only.

## Build and open

Keep `argentic-core` beside `argentic-runtime`. Each owns a manifest and lockfile.
With the locked dependencies available locally:

```sh
cargo build --offline --locked --manifest-path argentic-runtime/Cargo.toml --example argentic-host
```

From a Macro checkout, prefix the manifest with `crates/`. The executable is in
the runtime target's `debug/examples/argentic-host`, or in `CARGO_TARGET_DIR` when
set. On macOS the runtime build requires the Swift toolchain. The example calls
`content_io::file_helper::initialize` before Tokio. Downstream host packages must
also preserve `-Wl,-weak_framework,LightweightCodeRequirements` for deployment
before macOS 14.4. Local native content has its existing macOS 14.4+ qualification.

Choose a disposable workspace containing an existing regular `sentinel.txt` with
`before` and a newline. Keep the private data directory outside that workspace,
with neither directory containing the other. Review `examples/fixtures/policy.json`:
`owner` and canonical decimal `sourceRevision` identify this source; `permissions`
is the approved host ceiling; `readOnly` is the project restriction. Increment the
revision for a changed source. Review the source separately. Approve the exact
policy bytes by supplying their SHA-256, not by accepting an implicit default.

```sh
shasum -a 256 examples/fixtures/policy.json
/path/to/argentic-host --data /absolute/private-host-data \
  --workspace /absolute/disposable-workspace \
  --source /absolute/write-review.json --policy /absolute/policy.json \
  --approve-policy THE_REVIEWED_SHA256 --stop-on-exit --codex
```

Omit `--codex` and use `human-only.json` for a provider-free human-flow exercise
on macOS ARM64. `--stop-on-exit` explicitly consents to Stop/drain of this process's
admitted runs on EOF, Ctrl-C or output disconnection. Keep the process alive for
all commands and human answers. A separate invocation never adopts a live run.

The official private Codex profile is rooted at the explicit `--data` directory:
`native-engines/codex-v1`, with the isolated context in `native-contexts/codex-v1`.
Use the official login procedure in [Native Codex](https://github.com/Andrologic/Macro/blob/develop/docs/agsdl-codex-native.md#private-login),
substituting this data root. The embedding API never imports credentials from
Macro or a default Codex home. `CODEX_LOGIN_REQUIRED` is an unmet prerequisite,
not a passing recipe. A model catalogue comes only from the native observation.

Alternatively, explicitly supply `--codex-auth-file /absolute/ordinary-home/auth.json`
to the operator, or call `Host::with_codex_auth_file` before preflight/Start.
Embedding hosts use `HostContext::with_codex_auth_file`. Construction still
starts no provider and reads no credentials. This experimental opt-in uses the
internal app-server external-auth API, limited to the exact official 0.167.0
execution binary. It reads only a private, owned, regular ChatGPT file session,
never its configuration or refresh mechanism. The default private login remains
unchanged. Keep the file outside the workspace and execution profile, and use a
private execution profile without stored auth. See [authentication limits and
diagnostics](https://github.com/Andrologic/Macro/blob/develop/docs/agsdl-codex-native.md#explicit-existing-file-authentication).
Do not expose credentials in operator input/output, logs or evidence. A status
login or synthetic peer does not qualify this opt-in for product use.

## Commands

One JSON object per stdin line; stdout contains one JSON object per response.
The first record contains `ready`, the exact `source` revision/digest and retained
`runs`. Responses contain `result` or a typed `error`; shutdown errors also report
`shutdownStarted`. Invalid commands leave the process available for another one.

```json
{"op":"preflight","entry":{"deliveryId":"entry-1","messageJson":"{\"prompt\":\"Perform the bounded write-review.\"}"}}
{"op":"start","requestId":"start-1","entry":{"deliveryId":"entry-1","messageJson":"{\"prompt\":\"Perform the bounded write-review.\"}"}}
{"op":"runs"}
```

Retain the returned `receipt.identity.systemStartId` and the returned `source`.
Replace `SYSTEM` and `SOURCE_OBJECT` below with those actual values. Never invent
snapshot identities, human request ids, revisions or decisions.

```text
{"op":"inspect","query":{"systemStartId":"SYSTEM","source":SOURCE_OBJECT,"snapshotId":null}}
{"op":"humans","scope":{"systemStartId":"SYSTEM","source":SOURCE_OBJECT}}
{"op":"answer","input":{"scope":{"systemStartId":"SYSTEM","source":SOURCE_OBJECT},"requestId":"ACTUAL_REQUEST","expectedRevision":"ACTUAL_REVISION","answer":{"kind":"decision","decision":"yes","comment":"Reviewed the exact command and file grant."}}}
{"op":"stop","systemStartId":"SYSTEM","requestId":"stop-1"}
{"op":"quit","approved":["SYSTEM"]}
```

Read every human request before answering. Native action approvals use `decision`
with `yes` or `no`; ordinary flow choices use `{"kind":"approval","choice":"yes","comment":"..."}`.
Question answers use `{"kind":"question","answerJson":"..."}`. These are person
submissions, not callbacks authorizing a physical response. The engine correlates
and consumes them under its existing guards. A final result is validated by the
work controller; the operator has no command to forge an agent result.

`inspect` and `humans` accept the returned `nextPage` as `continuation`; revisions
and scopes must still match. `deliver` accepts the existing `DeliveryRequest030`
contract from `api`. Start ids are idempotency keys: after an uncertain reply,
inspect `runs` and use the same request, never submit a new id to guess success.
`shutdown` has the same `approved` list as `quit` but keeps inspection available.
Stop/shutdown waiter deadlines do not prove a physical end. Retry the same
retirement. Once shutdown starts, admissions stay closed; the operator never
resumes work or releases storage before successful drainage. EOF drainage retries
errors while retaining owners. Fix the reported storage/resource issue instead
of interpreting a timeout or forced process exit as success.

## Storage, API and limits

`standalone::Host::open` owns an exclusive OS file lock for its lifetime. It
opens a new engine-only database or verifies the complete existing schema and
`post-042` revision before interruption/fencing. Extra, missing or modified DDL,
unknown revisions and Macro databases are refused. There are no implicit
migrations. `sqlite::memory()` is an independent shared-memory pool; file and
memory use the same engine SQL. Raw-pool embedders own their process exclusion.
After a crash, `runs` reports `interrupted: true`; inspection remains available,
and old owners cannot be adopted or automatically resumed. Review external
side effects before explicitly starting new work.

The small embedding API exposes `Host`, `Policy`, preflight, Start, projections,
human submissions, message delivery, Stop, shutdown and close. It keeps the Start
adapter and native capabilities private. Source, policy bytes and workspace
identity are rechecked with retained input guards. Changes are refused until a
new process explicitly approves its inputs. `close` succeeds only after a
successful native shutdown; dropping the host is not a Stop receipt.

Authored JSON bytes and numeric lexemes use the existing exact codec. Keep JSON
payload fields encoded as strings where specified; do not round them through
JavaScript numbers. Start uses the existing immediate transaction, generation
checks, correlation, idempotency barrier and post-commit readback.

Codex remains limited to qualified 0.167.x/macOS ARM64 or Linux ARM64. Human flow
support here follows the current macOS ARM64 gate. Local host calls, other
harnesses, network content fetches and remote MCP are unavailable in this host.
Model reviewers, broader write grants and unsupported capabilities remain
refused. An accepted version string, a synthetic scenario or a successful build
does not qualify a new provider version or platform. Use the bounded
[requalification procedure](https://github.com/Andrologic/Macro/blob/develop/docs/agsdl-codex-native.md#bounded-requalification).
