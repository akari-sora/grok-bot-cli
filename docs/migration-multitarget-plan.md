# Multi-target migration: Hermes, Muse, dot and portable data

Date: 2026-11-08 (Asia/Taipei). Extends MR !13; the version-1 source archive remains unchanged.

## Decision and scope

Keep capture and offline conversion in grok-bot-cli. Keep authenticated messaging, seat selection, nonce/readback and the send ledger in the existing trinity-cli/muse-web-cli/chatgpt-dot-cli tools. Trinity is optional delivery plumbing, not a dependency of backup, Hermes import preparation or archive verification. Do not add another credential reader, a new Hermes seat solely for file import, or a bulk auto-send loop.

Targets:

| Target | Result | Trinity |
| --- | --- | --- |
| openclaw | Existing create-only workspace staging, byte-compatible with previous v1 output | Not required |
| hermes | Official `grok-bot-export` input; source roles become skills in one existing agent | Not required |
| muse | Ordered, bounded UTF-8 context handoff packets plus a complete observed archive | Optional reviewed `ask muse` |
| dot | Same context handoff contract, targeted to dot | Optional reviewed `ask dot` |
| portable | Platform-independent observed snapshot with integrity verification | Not required |

No target claims native history, learned-memory restoration, running routines or account credentials. Muse/dot packets are not a native importer. Successful delivery would not establish durable memory.

## Primary research and code inspection

Hermes now explicitly supports Grok Bot through its official agent-importers plugin. The normal source export is manual (ask each Bot for JSON); this CLI can generate a compatible input directly from observed data. Do not route through OpenClaw or invent another Hermes importer.

- https://hermes-agent.nousresearch.com/docs/user-guide/import-from-other-agents
- https://hermes-agent.nousresearch.com/marketplace/agent-importers
- Official source pin: NousResearch/hermes-official-plugins commit `13b2c1c9c8204bf333df240b2aacf98c3e6250b7`, agent-importers/grok_bot.py blob `195d0ceca1cdebc79343dcf0f0163bb83f417716`.

The upstream parser merges bots by lowercase name. To avoid duplicate-name collisions and persona blending, emit one import bundle with stable source-ID-derived role/skill names and empty host instructions, memory, user facts, routines and apps. Original data stays in archive/snapshot.json and ROLE-MAP.json. Existing workflow text is included only with --include-skills; source explicit role instructions always become opt-in task-role skills. Missing routine timezone/instruction fields are not guessed from a cron string.

Inspected user repositories: trinity-cli README and trinity_cli/seats/muse.py; muse-web-cli README. Trinity's `hand` forwards one previous message, not an archive. `brief push` does not write Muse instructions. Muse memory is read-only. `ask muse` accepts stdin at the top level but currently forwards text as a muse-web-cli positional argv argument; therefore no end-to-end argv secrecy claim is made. A fresh ask gets a new nonce and is not a persistent deduplication retry. Do not automatically deliver private archives in this implementation session.

## Implementation and validation gates

1. Pure target registry/converters; no network, subprocess or account access.
2. Reuse the existing create-only archive publisher and exact source-to-output verifier. Preserve legacy OpenClaw output bytes and manifests. New target formats are explicit and allowlisted.
3. Add `migrate targets` and extend plan/apply target schemas. Verify identifies the staged target from its manifest.
4. Tests: one-agent Hermes role mapping; duplicate source names; absent memory; workflow opt-in; no routine guesses; complete UTF-8 chunk reconstruction; stable per-part digests; safe paths; deterministic output; source preservation; target tampering; generated CLI round trips.
5. Execute a pinned upstream Hermes parser contract against generated inputs. Keep this separate from a live Hermes runtime test; network/download failure is a failing gate, never a skipped pass.
6. Run full existing build/type/unit/route checks in CI and document actual results. No live source login or destination chat is available here; do not label synthetic tests as real-account validation.

## Deferred integration work

Direct native Muse memory/session/skill import needs a verified supported write interface; current repositories do not provide one. A richer future Trinity migration delivery command should use a persistent source-digest ledger, explicit source/destination selection, strict current-chat checks and end-to-end stdin support in muse-web-cli. That is separate from the offline target conversion in this change. No trinity-cli code change is required to use its existing reviewed one-message stdin handoff.
