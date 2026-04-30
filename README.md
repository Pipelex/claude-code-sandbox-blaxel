# Claude Code Sandbox Template (for Blaxel)

A minimal, opinionated template for running the **Claude Agent SDK** inside a
**Blaxel sandbox** and exposing it as an HTTP/SSE service. Drop it behind any
chat UI, point it at a workspace, and you have an editor-aware Claude agent
that streams its work back to the browser — running in a real isolated VM
with full filesystem and process access via Blaxel's `sandbox-api`.

The image ships with two Claude Code toolkits pre-installed and ready to use:

- **[gstack](https://github.com/garrytan/gstack)** — Garry Tan's opinionated
  Claude Code workflow toolkit. 23+ slash commands covering planning,
  review, QA, security, and shipping (`/office-hours`, `/plan-ceo-review`,
  `/review`, `/qa`, `/ship`, `/cso`, ...). MIT licensed.
- **[MTHDS](https://mthds.ai)** — Slash commands for building, editing, and
  validating MTHDS method bundles (`/mthds-build`, `/mthds-edit`,
  `/mthds-check`, `/mthds-fix`, ...).

The server, system prompt, and request contracts are otherwise fully generic —
swap or extend the toolkits and use it for any Claude Code use case.

## TL;DR

```sh
cp .env.example .env && echo "ANTHROPIC_API_KEY=sk-..." >> .env
make build && make run
```

```sh
curl -N -X POST http://localhost:4100/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "demo",
    "content": "Create hello.txt with the word hi inside.",
    "files": []
  }'
```

You'll get a Server-Sent Events stream containing every assistant message,
tool call, tool result, plus a workspace snapshot at end-of-turn.

To wire it into your own UI, jump to **[Consuming the stream from a UI](#consuming-the-stream-from-a-ui)**.

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
  matches the editor exactly — no drift between agent edits and user edits.
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

### Generic attachments

- Messages can carry an `attachments: [{ name, uri }]` list.
- The server appends a structured reference block to the prompt; the URIs are
  opaque handles for the agent to pass through, never fetched.
- Use this for blob storage references, signed URLs, internal handles — any
  caller-defined scheme.

### Plugin discovery

- Plugins installed at image build time are discovered at runtime by reading
  `installed_plugins.json` and remapping `/root/...` paths to `/home/agent/...`
  (so build-as-root + run-as-agent works out of the box).
- Falls back to scanning the plugin cache directory if the manifest is absent.
- Add plugins by editing the `claude plugin install ...` lines in the
  `Dockerfile`.

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
  ],
  "attachments": [
    { "name": "spec.pdf", "uri": "your-scheme://blob/abc" }
  ]
}
```

Response: `text/event-stream`. Event types:

- `session` — `{ sessionId }`. First event, echoes the resolved session id.
- `message` — every SDK message (assistant text, tool calls, tool results,
  partial deltas, etc.).
- `files` — `{ files: [{ path, content }] }`. Workspace snapshot, emitted
  immediately before `done`.
- `done` — `{ ok: true }`. Turn finished.
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

## Consuming the stream from a UI

The `/chat` response is a **Server-Sent Events** stream. Two layers:

1. **Server SSE event types** (the `event:` line) — set by this server.
2. **SDK message types** (the `type:` field inside `event: message`'s JSON) —
   passed through verbatim from the Claude Agent SDK.

### What to render, what to ignore

For a typical chat UI with a code editor pane, you only need to act on a small
subset:

| Where it comes from               | What it is                                  | What your UI does                                           |
|-----------------------------------|---------------------------------------------|-------------------------------------------------------------|
| `event: session`                  | sessionId echo                              | Store it; reuse on follow-ups.                              |
| `event: message` `type: system`   | Init metadata (model, tools, plugins)       | Optional "connected" indicator; otherwise ignore.           |
| `event: message` `type: stream_event` `delta: text_delta` | Live token of assistant text | **Append to current chat bubble** for live streaming.       |
| `event: message` `type: stream_event` `delta: input_json_delta` | Live token of tool-call args | Ignore (or show a "preparing tool…" spinner).               |
| `event: message` `type: assistant` (text block)      | Final assistant text          | If you stream via `text_delta`, ignore. Otherwise render.   |
| `event: message` `type: assistant` (tool_use block)  | Claude is calling a tool      | Render a tool-call widget (e.g. "Reading main.py").         |
| `event: message` `type: user` (tool_result)          | Tool output coming back       | Render inline / collapsed under the tool widget.            |
| `event: files`                    | End-of-turn workspace snapshot              | **Replace editor state** with `files`.                      |
| `event: message` `type: result`   | Turn finished, with cost/usage              | Mark chat as done; optionally show cost.                    |
| `event: done`                     | SDK iterator closed (rare)                  | Close the connection.                                       |
| `event: error`                    | Server error                                | Show error toast.                                           |
| `: keepalive`                     | Comment line every 15s                      | Ignore (the parser below skips it).                         |

Two simplifying choices most apps make:

- Pick **one** of `text_delta` (live tokens) or consolidated `assistant`
  (final block) — not both, or you double-render.
- Skip `input_json_delta` entirely. It's high-volume and watching JSON arrive
  byte-by-byte is not a feature.

### Drop-in TypeScript client

```ts
// sandbox-client.ts — copy-paste, no dependencies.

export type ChatRequest = {
  sessionId: string;
  content: string | unknown[];
  files?: { path: string; content: string }[];
  attachments?: { name: string; uri: string }[];
};

export type WorkspaceFile = { path: string; content: string };

export type Handlers = {
  /** Live token from the assistant. Append to the current chat bubble. */
  onText?: (chunk: string) => void;
  /** Claude is calling a tool. Show a widget. */
  onToolUse?: (tool: { id: string; name: string; input: unknown }) => void;
  /** Tool finished. Show its output. */
  onToolResult?: (result: { toolUseId: string; content: unknown }) => void;
  /** End-of-turn workspace snapshot. Replace your editor state. */
  onFiles?: (files: WorkspaceFile[]) => void;
  /** Turn finished. Optionally show cost/duration. */
  onResult?: (result: {
    text: string;
    durationMs: number;
    costUsd: number;
    numTurns: number;
  }) => void;
  onError?: (message: string) => void;
};

export async function chat(
  baseUrl: string,
  body: ChatRequest,
  handlers: Handlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;

    // SSE frames are separated by a blank line.
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleFrame(frame, handlers);
    }
  }
}

function handleFrame(frame: string, h: Handlers) {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;             // keepalive comment
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!data) return;

  let payload: any;
  try { payload = JSON.parse(data); } catch { return; }

  switch (event) {
    case "session": return;
    case "files":   h.onFiles?.(payload.files); return;
    case "done":    return;
    case "error":   h.onError?.(payload.error); return;
    case "message": handleSDKMessage(payload, h); return;
  }
}

function handleSDKMessage(msg: any, h: Handlers) {
  switch (msg.type) {
    case "stream_event": {
      const ev = msg.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        h.onText?.(ev.delta.text);
      }
      return;
    }
    case "assistant": {
      // Use this branch if you DON'T stream via text_delta.
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_use") {
          h.onToolUse?.({ id: block.id, name: block.name, input: block.input });
        }
      }
      return;
    }
    case "user": {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_result") {
          h.onToolResult?.({
            toolUseId: block.tool_use_id,
            content: block.content,
          });
        }
      }
      return;
    }
    case "result": {
      h.onResult?.({
        text: msg.result,
        durationMs: msg.duration_ms,
        costUsd: msg.total_cost_usd,
        numTurns: msg.num_turns,
      });
      return;
    }
  }
}
```

### Minimal usage

```ts
import { chat } from "./sandbox-client";

await chat(
  "http://localhost:4100",
  {
    sessionId: "demo",
    content: "Add a docstring to main.py",
    files: editor.getAllFiles(),          // [{ path, content }, ...]
  },
  {
    onText:       (chunk)  => chatBubble.append(chunk),
    onToolUse:    (tool)   => chatBubble.showToolWidget(tool),
    onToolResult: (result) => chatBubble.showToolResult(result),
    onFiles:      (files)  => editor.replaceAll(files),
    onResult:     (r)      => chatBubble.markDone(r),
    onError:      (msg)    => toast.error(msg),
  },
);
```

### Sending follow-ups in the same session

Two patterns, both valid:

- **New `/chat` request** with the same `sessionId` — server resumes the SDK
  session, keeps history. Easiest pattern.
- **`POST /respond`** while a `/chat` SSE stream is still open — pushes a
  message into the live session. The reply streams back on the existing
  connection. Use this if you want to keep one long-lived SSE per session.

### Common pitfalls

- **Don't use `EventSource`.** It only does GET. The body for `/chat` is JSON
  in a POST, so use `fetch` + `ReadableStream` (the parser above).
- **Pass `signal` to `fetch`** if you want to cancel a stream when the user
  navigates away. Without it, the server keeps streaming until the SDK
  finishes.
- **`event: done` is rare.** It only fires when the SDK's iterator truly
  closes (idle session reaped, server shutting down). For "turn finished"
  use `result`, not `done`.
- **The workspace snapshot is the source of truth at end-of-turn.** Don't
  try to track agent edits from `tool_result` events — just diff the
  snapshot against your last-known state. The server already coalesced
  everything for you.

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
| `SNAPSHOT_MAX_FILE_BYTES` | `1048576` (1 MiB)                                    | Per-file size limit for snapshots.               |
| `SYSTEM_PROMPT_APPEND`    | empty                                                | Extra text appended to the system prompt.        |
| `PLUGINS_INSTALLED_PATH`  | `/home/agent/.claude/plugins/installed_plugins.json` | Manifest used for plugin discovery.              |
| `PLUGINS_CACHE_DIR`       | `/home/agent/.claude/plugins/cache`                  | Fallback plugin scan directory.                  |

`ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are baked at build time via
`bl deploy -e .env`. Per-instance vars can be injected at sandbox creation
time via the Blaxel API.

## Quick start

### Local

```sh
cp .env.example .env
# fill in ANTHROPIC_API_KEY

make build
make run
```

Then:

```sh
curl -N -X POST http://localhost:4100/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "demo",
    "content": "Create a hello.txt with the word hi inside.",
    "files": []
  }'
```

You should see `session`, a stream of `message` events, a `files` snapshot,
then `done`.

### Deploy to Blaxel

```sh
make deploy
```

This runs `bl deploy -e .env`, which builds the image, pushes it to your
Blaxel workspace, and updates the `claude-sandbox` sandbox definition.
Existing running instances are unaffected until they restart; new instances
use the updated image.

To spin up a throwaway test instance from the deployed image, see the
example `bl apply` invocation pattern in your Blaxel docs.

## Customizing

This is what makes the template *generic* — the Claude Code wrapper is
deliberately use-case-agnostic. Adapt it to your domain by changing:

- **Persona / scope rules** — edit `CLAUDE.md`. Copied into
  `/home/agent/.claude/CLAUDE.md` at build time and loaded by the SDK as
  project-level instructions.
- **Extra system prompt** — set `SYSTEM_PROMPT_APPEND` at runtime; appended
  to the Claude Code preset without rebuilding the image. Useful for
  per-instance personas injected by the Blaxel API.
- **Toolkits** — edit the relevant lines in `Dockerfile`:
  - `claude plugin install ...` for Claude Code marketplace plugins (MTHDS
    is included).
  - The `git clone .../gstack && ./setup -q` block for skill-based toolkits
    (gstack is included).
  - Remove either, replace with your own, or add more.

## Project layout

```
.
├── Dockerfile          # Node 22 + sandbox-api + Claude Code + plugins (gstack, MTHDS)
├── LICENSE             # MIT
├── Makefile            # build / run / deploy
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
