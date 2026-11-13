# Cookie persistence during native exit

Source: the locked crates.io package `tauri-plugin-http` 2.5.9. The upstream
MIT and Apache-2.0 licenses and native permission/API files are retained.
Only the native crate and its required global API script are vendored.

Upstream Exit waits synchronously for `CookieStoreMutex::request_save`.
That method queued an async task before calling `tokio::fs::write`. On macOS,
Tauri IPC responders can occupy every async worker while WebKit synchronously
waits for the main loop. If Exit is waiting for cookies on that main loop,
the async save cannot start and neither side can progress.

Macro submits the file write directly to `tauri::async_runtime::spawn_blocking`
and uses `std::fs::write` there. Both the write and its completion notification
can finish while the async workers remain occupied. Cookie snapshots, persistent
versus session cookie selection, file format, path, best-effort supersession,
HTTP commands, scopes and default features remain upstream behavior. There is
no shutdown timeout, forced exit or global disabling of persistence.

The tests reproduce occupied async workers without starting an application or
network request, then verify completion and reload of the latest persistent
cookie without its session cookie. An error writing the file must disconnect
the waiter. The original async implementation fails the occupied-worker test;
both paths release and join their synthetic waiters even on assertion failure.

When updating the dependency, preserve these tests and the independent blocking
save, or use an upstream implementation that provides the same exit behavior.
