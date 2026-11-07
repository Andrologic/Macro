# WKWebView component check

On 7 November, the bench at commit `5e3761e4959daf3ed7ead62f9ad608b4dff82271` exercised frontend assets built from commit `8beefd59400d0cd30608ff2fa187d55d317da2ff`. The reader worker asset had SHA-256 `74979377c6ec9a4a80dee79c4d927c5fdf058d50486aa5853c9c5eaa06e2cbcb`; the source Tauri configuration had SHA-256 `02d88b8ec49579d130b550fd155ddae6eca6a861da29103f15cff6ace495c54e`. The bench served those assets on loopback with the CSP read from that configuration, inside a nonpersistent WKWebView.

The native compiler and all three bench processes returned exit code 0. The report checker passed all three reports. Seven module workers loaded and returned one message each under the source CSP; no CSP violation occurred. Valid, warning, semantic error, large integer and noninteger cases produced their expected verdicts and diagnostic codes. A direct reader check also accepted the 1,000-composition document with its expected unverified-harness warning.

A timer fired after 11 ms while that document was still validating; the response arrived after 554 ms in this single run. Two close revisions were checked with a test-level version guard. This does not test `useAgsdlStore` or establish a timing guarantee.

With a test-only `worker-src 'none'`, WKWebView created a worker and then emitted an error and a CSP violation. The asynchronous validation rejected and terminated the worker. A separate missing-asset case also rejected and terminated its worker. No synchronous constructor rejection was observed in this run.

This component test does not qualify the packaged Tauri application's URL scheme, effective CSP, actual store, or full UI. A native package check remains necessary. The local JSON reports, exit codes and asset manifest are retained separately as ignored evidence; see the bench README for reproduction.

The report gate now explicitly rejects a failed worker that was not terminated, in both blocked and missing modes. A regression test reproduces the former false success with `terminated: false`. The corrected browser assertions and gate passed a further component run in all three modes; each process and the gate returned 0. The compiled bench executable and frontend assets were unchanged. This rerun does not extend the qualification to the packaged application or the production store.
