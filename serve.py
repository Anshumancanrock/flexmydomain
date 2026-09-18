#!/usr/bin/env python3
"""Static server for the flexmydomain frontend."""
import argparse
import http.server
import os
import posixpath
import urllib.parse

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".json": "application/json",
    }

    def translate_path(self, path):
        clean = urllib.parse.urlsplit(path).path
        clean = posixpath.normpath(urllib.parse.unquote(clean))
        full = os.path.join(ROOT, clean.lstrip("/"))
        if os.path.isdir(full):
            index = os.path.join(full, "index.html")
            if os.path.isfile(index):
                return index
        return full

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        status = args[1] if len(args) > 1 else ""
        if status not in ("200", "304"):
            print(f"{args[0]} -> {status}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--port", type=int, default=8000)
    args = ap.parse_args()
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"flexmydomain -> http://localhost:{args.port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
