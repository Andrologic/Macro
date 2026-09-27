"""Local protocol fixture, launched with separate arguments by Rust tests."""
import json
import pathlib
import sys
import time

mode = sys.argv[1]

def send(message):
    body = json.dumps({"jsonrpc": "2.0", **message}).encode()
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    sys.stdout.buffer.flush()

while True:
    headers = {}
    while line := sys.stdin.buffer.readline():
        if line == b"\r\n":
            break
        name, value = line.decode().split(":", 1)
        headers[name.lower()] = value.strip()
    if not headers:
        break
    message = json.loads(sys.stdin.buffer.read(int(headers["content-length"])))
    method = message.get("method")
    if method == "initialize":
        if mode == "startup_timeout":
            time.sleep(3)
        if mode == "startup_failure":
            send({"id": message["id"], "error": {"code": -32603, "message": "fixture failure"}})
        else:
            send({"id": message["id"], "result": {"capabilities": {"textDocumentSync": 1}}})
    elif method == "textDocument/didOpen":
        document = message["params"]["textDocument"]
        pathlib.Path("lsp-opened").write_text(document["uri"])
        if mode == "exit":
            sys.exit(2)
        if mode == "pending":
            continue
        if mode == "delayed":
            time.sleep(0.15)
        diagnostic = {"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}}, "message": "synthetic error", "code": 2322, "severity": 1}
        items = [diagnostic] if "bad" in document["text"] else []
        if mode == "many":
            diagnostic["message"] = "x" * 3000
            diagnostic["data"] = "private payload"
            items = [diagnostic] * 50
        params = {"uri": document["uri"], "version": 0 if mode == "stale" else 1, "diagnostics": items}
        if mode == "wrong_uri":
            params["uri"] += ".other"
        send({"method": "textDocument/publishDiagnostics", "params": params})
        if mode == "replacement":
            time.sleep(0.05)
            params["diagnostics"] = []
            send({"method": "textDocument/publishDiagnostics", "params": params})
        if mode == "apply_edit":
            send({"id": "server-edit", "method": "workspace/applyEdit", "params": {"edit": {"changes": {document["uri"]: []}}}})
    elif message.get("id") == "server-edit":
        pathlib.Path("apply-edit-response.json").write_text(json.dumps(message))
    elif method == "shutdown":
        send({"id": message["id"], "result": None})
    elif method == "exit":
        break
