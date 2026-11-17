# Grok Bot 1.1.0 transcript reads (2026-11-17)

The installed macOS app reports version 1.1.0. Its `Contents/Resources/app.asar`
SHA-256 is `2ce3b335f3d92c7be6ad59da397f8f6bf16c6d29474041ec5cc1e508b65b8e48`.
Only bundled code was read; no app files were changed. Offsets below are zero-based
character offsets in the UTF-8 decoded bundled files (minified, single line).

## App evidence

- `dist/electron-main/main-app.cjs`, offset 3214094: `resolveServerTranscriptTail`
  checks `sand_transcript_server_tail`, separately from the server roster capability.
- `dist/node-agent-coordinator/main.cjs`, offsets 1018172 and 1088460:
  `listGrokBotTranscriptEntries` receives `{agentId, limit: bounded + 1}` for the main
  session; other sessions include `sessionId`. Proto3 JSON omits the default session.
  Rows have base64 JSON bodies and sequence numbers; newest-first rows are reversed
  into chronological entries. Existing CLI decoding retains ids, authors, content,
  timestamps, nonces and request ids, and verifies store blob hashes.
- Coordinator offsets 1082977-1083545: the app retries omitted bodies individually
  before fetching blobs. The CLI retains its existing unreadable markers and cursor
  barrier; it does not promise complete approvals when row bodies are unavailable.
- Main app offset 3187649: creation uses `CreateGrokBotTemporalAgent`; fetched main
  already implements it. No live creation was attempted.
- Main app offset 3005612: user skills use `ListGrokBotUserSkills` and distinguish
  `heldOnBox`. Fetched main already falls back from box skills to the box store;
  server-held, team and plugin skills may be absent. No speculative mapping or skill
  edits were added. Approval listing already derives cards from the shared tail.

## Compatibility and validation

The installed iml1s.6 CLI still requires the removed box transcript route. Fetched
main `55f2153` already contains backend transcript/create/skills work from later
fork releases. This patch reuses it and repairs compatibility: try the box first,
then the backend only on a classified unroutable 404 with an access token. An auth
error, ordinary 404, or server error remains visible; backend failure never sends
or retries a prompt. A no-wake receipt routing rejection does not rebuild/wake the box; ordinary reads
still refresh a stale saved-login gateway before falling back.
Best-effort send receipts use the same reader but only inline bodies, so store
fetches cannot delay an already accepted send. Normal tail reads retain blob reads.

Live checks used the worktree launcher and a saved login. Thread returned 40 rows;
a second read after the last opaque id returned 0 rows with `gapReset: false`.
Reconcile without `--nonce` exited 2 at argument validation, as documented. No
message content, login credential, account id or private bot id is recorded here.
