FROM node:22-slim

WORKDIR /app

# Blaxel sandbox runtime API.
# Provides filesystem and process APIs on port 8080. Required by Blaxel.
COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api

# Minimal system deps for Claude Code + the agent runtime.
# `gosu` lets the entrypoint drop from root to the `agent` user.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl bash netcat-openbsd gosu ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV ANTHROPIC_MODEL="claude-sonnet-4-6"
ENV WORKSPACE_DIR="/workspace"

# Claude Code CLI (provides the `claude` binary the SDK shells out to).
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Non-root runtime user. Created before any user-scoped Claude tooling so
# everything lands in /home/agent/.claude with the right ownership.
RUN useradd -m -d /home/agent agent \
    && mkdir -p /workspace /home/agent/.claude/plugins \
    && chown -R agent:agent /workspace /home/agent

# To install Claude Code marketplace plugins at build time, add lines like:
#
#   RUN gosu agent bash -lc '\
#         claude plugin marketplace add owner/repo --scope user \
#         && claude plugin install plugin-name@repo --scope user'
#
# `src/plugins.mjs` discovers anything installed under
# /home/agent/.claude/plugins and registers it with the Agent SDK.

# App code, project-level prompt, entrypoint.
COPY CLAUDE.md /home/agent/.claude/CLAUDE.md
RUN chown agent:agent /home/agent/.claude/CLAUDE.md

COPY package.json /app/package.json
COPY server.mjs /app/server.mjs
COPY src /app/src
RUN npm install --omit=dev && npm cache clean --force \
    && chown -R agent:agent /app

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
