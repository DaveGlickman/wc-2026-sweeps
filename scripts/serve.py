#!/usr/bin/env python3
"""Tiny static file server for local preview of public/.

Avoids http.server's CLI path (which calls os.getcwd() at import-time and is
blocked in the preview sandbox) by serving an absolute directory directly.
"""
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")
ROOT = os.path.abspath(ROOT)
PORT = 4173

handler = partial(SimpleHTTPRequestHandler, directory=ROOT)
httpd = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
print(f"Serving {ROOT} at http://127.0.0.1:{PORT}")
httpd.serve_forever()
