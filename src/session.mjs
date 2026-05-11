/**
 * Sessions, message queue, and the SDK system prompt.
 *
 * One AgentSession owns the long-lived `query()` iterator from the Claude
 * Agent SDK for a given logical sessionId. It feeds the SDK new user
 * messages via MessageQueue and broadcasts SDK output to attached SSE
 * clients. Sessions resume across HTTP requests via SDK session ids and
 * are reaped when idle.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  WORKSPACE,
  MAX_TURNS,
  SESSION_IDLE_MS,
  SYSTEM_PROMPT_APPEND,
  log,
} from "./config.mjs";
import { DISCOVERED_PLUGINS } from "./plugins.mjs";
import { readWorkspaceSnapshot } from "./workspace.mjs";

// ---------------------------------------------------------------------------
// System prompt appended to Claude Code's preset.
// Customize via the SYSTEM_PROMPT_APPEND env var or by editing CLAUDE.md.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `
# Sandbox Environment

You are running inside an isolated sandbox container, accessible to a user via an HTTP/SSE bridge.

## Workspace

Your working directory is \`${WORKSPACE}\`. Treat it as the source of truth.

Before each user turn, the sandbox replaces this directory with the files the
caller currently has open in their editor or UI. Anything you wrote in a
previous turn that the caller has since deleted will be gone. Anything you
write here will be visible to the caller after the turn finishes.

Stay inside \`${WORKSPACE}\`. Do not write outside it.

## Interaction model

The user interacts via a chat UI; there is no terminal. Format responses for
that channel — short, structured, no shell prompts. Never call interactive
question tools; if you need clarification, ask in plain text and wait.
`;

// ---------------------------------------------------------------------------
// Async message queue
//
// Single-consumer queue that the SDK iterates over. push() either resolves a
// pending await or buffers; close() unblocks any waiter and ends the loop.
// ---------------------------------------------------------------------------

class MessageQueue {
  constructor() {
    this.messages = [];
    this.waiting = null;
    this.closed = false;
  }

  push(content) {
    if (this.closed) return;
    const msg = { type: "user", message: { role: "user", content } };
    if (this.waiting) {
      const resume = this.waiting;
      this.waiting = null;
      resume(msg);
    } else {
      this.messages.push(msg);
    }
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift();
      } else {
        const next = await new Promise((resolve) => {
          this.waiting = resolve;
        });
        if (this.closed) return;
        yield next;
      }
    }
  }

  close() {
    this.closed = true;
    if (this.waiting) {
      const resume = this.waiting;
      this.waiting = null;
      resume({ type: "user", message: { role: "user", content: "" } });
    }
  }
}

// ---------------------------------------------------------------------------
// AgentSession
// ---------------------------------------------------------------------------

export class AgentSession {
  constructor(id) {
    this.id = id;
    this.queue = new MessageQueue();
    this.outputIterator = null;
    this.running = false;
    this.sseClients = new Set();
    this.sdkSessionId = null;
    this.lastActivity = Date.now();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  _options(resumeSessionId) {
    const opts = {
      maxTurns: MAX_TURNS,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      cwd: WORKSPACE,
      stderr: (data) => log(`[${this.id}][stderr]`, data),
      settingSources: ["user", "project"],
      plugins: DISCOVERED_PLUGINS,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          SYSTEM_PROMPT +
          (SYSTEM_PROMPT_APPEND ? `\n\n${SYSTEM_PROMPT_APPEND}` : ""),
      },
    };
    if (resumeSessionId) opts.resume = resumeSessionId;
    return opts;
  }

  start(resumeSessionId) {
    this.queue = new MessageQueue();
    const q = query({ prompt: this.queue, options: this._options(resumeSessionId) });
    this.outputIterator = q[Symbol.asyncIterator]();
    this.running = true;
    this._consume();
  }

  sendMessage(content) {
    this.touch();
    if (!this.running && this.sdkSessionId) {
      log(`[${this.id}] resuming SDK session ${this.sdkSessionId}`);
      this.start(this.sdkSessionId);
    } else if (!this.running) {
      this.start();
    }
    this.queue.push(content);
  }

  addSSEClient(res) {
    this.sseClients.add(res);
    const keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        /* socket gone */
      }
    }, 15_000);
    res.on("close", () => {
      clearInterval(keepalive);
      this.sseClients.delete(res);
    });
  }

  async _consume() {
    try {
      while (this.running) {
        const { value, done } = await this.outputIterator.next();
        if (done) break;

        if (
          value.type === "system" &&
          value.subtype === "init" &&
          value.session_id
        ) {
          this.sdkSessionId = value.session_id;
          log(`[${this.id}] SDK session ${this.sdkSessionId}`);
        }

        if (value.type === "assistant" || value.type === "result") {
          log(`[${this.id}] sdk:`, JSON.stringify(value).slice(0, 2000));
        }

        if (value.type === "result") {
          const snapshot = readWorkspaceSnapshot();
          if (snapshot.length > 0) {
            this._broadcast("files", { files: snapshot });
            log(
              `[${this.id}] snapshot: ${snapshot
                .map((f) => f.path)
                .slice(0, 10)
                .join(", ")}${snapshot.length > 10 ? ` (+${snapshot.length - 10} more)` : ""}`,
            );
          }
        }

        this._broadcast("message", value);
        this.touch();
      }
      this._broadcast("done", { ok: true });
    } catch (err) {
      log(`[${this.id}] query error:`, err.message);
      if (err.name !== "AbortError") {
        this._broadcast("error", { error: err.message });
      }
    } finally {
      this.running = false;
    }
  }

  _broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch {
        /* ignore broken sockets */
      }
    }
  }

  close() {
    this.running = false;
    this.queue.close();
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();
  }
}

// ---------------------------------------------------------------------------
// Session registry + idle reaper
//
// Sessions with no SSE clients and no activity for SESSION_IDLE_MS are
// closed and removed so the Map does not grow forever.
// ---------------------------------------------------------------------------

export const sessions = new Map();

const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const idle = now - session.lastActivity;
    if (session.sseClients.size === 0 && idle > SESSION_IDLE_MS) {
      log(`[${id}] reaping idle session (${Math.round(idle / 1000)}s)`);
      session.close();
      sessions.delete(id);
    }
  }
}, 60_000);
reaper.unref();

/** Called from the entrypoint on SIGTERM/SIGINT. */
export function shutdownAllSessions() {
  clearInterval(reaper);
  for (const [, s] of sessions) s.close();
  sessions.clear();
}
