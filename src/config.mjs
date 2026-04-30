/**
 * All env-driven configuration in one place.
 *
 * Every value here has a sane default so the server boots with no env vars set.
 * Override at deploy time via blaxel.toml / Blaxel API / `bl deploy -e .env`.
 */

const num = (name, def) => parseInt(process.env[name] || String(def), 10);

export const PORT = num("AGENT_PORT", 4100);
export const WORKSPACE = process.env.WORKSPACE_DIR || "/workspace";

export const PLUGINS_INSTALLED_PATH =
  process.env.PLUGINS_INSTALLED_PATH ||
  "/home/agent/.claude/plugins/installed_plugins.json";
export const PLUGINS_CACHE_DIR =
  process.env.PLUGINS_CACHE_DIR || "/home/agent/.claude/plugins/cache";

export const MAX_BODY_BYTES = num("MAX_BODY_BYTES", 10 * 1024 * 1024);
export const SESSION_IDLE_MS = num("SESSION_IDLE_MS", 30 * 60 * 1000);
export const MAX_TURNS = num("MAX_TURNS", 100);
export const SNAPSHOT_MAX_FILES = num("SNAPSHOT_MAX_FILES", 200);
export const SNAPSHOT_MAX_FILE_BYTES = num("SNAPSHOT_MAX_FILE_BYTES", 1024 * 1024);

export const SYSTEM_PROMPT_APPEND = process.env.SYSTEM_PROMPT_APPEND || "";

export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
