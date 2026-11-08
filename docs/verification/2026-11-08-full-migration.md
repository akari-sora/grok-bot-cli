# Full migration verification — 2026-11-08

Time zone Asia/Taipei. Real source → real destinations on the maintainer's Mac. This records what was run with the final code (grok-bot-cli `4ac07c4`, trinity-cli `3c2d2dc`, muse-web-cli `2d021f7`, chatgpt-dot-cli `e60eb1f`), what passed, what failed first, and why. The earlier records from the same day (`2026-11-08-migration*.md`) describe the first design and are superseded.

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

## Earlier runs on the same day (first design, file by file in chat)

They found the problems the current design answers: Muse replying "saved" without writing Memory.md; a dot replying "saved" although its own review blocked the write; the dot's own alerts taken as answers; a token after a JSON `\n` that escaped redaction; Muse compiling a migrated script (`__pycache__`). Chat delivery is still available (`--via chat`); with the same checks it reached 9/9 digests and 7/7 questions on both.

## Strict review

Codex (gpt-6-astra, max reasoning, read-only) reviewed the toolkit: round 1 asked for changes (secrets across chunk boundaries, destination path escape, ownership, check running an import, transcript cut at a capped page, and more). The fixes are in `960fb63` and the trinity, muse-web-cli and chatgpt-dot-cli commits above. Round 2 is recorded with the merge request.

## Incident during the fixes

While a sub-agent tested the new Hermes preflight, running the Hermes runtime with `HERMES_HOME` set to an empty temp folder made Hermes provision a runtime there and point the installed `hermes` launchers at it for a few minutes. The launchers were restored to the original interpreter and checked (`hermes --version`, `--print-runtime-command`, `profile list`, running gateways). The preflight now runs with the existing Hermes root.

## Automated tests

- grok-bot-cli: `npm run check` (validate, build, artifact validation, typecheck, 841 unit tests, 96 route tests); Hermes helper contract 3/3 against a fake runtime with the real API names; official importer (bundled export) 4/4.
- trinity-cli: 223 tests (7 platform skips).
- muse-web-cli: 131 passed, 2 skipped. chatgpt-dot-cli: 121 tests, all new ones pass; one redirect test (`test_cli_usage_redirect_exits_three`) fails as it did before these changes.
