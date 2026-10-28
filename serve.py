#!/usr/bin/env python3
# Dev server with no-store headers — plain http.server lets Chrome cache ES
# modules heuristically, which serves stale code after edits.
import http.server


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("", 8000), NoCacheHandler).serve_forever()
