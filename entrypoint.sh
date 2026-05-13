#!/bin/bash
set -e

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Blaxel sandbox API — must run as root on port 8080.
/usr/local/bin/sandbox-api &
SANDBOX_API_PID=$!

# Wait for sandbox-api to bind.
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

# Diagnostics: how many plugin skill files are present.
if [ -d /home/agent/.claude/plugins ]; then
  SKILL_COUNT=$(find /home/agent/.claude/plugins -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
  echo "Plugin skills found: $SKILL_COUNT"
fi

# Start the agent server as the non-root user.
echo "Starting Claude sandbox server as user 'agent'..."
gosu agent /usr/local/bin/node /app/server/server.js &
AGENT_PID=$!

# Exit if EITHER process dies — Blaxel will restart us.
wait -n
echo "ERROR: a background process exited; shutting down"
kill $SANDBOX_API_PID $AGENT_PID 2>/dev/null || true
exit 1
