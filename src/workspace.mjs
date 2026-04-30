/**
 * Editor-synced workspace operations.
 *
 *   syncWorkspace(files)         — wipe-and-write the workspace from caller files
 *   readWorkspaceSnapshot()      — read the workspace back as { path, content }[]
 *   safeWorkspacePath(relPath)   — resolve a caller-supplied path, refusing escapes
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import {
  WORKSPACE,
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_MAX_FILE_BYTES,
  log,
} from "./config.mjs";

/**
 * Resolve a caller-supplied relative path against the workspace, refusing
 * anything that escapes the workspace root via "..", absolute paths, or
 * null bytes.
 */
export function safeWorkspacePath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  if (relPath.startsWith("/") || relPath.includes("\0")) {
    throw new Error(`unsafe path: ${relPath}`);
  }
  const resolved = resolve(WORKSPACE, relPath);
  const rel = relative(WORKSPACE, resolved);
  if (rel.startsWith("..") || rel === "" || rel.split(sep).includes("..")) {
    throw new Error(`path escapes workspace: ${relPath}`);
  }
  return resolved;
}

/**
 * Reset the workspace to mirror exactly the files supplied by the caller.
 * Returns the list of relative paths actually written.
 *
 * Empties workspace contents without removing the root directory itself —
 * the runtime user (`agent`) does not have write permission on the parent
 * of WORKSPACE (typically `/`), so `rmSync(WORKSPACE)` would EACCES.
 */
export function syncWorkspace(files) {
  if (existsSync(WORKSPACE)) {
    for (const entry of readdirSync(WORKSPACE)) {
      rmSync(join(WORKSPACE, entry), { recursive: true, force: true });
    }
  } else {
    mkdirSync(WORKSPACE, { recursive: true });
  }

  const written = [];
  if (!Array.isArray(files)) return written;

  for (const file of files) {
    if (!file || typeof file.path !== "string" || file.content == null) continue;
    const dest = safeWorkspacePath(file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, String(file.content), "utf-8");
    written.push(file.path);
  }
  return written;
}

/**
 * Recursively read the workspace and return [{ path, content }, ...].
 * Skips files exceeding SNAPSHOT_MAX_FILE_BYTES; stops after
 * SNAPSHOT_MAX_FILES entries to bound memory.
 */
export function readWorkspaceSnapshot() {
  const out = [];
  if (!existsSync(WORKSPACE)) return out;

  function walk(dir) {
    if (out.length >= SNAPSHOT_MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      log("[snapshot] readdir failed:", dir, err.message);
      return;
    }
    for (const entry of entries) {
      if (out.length >= SNAPSHOT_MAX_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = statSync(full);
          if (stat.size > SNAPSHOT_MAX_FILE_BYTES) continue;
          const content = readFileSync(full, "utf-8");
          out.push({ path: relative(WORKSPACE, full), content });
        } catch (err) {
          log("[snapshot] read failed:", full, err.message);
        }
      }
    }
  }

  walk(WORKSPACE);
  return out;
}
