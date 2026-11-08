---
name: migrate-grok-bot
description: >
  Move a Grok Bot bot to Hermes Agent, Meta Muse or ChatGPT Your dot with `gbot migrate`: list the
  bots, capture one read-only, preview, import after the user confirms, and check the result
  (read-back and questions the migrated agent must answer from the migrated data). Use when the
  user wants to leave Grok Bot or copy a bot's role, memory, skills, routines, tasks, history and
  files to another agent. 把 Grok Bot 的 bot 搬到 Hermes、Muse 或 Your dot 時使用。Reply in the user's language.
---
# Move a Grok Bot bot (`gbot migrate`)

Reply in the user's language. Full guide: `docs/migration.md` in this fork; real-run record:
`docs/verification/2026-11-08-full-migration.md`.

## Before you start

- `gbot migrate --help` must list `bots capture preview import check run`. If not, install the
  fork's latest GitLab release file as FORK.md "Install" says (never `npm install -g grok-bot-cli`:
  that is upstream, without `migrate`).
- The Grok Bot desktop app is signed in on this computer (gbot reads its login; `gbot accounts`
  lists the logins). With several, pass `--account <alias|email|label>` after the subcommand.
- Destination tools on the same computer: Hermes → `hermes --version`. Muse → `trinity-cli` 0.5+,
  `muse-web-cli` 0.1.6+ (signed in to Muse once; side chats need `trinity-cli login muse`). Your dot
  → `trinity-cli` 0.5+ and `chatgpt-dot-cli` 0.2.6+.

## Steps (non-interactive; add `--json` before the subcommand for machine output)

1. `gbot --json migrate bots --account A` — pick the bot with the user (name or id).
2. `gbot --json migrate capture --account A --bot "<name or id>"` — read-only, never wakes the box;
   writes a private archive (`~/.grok-bot-cli/migrations/<bot>-<time>`). Tell the user what the
   capture reports as missing or partial before going on.
3. `gbot --json migrate preview <archive> --to hermes|muse|dot [options]` — what the destination
   would get and what cannot move (with alternatives). Show it to the user and wait for an explicit
   yes. Do not import without it.
4. `gbot --json migrate import <archive> --to <dest> --yes [options]` — imports, reads back and asks
   the acceptance questions. `run --account A --bot X --to <dest> --yes` does steps 2–4 in one go
   (preview it first without `--yes`).
5. Later, or after an interruption: `gbot migrate check <archive> --to <dest> [same options] --accept`.

Options for Muse/dot: `--via auto|upload|drive|chat`, `--history full|recent:N|none`,
`--skills all|index|none|a,b`, `--folder PATH`, `--drive-remote NAME:`. Hermes: `--profile NAME`,
`--into-existing`. Routines: by default nothing in Grok Bot changes and the user's Grok Bot
routines keep running there (Hermes gets them paused, Muse/dot in ROUTINES.md). Never pause them
unless the user asks: `--activate-routines` creates them active at the destination too (both run,
so each may run twice); `--move-routines`, only when the user asks for it, switches them over once
the check passes: paused in Grok Bot first, then turned on at the destination (a short gap, never
both running, so routines with side effects are not run twice; one that does not turn on there is
turned back on in Grok Bot and reported as rolled back). When the user names only some routines, add
`--routines <id or exact name>,…` (ids from the preview's routine list); the others are left as by
default and never paused. Give `preview`, `import` and `check` the same routine options.

## Reading the result

- Exit 0: migrated and verified. Exit 3: imported, something did not verify — read the ✗ items
  (`verify`, `acceptance.results[].ok`, `notMigrated`, `routines`/`switchOver` for a move,
  `memoryNotCaptured`) and report them. A switch-over line saying ROUTINE MAY RUN NOWHERE is
  urgent: report it first, with its manual fix. Exit 2: usage or missing `--yes`. Exit 1: other errors.
- The report JSON is also written next to the archive (`<archive>.<dest>.report.json`).

## Rules

- Never import without the user's yes on the preview. Never delete or change the Grok Bot bot.
- The default never pauses the user's Grok Bot routines (many still use Grok Bot). Use
  `--move-routines` only when the user asks to move them, and `--routines` to limit it to the ones
  they name.
- Muse/dot delivery is resumable and never resends an uncertain message: to continue, run the same
  `gbot migrate import` again; never paste archive files into a chat yourself.
- The archive holds the user's private data (memory, history, files). Do not print its contents;
  summarize counts and names. Known token formats are kept out of every destination, not shown.
- Sends to Muse/dot are paced like the apps (one at a time, ≥20 s apart, stop on a rate limit);
  do not loop or retry faster.
