FROM node:22-slim

WORKDIR /app

# ═══════════════════════════════════════════════════════════════════════════
# CORE — Blaxel sandbox + Claude Code SDK
# Required. Do not remove anything in this section.
# ═══════════════════════════════════════════════════════════════════════════

# Blaxel sandbox runtime API
COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api

# Minimal system dependencies for Claude Code + the agent runtime.
# `gosu` is used in build steps to drop to the agent user.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl bash netcat-openbsd gosu ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/usr/bin:/sbin:/bin"
ENV ANTHROPIC_MODEL="claude-sonnet-4-6"
ENV WORKSPACE_DIR="/workspace"

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Non-root runtime user. Created before any user-scoped Claude tooling so
# everything lands in /home/agent/.claude with the right ownership.
RUN useradd -m -d /home/agent agent \
    && mkdir -p /workspace /home/agent/.claude/skills \
    && chown -R agent:agent /workspace /home/agent


# ═══════════════════════════════════════════════════════════════════════════
# PLUGIN — MTHDS  (https://mthds.ai)
# Optional. Remove this entire section to drop MTHDS support.
# Slash commands: /mthds-build, /mthds-edit, /mthds-check, /mthds-fix, ...
# ═══════════════════════════════════════════════════════════════════════════

# Install the `mthds` npm package (provides `mthds` and `mthds-agent` CLIs
# that the slash-command skills shell out to), bootstrap the agent runtime,
# then register and install the plugin from the Claude marketplace.
RUN npm install -g mthds && npm cache clean --force
RUN gosu agent bash -lc '\
      mthds-agent bootstrap \
      && claude plugin marketplace add mthds-ai/mthds-plugins --scope user \
      && claude plugin install mthds@mthds-plugins --scope user'

# ═══════════════════════════════════════════════════════════════════════════
# /MTHDS
# ═══════════════════════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════════════════════
# SKILLS — gstack  (https://github.com/garrytan/gstack)
# Optional. Remove this entire section to drop gstack.
# Slash commands: /office-hours, /plan-ceo-review, /review, /qa, /ship, /cso, ...
#
# Removing gstack also lets you drop:
#   - `unzip` from the apt-get line below
#   - the entire `apt-get install` Chromium-libs block below
#   - the Bun install RUN
# ═══════════════════════════════════════════════════════════════════════════

# gstack-only system deps
# - unzip:                      Bun installer needs it
# - libnss3 ... libfontconfig1: Playwright Chromium runtime deps (so
#                               /browse, /qa, /design-review actually launch
#                               Chromium at runtime). Without these the
#                               build's Chromium-launch verification fails.
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libxkbcommon0 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    fonts-liberation libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*

# Bun — required by gstack's setup script. Installed system-wide so both root
# (build) and agent (runtime) can use it.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# Clone + run gstack's setup script.
#
# Why the `|| true` + post-check pattern:
# gstack's setup ends with a Chromium launch verification. When the image is
# built for linux/amd64 on an arm64 host (e.g. Apple Silicon under Docker
# Desktop), QEMU cannot launch amd64 Chromium and the verification fails —
# even though Chromium binaries, skills, and the browse binary all installed
# correctly. The verification passes natively on the Blaxel build host.
#
# We tolerate setup's non-zero exit and explicitly assert the artefacts that
# actually matter: the browse binary and at least one skill file.
RUN gosu agent bash -lc '\
      git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git \
        /home/agent/.claude/skills/gstack \
      && cd /home/agent/.claude/skills/gstack \
      && (./setup -q || echo "gstack: launch verification skipped (cross-arch build host)") \
      && test -x browse/dist/browse \
      && test -f office-hours/SKILL.md'

# ═══════════════════════════════════════════════════════════════════════════
# /gstack
# ═══════════════════════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════════════════════
# CORE (continued) — App code, project-level prompt, entrypoint
# ═══════════════════════════════════════════════════════════════════════════

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
