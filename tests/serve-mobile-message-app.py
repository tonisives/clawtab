#!/usr/bin/env python3
"""Serve a worker-exported Expo app with an isolated two-machine message fixture."""
import argparse
import base64
import functools
import http.server
import json
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--port", type=int, default=1944)
    parser.add_argument("--duration", type=int, default=1200)
    args = parser.parse_args()
    root = args.export.resolve()
    if not (root / "index.html").is_file():
        parser.error("Use the web export returned by the shared build worker")
    bootstrap = Path(__file__).with_name("mobile-message-app-fixture.js").read_text()
    document = (root / "index.html").read_text().replace("<head>", "<head><script>" + bootstrap + "</script>", 1).encode()
    assets = [(args.image, "image/png"), (args.video, "video/mp4")]

    class Handler(http.server.SimpleHTTPRequestHandler):
        def reply(self, body, mime):
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlsplit(self.path)
            if url.path.startswith("/__message_fixture/media/"):
                index = int(url.path.rsplit("/", 1)[1])
                path, mime = assets[index]
                query = parse_qs(url.query)
                offset = max(0, int(query.get("offset", ["0"])[0]))
                length = min(256 * 1024, max(0, int(query.get("length", ["0"])[0])))
                with path.open("rb") as stream:
                    size = path.stat().st_size
                    stream.seek(offset)
                    data = stream.read(length)
                self.reply(json.dumps({"mime": mime, "size": size, "offset": offset,
                    "data": base64.b64encode(data).decode(), "eof": offset + len(data) >= size}).encode(), "application/json")
            elif url.path.startswith(("/account/", "/billing/", "/subscription")):
                self.reply(b"{}", "application/json")
            elif url.path == "/" or url.path.startswith(("/notifications", "/process/", "/job/")):
                self.reply(document, "text/html; charset=utf-8")
            else:
                super().do_GET()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), functools.partial(Handler, directory=str(root)))
    timer = threading.Timer(args.duration, server.shutdown)
    timer.daemon = True
    timer.start()
    print(f"Message app fixture: http://127.0.0.1:{server.server_port}/notifications/message/launch-review?machine=mac-b", flush=True)
    try:
        server.serve_forever()
    finally:
        timer.cancel()
        server.server_close()


if __name__ == "__main__":
    main()
