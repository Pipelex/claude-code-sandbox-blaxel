# Claude Code Sandbox

A Blaxel sandbox image that runs **Claude Code** (the CLI/agent harness)
inside an isolated container and exposes it as an HTTP/SSE service on
port `4100`. Drop it behind any chat UI or agent and you get an
editor-aware Claude agent that streams its work back to the caller.

> **Claude Code vs Claude Agent SDK** — the image installs the
> [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code)
> CLI (the `claude` binary). Our `server/` wrapper depends on the
> [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
> package and uses it to drive the CLI from Node. Two different packages,
> both required; we mention both for clarity.

Structured to slot directly into
[`blaxel-ai/sandbox/hub/claude-code/`](https://github.com/blaxel-ai/sandbox/tree/main/hub).

> **👉 Working example:** see
> [`template-chatbot-claudecode`](https://github.com/pipelex/template-chatbot-claudecode)
> — a Blaxel agent template that spawns instances of this image, forwards
> provider auth per session, mints private preview tokens, and proxies a
> streaming chatbot conversation through to the sandbox. Production-shaped
> consumer, ~250 lines of TypeScript, ready to fork.

## Architecture

Two processes run inside the container:

- **`sandbox-api`** (port `8080`) — Blaxel's sandbox runtime. Generic
  filesystem and process APIs. We didn't write this; it's the standard
  binary every hub entry includes.
- **`server/server.js`** (port `4100`, non-root `agent` user) — our
  Node HTTP/SSE wrapper that drives the Claude Code CLI via the Claude
  Agent SDK. Exposes `/chat`, `/respond`, `/health`. This is the layer
  that turns the low-level `sandbox-api` into a high-level chat API.

This is the same shape as
[`hub/jupyter-server/`](https://github.com/blaxel-ai/sandbox/tree/main/hub/jupyter-server),
which runs `sandbox-api` plus a custom FastAPI server on port 8888.

## Features

- **Streaming SSE** — `/chat` responds with `text/event-stream`,
  forwarding every SDK message (text deltas, tool calls, tool results,
  init, result) verbatim. 15s `: keepalive` comments survive nginx /
  Cloudflare timeouts.
- **Resumable sessions** — sessions are keyed by a caller-supplied
  `sessionId`. The SDK session id is captured from the `init` event and
  used to `resume` across HTTP requests, keeping multi-turn history.
  Persisted to `SESSION_MAP_PATH` (a JSON file next to the SDK's own
  session JSONLs).
- **Skill discovery** — `settingSources: ["user", "project"]` makes the
  SDK auto-load anything dropped under `/home/agent/.claude/skills/`.
  Consumers push skills at runtime via Blaxel's `sandbox.fs.write` API
  — no image rebuild, no plugin install.
- **Provider-agnostic** — Anthropic API or Amazon Bedrock, configured
  via env vars only. See *Provider auth* below.
- **Bounded resource use** — request body capped at `MAX_BODY_BYTES`
  (default 10 MiB); oversize returns 413. Server runs as non-root,
  handles `SIGTERM`/`SIGINT` cleanly. SDK is aborted on client
  disconnect so you don't keep paying for tokens after the user is gone.

## Provider auth

The Claude Agent SDK supports two backends. Pick **one** by setting the
right env vars — the SDK reads them directly; the sandbox itself does
nothing provider-specific.

### Anthropic API (default)

```sh
ANTHROPIC_API_KEY=sk-ant-...
```

### Amazon Bedrock

Pick one of the two auth modes below.

**Bedrock API key** (simplest):

```sh
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=us-west-2
AWS_BEARER_TOKEN_BEDROCK=...
```

**AWS IAM credentials**:

```sh
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...        # optional, for temporary creds
```

When using Bedrock, set `ANTHROPIC_MODEL` to a Bedrock-format id (e.g.
`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) — see Claude Code's
[Bedrock docs](https://code.claude.com/docs/en/amazon-bedrock) for the
full list.

## How to run locally

```sh
docker build -t claude-code .
docker run --rm -p 4100:4100 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  claude-code
```

Send a request:

```sh
curl -N -X POST http://localhost:4100/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "demo",
    "content": "Create hello.txt with the word hi inside.",
    "files": []
  }'
```

You'll see a stream of SSE events including a workspace snapshot and a
final `message` with `type: "result"`.

## Deploy to Blaxel

1. **Install the [Blaxel CLI](https://docs.blaxel.ai/Get-started)** and
   log in:
   ```sh
   bl login YOUR-WORKSPACE
   ```
2. **Create `.env`** with your provider credentials:
   ```sh
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   > ⚠️ **Do not commit `.env`** — it holds your API key. Confirm it's
   > in `.gitignore` before you push.
3. **Deploy**:
   ```sh
   bl deploy
   ```
4. **Create a private preview URL** for the agent port (`4100`) via the
   [Blaxel Console](https://app.blaxel.ai) (Sandboxes → your sandbox →
   *Previews*). The console also shows the equivalent SDK snippet for
   minting previews programmatically.
5. **Test it.** Include the preview token in the URL:
   ```sh
   curl -N -X POST https://<preview-id>.preview.bl.run/chat?bl_preview_token=<token> \
     -H 'Content-Type: application/json' \
     -d '{
       "sessionId": "demo",
       "content": "Create hello.txt with the word hi inside.",
       "files": []
     }'
   ```

For an end-to-end example that programmatically provisions a sandbox,
mints a preview, and proxies a chatbot UI, see
[`template-chatbot-claudecode`](https://github.com/pipelex/template-chatbot-claudecode).

## API surface (brief)

- `POST /chat` — `{ sessionId?, content }` where `content` is a non-empty
  string. Responds with `text/event-stream`; every frame is
  `event: message` carrying a raw Claude Agent SDK message (text deltas,
  tool calls, tool results, init, result). One `event: error` frame on
  failure. Send another `POST /chat` with the same `sessionId` to continue
  the session.
- `GET /health` — returns `{ status: "ok" }`.

Each `event: message` carries a raw Claude Agent SDK message. The SDK
message shape (`type: "system" | "stream_event" | "assistant" | "result"`,
etc.) is the source of truth — see
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

## Configuration

Provider auth env vars are listed above. Tuning knobs:

| Env var            | Default                                            | Purpose                                                    |
|--------------------|----------------------------------------------------|------------------------------------------------------------|
| `ANTHROPIC_MODEL`  | SDK default                                        | Model id. Use a Bedrock-format id when on Bedrock.         |
| `AGENT_PORT`       | `4100`                                             | HTTP port for the agent server.                            |
| `WORKSPACE_DIR`    | `/workspace`                                       | Working directory passed to the Claude Agent SDK.          |
| `MAX_BODY_BYTES`   | `10485760` (10 MiB)                                | Request body cap; oversize returns 413.                    |
| `SESSION_MAP_PATH` | `/home/agent/.claude/projects/.session-map.json`   | Persisted caller-sessionId → SDK-session-id map.           |

That's the full surface. The sandbox is deliberately small.

## Authentication

This server has no auth of its own — Blaxel gates inbound traffic at
the platform layer (private previews, workspace tokens). Do not run
this image outside a Blaxel sandbox without putting an authenticating
proxy in front of it.

## Extending Claude with skills (no image changes)

The Claude Agent SDK in this sandbox runs with
`settingSources: ["user", "project"]`, so it auto-discovers anything
the **consumer** writes to `/home/agent/.claude/skills/` at runtime
using Blaxel's filesystem API — **no image rebuild, no fork of this
repo**.

```ts
import { SandboxInstance } from "@blaxel/core";

const sandbox = await SandboxInstance.get("claude-some-session");
await sandbox.fs.write(
  "/home/agent/.claude/skills/my-skill/SKILL.md",
  `---
name: my-skill
description: Custom skill the consumer just enabled.
---

Tell Claude how to behave when this skill is active.`,
);

// Next /chat through this sandbox will see /my-skill.
```

Useful for **per-tenant or per-session toolkits**. The skill stays on
disk until the sandbox is reaped; to make it durable across reaps,
mount a Blaxel volume that covers `/home/agent/.claude/skills/`.

The companion repo
[`template-chatbot-claudecode`](https://github.com/pipelex/template-chatbot-claudecode)
ships a working demo of this pattern (look for `pushSampleSkill` in
its `src/agent.ts`). Read its
["Extending Claude with Skills"](https://github.com/pipelex/template-chatbot-claudecode#-extending-claude-with-skills)
section for a runnable example.

### What about Claude Code marketplace plugins?

Marketplace plugins (MTHDS, gstack, etc.) ship runtime code that has
to live in the sandbox image. **First-class plugin support via the
consumer agent is coming.** For now this sandbox image stays bare; if
you absolutely need a plugin today you can fork this repo and add a
`RUN claude plugin install …` line to the Dockerfile, but most users
shouldn't need to — that path is the exception, not the convention.

For deep-dive material — module breakdown, SDK integration rationale,
workspace-sync mechanics — see
[`template-chatbot-claudecode/docs/`](https://github.com/pipelex/template-chatbot-claudecode/tree/main/docs).

## Test

Bash smoke test (requires the image running locally):

```sh
docker run --rm -p 4100:4100 -e ANTHROPIC_API_KEY=sk-ant-... claude-code &
./tests/smoke.sh
```

Tests `/health`, `/chat` happy path, session resume, 400 on missing
content, 400 on malformed JSON, 413 on oversize body, 404 on unknown
route. Uses `curl` + `jq` only — no test framework.

## License

MIT — see `LICENSE`.
