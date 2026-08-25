# Internal LSP core

This module owns one direct stdio connection to one explicitly configured
language server. It is an internal Rust API. It registers no Tauri command,
agent tool, remote route, product setting, or UI behavior.

## Responsibilities

`LspClient` owns the server process, LSP framing, JSON-RPC request routing,
session state, open-document overlays, and incoming event delivery. The writer
task serializes complete frames. Separate tasks read stdout, drain stderr into a
bounded tail buffer, and wait for the child process. The process supervisor
always reaps the direct child after graceful exit or forced termination.

The framing layer counts UTF-8 body bytes, accepts arbitrary chunk boundaries,
extracts every complete message, and caps header and body sizes before growing
its retained buffer. Malformed headers, invalid lengths, invalid JSON, and a
partial frame at EOF return `FramingError`.

The document cache stores normalized URIs, language identifiers, versions,
exact text, and the open or closed state. It never reads or watches the
filesystem. `open_document`, `replace_document`, `edit_document`, and
`close_document` validate the next state before sending a notification. A
successful write acknowledgement commits the new snapshot. Changes currently
use full-text `didChange` payloads; byte-range edits are applied locally before
that payload is sent. Closed snapshots remain available for the lifetime of the
client so a future adapter can decide when to discard or reuse them.

## Internal API

The stable connection seam for a future Macro adapter consists of:

- `LspServerConfig`, which requires an executable, separate arguments, a
  working directory, optional environment overrides, exact initialize params,
  and startup, request, and shutdown deadlines;
- `LspClient`, which starts, requests, notifies, manages documents, exposes
  immutable snapshots, and shuts down the session;
- `RequestOptions` and `CancellationToken`, which bound each request without
  terminating a session that can still serve other work;
- `ServerRequestHandler`, which handles requests initiated by the server and
  returns a JSON-RPC result, error, or `Unhandled`;
- `LspEvent`, delivered through a bounded broadcast channel, plus a watch
  channel for the latest `ClientState`;
- `LspError` and `FramingError`, which keep transport, protocol, lifecycle,
  timeout, cancellation, process, and document failures distinct.

The adapter should retain a `watch::Receiver<ClientState>` when it must observe
the terminal state even if it subscribes late. The event broadcast is intended
for live notifications and can report lag to a slow consumer. Every incoming
notification emits the generic `Notification` event; diagnostics, progress,
and log messages additionally emit their typed convenience event.

## Lifecycle and failure rules

The normal lifecycle is:

```text
created -> starting -> initializing -> ready -> shutting_down -> stopped
```

After spawn, the client sends `initialize`, stores the returned server
capabilities, sends `initialized`, and only then becomes ready. Shutdown rejects
new work, cancels pending ordinary requests, sends `shutdown`, writes `exit`,
waits for the configured deadline, and kills then reaps the direct child if it
does not exit. Concurrent and repeated shutdown calls share the lifecycle lock,
so only one handshake runs.

A framing error, broken stdin or stdout, failed initialization, or unexpected
process exit moves the session to `failed`, rejects every pending request, and
starts forced cleanup. Stderr EOF alone is not fatal. A timed-out or cancelled
request is removed from the pending map and queues `$/cancelRequest`; a late
response becomes an `UnmatchedResponse` event and does not affect other
requests. Incoming messages are classified by `method` before `id`, because
server and client request identifiers occupy independent spaces.

`kill_on_drop` and the supervisor cover the configured child process. They do
not yet create a Unix process group or Windows Job Object for arbitrary
descendants started by that server. A future production adapter that accepts
untrusted server launchers should add process-tree isolation before treating
descendant cleanup as guaranteed.

## Future Macro adapter

The adapter remains responsible for server selection, installed-server
detection, user configuration, workspace routing, persistence, tool policy,
approvals, and presentation. It should construct explicit initialize params and
register the server-request methods Macro is prepared to honor. In particular,
`workspace/applyEdit` must remain unhandled until the adapter can apply edits
through Macro's validated mutation path.

The first product operations can map to the core without changing its
transport:

- diagnostics subscribe to `LspEvent::Diagnostics` and may request a document
  diagnostic method when the server advertises it;
- definition sends `textDocument/definition` with a document URI and position;
- references sends `textDocument/references` with its reference context;
- hover sends `textDocument/hover`;
- symbols sends `textDocument/documentSymbol` or `workspace/symbol`.

Those operations should live in the future adapter. They should inspect
`server_capabilities`, open or update the required document explicitly, pass a
request deadline and cancellation token, and translate raw JSON into Macro
contracts. The core should remain unaware of agent tools and product UI.
