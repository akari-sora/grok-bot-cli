# Move a Grok Bot to Hermes, Muse or Your dot

English | [繁體中文](migration.zh-TW.md)

`gbot migrate` (new in `v0.11.2-iml1s.7`) moves one Grok Bot to another agent, reads the destination back, and asks the migrated agent questions to prove it can carry on with the work. It is not a backup and it does not leave you a bundle to paste by hand. Demo and screenshots: [README](../README.md#move-a-bot-to-hermes-muse-or-your-dot).

## Steps

In a terminal, `gbot migrate` asks for the source login, the bot (or several), the destination, shows the diff, asks to confirm, then imports, reads back and runs the acceptance checks. Each step is a plain command you can also run yourself or script:

```sh
gbot migrate                                                      # guided
gbot migrate bots --account A                                     # 1. list the bots of a login
gbot migrate capture --account A --bot "Deploy QA"                # 2. capture into an archive (read-only)
gbot migrate preview ARCHIVE --to hermes                          # 3. what the destination gets, what cannot move
gbot migrate import ARCHIVE --to hermes --yes                     # 4. import, read back, ask
gbot migrate check ARCHIVE --to hermes --accept                   # check again any time
gbot migrate run --account A --bot "Deploy QA" --to hermes --yes  # 2–4 in one go
```

`--to` is `hermes`, `muse` or `dot`. Muse and dot are delivered by `trinity-cli migrate` (trinity-cli v0.5.2 or later, which reads an answer the agent gives in several messages, with muse-web-cli v0.1.6 or later and chatgpt-dot-cli v0.2.6 or later: they have `send --attach` and `--attach-sha256`). `--via drive` also needs [rclone](https://rclone.org) with a remote for your Google Drive, and the Google Drive connector set up in Muse or the dot.

![The same bot moved to Muse and to Your dot: one zip each, checked on their computer](../demo/gbot-migrate-muse-dot.gif)

The same bot to Muse and to Your dot: one zip each (4.2 MB, 329 files, two messages), unzipped on the agent's own computer, checked part by part with a salted SHA-256, then asked questions (7/7 on both in the final check; on Muse in a new chat that cannot see the migration; a dot has one inbox, and the report says so). [MP4](../demo/gbot-migrate-muse-dot.mp4) · tape: [demo/gbot-migrate-muse-dot.tape](../demo/gbot-migrate-muse-dot.tape). Real-run record (a 903-row bot and the demo bot, all three destinations): [verification/2026-11-08-full-migration.md](verification/2026-11-08-full-migration.md).

## Options

The same on `preview`, `import`, `check` and `run`; give `check` the options of the import. The routine options apply to every destination, and their selection is part of the plan.

| Option | Default | What it does |
| --- | --- | --- |
| `--via auto\|upload\|drive\|chat` | `auto` | Muse/dot. `upload`: the whole handoff folder as one zip attachment the agent unzips. `drive`: the same zip in your Google Drive with rclone (MD5 checked); the agent fetches it with its Google Drive connector and unzips it; the Drive copy is removed after a verified migration (`--keep-drive` keeps it). `chat`: one message per file. `auto`: upload when the attachment fits (Muse 256 MB, dot 20 MB), else drive when a remote is set, else chat |
| `--drive-remote NAME:` | `GBOT_DRIVE_REMOTE` | The rclone remote for your Google Drive (`rclone listremotes`); required for `--via drive`. Set it up with your own Google OAuth client, as [rclone describes](https://rclone.org/drive/#making-your-own-client-id): rclone's shared client is rate-limited and is being retired during 2026; gbot works with any remote |
| `--drive-folder PATH` | `gbot-migrations` | The Drive folder for the zip |
| `--history full\|recent:N\|none` | upload `full`, chat `recent:30` | How much conversation |
| `--skills all\|index\|none\|a,b` | upload `all`, chat `index` | `index` is names and purpose only; Hermes takes `all` or `none` |
| `--folder PATH` | `~/grok-bot/<bot>-<first 8 of its id>` | The folder on the agent's computer (bots with one name never share a folder) |
| `--profile NAME` | `grok-<bot>` | Hermes profile name; `--into-existing` (import, run) adds to an existing profile this migration did not create |
| `--activate-routines` | off | Create the scheduled routines that are on in Grok Bot as active schedules at the destination (Hermes: cron jobs not paused; Muse/dot: asked to create them). The Grok Bot copies keep running, so both run |
| `--move-routines` | off | Move them, **with a short gap and never both running**: created paused at the destination (Muse/dot: not yet), paused in Grok Bot once the import's read-back and acceptance pass, then turned on at the destination and read back ([Routines](#routines)). Give `import` the bot's login with `--account` |
| `--routines ID_OR_NAME,…` | every routine that is on | Limit `--activate-routines` / `--move-routines` to those routines (comma-separated, the captured routine id or exact name; only scheduled routines that are on in Grok Bot; an unknown one stops with the list of valid ones before anything changes). The others stay as by default (Hermes: created paused; Muse/dot: ROUTINES.md only) and are never paused in Grok Bot |
| `--accept` | import and run: on; check: off | The acceptance questions (they use the destination model) |

Capture options: `--max-file-mb` (largest box file, default 8 MiB), `--out` (default `~/.grok-bot-cli/migrations/<bot>-<time>`), `--time-zone` (for routine times; default this computer).

## Capture (read-only)

| Item | Source | Scope |
| --- | --- | --- |
| Role, name, description | `ListGrokBotAgents` | complete |
| Conversation | `ListGrokBotTranscriptEntries`, paged back with `beforeSeq` to an empty page or the first row; omitted bodies filled from box-store blobs | **all of it**, not the last 200; rows with no body (deleted, rolled back or never written) are listed as sequence gaps |
| Memory | box store: the bot's own `memory/`, every assistant's shared `user-memory/` shard, joined projects' memory | whole files |
| Skills | box store `workflows/<name>/`, whole folders (shared by every bot of the account) | complete, with their files |
| Routines | `ListGrokBotAgentAutomations` (prompt, cron, time zone, trigger, enabled state) | complete |
| Open tasks | `ListGrokBotAgentTodos`, `ListGrokBotAgentTasks`, `ListGrokBotTasks` | complete |
| Needed files | the bot's attachments and assets, plus `/home/box/…` and `/workspace/…` files named in its role, routines, memory or conversation | up to `--max-file-mb` each |
| Groups, teammates, connectors, library docs | names and settings | listed only |

Every area's status (complete, partial, not applicable or failed, with the reason) is in the archive's `REPORT.md` and `capture.json` → `coverage`. Memory is `complete` only when every memory file the store lists for the bot was read; one left out (size limit, unreadable blob or digest mismatch, credential path, …) makes it `partial` with each missing file and the reason (`coverage.memory.missing`), and none read is `failed`. Missing memory files are in the preview's not-migrated list and in the import report (`memoryNotCaptured`, "Memory files not captured" in the terminal). Every archived file has a SHA-256 and is re-verified when the archive is opened; extra or missing files are refused.

Known credential paths (`.secrets/`, `.ssh/`, `.npmrc`, `rclone.conf`, `glab-cli`, `*token*`, …; the same bytes under another name count too) are not read; when they are mentioned they are listed as "sign in again at the destination". This is a name list, not a guarantee. Known token formats (`ghp_…`, `glpat-…`, `sk-…`, `npm_…`, JWT, Bearer, private keys, …; also in file names, UTF-16 text and escaped or URL-encoded forms) stay only in the private local archive (mode 0600) and are replaced with `[redacted]` before anything is written to a destination or sent to a cloud agent; a file whose token cannot be replaced in place is not sent and is listed in the report. This matches known formats; it cannot recognise every secret.

## Destinations

| | Hermes | Muse | Your dot |
| --- | --- | --- | --- |
| One bot becomes | its own new Hermes profile (`grok-<bot>`), written through Hermes' own stores | one side chat in the one Muse (shared memory, many chats) | the one dot (one inbox per account) |
| Kept in | the profile | a handoff folder on Muse's computer, `~/grok-bot/<bot>-<id>/`, plus one message asking it to remember a pointer to that folder long-term | the same folder and pointer on the dot's computer |
| Sent by | written into Hermes' own store | one zip attachment by default (`muse-web-cli send --attach`, uploaded in the Muse window like a manual attachment); or through your Google Drive (fetched with its Google connector); or file by file | one zip attachment by default (`chatgpt-dot-cli send --attach`, uploaded to the message room first, as the dot app does); or through your Google Drive; or file by file |
| Role | `SOUL.md` | `ROLE.md` | `ROLE.md` |
| Memory | `USER.md`, `MEMORY.md` through Hermes' MemoryStore (limits raised for the new profile when needed) | `MEMORY.md` | `MEMORY.md` |
| Conversation | all of it, side conversations included, as searchable Hermes sessions, plus a readable copy | zip: all (`HISTORY.md`, `history/`); file by file: the last 30 | as Muse |
| Skills | `skills/grok-bot-imports/<name>/`, whole folders | zip: `skills/<name>/` whole folders plus `SKILLS.md`; file by file: `SKILLS.md` (names and purpose) | as Muse |
| Routines | scheduled: `hermes cron create --paused` (same time zone, tagged with the source id); event routines: `routines-not-scheduled.md` | `ROUTINES.md` (Muse has no paused schedule) | `ROUTINES.md` |
| Tasks | "open tasks" in memory | `TASKS.md` | `TASKS.md` |
| Files | `workspace/grok-bot/grok-box/…` in the profile | zip only (`box/…`, bytes unchanged); file-by-file delivery sends no files, because the agent would retype them and one space changes a script | as Muse |
| Read back | Hermes' own stores: SOUL, memory, skills, cron (schedule, time zone, paused state), per-session content digests, file digests | a read-only command on Muse's computer prints a salted SHA-256 per part; Memory.md is listed for reference only | as Muse (a dot's memory cannot be read from outside) |
| Questions asked in | `hermes -p`, one-shot | a fresh side chat that cannot see the migration; only that chat is deleted afterwards | the one inbox (the report notes the answers may use the conversation) |

The handoff folder holds README, ROLE, MEMORY, TASKS, ROUTINES, SKILLS, HISTORY, `skills/`, `history/`, `box/` and MANIFEST.txt.

## Routines

By default nothing in Grok Bot changes: its routines keep running there, and gbot pauses one only with `--move-routines` (choice 3 in the guided flow), and then only the ones chosen. The Hermes cron jobs are created paused, because the Grok Bot copy keeps running and two running copies would run twice: turn the Grok Bot one off, then `hermes -p grok-<bot> cron resume <id>`. Muse and dot have no paused schedule, so they only get ROUTINES.md; `--activate-routines` asks them to create the schedules.

In the guided flow, after the capture, a bot with scheduled routines that are on gets this question (default 1):

1. Keep them off in <destination>; Grok Bot keeps running them (nothing in Grok Bot changes)
2. Run them in both: turn them on in <destination> and leave Grok Bot running them (they may run twice) — `--activate-routines`
3. Move them: once the check passes, pause them in Grok Bot, then turn them on in <destination> (a short gap; never both running) — `--move-routines`

For 2 or 3 it lists the routines that are on (number, name, schedule) and asks "Which routines? Enter for all, or numbers like 1,3"; picking some becomes `--routines`. The preview lists, per routine, what happens (off at the destination, on at the destination, or moved), with how to turn a paused one back on.

A move is switched over with a short gap, never both running, so routines with side effects (sending messages, merging, paying) are not run twice. For each routine:

1. The import creates it paused at the destination (Hermes: a paused cron job, which the read-back still checks for schedule and prompt). Muse and dot have no paused schedule, so nothing is created there yet.
2. Only after the import's read-back and acceptance pass, gbot pauses it in Grok Bot with the request the app's Routines toggle makes, `SetGrokBotAgentAutomationEnabled` `{ agentId, automationId, isEnabled: false, timeZone }`, and the answer must show it off.
3. Only for a routine confirmed off, the destination copy is turned on: Hermes runs `hermes -p <profile> cron resume <job id>` and reads it back active; Muse and dot get the one message that creates the schedule only now (a trinity plan of its own per routine, `<archive>.<dest>-switch-<id>.json`), and their schedules are read back after that.
4. When the destination copy does not turn on (read back paused or missing), gbot turns the Grok Bot routine back on (`isEnabled: true`, confirmed) and reports it as rolled back. When that roll back fails or is not confirmed, the report says ROUTINE MAY RUN NOWHERE with the exact manual fix. A destination whose state is unknown (the read-back failed) is not rolled back, since it may be running there; the report says how to check.

Only the scheduled routines that were on, were chosen and were migrated are touched; routines not chosen, event-triggered routines (GitHub, Slack, …) and routines that were off are not. Every step is one request per routine and is never retried. The capture stays read-only; these are separate writes after verification, and they do not wake the box.

- When verification did not pass (or Muse/dot ran without the acceptance questions), nothing is paused and the report says `source routines left on: verification did not pass`; the destination copies are still paused (Muse/dot: not created), so nothing runs twice. Fix it and run the same `gbot migrate import` again.
- A pause that fails or whose effect is unknown (a timeout) leaves the destination copy paused and is listed per routine with how to finish by hand (in the Grok Bot app: Routines → toggle off, then turn on the destination copy); the exit code is 3.
- The report (`routines`: per routine its state at the destination and in Grok Bot and whether it was rolled back; `switchOver`: each step; `sourceRoutines`: each pause request) and the terminal output list every routine. Turn one back on in the Grok Bot app: Routines → toggle.
- During the switch a routine is off in both places for a moment, so a run due in that gap is skipped; it never runs in both.

## Acceptance

Saying "saved" is not proof: in real runs Muse kept MR state out of Memory.md, and a dot's TASKS.md write was blocked by its own review while it still replied "saved".

- **Hermes** is read back through Hermes' own code (role, memory, skills, cron schedule/time zone/state, per-session content digests, file digests), then asked with `hermes -p` who it is, what it remembers about you, its routines and open tasks, to quote an old conversation from search, to open a skill and to read a migrated file.
- **Muse and dot** run one read-only `python3` command on their own computer. The folder and a fresh random salt arrive base64-encoded, and it prints a salted SHA-256 for each part listed in MANIFEST.txt (each main file, `box/`, `skills/`, `history/`). Those values need the bytes. gbot checks the answer row by row (each part printed once, right column): exact bytes for a zip, content without whitespace and backslashes for chat delivery (agents drop escape backslashes when they write chat text to a file). That is strong evidence that the agent has those bytes on its computer and ran the check, not an independent read of the folder (Muse and dot offer no outside file read). A missing or different part is re-sent once and checked again; parts it did not print are reported as not verified and not re-sent.
- The other questions (does it know this bot, what is in TASKS.md, the first message, a skill's steps, …) go to a fresh Muse side chat; a dot has one inbox, and the report says so.
- Every answer must start with its marker (`Q1:`; `Q10:` is not `Q1:`), so the agent's own alerts and briefings are not taken as answers. A failed question is asked once more and both answers are kept.
- An answer passes only with a keyword only the migrated data has (an MR number, an account, file contents); words in the question itself and common English words do not count. This is a behavioural test, not a proof: a pass means it can find and use the migrated data. The questions use the destination model and a little of its quota.

## Pace and request style

- One message at a time, each after the previous reply, at least 20 s apart (`trinity-cli migrate --min-interval`, also across resumed runs); a failed send or a rate-limit reply stops the run without resending. A zip migration is two messages plus the questions.
- Requests follow the official front ends: Muse is driven in the Muse window (attach, type, Enter); the dot gets what the dot app sends (room upload, then `content{text, attachments}`, `request_id`, `timezone_offset_min`; the app's integrity attestation is not imitated); the Grok Bot source uses only read RPCs the app uses, pages transcripts at 500+1 rows and reads the store 8 requests at a time like the app, and never wakes the box.

Muse/dot delivery is resumable: every step has a nonce and a ledger. Run the same `gbot migrate import` again: answered steps are skipped, and an uncertain one is read back from the chat first, never sent blind. `gbot migrate check` sends no migration content; with `--accept` it sends the acceptance questions.

## Destination setup

- Hermes: nothing; the current Hermes default model and login are used.
- Muse: `muse-web-cli login` once in the Muse window; side chats use the api backend (`trinity-cli login muse`).
- dot: `codex login`.
- Connectors (GitHub, Slack, Gmail, …) and CLI logins (glab, gh) are connected again at the destination; OAuth grants do not move.

## Exit codes

0 migrated and verified; 3 imported but something did not verify, or with `--move-routines` a routine was not paused in Grok Bot (see ✗ in the report); 2 an invalid option, rejected before anything runs; 1 other errors, including a missing `--yes` (nothing was imported) and an unknown `--routines` entry. The report is written next to the archive: `<archive>.<dest>….report.json`.

## For agents (Claude Code, Codex, Cursor)

After `gbot-install install claude` (or `codex`, `cursor`) the gbot plugin gives the agent the `migrate-grok-bot` skill (source: `src/skills/migrate-grok-bot/SKILL.md`). It works like this, and a person can follow the same steps:

1. `gbot --json migrate bots --account A`: list the bots and confirm with the user which to move.
2. `gbot --json migrate capture --account A --bot "<name or id>"`: read-only capture; say what is missing first.
3. `gbot --json migrate preview <archive> --to hermes|muse|dot`: show the preview and **wait for an explicit yes**.
4. `gbot --json migrate import <archive> --to <dest> --yes`: import, read back, ask; read the exit code and the ✗ items in the report.
5. After an interruption, or later: `gbot migrate check <archive> --to <dest> --accept` (Muse/dot resume with the same `import`; an uncertain message is never sent again).

The skill's rules: no import without the user's yes; never change or delete the bot in Grok Bot; never paste archive contents into a chat (report counts and names); Muse/dot sends follow the apps' pace, no faster retries; by default never pause the user's Grok Bot routines: `--move-routines` only when the user asks for it, with `--routines` when they name only some.
