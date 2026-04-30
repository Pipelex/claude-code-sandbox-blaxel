# Architecture

This document describes how the sandbox server is organized — what each
module does, how data flows through them, and where to look when you want
to extend something.

For *why* the SDK is integrated the way it is, see
[`sdk-integration.md`](./sdk-integration.md).

## Two-process container

A running container has two server processes:

- **`sandbox-api`** (port 8080, root) — Blaxel's sandbox runtime. Provides
  filesystem and process APIs that Blaxel SDK clients use to inspect and
  manipulate the container. Started by `entrypoint.sh`. We don't touch it.
- **`server.mjs`** (port 4100, agent user) — the Claude Agent SDK wrapper
  this template owns. Everything below describes this process.

Only port 4100 is exposed externally via Blaxel routing. `sandbox-api` is for
Blaxel-internal use.

## Request flow

A typical `POST /chat` round-trip:

```
Frontend                      routes.mjs            session.mjs           SDK / Claude
   │                              │                    │                    │
   │── POST /chat (files=[…]) ───▶│                    │                    │
   │                              │ readBody (capped)  │                    │
   │                              │ syncWorkspace ─────│ wipe + write       │
   │                              │ get/create session ▶                    │
   │                              │                    │ AgentSession.start │
   │                              │                    │ ───── query() ────▶│
   │                              │ addSSEClient ─────▶│                    │
   │                              │ session.sendMessage▶ MessageQueue.push  │
   │                              │                    │                    │ ◀── pulls user msg
   │                              │                    │                    │ ──→ token deltas
   │◀──── SSE: message ───────────┼────────────────────│ _broadcast         │
   │◀──── SSE: message ───────────┼────────────────────│                    │
   │                              │                    │                    │ ──→ tool_use
   │                              │                    │                    │ ◀── tool_result
   │                              │                    │                    │ ──→ result
   │                              │                    │ readWorkspaceSnap. │
   │◀──── SSE: files ─────────────┼────────────────────│                    │
   │◀──── SSE: message (result) ──┼────────────────────│                    │
```

After `result`, the SDK iterator is still alive waiting for the next user
message. The session stays in the `sessions` Map; an idle reaper closes it
after `SESSION_IDLE_MS` of no activity.

## Module breakdown

| File                    | Lines | Owns                                                                          |
|-------------------------|-------|-------------------------------------------------------------------------------|
| `server.mjs`            |  ~50  | Entrypoint. Boots HTTP server, wires the route handler, handles SIGTERM/SIGINT. |
| `src/config.mjs`        |  ~30  | Env-driven configuration + the `log()` helper.                                |
| `src/plugins.mjs`       |  ~65  | Discovers Claude Code plugins installed at image build time.                  |
| `src/workspace.mjs`     | ~115  | Editor-synced workspace operations: path safety, wipe-and-write, snapshot.    |
| `src/session.mjs`       | ~280  | `MessageQueue`, `AgentSession`, sessions Map, idle reaper, `SYSTEM_PROMPT`.   |
| `src/routes.mjs`        | ~200  | HTTP/SSE: `readBody`, `sendJSON`, `sendSSE`, route handler for `/chat`/`/respond`/`/health`. |

## Dependency graph

```
server.mjs
  ├── config        (PORT, log, etc.)
  ├── routes        (handleRequest)
  └── session       (shutdownAllSessions)

routes.mjs
  ├── config
  ├── plugins       (DISCOVERED_PLUGINS — for /health)
  ├── workspace     (syncWorkspace)
  └── session       (AgentSession, sessions Map)

session.mjs
  ├── config
  ├── plugins       (DISCOVERED_PLUGINS — for query options)
  └── workspace     (readWorkspaceSnapshot)

workspace.mjs
  └── config

plugins.mjs
  └── config

config.mjs           (no app-internal deps)
```

No cycles. `config.mjs` is the leaf; `server.mjs` is the root.

## Where to look when…

| Want to change…                                         | Edit                          |
|---------------------------------------------------------|-------------------------------|
| An env var default                                      | `src/config.mjs`              |
| The system prompt the agent runs under                  | `src/session.mjs` (or `SYSTEM_PROMPT_APPEND` env var, or `CLAUDE.md`) |
| The HTTP routes / SSE event names                       | `src/routes.mjs`              |
| What gets included in the end-of-turn workspace snapshot| `src/workspace.mjs`           |
| Path-traversal rules for caller-supplied file paths     | `src/workspace.mjs` (`safeWorkspacePath`) |
| Plugin discovery (e.g. a new plugin install location)   | `src/plugins.mjs`             |
| Session timeout / reaping cadence                       | `SESSION_IDLE_MS` (config) + reaper in `src/session.mjs` |
| The keepalive interval                                  | `src/session.mjs` (`addSSEClient`) |
| What happens on `result` (the snapshot trigger)         | `src/session.mjs` (`_consume`) |

## Why this layout

Two principles:

1. **One concern per file.** Each module has a single, named responsibility
   that fits in one sentence. If a change requires editing more than two
   files, the split was probably wrong.
2. **No cycles, leaves are dependency-free.** `config.mjs` imports nothing
   internal. Everything else imports from it. This makes the modules unit-testable
   in isolation if you ever decide to add tests.

A flatter layout (single `server.mjs`) was tried first and reached ~670 lines.
At that size the file mixes config, transport, session lifecycle, and SDK
adapter code into one scrollable block — readable in isolation, painful to
extend or fork. Splitting along the boundaries above keeps each file under
~300 lines and makes the boundaries between "your app concerns" (routing,
sessions, snapshot) and "SDK plumbing" (queue, system prompt) explicit.
