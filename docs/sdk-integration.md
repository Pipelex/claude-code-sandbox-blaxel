# SDK integration: what we add on top of `@anthropic-ai/claude-agent-sdk`

A reasonable question to ask when reading `src/session.mjs`:

> Doesn't the SDK already handle sessions and message queues? Why are
> `MessageQueue` and `AgentSession` here?

This document answers that. Short version:

- `MessageQueue` exists because of how the **stable v1** of the SDK takes
  user input. The **unstable v2** would replace it. We deliberately use v1.
- `AgentSession` does v1's job *plus* a bunch of things the SDK doesn't do
  for you at any version (multi-client SSE fan-out, session registry, idle
  reaping, snapshot integration).

## What the SDK actually exports

Two relevant entrypoints, both from `@anthropic-ai/claude-agent-sdk`.

### v1 — `query()` (stable, what we use)

```ts
function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

`prompt` is *either* a one-shot string, *or* an async iterable. If you want
a multi-turn conversation, you give it an iterable that you keep pushing
into. There is **no `query.send(msg)` method**. The shape forces you to wrap
your input in an iterable.

The returned `Query` is an `AsyncGenerator<SDKMessage>` — pull messages out
by iterating it. It also exposes `interrupt()`, `setPermissionMode()`,
`setModel()`, `setMcpServers()`, etc.

Resume across processes is supported via `options.resume = sessionId`.

### v2 — `unstable_v2_createSession()` (UNSTABLE)

```ts
interface SDKSession {
  readonly sessionId: string;
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
}

function unstable_v2_createSession(options): SDKSession;
function unstable_v2_resumeSession(sessionId, options): SDKSession;
```

Much closer to what `AgentSession` looks like. `send()` pushes a message,
`stream()` returns the output. No queue-as-iterable dance.

But the function names are literally prefixed `unstable_v2_` — Anthropic is
telling you the API may change.

## Why `MessageQueue` exists

It's the iterable adapter required by v1 to support multi-turn input.

The SDK pulls user messages from your iterable. We need a way to push into
it from HTTP handlers (each `/chat` POST and `/respond` POST is a separate
request, not a coroutine the SDK can await). `MessageQueue` is exactly that
— an async iterator with a `push()` method on the side.

Mechanics in 30 seconds:

1. We construct a `MessageQueue` per session start.
2. We pass it as `query({ prompt: queue, ... })`. The SDK begins iterating it.
3. When the queue is empty, its `Symbol.asyncIterator` parks on a Promise.
4. `queue.push(content)` resolves that Promise with a `{ role: "user", content }`
   message — the SDK gets its next input.
5. `queue.close()` unparks the waiter with an empty message and ends the loop.

If we switched to v2, `MessageQueue` would disappear entirely.
`session.send(content)` would replace `queue.push(content)`. Roughly 30
lines deleted.

## Why `AgentSession` exists

It wraps the SDK with things the SDK doesn't do **at any version**.

| Concern                                       | SDK v1 | SDK v2 (unstable) | `AgentSession`                      |
|-----------------------------------------------|--------|-------------------|-------------------------------------|
| Multi-turn input plumbing                     | ❌ (need queue) | ✅ `send()`         | ✅ via `MessageQueue`               |
| Output as async iterator                      | ✅      | ✅                  | consumed in `_consume()`           |
| SDK session id capture                        | ✅ (in `init` msg) | ✅ `sessionId` prop | captured + stored                  |
| Resume across HTTP requests                   | ✅ via `options.resume` | ✅ via `unstable_v2_resumeSession` | yes — uses `resume:` on next start |
| **Fan-out one SDK stream to N SSE clients**   | ❌      | ❌                  | ✅ `sseClients` Set + `_broadcast`  |
| **Registry of named sessions by your id**     | ❌      | ❌                  | ✅ `sessions` Map (in `session.mjs`) |
| **Idle reaper to free memory**                | ❌      | ❌                  | ✅ `setInterval` reaper             |
| **Trigger workspace snapshot on `result`**    | ❌      | ❌                  | ✅ in `_consume()`                  |
| **Keepalive comments on SSE**                 | ❌      | ❌                  | ✅ in `addSSEClient`                |

Roughly:

- ~30% of `session.mjs` (the `MessageQueue` class + the iterator-consumption
  loop in `_consume()`) is SDK plumbing — it exists because we use v1. v2
  would replace most of it.
- ~70% is your-app concerns the SDK doesn't touch — registry, fan-out,
  reaper, snapshot integration, keepalive. You'd write nearly identical code
  on top of v2.

## Why we use v1, not v2

For a template meant to be forked and depended on, the trade-offs lean v1:

- **v2 is flagged unstable.** Functions are prefixed `unstable_v2_`. Anthropic
  is explicitly reserving the right to change the API. Every fork of this
  template would inherit that risk.
- **The savings are modest.** ~30 lines of `MessageQueue` deletion plus a
  slightly cleaner `AgentSession.start()`. Not worth pinning to an unstable
  surface.
- **v1's resume mechanism is sufficient.** `options.resume = sessionId` does
  the same thing — capture the SDK's `session_id` from the `init` message,
  pass it back next time the iterator restarts.
- **v1 is unlikely to disappear.** Even after v2 graduates, `query()` is
  used in too many production codebases to remove without a long deprecation
  window.

## When to revisit

Switch to v2 when **all** of the following are true:

- The `unstable_v2_` prefix is dropped from the SDK exports.
- There's a release-notes entry promising API stability.
- Resume semantics across process restarts are explicitly documented for v2.

At that point the migration is mostly mechanical:

1. Delete `MessageQueue` (the class, not the import sites yet).
2. Replace `AgentSession.start()` body with
   `this.sdkSession = sdkSessionId ? resumeSession(sdkSessionId, opts) : createSession(opts)`.
3. Replace `this.queue.push(content)` with `await this.sdkSession.send(content)`.
4. Replace the `_consume` iterator setup with
   `for await (const value of this.sdkSession.stream()) { … }`.
5. Replace `this.sdkSessionId` capture with `this.sdkSession.sessionId`.
6. Drop the `init`-message session id capture branch — v2 sessions know
   their id from creation/resume time.

The fan-out/reaper/snapshot/keepalive logic stays unchanged.

## Reading list (in the SDK source)

If you want to verify any of this yourself:

- `node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/agentSdkTypes.d.ts`
  — the public SDK surface. `query`, `unstable_v2_createSession`,
  `unstable_v2_resumeSession`.
- `node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/runtimeTypes.d.ts`
  — the `Query` interface (line ~87) and `SDKSession` interface (line ~209).
- `node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.d.ts`
  — `SDKMessage`, `SDKUserMessage`, `Options`, etc.
