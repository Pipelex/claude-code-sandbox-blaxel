-include .env
IMAGE_NAME := claude-sandbox

# ── Setup ──────────────────────────────────────────────────────────────────
install:
	npm install

# ── Quality checks ─────────────────────────────────────────────────────────
# `make check` runs lint, format, and type checks. Fails on any violation.
# `make fix` applies all auto-fixable lint and format issues.
check: check-lint-format check-types

check-lint-format:
	npx biome check .

check-types:
	npx tsc --noEmit

fix:
	npx biome check --write .

# ── Local development ──────────────────────────────────────────────────────
build:
	docker build --platform linux/amd64 -t $(IMAGE_NAME) .

run: build
	docker run --rm -p 4100:4100 \
		-e ANTHROPIC_API_KEY=$(ANTHROPIC_API_KEY) \
		-e PIPELEX_API_KEY=$(PIPELEX_API_KEY) \
		$(IMAGE_NAME)

# ── Blaxel deployment ──────────────────────────────────────────────────────
# Requires the `bl` CLI and a configured Blaxel workspace.
deploy:
	bl deploy -e .env

.PHONY: install check check-lint-format check-types fix build run deploy
