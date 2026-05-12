// claude-code sandbox — HTTP/SSE wrapper around the Claude Agent SDK.
//
//   POST /chat     { content, sessionId? }  → text/event-stream
//   GET  /health                            → { status: "ok" }
//
// Designed to be reviewed in one sitting. Roughly:
//   - 20 lines of HTTP plumbing
//   - 30 lines of chat handling
//   - 10 lines of shutdown / lifecycle

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = parseInt(process.env.AGENT_PORT || "4100", 10);
const WORKSPACE = process.env.WORKSPACE_DIR || "/workspace";
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
const KEEPALIVE_MS = 15_000;

// Caller-chosen sessionId → SDK session id, used to drive `resume`.
// Persisted at SESSION_MAP_PATH; the file lives next to the SDK's own session
// JSONLs at /home/agent/.claude/projects/. If that directory is backed by a
// Blaxel volume (the chatbot template's optional persistence mode), this map
// survives container restarts and the SDK can keep resuming the same
// conversation. Without a volume, it's just a regular file inside the
// container that dies with it — same effective behavior as in-memory.
const SESSION_MAP_PATH =
  process.env.SESSION_MAP_PATH || "/home/agent/.claude/projects/.session-map.json";

function loadSessionMap() {
  try {
    if (existsSync(SESSION_MAP_PATH)) {
      const obj = JSON.parse(readFileSync(SESSION_MAP_PATH, "utf8"));
      const map = new Map(Object.entries(obj));
      console.log(`[session-map] loaded ${map.size} entries from ${SESSION_MAP_PATH}`);
      return map;
    }
  } catch (err) {
    console.warn(`[session-map] failed to load: ${err.message}`);
  }
  return new Map();
}

function saveSessionMap(map) {
  try {
    mkdirSync(dirname(SESSION_MAP_PATH), { recursive: true });
    writeFileSync(SESSION_MAP_PATH, JSON.stringify(Object.fromEntries(map)));
  } catch (err) {
    console.warn(`[session-map] failed to save: ${err.message}`);
  }
}

const sdkSessionByCaller = loadSessionMap();

// ── HTTP helpers ─────────────────────────────────────────────────────────

async function readBody(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error("payload too large");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("invalid JSON");
    err.statusCode = 400;
    throw err;
  }
}

function sendJSON(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── /chat ────────────────────────────────────────────────────────────────

async function handleChat(req, res) {
  const { content, sessionId } = await readBody(req, MAX_BODY_BYTES);

  const hasStringContent = typeof content === "string" && content.length > 0;
  const hasBlocksContent = Array.isArray(content) && content.length > 0;
  if (!hasStringContent && !hasBlocksContent) {
    return sendJSON(res, 400, { error: "content (string or array of content blocks) required" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });

  // Keep proxies from killing the connection during slow Claude runs.
  const keepalive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      /* socket gone */
    }
  }, KEEPALIVE_MS);

  // Cancel the SDK if the client disconnects mid-stream — otherwise Claude
  // keeps generating (and you keep paying) after the user has gone. If the
  // SDK already finished naturally, abort() is a no-op.
  const ac = new AbortController();
  let done = false;
  res.on("close", () => {
    if (!done) {
      console.log("[chat] client disconnected; aborting SDK");
      ac.abort();
    }
  });

  const options = {
    permissionMode: "bypassPermissions",
    settingSources: ["user", "project"],
    includePartialMessages: true,
    cwd: WORKSPACE,
    abortController: ac,
  };
  const resumeId = sessionId && sdkSessionByCaller.get(sessionId);
  if (resumeId) options.resume = resumeId;

  try {
    for await (const msg of query({ prompt: content, options })) {
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id && sessionId) {
        // Only persist on first capture or when the SDK's session id changes.
        if (sdkSessionByCaller.get(sessionId) !== msg.session_id) {
          sdkSessionByCaller.set(sessionId, msg.session_id);
          saveSessionMap(sdkSessionByCaller);
        }
      }
      sse(res, "message", msg);
    }
  } catch (err) {
    // Don't emit an error frame if the abort was triggered by client disconnect —
    // the socket is gone, the write would throw anyway.
    if (!ac.signal.aborted) {
      sse(res, "error", { error: err.message || String(err) });
    }
  } finally {
    done = true;
    clearInterval(keepalive);
    res.end();
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    // Strip query string so route matching survives `?bl_preview_token=...`
    // appended by Blaxel preview-token auth.
    const path = req.url.split("?")[0];
    if (req.method === "GET" && path === "/health") {
      return sendJSON(res, 200, { status: "ok" });
    }
    if (req.method === "POST" && path === "/chat") {
      return await handleChat(req, res);
    }
    return sendJSON(res, 404, { error: "not found" });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("[server]", err);
    if (!res.headersSent) {
      return sendJSON(res, status, { error: err.message || "internal error" });
    }
    res.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`claude-code sandbox listening on ${PORT}`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
