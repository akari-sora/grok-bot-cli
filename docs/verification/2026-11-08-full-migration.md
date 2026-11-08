# Full migration verification — 2026-11-08

Time zone Asia/Taipei. Real source → real destinations on the maintainer's Mac. This records what was run (Deploy QA with grok-bot-cli `4ac07c4`, trinity-cli `3c2d2dc`; the demo bot with the round-2 code: grok-bot-cli `6ef691a`, trinity-cli `94092a5`, muse-web-cli `19a0c34`, chatgpt-dot-cli `5f4b383`), what passed, what failed first, and why. Later commits answer the third review and are covered by the automated tests below. The earlier records from the same day (`2026-11-08-migration*.md`) describe the first design and are superseded.

## Source: Grok Bot, read-only

`gbot migrate capture --account A --bot "Deploy QA"` → archive `deploy-qa-20261108-063453`.

- The session is backend-only: no box describe or wake call is made (unit-tested: zero requests before the first allowlisted read).
- Requests follow the Grok Bot app: transcripts paged at 500 + 1 rows, store blobs read 8 at a time (the app's `node-agent-coordinator` uses the same values).

| Area | Result |
| --- | --- |
| Transcript | complete: 903 rows in 2 pages, 749 user/assistant messages, 24 sequence numbers with no row, 0 unreadable |
| Automations | 5 (1 cron `52 9-21 * * 1-5` Asia/Taipei, 4 GitHub events), all off in Grok Bot |
| Todos | 52 (2 open: telltale !65, !82) |
| Memory | own profile and logs, plus the shared user-memory shards (11 user facts) |
| Skills | 103 user skills, whole folders (the library is shared by every bot of the login) |
| Files | 360 box files and 7 links; 14 not captured (9 larger than 8 MiB, 5 credential paths) |
| Server memory API | 403 (team bots only); personal memory comes from the box store |

## Hermes (Hermes Agent 0.21.5, default model gpt-6-luna)

The earlier test profile was exported (`~/.hermes/profile-exports/grok-deploy-qa-20261108-143430.tar.gz`, mode 600) and deleted first: the first design had copied two SQLite files with tokens inside into it. Then `gbot migrate import ARCHIVE --to hermes --yes` created `grok-deploy-qa` again.

- Read back through Hermes' own code — **7/7**: role, 11 user facts, 11 memory entries (now including the routine notes the old code dropped), 103 skills, 1 cron job paused with the original schedule and time zone (tagged with its routine id), 749 messages with matching content digests, 358 files with matching digests (the 2 SQLite files with tokens are reported, not copied).
- Acceptance with `hermes -p grok-deploy-qa -z` — **7/7**.
- A scan of all 1,050 files in the profile for token formats finds one file: Hermes' own bundled skill `autonomous-ai-agents/hermes-agent` (installed with Hermes, placeholder values like `ghp_xx…`), nothing written by the migration.

## Muse and Your dot: one zip each

`gbot migrate import ARCHIVE --to muse --yes` and `--to dot --yes` (default `--via auto` → upload).

- The handoff folder: 366 files, 11.1 MB zip (full history, the whole skill library, 358 box files, README, ROLE, MEMORY, TASKS, ROUTINES, SKILLS, HISTORY, MANIFEST.txt). Delivery: **2 messages** per destination (the zip, then the long-term pointer), sent at least 20 s apart, each after the previous reply.
- Muse: `muse-web-cli send --attach` uploaded the zip in the Muse window into the side chat "Grok Bot · Deploy QA". Your dot: `chatgpt-dot-cli send --attach` uploaded it to the dot's room and sent it with the message, as the dot app does.
- Digest check (the agent runs a read-only command; salted SHA-256 per part, exact bytes): **10/10 parts** on both.
- Questions: first run 5/8 on Muse and 6/8 on the dot. All failures were in the questions, not the migration (the answers were right):
  1. the memory question expected an account name instead of the folder the agent was told to remember;
  2. the skill question took a keyword from anywhere in the file, not from the first steps it asked for;
  3. the history question took its keyword from a message whose token was redacted in HISTORY.md (that also put a raw value into the local plan file); its second form ("the first message without a redacted part") had a different right answer than the one the plan picked.
- After `d1a00bf` and `4ac07c4` (keywords only from delivered, redacted text; one message named by its minute), `gbot migrate check ARCHIVE --to muse|dot --accept` — which sends no migration message — gave **8/8 on Muse** (in a new side chat, deleted afterwards) and **8/8 on the dot**.

Re-migrated with the final code (folder `~/grok-bot/Deploy-QA-bbb15179`, the earlier `~/grok-bot/Deploy-QA` copy is left on their computers): **Muse through your Google Drive** (`--via drive --drive-remote trinity-gdrive:`; the zip went to Drive with rclone, MD5-checked, Muse fetched it with its Google Drive connector, the Drive copy was removed after verification) — 7/7; **Your dot** with the attachment — 7/7. Before building the Drive channel, both agents were probed: each read a text file and fetched, unzipped and counted a 4 MB zip from Drive correctly.

## A second real bot, recorded for the demo

"Demo · Trip Planner" was created on account A with `gbot bots create` (backend, as the app does; verified live), given four plain-language messages (preferences, a Kyoto plan, a to-do, a routine left off) one at a time at least 20 s apart, then migrated with the guided `gbot migrate` and recorded (`demo/gbot-migrate-*.gif`):

- Capture: 17 messages, 1 routine (off), 3 to-dos (1 open), 103 skills, 321 box files.
- Hermes, new profile `grok-demo`: read back 7/7 (role, 3 user facts, 4 memory entries, 103 skills, 1 paused cron job, 17 messages, 321 files), acceptance 5/5 (user facts on the second try); asked afterwards, the bot named the open hotel task and that nothing was booked.
- Muse: 4.2 MB zip, 329 files, 2 messages; 6/6 in a new chat. Your dot: the same zip; 6/6.

## Earlier runs on the same day (first design, file by file in chat)

They found the problems the current design answers: Muse replying "saved" without writing Memory.md; a dot replying "saved" although its own review blocked the write; the dot's own alerts taken as answers; a token after a JSON `\n` that escaped redaction; Muse compiling a migrated script (`__pycache__`). Chat delivery is still available (`--via chat`); with the same checks it reached 9/9 digests and 7/7 questions on both.

## Strict review

Codex (gpt-6-astra, max reasoning, read-only) reviewed all four repos in rounds until the findings converged:

- Round 1 — request changes: secrets across chunk boundaries, destination path escape, Hermes ownership, `check` running an import, a transcript cut short by a capped page, and more. Fixed in `960fb63` and the matching trinity, muse-web-cli and chatgpt-dot-cli commits.
- Round 2 — round-1 items 1, 4 and 11 closed; new findings: UTF-16 tokens and token-shaped file names, a credential read before selection, folder collisions, the Hermes write race, Muse receipts and chat ownership, digest answers matched loosely. Fixed in `7fb2da7`, `6ef691a`, trinity `94092a5`, muse-web-cli `19a0c34`, chatgpt-dot-cli `5f4b383`.
- Round 3 — items 1, 3, 4, 5 and 11 closed; four narrower blockers left (memory files decoded before the byte check, the SOUL write race, Muse after-Enter failures and interleaving, chat delivery of skill scripts and the memory question). Fixed in `50114e7`, `970c33e`, muse-web-cli `3db0982`, trinity `a60dda7`.
- Round 4 — B2, B3b and B4 closed; two left: a long UTF-16 memory file (no NUL in its first 8 KiB) passed as text, and three more ways a Muse send after Enter was recorded as not sent. Fixed in `3b89c6a`, muse-web-cli `75507b8`, trinity `f37e7a0`.
- Round 5 — **can merge**: B1 and all four after-Enter cases closed (reproduced through the real CLI → seat → migration chain), no new blocker. Its one should-fix (a marked rate-limit reply after another message) is fixed in trinity `b95f07b`. Deferred by agreement: SHA binding inside the two senders, per-item conflicts in preview, `hermes cron create` in the automated contract.

- Round 6 (on what was added after round 5: Google Drive channel, SHA binding inside the senders, backend thread tail, Hermes preview conflicts) — two blockers: the Drive upload re-read the zip instead of binding it to the plan's SHA-256, and the Hermes preview's read-back went through Hermes' repair-and-save cron loader and a writable session store. Fixed in `b9e12ec` (rcat of the hashed bytes; repair-free cron read, `SessionDB(read_only=True)`; the real-install contract now checks that no profile file changes), plus a cursor fix.
- Round 7 — **can merge**: both closed, no new blocker. Its remaining should-fix (the first read and a gap reset also stop before an unreadable row) is fixed in `cf979b2`.

## Final self-check (after the review)

With the final code, `gbot migrate check --accept` on the demo bot (nothing re-sent; questions only, paced): Hermes 7/7 read back and 6/6 questions; Muse and Your dot first showed two false negatives from the new plain-language keyword fallback (a sentence start after a line break, and a role question that asked for projects but not places). Fixed in `706be83`; re-checked: **Muse 7/7, Your dot 7/7**.

## Incident during the fixes

While a sub-agent tested the new Hermes preflight, running the Hermes runtime with `HERMES_HOME` set to an empty temp folder made Hermes provision a runtime there and point the installed `hermes` launchers at it for a few minutes. The launchers were restored to the original interpreter and checked (`hermes --version`, `--print-runtime-command`, `profile list`, running gateways). The preflight now runs with the existing Hermes root.

## Automated tests

- grok-bot-cli: `npm run check` (validate, build, artifact validation, typecheck, 856 unit tests, 96 route tests); Hermes helper contract 3/3 against a fake runtime with the real API names, 3/3 against the installed Hermes stores in a scratch home; official importer (bundled export) 4/4.
- trinity-cli: 234 tests (7 platform skips).
- muse-web-cli: 139 passed, 2 skipped. chatgpt-dot-cli: 122 tests, all new ones pass; one redirect test (`test_cli_usage_redirect_exits_three`) fails as it did before these changes.
