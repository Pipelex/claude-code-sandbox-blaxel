# Claude Code Sandbox (for Blaxel)

A minimal sandbox image for running the **Claude Agent SDK** inside a
**Blaxel sandbox** and exposing it as an HTTP/SSE service. Drop it behind any
chat UI or agent, point it at a workspace, and you have an editor-aware
Claude agent that streams its work back to the caller — running in a real
isolated VM with full filesystem and process access via Blaxel's
`sandbox-api`.

The image is deliberately generic. It ships with no slash-command plugins.
You bring your own — see `Customizing` below.

## Architecture

Two processes run inside the container:

- **`sandbox-api`** (port 8080, root) — Blaxel's sandbox runtime. Provides
  filesystem and process APIs that Blaxel SDK clients use to inspect and
  manipulate the container.
- **`server.mjs`** (port 4100, non-root `agent` user) — Claude Agent SDK
  wrapper. Owns the long-lived `query()` iterator, streams SDK events as SSE,
  syncs the workspace before each turn, snapshots it after.

Only port 4100 is exposed publicly via Blaxel routing. `sandbox-api` is for
Blaxel-internal use.

## Features

### Editor-synced workspace

- Caller sends the current set of files with every `/chat` request.
- The server **wipes and rewrites** `WORKSPACE_DIR` so the agent's view always
  matches the caller exactly — no drift between agent edits and caller edits.
- After the agent finishes a turn, the server emits a `files` SSE event with
  a snapshot of the workspace so the caller can re-hydrate authoritatively.
- Supports nested directories. Path-traversal attempts (`..`, absolute paths)
  are rejected.

### Streaming over Server-Sent Events

- `/chat` responds with `text/event-stream` and forwards every SDK message
  (`message`, `files`, `done`, `error`).
- 15-second keepalive comments keep proxies and load balancers from killing
  idle streams.
- Multiple SSE clients can attach to the same logical session.

### Resumable sessions

- Sessions are keyed by a caller-supplied `sessionId` (project id, doc id,
  whatever you choose).
- The SDK session id is captured from the `init` event and used to `resume:`
  when a new message arrives after the previous query loop ended, so
  multi-turn conversations keep their full history.
- Idle sessions (no SSE clients, no activity for `SESSION_IDLE_MS`) are
  reaped automatically — the session map does not grow forever.

### Plugin discovery

- Any plugins installed at image build time are discovered at runtime by
  reading `installed_plugins.json` and remapping `/root/...` paths to
  `/home/agent/...` (so build-as-root + run-as-agent works out of the box).
- Falls back to scanning the plugin cache directory if the manifest is absent.
- No plugins are installed in this template — see `Customizing`.

### Bounded resource use

- Request bodies are capped at `MAX_BODY_BYTES` (default 10 MiB).
  Oversized requests are rejected with `413` before they hit memory.
- Workspace snapshots are bounded by `SNAPSHOT_MAX_FILES` and
  `SNAPSHOT_MAX_FILE_BYTES` so a giant artefact in the workspace cannot
  blow up the SSE payload.
- Agent runs are capped at `MAX_TURNS` turns.

### Container lifecycle

- Server runs as a non-root `agent` user under `gosu`.
- Handles `SIGTERM` / `SIGINT`: closes sessions, flushes SSE clients, exits
  cleanly with a 5s safety timeout.

## API

### `POST /chat`

```jsonc
{
  "content": "string or Anthropic content blocks",
  "sessionId": "stable id chosen by the caller",
  "files": [
    { "path": "src/main.ts", "content": "…" }
  ]
}
```

For images, PDFs, or any other multimodal input, pass an array of standard
Anthropic content blocks as `content` — the SDK supports image and document
blocks natively. The sandbox does not invent a parallel attachments API.

Response: `text/event-stream`. Event types:

- `session` — `{ sessionId }`. First event, echoes the resolved session id.
- `message` — every SDK message (assistant text, tool calls, tool results,
  partial deltas, etc.). To detect "turn finished," look for a `message`
  with `type: "result"`.
- `files` — `{ files: [{ path, content }] }`. Workspace snapshot, emitted
  on each turn just before the `message` carrying `type: "result"`.
- `done` — `{ ok: true }`. Emitted only when the SDK iterator closes
  entirely (idle session reaped, server shutting down). Rare; not fired
  after every turn.
- `error` — `{ error }`. Server-side error.

### `POST /respond`

```jsonc
{ "sessionId": "...", "content": "follow-up message" }
```

Pushes a follow-up message into an existing session. Use this when the SSE
stream for `/chat` is still open and you want to add a new user turn without
opening another stream.

### `GET /health`

Returns `{ status, sessions, plugins }`.

## How to run

### Locally with Docker

Set your API key:

```sh
cp .env.example .env
# then open .env and fill in ANTHROPIC_API_KEY
```

Build the image:

```sh
docker build --platform linux/amd64 -t claude-sandbox .
```

Run it:

```sh
docker run --rm -p 4100:4100 --env-file .env claude-sandbox
```

In another terminal, send a request:

```sh
curl -N -X POST http://localhost:4100/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "demo",
    "content": "Create hello.txt with the word hi inside.",
    "files": []
  }'
```

You should see `session`, a stream of `message` events, a `files`
snapshot, and finally a `message` with `type: "result"` — that's the
end-of-turn marker. The SSE connection then stays open; close it
client-side when you're done.

### Deploy to Blaxel

Requires the [Blaxel CLI](https://docs.blaxel.ai/Get-started) (`bl`) and a
configured workspace.

```sh
bl deploy -e .env
```

This builds the image on Blaxel's build host, pushes it to your Blaxel
workspace, and registers the `claude-sandbox` sandbox image. From there,
any Blaxel agent in the same workspace can spawn instances of it via
`SandboxInstance.create({ image: "claude-sandbox", ... })`.

## Configuration

| Env var                   | Default                                              | Purpose                                          |
|---------------------------|------------------------------------------------------|--------------------------------------------------|
| `ANTHROPIC_API_KEY`       | —                                                    | Required. SDK auth.                              |
| `ANTHROPIC_MODEL`         | `claude-sonnet-4-6`                                  | Model id used by the agent.                      |
| `AGENT_PORT`              | `4100`                                               | HTTP port (matches `blaxel.toml`).               |
| `WORKSPACE_DIR`           | `/workspace`                                         | Mirrored workspace root.                         |
| `MAX_BODY_BYTES`          | `10485760` (10 MiB)                                  | Request body cap.                                |
| `SESSION_IDLE_MS`         | `1800000` (30 min)                                   | Idle session reap threshold.                     |
| `MAX_TURNS`               | `100`                                                | SDK turn cap per query.                          |
| `SNAPSHOT_MAX_FILES`      | `200`                                                | Files included in end-of-turn snapshot.          |
| `SNAPSHOT_MAX_FILE_BYTES` | `1048576`                                            | Per-file size limit for snapshots.               |
| `SYSTEM_PROMPT_APPEND`    | empty                                                | Extra text appended to the system prompt.        |
| `PLUGINS_INSTALLED_PATH`  | `/home/agent/.claude/plugins/installed_plugins.json` | Manifest used for plugin discovery.              |
| `PLUGINS_CACHE_DIR`       | `/home/agent/.claude/plugins/cache`                  | Fallback plugin scan directory.                  |

`ANTHROPIC_API_KEY` is never baked into the image — it is injected at
runtime via `--env-file .env` (local Docker) or by Blaxel from your `.env`
when you run `bl deploy -e .env`. `ANTHROPIC_MODEL` has a default set in
the Dockerfile (`ENV ANTHROPIC_MODEL=claude-sonnet-4-6`); override it the
same way. Per-instance vars can be injected at sandbox creation time via
the Blaxel API.

## Customizing

The sandbox is meant to be forked. Common knobs:

- **Persona / scope rules** — edit `CLAUDE.md`. Copied into
  `/home/agent/.claude/CLAUDE.md` at build time and loaded by the SDK as
  project-level instructions.
- **Extra system prompt** — set `SYSTEM_PROMPT_APPEND` at runtime; appended
  to the Claude Code preset without rebuilding the image. Useful for
  per-instance personas injected by the Blaxel API.
- **Slash-command plugins** — add `claude plugin install ...` lines to the
  `Dockerfile`. `src/plugins.mjs` discovers them at runtime and registers
  them with the SDK automatically. Examples:
  - [MTHDS](https://mthds.ai) — `/mthds-build`, `/mthds-edit`, ...
  - [gstack](https://github.com/garrytan/gstack) — `/qa`, `/ship`, `/review`, ...

## Project layout

```
.
├── Dockerfile          # Node 22 + sandbox-api + Claude Code, no plugins
├── LICENSE             # MIT
├── Makefile            # contributor shortcuts (lint, build, deploy)
├── README.md
├── CLAUDE.md           # generic project-level Claude instructions
├── blaxel.toml         # Blaxel sandbox manifest
├── entrypoint.sh       # boots sandbox-api, then the agent server
├── package.json        # @anthropic-ai/claude-agent-sdk
├── server.mjs          # entrypoint: HTTP server boot + signal handling
├── src/
│   ├── config.mjs      # env-driven config + log()
│   ├── plugins.mjs     # Claude Agent SDK plugin discovery
│   ├── workspace.mjs   # editor-synced workspace ops (sync, snapshot, path safety)
│   ├── session.mjs     # MessageQueue, AgentSession, sessions Map, idle reaper
│   └── routes.mjs      # HTTP/SSE handlers for /chat, /respond, /health
├── docs/
│   ├── architecture.md     # module breakdown, request flow, dependency graph
│   ├── sdk-integration.md  # what we add on top of @anthropic-ai/claude-agent-sdk
│   └── workspace-sync.md   # the editor-synced workspace pattern, in detail
├── .env.example
└── .gitignore
```

## SSE event reference

A consumer reading the `/chat` stream needs to handle two layers:

1. **Server SSE event types** (the `event:` line) — set by this server.
2. **SDK message types** (the `type:` field inside `event: message`'s JSON) —
   passed through verbatim from the Claude Agent SDK.

For a typical chat UI:

| Where it comes from               | What it is                                  | What your UI does                                           |
|-----------------------------------|---------------------------------------------|-------------------------------------------------------------|
| `event: session`                  | sessionId echo                              | Store it; reuse on follow-ups.                              |
| `event: message` `type: system`   | Init metadata (model, tools, plugins)       | Optional "connected" indicator; otherwise ignore.           |
| `event: message` `type: stream_event` `delta: text_delta` | Live token of assistant text | **Append to current chat bubble** for live streaming.       |
| `event: message` `type: assistant` (text block)      | Final assistant text          | If you stream via `text_delta`, ignore. Otherwise render.   |
| `event: message` `type: assistant` (tool_use block)  | Claude is calling a tool      | Render a tool-call widget.                                  |
| `event: message` `type: user` (tool_result)          | Tool output coming back       | Render inline / collapsed under the tool widget.            |
| `event: files`                    | End-of-turn workspace snapshot              | **Replace editor state** with `files`.                      |
| `event: message` `type: result`   | Turn finished, with cost/usage              | Mark chat as done; optionally show cost.                    |
| `event: done`                     | SDK iterator closed (rare)                  | Close the connection.                                       |
| `event: error`                    | Server error                                | Show error toast.                                           |
| `: keepalive`                     | Comment line every 15s                      | Ignore.                                                     |

For a working SSE parser and a Fastify agent that proxies this stream, see
`template-chatbot-claudecode`.

## Authentication

This server has no auth of its own — Blaxel gates inbound traffic at the
platform layer (private previews, workspace tokens). Do not run this image
outside a Blaxel sandbox without putting an authenticating proxy in front of
it.

## License

MIT — see `LICENSE`.
