---
"grok-bot-cli": minor
---

Add `migrate inspect`, `export`, `plan`, `apply`, and `verify` for private, versioned Grok Bot snapshots and offline OpenClaw workspace staging. Export observed instructions, bounded transcript tails and workflow bodies with explicit limitations and safe partial-failure reporting. Verify hashes and source-to-destination bytes, refuse overwrite and unsafe archive paths, and require explicit consent before staging skill instructions. This does not restore full history, hidden memory, credentials or live runtime state, and does not activate destination agents.
