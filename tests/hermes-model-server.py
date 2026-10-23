"""Deterministic OpenAI-compatible model for the opt-in Hermes integration test.

Bind only to loopback. No credentials or request bodies are logged. The only
terminal command returned by this model prints a fixed test marker.
"""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_json({"object": "list", "data": [{"id": "clawtab-test", "object": "model"}]})

    def send_json(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        messages = request.get("messages", [])
        last_user = max((i for i, row in enumerate(messages) if row.get("role") == "user"), default=-1)
        prompt = str(messages[last_user].get("content", "")) if last_user >= 0 else ""
        has_result = any(row.get("role") == "tool" for row in messages[last_user + 1:])
        message = {"role": "assistant", "content": "HERMES_TEST_REPLY"}
        if "CLAWTAB_TEST_SLOW" in prompt:
            time.sleep(5)
            message["content"] = "HERMES_SLOW_DONE"
        elif "CLAWTAB_TEST_APPROVAL" in prompt:
            if has_result:
                message["content"] = "HERMES_APPROVAL_DONE"
            else:
                message = self.tool("terminal", {"command": "printf HERMES_TOOL_OK", "timeout": 10})
        elif "CLAWTAB_TEST_CLARIFY" in prompt:
            if has_result:
                message["content"] = "HERMES_CLARIFY_DONE"
            else:
                message = self.tool("clarify", {"questions": [{"question": "Choose a test color", "choices": ["Blue", "Green"]}]})
        elif "CLAWTAB_TEST_SECOND" in prompt:
            message["content"] = "HERMES_SECOND_REPLY"
        elif "CLAWTAB_TEST_FOLLOWUP" in prompt:
            message["content"] = "HERMES_FOLLOWUP_REPLY"
        reason = "tool_calls" if "tool_calls" in message else "stop"
        result = {"id": "chatcmpl-clawtab", "object": "chat.completion", "created": int(time.time()), "model": "clawtab-test",
                  "choices": [{"index": 0, "message": message, "finish_reason": reason}],
                  "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}}
        if not request.get("stream"):
            self.send_json(result)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        delta = dict(message)
        if "tool_calls" in delta:
            delta["tool_calls"] = [dict(call, index=i) for i, call in enumerate(delta["tool_calls"])]
        chunk = {**result, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
        self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
        chunk["choices"] = [{"index": 0, "delta": {}, "finish_reason": reason}]
        self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode())
        self.wfile.flush()

    @staticmethod
    def tool(name, args):
        return {"role": "assistant", "content": None, "tool_calls": [
            {"id": "call-clawtab-test", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18341)
    options = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", options.port), Handler)
    print("Hermes test model listening on 127.0.0.1:" + str(server.server_port), flush=True)
    server.serve_forever()
