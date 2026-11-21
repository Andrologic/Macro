# AgSDL worker WKWebView component bench

This bench runs the built frontend's `validateDocument` export and its real module worker inside a nonpersistent macOS WKWebView. It serves the selected build and the CSP from the supplied Tauri configuration over loopback. The built compiler chunk's minified export name is build-specific; a missing export is reported as a failure. The bench does not exercise the Tauri application, its packaged URL scheme, or the production store.

Coordinate the native compiler slot before building. From the repository root, with a dedicated output directory:

```sh
swiftc dev/qa/agsdl-webview/bench.swift -o /path/to/qa-output/wk-bench
python3 -B dev/qa/agsdl-webview/server.py /path/to/built/dist /path/to/tauri.conf.json
```

The server prints the loopback port and chosen asset names. In another terminal, using that port:

```sh
/path/to/qa-output/wk-bench http://127.0.0.1:PORT/normal/ > /path/to/qa-output/normal.json
/path/to/qa-output/wk-bench http://127.0.0.1:PORT/blocked/ > /path/to/qa-output/blocked.json
/path/to/qa-output/wk-bench http://127.0.0.1:PORT/missing/ > /path/to/qa-output/missing.json
python3 dev/qa/agsdl-webview/check.py /path/to/qa-output/normal.json /path/to/qa-output/blocked.json /path/to/qa-output/missing.json
```

The process exit code detects navigation and timeout failures. Always run `check.py`: test assertion failures are recorded in the JSON report. Stop the loopback server after the run. The blocked mode adds `worker-src 'none'` to the source CSP; missing mode returns 404 for the worker. These are test-only failures. The revision check uses a test-level version guard, not `useAgsdlStore`; qualifying the actual store and packaged Tauri CSP remains separate work.

Both failure modes must reject validation and terminate their workers. Run the report-gate regression with `python3 -B -m unittest discover -s dev/qa/agsdl-webview -p test_check.py`; it checks that a failure report with `terminated: false` is refused in each mode.
