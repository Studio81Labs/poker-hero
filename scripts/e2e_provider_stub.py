#!/usr/bin/env python3
from argparse import ArgumentParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Lock


class ProviderState:
    def __init__(self) -> None:
        self._fail_next = False
        self._lock = Lock()

    def arm_failure(self) -> None:
        with self._lock:
            self._fail_next = True

    def consume_failure(self) -> bool:
        with self._lock:
            should_fail = self._fail_next
            self._fail_next = False
            return should_fail


def build_handler(state: ProviderState) -> type[BaseHTTPRequestHandler]:
    class ProviderHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/health":
                self.send_error(404)
                return
            self._send_json(200, {"status": "ok"})

        def do_POST(self) -> None:
            if self.path == "/control/fail-next":
                state.arm_failure()
                self._send_json(200, {"armed": True})
                return
            if self.path != "/recommend":
                self.send_error(404)
                return

            content_length = int(self.headers.get("Content-Length", "0"))
            self.rfile.read(content_length)
            if state.consume_failure():
                self._send_json(503, {"detail": "Temporary solver outage"})
                return
            self._send_json(
                200,
                {
                    "action": "call",
                    "sizing": None,
                    "confidence": 0.78,
                    "explanation": "E2E solver compared the available actions.",
                    "raw": {
                        "provider": "external_solver",
                        "engine": "e2e_provider_stub",
                    },
                },
            )

        def log_message(self, format: str, *args: object) -> None:
            return

        def _send_json(self, status: int, payload: object) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return ProviderHandler


def main() -> None:
    parser = ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8011)
    parser.add_argument("--ready-file", type=Path, required=True)
    args = parser.parse_args()

    server = ThreadingHTTPServer(
        (args.host, args.port),
        build_handler(ProviderState()),
    )
    args.ready_file.touch()
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
