/**
 * HTTP/SSE request handler.
 *
 *   POST /chat      — sync workspace, start/reuse session, stream SSE
 *   POST /respond   — push a follow-up message into an existing session
 *   GET  /health    — liveness probe (no auth)
 *   OPTIONS *       — permissive CORS preflight
 */

import { MAX_BODY_BYTES, log } from "./config.mjs";
import { DISCOVERED_PLUGINS } from "./plugins.mjs";
import { syncWorkspace } from "./workspace.mjs";
import { AgentSession, sessions } from "./session.mjs";

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBytes) {
        aborted = true;
        const err = new Error("payload too large");
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString();
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error("invalid JSON");
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Route handler — installed as the createServer callback in server.mjs
// ---------------------------------------------------------------------------

export async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    return sendJSON(res, 200, {
      status: "ok",
      sessions: sessions.size,
      plugins: DISCOVERED_PLUGINS.length,
    });
  }

  if (req.method === "POST" && req.url === "/chat") {
    return handleChat(req, res);
  }

  if (req.method === "POST" && req.url === "/respond") {
    return handleRespond(req, res);
  }

  return sendJSON(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// /chat
// ---------------------------------------------------------------------------

async function handleChat(req, res) {
  let body;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    return sendJSON(res, err.statusCode || 400, { error: err.message });
  }

  const { content, sessionId, files } = body;

  const hasContent =
    (typeof content === "string" && content.length > 0) ||
    (Array.isArray(content) && content.length > 0);
  if (!hasContent) {
    return sendJSON(res, 400, { error: "content is required" });
  }

  let synced;
  try {
    synced = syncWorkspace(files);
  } catch (err) {
    return sendJSON(res, 400, { error: `sync failed: ${err.message}` });
  }
  if (synced.length > 0) log(`[sync] ${synced.join(", ")}`);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const sessId =
    sessionId || `anon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let session = sessions.get(sessId);
  if (!session) {
    session = new AgentSession(sessId);
    sessions.set(sessId, session);
    session.start();
    log(`[${sessId}] new session`);
  } else {
    log(`[${sessId}] reusing session`);
  }

  sendSSE(res, "session", { sessionId: sessId });
  session.addSSEClient(res);

  const prefix =
    synced.length > 0 ? `[Workspace synced: ${synced.join(", ")}]\n\n` : "";

  let outboundContent;
  if (typeof content === "string") {
    outboundContent = prefix + content;
  } else if (prefix) {
    outboundContent = [{ type: "text", text: prefix }, ...content];
  } else {
    outboundContent = content;
  }

  session.sendMessage(outboundContent);
}

// ---------------------------------------------------------------------------
// /respond
// ---------------------------------------------------------------------------

async function handleRespond(req, res) {
  let body;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    return sendJSON(res, err.statusCode || 400, { error: err.message });
  }

  const { content, sessionId } = body;
  if (!sessionId || !sessions.has(sessionId)) {
    return sendJSON(res, 404, { error: "session not found" });
  }
  if (!content) {
    return sendJSON(res, 400, { error: "content is required" });
  }
  sessions.get(sessionId).sendMessage(content);
  return sendJSON(res, 200, { ok: true });
}
