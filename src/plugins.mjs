/**
 * Plugin discovery for the Claude Agent SDK.
 *
 * No plugins are installed by default in this template. To add one, append a
 * `claude plugin install ...` line to the Dockerfile — the discovery here will
 * pick it up automatically and pass it to the SDK in `query()`'s options.
 *
 * Plugins are typically installed at image build time as `root` and run at
 * runtime as `agent`. The `installed_plugins.json` file records install paths
 * using the build-time user, so we remap `/root/...` -> `/home/agent/...` when
 * needed. If the manifest is missing or empty we fall back to scanning the
 * plugin cache directory.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLUGINS_INSTALLED_PATH,
  PLUGINS_CACHE_DIR,
  log,
} from "./config.mjs";

export function discoverPlugins() {
  const plugins = [];

  if (existsSync(PLUGINS_INSTALLED_PATH)) {
    try {
      const data = JSON.parse(readFileSync(PLUGINS_INSTALLED_PATH, "utf-8"));
      for (const [id, installs] of Object.entries(data.plugins || {})) {
        for (const install of installs) {
          const pluginPath = (install.installPath || "").replace(
            /^\/root\//,
            "/home/agent/",
          );
          if (pluginPath && existsSync(pluginPath)) {
            plugins.push({ type: "local", path: pluginPath });
            log(`[plugins] discovered ${id} -> ${pluginPath}`);
          } else if (pluginPath) {
            log(`[plugins] missing path for ${id}: ${pluginPath}`);
          }
        }
      }
    } catch (err) {
      log(`[plugins] failed to read ${PLUGINS_INSTALLED_PATH}:`, err.message);
    }
  }

  if (plugins.length === 0 && existsSync(PLUGINS_CACHE_DIR)) {
    try {
      for (const entry of readdirSync(PLUGINS_CACHE_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const pluginPath = join(PLUGINS_CACHE_DIR, entry.name);
          plugins.push({ type: "local", path: pluginPath });
          log(`[plugins] discovered (cache fallback) ${pluginPath}`);
        }
      }
    } catch (err) {
      log(`[plugins] cache scan failed:`, err.message);
    }
  }

  return plugins;
}

/**
 * Discovered once at module load. Cached because plugin discovery does
 * filesystem reads and never changes during the process lifetime.
 */
export const DISCOVERED_PLUGINS = discoverPlugins();
