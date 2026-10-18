# OpenJarvis Coding Agent for VS Code

A personal coding agent backed by an OpenJarvis server. It explores a workspace,
reads and searches code, explains diagnostics, proposes focused edits and can
request terminal commands. Each edit opens a diff for review. Each command asks
for approval. No Copilot subscription is required.

This is an initial developer preview. It does not imply approval for use with
company or client systems and data.

## Install

1. In VS Code 1.95 or later, run **Extensions: Install from VSIX** and choose
   `openjarvis-coding-agent-0.1.0.vsix`.
2. Open a trusted project folder. Click the OpenJarvis icon in the activity bar.
3. Start the OpenJarvis backend below. Click **Choose model** and select an
   installed model that supports function/tool calls.
4. Ask a task such as “Explore this project and explain its structure.”

The default endpoint is `http://127.0.0.1:8000/v1`. Use **OpenJarvis: Configure
Connection** for another endpoint. If the backend uses `OPENJARVIS_API_KEY`, run
**OpenJarvis: Set Server API Key**. The key is kept in VS Code SecretStorage,
scoped to that exact endpoint; it is not written to settings or shown to the model.

## Start a dedicated local backend (Windows PowerShell)

From your OpenJarvis checkout, after installing its prerequisites:

```powershell
uv sync --extra server
# Install a local model with tool-calling support, if it is not already present.
ollama pull qwen3.5:4b

# Use a dedicated home so this server does not reuse your personal memory,
# agents, connectors or stored credentials. Leave your normal configuration intact.
$env:OPENJARVIS_HOME = Join-Path $env:LOCALAPPDATA 'OpenJarvis-VSCode'
$env:OPENJARVIS_CONFIG = (Resolve-Path '.\integrations\vscode\backend\vscode-local.toml').Path
uv run jarvis serve --engine ollama --host 127.0.0.1 --port 8000
```

On macOS/Linux, set `OPENJARVIS_HOME` to a dedicated directory and
`OPENJARVIS_CONFIG` to the absolute path of `backend/vscode-local.toml`, then run
the same `uv run jarvis serve` command. Model download and dependency installation
need internet access. Run the dedicated backend without cloud-provider credentials.
The sample model is a starting point; coding quality and latency depend on your
chosen model and hardware. A reachable model is not necessarily a capable coding model.

The profile disables external analytics, local inference telemetry, traces,
automatic memory, skills, scheduled agents and connector channels. The extension
does not modify a running backend's configuration. It always supplies its own tool
definitions, selecting OpenJarvis's raw function-calling API; tool execution stays
in VS Code. It does not use the server's autonomous shell agent.

## Working with the agent

- **Editor context** attaches the current selection, or the whole active file when
  nothing is selected. Attachments are visible and removable before sending.
- Workspace tools read/search allowed files without separate prompts once you send
  a task. The activity feed shows the tool and file being accessed.
- **Edits:** inspect the original/proposed diff, then choose **Apply and Save** or
  **Decline** in the notification. The notification is non-modal so you can scroll
  the diff. Applying also saves existing unsaved content in that file. VS Code undo
  remains available. Save-time formatters may change the final text.
- A file that changes during review must be read and proposed again. New files are
  supported; delete and rename operations are not included in this version.
- **Terminal commands** are disabled initially. Enable the checkbox to allow the
  agent to request them. Review the exact command, reason and working directory.
  Commands run as VS Code tasks with a two-minute limit. They have the same system
  and network access as your normal terminal, not a sandbox. Save dirty files first.
- The model receives a command's exit code, not its terminal output. You can paste
  relevant output into chat when needed; inspect it for secrets before sending.
- **Stop** cancels the pending HTTP request and requests termination of an approved
  running task. It does not undo completed changes or guarantee termination of
  detached child processes. Cancelling an HTTP request may not stop backend inference.
- **New chat** clears in-memory conversation context. This extension does not persist
  chat transcripts. Backend storage and retention are separate.

## File and connection boundaries

Each chat is scoped to one chosen workspace root. Files outside it, symlinks,
hard links, common credential filenames, `.git`, dependencies and build folders are
blocked. Root and nested `.gitignore` files and a root `.openjarvisignore` are
respected. Ignore handling is conservative: a parent exclusion cannot be reopened
by a child rule. Use `.openjarvisignore` for additional private paths, for example:

```gitignore
client-data/
private-config/
**/*.production.json
```

Read/edit size is limited to 64 KB per file; attachments to 20,000 characters.
Text searches scan at most 1,000 allowed files and return at most 50 matching lines.
Directory traversal is bounded to 5,000 entries. Context is bounded by characters
rather than model tokenization, so small-context models may require smaller tasks.
These controls do not detect every secret embedded in otherwise ordinary source code.

The extension contains no analytics SDK, leaderboard or third-party network client.
Its only application HTTP calls are `/v1/models` and `/v1/chat/completions` on the
configured server. Redirects are refused. Remote endpoints require HTTPS and the
user-level `openjarvis.allowRemoteServer` setting; repository settings cannot change
the endpoint, model, credentials or command permission.

Code and conversation sent to the server may leave that machine if its models,
plugins or configuration use external services. A loopback URL alone does not prove
offline processing. The local profile is a configuration starting point, not an
enterprise security certification. Review the backend and verify network behaviour
before using sensitive data.

In WSL, SSH, Dev Containers or Codespaces, this workspace extension runs on the
remote extension host. `127.0.0.1` refers to that host, not necessarily your laptop.
This version does not run as a browser-only extension on vscode.dev.

## Develop and package

```sh
cd integrations/vscode
npm ci
npm test
python scripts/check_backend.py  # Requires fastapi, httpx and pydantic in this Python environment
npm run test:host       # On Linux, use xvfb-run -a npm run test:host
npm run package
```

The VSIX bundles its runtime code; Python and models remain in the separate backend.
For debugging, open `integrations/vscode` as a VS Code folder and choose the
included **Run OpenJarvis Agent** launch configuration. It bundles the extension
before opening an Extension Development Host.
Tests include a mock OpenJarvis HTTP server, tool-loop behaviour, cancellation,
response validation, filesystem boundaries, a contract check against OpenJarvis's
actual API routes with a deterministic engine, and a real VS Code extension-host
smoke test. They do not measure a real language model's coding ability.

## Limits of this preview

Responses arrive after each model step; token-by-token streaming and inline
completions are not implemented. There is no background indexing, repository-wide
automatic rewriting, automatic command execution or Marketplace publication.
Use the supplied VSIX for evaluation and keep changes under source control.
