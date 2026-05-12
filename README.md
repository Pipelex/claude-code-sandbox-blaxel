# Claude Code Sandbox

A Blaxel sandbox image that runs the **Claude Agent SDK** inside an
isolated container and exposes it as an HTTP/SSE service on port `4100`.
Drop it behind any chat UI or agent and you get an editor-aware Claude
agent that streams its work back to the caller.

Structured to slot directly into
[`blaxel-ai/sandbox/hub/claude-code/`](https://github.com/blaxel-ai/sandbox/tree/main/hub).
For a working consumer — a Blaxel agent that spawns instances of this
image and proxies a chatbot conversation through it — see
[`template-chatbot-claudecode`](https://github.com/pipelex/template-chatbot-claudecode).

## Architecture

Two processes run inside the container:

- **`sandbox-api`** (port `8080`) — Blaxel's sandbox runtime. Generic
  filesystem and process APIs. We didn't write this; it's the standard
  binary every hub entry includes.
- **`server/server.js`** (port `4100`, non-root `agent` user) — our
  Node HTTP/SSE wrapper around the Claude Agent SDK. Exposes `/chat`,
  `/respond`, `/health`. This is the layer that turns the low-level
  `sandbox-api` into a high-level chat API.

This is the same shape as
[`hub/jupyter-server/`](https://github.com/blaxel-ai/sandbox/tree/main/hub/jupyter-server),
which runs `sandbox-api` plus a custom FastAPI server on port 8888.

## Features

- **Editor-synced workspace** — caller sends files with each `/chat`
  request; the server wipes and rewrites `WORKSPACE_DIR` so the agent
  sees exactly what the caller sees. End-of-turn snapshot returns the
  modified files via an `event: files` SSE frame.
- **Streaming SSE** — `/chat` responds with `text/event-stream`,
  forwarding every SDK message (text deltas, tool calls, tool results)
  plus workspace snapshots. 15s keepalive comments. Multiple SSE
  clients can attach to one session.
- **Resumable sessions** — sessions are keyed by a caller-supplied
  `sessionId`. The SDK session id is captured from the `init` event and
  used to `resume` across HTTP requests, keeping multi-turn history.
  Idle sessions reap after `SESSION_IDLE_MS`.
- **Multimodal inputs** — text, image, and PDF content blocks pass
  through the Agent SDK natively. No parallel attachments API.
- **Provider-agnostic** — Anthropic API or Amazon Bedrock, configured
  via env vars only. See *Provider auth* below.
- **Plugin discovery** — any `claude plugin install …` line added to
  the `Dockerfile` is auto-loaded by the SDK at runtime. No plugins are
  installed by default.
- **Bounded resource use** — request body capped at `MAX_BODY_BYTES`
  (default 10 MiB); oversize returns 413. Server runs as non-root,
  handles `SIGTERM`/`SIGINT` cleanly.
- **Keepalive** — `: keepalive\n\n` comment frames every 15s on `/chat`
  so corporate proxies (nginx, Cloudflare, etc.) don't kill the SSE
  connection during slow Claude responses.

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

## API surface (brief)

- `POST /chat` — `{ sessionId, content, files }`. Responds with
  `text/event-stream`. Event types: `session`, `message`, `files`,
  `done`, `error`.
- `POST /respond` — `{ sessionId, content }`. Pushes a follow-up message
  into an existing session.
- `GET /health` — returns `{ status, sessions, plugins }`.

Full SSE event reference (including the SDK message types nested inside
`event: message`) lives in
[`template-chatbot-claudecode/docs/api.md`](https://github.com/pipelex/template-chatbot-claudecode/blob/main/docs/api.md).

## Configuration

Provider auth env vars are listed above. Tuning knobs:

| Env var                   | Default      | Purpose                                          |
|---------------------------|--------------|--------------------------------------------------|
| `ANTHROPIC_MODEL`         | SDK default  | Model id. Use a Bedrock-format id when on Bedrock. |
| `AGENT_PORT`              | `4100`       | HTTP port for the agent server.                  |
| `WORKSPACE_DIR`           | `/workspace` | Mirrored workspace root.                         |
| `MAX_BODY_BYTES`          | `10485760`   | Request body cap (10 MiB).                       |
| `SESSION_IDLE_MS`         | `1800000`    | Idle session reap threshold (30 min).            |
| `MAX_TURNS`               | `100`        | SDK turn cap per query.                          |
| `SNAPSHOT_MAX_FILES`      | `200`        | Files included in end-of-turn snapshot.          |
| `SNAPSHOT_MAX_FILE_BYTES` | `1048576`    | Per-file size limit for snapshots.               |
| `SYSTEM_PROMPT_APPEND`    | empty        | Extra text appended to the system prompt.        |

These can be passed per-instance via `SandboxInstance.create({ envs })`
from a driver agent (see `template-chatbot-claudecode/src/agent.ts`).

## Authentication

This server has no auth of its own — Blaxel gates inbound traffic at
the platform layer (private previews, workspace tokens). Do not run
this image outside a Blaxel sandbox without putting an authenticating
proxy in front of it.

## Customizing — adding skills and plugins

The Claude Agent SDK in this sandbox runs with
`settingSources: ["user", "project"]`, so it auto-discovers everything
under `/home/agent/.claude/`. Three paths to extend it, from canonical
to advanced:

### Path 1: bake plugins or skills into the image (canonical)

The standard pattern. Fork the repo, edit the `Dockerfile`, rebuild,
redeploy. Every sandbox instance spawned from the new image inherits
your additions.

**Install a Claude Code marketplace plugin:**

```dockerfile
RUN gosu agent bash -lc '\
      claude plugin marketplace add owner/repo --scope user \
      && claude plugin install plugin-name@repo --scope user'
```

Real examples:

```dockerfile
# MTHDS — /mthds-build, /mthds-edit, ...
RUN gosu agent bash -lc '\
      claude plugin marketplace add mthds-ai/mthds-plugins --scope user \
      && claude plugin install mthds@mthds-plugins --scope user'

# gstack — /qa, /ship, /review, ...
RUN gosu agent bash -lc '\
      git clone --depth 1 https://github.com/garrytan/gstack.git \
        /home/agent/.claude/skills/gstack \
      && cd /home/agent/.claude/skills/gstack && ./setup -q || true'
```

**Bake a single standalone skill:**

A skill is just a `SKILL.md` with YAML frontmatter. Create
`skills/my-skill/SKILL.md` in this repo:

```markdown
---
name: my-skill
description: When to use this skill — one short sentence.
---

Tell Claude how to do the thing here. Regular markdown.
```

Then `COPY` it into the image:

```dockerfile
COPY skills/my-skill /home/agent/.claude/skills/my-skill
RUN chown -R agent:agent /home/agent/.claude/skills
```

Rebuild. The new `/my-skill` slash command is available. Verify via
the `init` SSE event — the `skills` array will list your new entry.

### Path 2: drop a skill into a *running* sandbox via `sandbox-api`

A skill is just markdown on disk. A consumer (e.g. the chatbot template
or any code holding a Blaxel `SandboxInstance` handle) can write a skill
into a live container using Blaxel's filesystem API:

```ts
import { SandboxInstance } from "@blaxel/core";

const sandbox = await SandboxInstance.get("claude-some-session");
await sandbox.fs.write(
  "/home/agent/.claude/skills/my-skill/SKILL.md",
  `---
name: my-skill
description: Custom skill the user just enabled.
---

Reply with: "I have the my-skill skill loaded."`,
);

// Next /chat will see it via settingSources.
```

Useful for **per-tenant or per-session toolkits** without rebuilding the
image. The skill is live until the sandbox is reaped — it doesn't
persist across container restarts unless you mount a Blaxel volume that
covers `/home/agent/.claude/skills/` (out of scope here; see
[`docs/providers.md` in the chatbot template](https://github.com/pipelex/template-chatbot-claudecode/blob/main/docs/providers.md)
for the volume pattern).

Note: this only works for **skills** (markdown files). Marketplace
**plugins** with runtime code can't be safely installed this way —
they need build-time setup, see Path 1 or Path 3.

### Path 3: install plugins at sandbox creation time via env (extension point)

Not in the entrypoint today, but easy to wire if you need it.

A consumer can pass an env var via Blaxel's per-instance injection:

```ts
SandboxInstance.create({
  image: "claude-code-sandbox",
  envs: [
    { name: "INSTALL_PLUGINS", value: "mthds-ai/mthds-plugins:mthds" },
  ],
});
```

Add ~10 lines to `entrypoint.sh` to parse `INSTALL_PLUGINS` and call
`claude plugin install` before starting the agent server. Adds 1–3s of
cold-start per plugin.

Open a PR if you want this wired up — it's a clean extension point.

### Summary

| You want… | Use path | Rebuild? | Persistent? |
|---|---|---|---|
| Every sandbox gets a specific toolkit | 1 (bake in) | Yes, once | Yes |
| Each user/session gets a custom skill | 2 (`sandbox.fs.write`) | No | No (lost on reap) |
| Each session picks from a plugin set at creation | 3 (entrypoint env, not shipped) | Build once + wire entrypoint | Yes (lifetime of sandbox) |

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
