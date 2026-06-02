# Blaxel sandbox-api binary lives in this base image. The default is `latest`
# for convenience. For reproducible builds, override at build time with a
# specific tag or digest, e.g.:
#   docker build --build-arg SANDBOX_VERSION=sha256:abc123... .
ARG SANDBOX_VERSION=latest
FROM ghcr.io/blaxel-ai/sandbox:${SANDBOX_VERSION} AS sandbox-api

FROM node:22-slim

WORKDIR /app

# Pull the sandbox-api binary from the base image stage. Required by Blaxel —
# provides filesystem and process APIs on port 8080.
COPY --from=sandbox-api /sandbox-api /usr/local/bin/sandbox-api

# Minimal system deps for Claude Code + the agent runtime.
# `gosu` lets the entrypoint drop from root to the `agent` user.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl bash netcat-openbsd gosu ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV WORKSPACE_DIR="/workspace"

# `ANTHROPIC_MODEL` is intentionally NOT baked here. Provider/model selection
# happens at runtime via `.env` (secrets) and `blaxel.toml`'s `[env]` block
# (non-secret defaults). See the "Provider auth" section in README.md.

# Claude Code CLI (provides the `claude` binary the SDK shells out to).
# Pinned to a known-good version for reproducible builds.
ARG CLAUDE_CODE_VERSION=2.0.77
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

# Non-root runtime user. Created before any user-scoped Claude tooling so
# everything lands in /home/agent/.claude with the right ownership.
RUN useradd -m -d /home/agent agent \
    && mkdir -p /workspace /home/agent/.claude/plugins \
    && chown -R agent:agent /workspace /home/agent

# This image stays generic on purpose. Consumers extend Claude's capabilities
# from the OUTSIDE (no image fork needed) by writing skill files into the
# running container via Blaxel's `sandbox.fs.write` API — the SDK auto-
# discovers them via `settingSources: ["user", "project"]`.
# See template-chatbot-claudecode for a working demo of this pattern.

# Agent server source — installs deps inside /app/server and runs from there.
COPY server /app/server
RUN cd /app/server && npm install --omit=dev && npm cache clean --force \
    && chown -R agent:agent /app

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
