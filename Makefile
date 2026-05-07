# ── Setup ──────────────────────────────────────────────────────────────────
install:
	npm install

# ── Quality checks ─────────────────────────────────────────────────────────
check:
	npx biome check .
	npx tsc --noEmit

fix:
	npx biome check --write .

# ── Local Docker ───────────────────────────────────────────────────────────
# Builds the image and runs it locally with env from .env.
# Run them separately so what they each do is obvious.
build:
	docker build --platform linux/amd64 -t claude-sandbox .

run:
	docker run --rm -p 4100:4100 --env-file .env claude-sandbox

# ── Blaxel deployment ──────────────────────────────────────────────────────
# Builds the image on Blaxel's build host and registers the sandbox image so
# agents (e.g. template-chatbot-claudecode) can spawn instances of it.
deploy:
	bl deploy -e .env

.PHONY: install check fix build run deploy
