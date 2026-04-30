/**
 * Generic Claude Code sandbox server — entrypoint.
 *
 * The interesting code lives in ./src — this file just boots the HTTP server
 * and wires shutdown signals.
 *
 *   src/config.mjs      env-driven configuration + log()
 *   src/plugins.mjs     Claude Agent SDK plugin discovery
 *   src/workspace.mjs   editor-synced workspace operations
 *   src/session.mjs     SDK session lifecycle (queue, AgentSession, reaper)
 *   src/routes.mjs      HTTP/SSE request handler (/chat, /respond, /health)
 *
 * Endpoints
 *   POST /chat      body: { content, sessionId?, files?, attachments? }
 *                   response: text/event-stream (session, message, files, done, error)
 *   POST /respond   body: { content, sessionId }      → 200 ok / 404
 *   GET  /health    → { status, sessions, plugins }
 *
 * Authentication
 *   This server has no auth of its own — Blaxel gates inbound traffic at the
 *   platform layer. Do not run this image outside a Blaxel sandbox without
 *   putting an authenticating proxy in front of it.
 */

import { createServer } from "node:http";
import {
  PORT,
  WORKSPACE,
  MAX_BODY_BYTES,
  SESSION_IDLE_MS,
  MAX_TURNS,
  log,
} from "./src/config.mjs";
import { handleRequest } from "./src/routes.mjs";
import { shutdownAllSessions } from "./src/session.mjs";

const server = createServer(handleRequest);

server.listen(PORT, "0.0.0.0", () => {
  log(`Claude sandbox server listening on port ${PORT}`);
  log(
    `Config: workspace=${WORKSPACE} maxBody=${MAX_BODY_BYTES}B idleMs=${SESSION_IDLE_MS} maxTurns=${MAX_TURNS}`,
  );
});

function shutdown(signal) {
  log(`Received ${signal}, shutting down`);
  shutdownAllSessions();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
