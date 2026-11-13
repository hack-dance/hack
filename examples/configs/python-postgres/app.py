import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # DATABASE_URL comes from the environment Hack injects.
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            database = conn.execute("select current_database()").fetchone()[0]
        body = json.dumps({"ok": True, "database": database}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)


ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
