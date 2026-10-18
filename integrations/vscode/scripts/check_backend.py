"""Check the extension's tool contract against this checkout's real API routes.

Run after npm run compile, using Python with fastapi, httpx and pydantic installed.
The engine is deterministic: this test makes no model or external service calls.
"""

import json
import subprocess
import sys
from pathlib import Path

EXTENSION = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXTENSION.parents[1] / "src"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from openjarvis.core.config import load_config  # noqa: E402
from openjarvis.server.routes import router  # noqa: E402


class Engine:
    def __init__(self):
        self.calls = []

    def list_models(self):
        return ["test-coder"]

    def generate(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        assert kwargs["model"] == "test-coder"
        assert any(t["function"]["name"] == "propose_edit" for t in kwargs["tools"])
        if len(self.calls) == 1:
            return {
                "content": "I will inspect the file.",
                "finish_reason": "tool_calls",
                "tool_calls": [{
                    "id": "read-1",
                    "name": "read_file",
                    "arguments": '{"path":"sample.ts"}',
                }],
            }
        assert messages[-1].tool_call_id == "read-1"
        assert messages[-2].tool_calls[0].name == "read_file"
        return {"content": "The file declares a constant.", "finish_reason": "stop"}


class ForbiddenServerAgent:
    def run(self, *args, **kwargs):
        raise AssertionError("Client tools must bypass the server agent")


def main():
    config = load_config(EXTENSION / "backend" / "vscode-local.toml")
    assert not config.analytics.enabled and config.analytics.choice_recorded
    assert not config.telemetry.enabled and not config.traces.enabled
    assert not config.agent.context_from_memory
    assert not config.skills.enabled and not config.channel.enabled
    assert config.engine.default == "ollama" and config.server.host == "127.0.0.1"
    tools = json.loads(subprocess.check_output(
        ["node", "-e", "process.stdout.write(JSON.stringify(require('./dist/agent').TOOLS))"],
        cwd=EXTENSION, text=True,
    ))
    engine = Engine()
    app = FastAPI()
    app.include_router(router)
    app.state.engine = engine
    app.state.agent = ForbiddenServerAgent()
    app.state.config = config
    with TestClient(app) as client:
        models = client.get("/v1/models")
        assert models.status_code == 200, models.text
        assert models.json()["data"][0]["id"] == "test-coder"
        messages = [
            {"role": "system", "content": "You are a coding agent."},
            {"role": "user", "content": "Read sample.ts."},
        ]
        body = {"model": "test-coder", "messages": messages, "tools": tools,
                "stream": False, "max_tokens": 4096, "temperature": 0.2}
        first = client.post("/v1/chat/completions", json=body)
        assert first.status_code == 200, first.text
        reply = first.json()["choices"][0]["message"]
        assert reply["tool_calls"][0]["function"]["name"] == "read_file"
        assert reply["tool_calls"][0]["id"] == "read-1"
        messages.extend([reply, {"role": "tool", "tool_call_id": "read-1",
                                "content": '{"content":"const answer = 42;"}'}])
        final = client.post("/v1/chat/completions", json=body)
        assert final.status_code == 200, final.text
        assert final.json()["choices"][0]["message"]["content"] == "The file declares a constant."
    assert len(engine.calls) == 2
    print("PASS: dedicated profile, model listing, client tool routing and tool-result round trip")


if __name__ == "__main__":
    main()
