#!/bin/sh
set -e

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ── Blaxel sandbox API (must run as root, port 8080) ──────────────────────
/usr/local/bin/sandbox-api &

echo "Waiting for sandbox-api..."
i=0
while ! nc -z 127.0.0.1 8080; do
  i=$((i+1))
  if [ "$i" -gt 100 ]; then
    echo "ERROR: sandbox-api did not become ready in 10s"
    exit 1
  fi
  sleep 0.1
done
echo "sandbox-api ready"

# Ensure runtime dirs exist with correct ownership.
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
mkdir -p "$WORKSPACE_DIR" /home/agent/.claude
chown -R agent:agent "$WORKSPACE_DIR" /home/agent

# ── Diagnostics ────────────────────────────────────────────────────────────
if [ -d /home/agent/.claude/plugins ]; then
  SKILL_COUNT=$(find /home/agent/.claude/plugins -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
  echo "Plugin skills found: $SKILL_COUNT"
fi

# ── MTHDS runner: configure Pipelex API as default runner ─────────────────
# Synchronous + visible so any setup failure surfaces in container logs and
# the runner is configured before the agent server accepts requests.
if [ -n "$PIPELEX_API_KEY" ]; then
  echo "Configuring MTHDS API runner..."
  gosu agent mthds-agent runner setup api \
    --api-key "$PIPELEX_API_KEY" \
    --api-url "https://app-staging.pipelex.com"
  gosu agent mthds runner set-default api
fi

# ── Start the agent server as the non-root user ───────────────────────────
echo "Starting Claude sandbox server as user 'agent'..."
gosu agent /usr/local/bin/node /app/server.mjs &

# Keep the container alive — sandbox-api and the agent server both need to run.
wait
