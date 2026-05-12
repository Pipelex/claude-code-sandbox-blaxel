#!/usr/bin/env bash
# Smoke tests for the claude-code sandbox image.
#
# Usage:
#   tests/smoke.sh                   # uses http://localhost:4100
#   tests/smoke.sh http://host:port  # custom URL
#
# Requires: docker run -p 4100:4100 --env-file .env claude-code, then this.
# The sandbox must have a valid ANTHROPIC_API_KEY (or Bedrock vars) in env.

set -euo pipefail

URL="${1:-http://localhost:4100}"
PASS=0
FAIL=0

ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo "Smoke testing $URL"

# ── /health ──────────────────────────────────────────────────────────────
echo
echo "[1] GET /health"
body=$(curl -sf "$URL/health")
if [ "$(echo "$body" | jq -r .status)" = "ok" ]; then
  ok "returns {status:'ok'}"
else
  fail "expected {status:'ok'}, got $body"
fi

# ── /chat happy path ─────────────────────────────────────────────────────
echo
echo "[2] POST /chat — happy path"
log=$(mktemp)
curl -sN -X POST "$URL/chat" \
  -H 'Content-Type: application/json' \
  --max-time 60 \
  -d '{"sessionId":"smoke-1","content":"Reply with exactly: SMOKE-OK"}' \
  > "$log"
result=$(grep '"type":"result"' "$log" | head -1 | sed 's/^data: //' | jq -r .result 2>/dev/null || echo "")
if [ "$result" = "SMOKE-OK" ]; then
  ok "Claude replied 'SMOKE-OK'"
else
  fail "expected 'SMOKE-OK', got '$result' (events: $(grep -c '^event:' "$log"))"
fi
rm -f "$log"

# ── /chat session resume ─────────────────────────────────────────────────
echo
echo "[3] POST /chat — session resume (same sessionId)"
log=$(mktemp)
curl -sN -X POST "$URL/chat" \
  -H 'Content-Type: application/json' \
  --max-time 60 \
  -d '{"sessionId":"smoke-1","content":"What word did I ask you to reply with last turn?"}' \
  > "$log"
result=$(grep '"type":"result"' "$log" | head -1 | sed 's/^data: //' | jq -r .result 2>/dev/null || echo "")
# Claude usually answers "SMOKE-OK" or quotes it; accept any reply that contains it
if echo "$result" | grep -q "SMOKE-OK"; then
  ok "session resumed (Claude remembered previous turn): '$result'"
else
  fail "session resume failed: '$result'"
fi
rm -f "$log"

# ── 400 on missing content ───────────────────────────────────────────────
echo
echo "[4] POST /chat — missing content returns 400"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/chat" \
  -H 'Content-Type: application/json' -d '{"sessionId":"x"}')
if [ "$code" = "400" ]; then
  ok "400 on missing content"
else
  fail "expected 400, got $code"
fi

# ── 400 on malformed JSON ────────────────────────────────────────────────
echo
echo "[5] POST /chat — malformed JSON returns 400"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/chat" \
  -H 'Content-Type: application/json' -d 'not-json')
if [ "$code" = "400" ]; then
  ok "400 on malformed JSON"
else
  fail "expected 400, got $code"
fi

# ── 413 on oversize body ─────────────────────────────────────────────────
echo
echo "[6] POST /chat — 11 MiB body returns 413"
code=$(python3 -c "import sys,json; sys.stdout.write(json.dumps({'sessionId':'x','content':'x'*11534336}))" \
  | curl -s -o /dev/null -w "%{http_code}" -X POST "$URL/chat" \
      -H 'Content-Type: application/json' --data-binary @-)
if [ "$code" = "413" ]; then
  ok "413 on oversize body"
else
  fail "expected 413, got $code"
fi

# ── 404 on unknown route ─────────────────────────────────────────────────
echo
echo "[7] GET /nope — returns 404"
code=$(curl -s -o /dev/null -w "%{http_code}" "$URL/nope")
if [ "$code" = "404" ]; then
  ok "404 on unknown route"
else
  fail "expected 404, got $code"
fi

# ── Route matches with a query string ───────────────────────────────────
# Blaxel private-preview auth appends ?bl_preview_token=... to every URL,
# so the route dispatcher MUST tolerate a query string on /health and /chat.
echo
echo "[7b] GET /health?bl_preview_token=fake — still 200"
code=$(curl -s -o /dev/null -w "%{http_code}" "$URL/health?bl_preview_token=fake")
if [ "$code" = "200" ]; then
  ok "200 on /health with query string"
else
  fail "expected 200, got $code (query string broke route matching — see Blaxel preview-token auth)"
fi

# ── Abort propagation on client disconnect ───────────────────────────────
# Starts a /chat, kills curl after 1s (forces client disconnect mid-stream),
# then sends a follow-up /chat. If the server cleanly aborted the prior SDK
# run, the follow-up succeeds quickly. If the abort hangs or leaks state,
# the follow-up either times out or comes back wrong.
echo
echo "[8] POST /chat — client disconnect aborts the SDK"
# Start a long-running chat in the background, kill it after 1s.
( curl -sN -X POST "$URL/chat" \
  -H 'Content-Type: application/json' \
  --max-time 1 \
  -d '{"sessionId":"abort-1","content":"Count slowly from 1 to 100, one number per line."}' \
  > /dev/null 2>&1 ) || true
sleep 2
# Server should be ready to handle a new request.
log=$(mktemp)
curl -sN -X POST "$URL/chat" \
  -H 'Content-Type: application/json' \
  --max-time 30 \
  -d '{"sessionId":"abort-2","content":"Reply with: ABORTED-CLEANLY"}' \
  > "$log"
result=$(grep '"type":"result"' "$log" | head -1 | sed 's/^data: //' | jq -r .result 2>/dev/null || echo "")
if [ "$result" = "ABORTED-CLEANLY" ]; then
  ok "server still responsive after client disconnect (got '$result')"
else
  fail "server broken after disconnect; expected 'ABORTED-CLEANLY', got '$result'"
fi
rm -f "$log"

# ── Summary ──────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────"
echo "  PASS: $PASS    FAIL: $FAIL"
echo "─────────────────────────────────────────"

[ "$FAIL" -eq 0 ]
