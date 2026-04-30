# Editor-synced workspace

The single most important concept in this template. If your product has a
chat panel on one side and a code editor on the other, both touching the
same files, this is the pattern that keeps them in sync without races,
diffs, or merge logic.

## The problem

Without sync, you have two competing copies of "the truth":

- **Editor's copy** — what the user is typing in their browser.
- **Container's filesystem** — what Claude sees when it runs `Read`, `Edit`,
  `Bash`, etc.

If those drift, everything breaks:

- User types a change in the editor → Claude doesn't see it, edits the
  stale version → conflict.
- Claude writes a new file → editor doesn't know it exists.
- User deletes a file in the editor → Claude keeps "remembering" it from
  a previous turn.

You need a rule for who wins, and when.

## The rule

> **Editor wins at the start of every turn. Container wins at the end.**

```
Frontend                                Server                              Claude (SDK)
   │                                       │                                   │
   │── POST /chat (files=[…]) ────────────▶│                                   │
   │                                       │── syncWorkspace ──────────┐       │
   │                                       │   (wipe contents,         │       │
   │                                       │    write all files as     │       │
   │                                       │    sent)                  │       │
   │                                       │                                   │
   │                                       │── start agent turn ──────────────▶│
   │                                       │                                   │ reads/edits files
   │                                       │◀─── SSE: message events ──────────│
   │◀──────────── stream forwarded ────────│                                   │
   │                                       │                                   │ … finishes
   │                                       │◀── result message ────────────────│
   │                                       │── readWorkspaceSnapshot ──┐       │
   │                                       │   (recursive read of      │       │
   │                                       │    the workspace as       │       │
   │                                       │    [{path,content}, …])   │       │
   │◀── SSE: files (snapshot) ─────────────│                                   │
   │◀── SSE: message (result) ─────────────│                                   │
   │                                       │                                   │
   │  (editor replaces local state)        │                                   │
```

## Why it works

- **No drift.** The container's filesystem is rebuilt from the editor's
  state every single turn. There's no "what does Claude think the file
  looks like vs what I see" question — they're identical at the moment
  Claude starts working.
- **Anything Claude writes shows up in the editor.** The end-of-turn
  snapshot is the authoritative result. The frontend overwrites its local
  state with it.
- **Anything the user deletes stays deleted.** No turn-to-turn ghost
  files. If it's not in the next request's `files`, it doesn't exist.
- **No file watcher needed.** No inotify, no debouncing, no race conditions.
  Just two boundaries, both clean.

## What the frontend has to do

Three responsibilities, no more:

1. Keep the editor's current file list in memory.
2. On every send, include all of them in
   `files: [{ path, content }, …]`.
3. When `event: files` arrives, replace the editor state with that
   snapshot.

No diffing. No patches. No three-way merges.

## What the server does

`src/workspace.mjs` exposes three functions, each with one responsibility:

| Function                  | Called by                  | What it does                                                       |
|---------------------------|----------------------------|--------------------------------------------------------------------|
| `safeWorkspacePath(rel)`  | `syncWorkspace`            | Resolves a caller-supplied relative path against `WORKSPACE`. Refuses absolute paths, `..` traversal, and null bytes. Throws on violation. |
| `syncWorkspace(files)`    | `routes.handleChat`        | Wipes workspace contents, then writes each `{path, content}` from the request. Returns the list of paths actually written. |
| `readWorkspaceSnapshot()` | `session.AgentSession._consume` (on `result`) | Recursively reads the workspace and returns `[{path, content}, …]`. Bounded by `SNAPSHOT_MAX_FILES` and `SNAPSHOT_MAX_FILE_BYTES`. |

### Why `syncWorkspace` empties contents instead of removing the root

The runtime user (`agent`) has write permission *inside* `WORKSPACE` but
not on its parent (`/`). So `rmSync(WORKSPACE)` would `EACCES` —
removing a directory requires write permission on its parent. The
implementation iterates `readdirSync(WORKSPACE)` and removes each entry,
leaving the root directory itself in place.

### Path safety

`safeWorkspacePath` rejects:

- Absolute paths (`/etc/passwd`)
- Paths containing `..` segments
- Null-byte injection
- Empty strings or non-strings

A request with `files: [{ path: "../../etc/passwd", content: "x" }]`
fails fast with a 400 before anything is written.

It does **not** currently follow / refuse symlinks inside the workspace.
If the agent itself creates a symlink during a turn, a subsequent
`syncWorkspace` could in principle write through it. In practice the
wipe step removes any symlinks the previous turn created before the
write step runs, so the window is closed by construction. If you change
the wipe semantics, revisit this.

### Snapshot bounds

The recursive walk in `readWorkspaceSnapshot` enforces two caps:

- **`SNAPSHOT_MAX_FILES`** (default 200) — stop walking after this many
  files. Protects you if the agent runs `git clone` or `npm install`
  inside the workspace.
- **`SNAPSHOT_MAX_FILE_BYTES`** (default 1 MiB) — skip individual files
  larger than this. The user's editor probably can't display a 50 MB
  binary anyway, and the SSE payload would be enormous.

Files exceeding the size cap are silently skipped. Walks that hit the
file count cap stop returning new files but don't error. If you need
to surface either signal to the frontend, add a counter.

## Edge cases & gotchas

### Concurrent `/chat` on the same session

Two browser tabs POST `/chat` with the same `sessionId` simultaneously.
Both `syncWorkspace` calls run, both feed messages to the same SDK
session. Behavior: undefined-ish — whichever request's sync finishes
last wins, and the agent gets two user messages back-to-back.

This template doesn't lock per-session. If your product can have
multiple tabs writing to one session, add a per-`sessionId` async lock
around `handleChat` or reject with 409 when a turn is in flight.

### Binary files

`writeFileSync(dest, content, "utf-8")` and the snapshot's
`readFileSync(full, "utf-8")` both assume text. If you push a JPEG
through `files`, it round-trips through UTF-8 and corrupts.

If you need binary files, either:

- Pass them as `attachments` (opaque URIs), not workspace files.
- Or extend `files` with an optional `encoding: "base64"` field and
  decode on write / encode on snapshot.

### Files the agent expects but the user didn't send

If the agent's previous turn referenced `package.json` and the user
didn't include it in the next `files`, it's gone. The agent will see
`Read("/workspace/package.json")` fail with ENOENT.

The fix is a frontend responsibility: when displaying the editor,
collect all files the user has open (or all files the agent has touched)
and include them in every send. The pattern only works if the editor's
"source of truth" is comprehensive.

### Files the agent creates inside `node_modules`-style directories

If your workspace ends up with `node_modules/`, the recursive snapshot
walks into it. With 200-file and 1 MiB caps you won't ship the whole
thing, but you might fill the snapshot quota with package internals
instead of the user's actual files.

If you let the agent run installers, either:

- Configure higher caps and accept the bandwidth.
- Or filter the snapshot — add a `SNAPSHOT_IGNORE` env var and skip
  matching paths in `readWorkspaceSnapshot`'s walker.

## When you don't need this pattern

The sync is opt-in by virtue of whether you populate `files`.

- Pass `files: []` (or omit it) and the workspace is just empty scratch
  space the agent can use however it wants.
- Don't subscribe to `event: files` if you don't need to surface what
  the agent wrote.

Use cases that don't need editor sync:

- A pure conversation agent (no files involved).
- An agent that produces a single final answer, not editable artefacts.
- An agent that operates on inputs the user uploads once and doesn't
  edit (use `attachments` instead).

For anything else — IDE-style products, doc editors, `.mthds` builders,
notebooks — this is the pattern.

## Tunables

All in `src/config.mjs`, all overridable via env:

| Var                       | Default       | Effect                                       |
|---------------------------|---------------|----------------------------------------------|
| `WORKSPACE_DIR`           | `/workspace`  | Where the workspace lives in the container.  |
| `SNAPSHOT_MAX_FILES`      | `200`         | Cap on files in end-of-turn snapshot.        |
| `SNAPSHOT_MAX_FILE_BYTES` | `1048576`     | Per-file size limit for snapshots.           |
| `MAX_BODY_BYTES`          | `10485760`    | Cap on the incoming `/chat` body. Limits how much you can sync per turn. |
