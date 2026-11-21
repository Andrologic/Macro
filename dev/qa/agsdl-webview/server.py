#!/usr/bin/env python3
"""Serve immutable built assets on loopback with the source CSP, for WKWebView QA."""
import argparse, http.server, json, pathlib, sys

parser = argparse.ArgumentParser()
parser.add_argument('dist', type=pathlib.Path)
parser.add_argument('config', type=pathlib.Path)
parser.add_argument('--port', type=int, default=0)
args = parser.parse_args()
dist = args.dist.resolve(strict=True)
csp = json.loads(args.config.read_text())['app']['security']['csp']
workers = list((dist / 'assets').glob('reader030.worker-*.js'))
compilers = [p for p in (dist / 'assets').glob('compiler-*.js') if workers and workers[0].name in p.read_text()]
if len(workers) != 1 or len(compilers) != 1:
    sys.exit('Expected exactly one worker and its compiler chunk')
qa = pathlib.Path(__file__).resolve().parent
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        mode, _, path = self.path.partition('?')[0].lstrip('/').partition('/')
        if mode not in ('normal', 'blocked', 'missing'):
            self.send_error(404); return
        if path == '':
            body = b'<!doctype html><meta charset="utf-8"><script type="module" src="test.js"></script>'
            mime = 'text/html; charset=utf-8'
        elif path == 'test.js':
            body = (qa / 'test.js').read_bytes(); mime = 'text/javascript'
        elif path == 'config.js':
            body = ('export const compiler=' + json.dumps('./assets/' + compilers[0].name) + ';').encode(); mime = 'text/javascript'
        elif path.startswith('assets/'):
            file = (dist / path).resolve()
            if not file.is_relative_to(dist / 'assets') or not file.is_file() or (mode == 'missing' and file == workers[0]):
                self.send_error(404); return
            body = file.read_bytes(); mime = 'text/javascript' if file.suffix == '.js' else 'application/octet-stream'
        else:
            self.send_error(404); return
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Security-Policy', csp + ("; worker-src 'none'" if mode == 'blocked' else ''))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, fmt, *values):
        print(fmt % values, file=sys.stderr, flush=True)
with http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler) as server:
    print(json.dumps({'port': server.server_port, 'worker': workers[0].name, 'compiler': compilers[0].name, 'csp': csp}), flush=True)
    server.serve_forever()
