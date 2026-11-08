# Move to Hermes end to end, and Grok Bot usage of a move (2026-11-09)

English. Account A (Ultra plan, unified billing). Times are Taipei.

## Move to Hermes, a real conversation

The author's own Move to Hermes bot (instructions = template version 4) moved the demo bot "Demo · Trip Planner" to Hermes, driven over `gbot send`, `gbot thread` and the bot's own choice cards; every command ran through Grok Bot Shell on the Mac the bot was told to use. No step was done by hand outside the conversation.

1. 01:00 "你好，幫我把「Demo · Trip Planner」這個 bot 搬到 Hermes。" The bot explained each command runs on the user's own computer after it is shown, and asked to run `hermes --version`.
2. It offered the three connected computers as a choice card; the Mac was chosen.
3. It ran, one at a time and each after "可以": `hermes --version` (v0.21.5), `node --version` (v25.9.0), `gbot migrate --help` (installed, has migrate), `gbot migrate bots` (found the demo bot).
4. `gbot migrate run --bot <id> --to hermes` (preview only). It summarised what Hermes would get (role → SOUL.md, 3 user facts, 4 memories with 1 open task, 103 skill folders, 1 routine created paused, 17 messages, 321 files, no keys or tokens) and what cannot move.
5. The routine that was on (switched on for this test) produced the three-way choice card; option 1 (keep it off in Hermes, Grok Bot unchanged) was chosen.
6. It showed the import command with `--yes` and waited; after "確定，匯入吧。" it imported (01:08–01:12).
7. Its report: read-back matched for role, user facts, memories, skills, routine, messages and files; every acceptance question passed; the routine paused in Hermes and unchanged in Grok Bot; profile `grok-demo`; report path on the Mac.

Afterwards the demo routine was switched off again (its state before the test) and the `grok-demo` profile was deleted. The conversation is the source of `demo/move-to-hermes-phone.mp4`.

## Grok Bot usage of a move

The Grok Bot app reads the weekly meter with `aiserver.v1.DashboardService/GetSandUsageStatus` (`usagePercent`, plus period start and reset time).

| Time (UTC) | Event | usagePercent |
| --- | --- | --- |
| 17:13:51 | before `gbot migrate capture` of the demo bot | 16.57550 |
| 17:15:51 | capture finished (exit 0) | 16.57550 |
| 17:16:13 | before sending one short message to a bot | 16.57550 |
| 17:16:21–17:17:23 | three readings | 16.57550 |
| 17:17:54 | about 100 s after that message | 16.58092 |

A one-line bot turn showed up on the meter 70–100 s after it was sent (+0.0054 points). In this first run the capture ended only 22 s before that message, so the two could not be told apart, and the meter was read for about 90 s after the capture. The capture was therefore measured again with no message to any bot in the window:

| Time (UTC) | Event | usagePercent |
| --- | --- | --- |
| 17:39:13 | before `gbot migrate capture` of the demo bot | 16.58092 |
| 17:39:14–17:41:31 | capture (exit 0) | |
| 17:41:32–17:47:48 | 14 readings, every ~30 s, no message to any bot | 16.58092 (all) |

The full capture (transcript pages, memory, skills, routines, tasks, the box-store manifest and 321 files) did not move the meter in the 6 minutes after it, more than three times the delay a bot turn needs to show. This matches the code: the capture only calls read RPCs (`backendRead`) and never sends a message to a bot, so no bot runs. Only `--move-routines` writes to Grok Bot (the routine switch), and that is not a bot turn either.

The Move to Hermes route is different: each step is a turn of that bot and uses Grok Bot usage.

## A real bot, moved with the released v0.11.2-iml1s.16

`gbot migrate run --account A --bot <Deploy QA> --to hermes --profile grok-dqa-check --yes` with the release package (Deploy QA is a working bot of the author's, not a demo; it has no routines, so nothing in Grok Bot was touched):

- Capture: memory coverage `complete`, counted per file (3 of the bot's own memory files, 3 shared user-memory files, no project memory); the team-bot memory API answered 403 and is reported as unavailable, with the personal memory read from the box store instead.
- Import into a new Hermes profile; read back 7/7; acceptance 7/7 (role, user facts, schedules, open tasks, history, skills, files). Exit 0, "migrated and verified".
- Continuing the work: asked in Hermes (`hermes -p grok-dqa-check -z …`, read-only question) for its role and its unfinished task, it named its job (watch GitLab CI and deploys, fix failures, squash-merge green non-draft MRs) and the open item from its migrated memory (two Telltale merge requests waiting to leave draft, then merge them and wake the full check on main).

The test profile and the local archive were deleted afterwards.

## Routine switch-over on a working bot (`--move-routines --routines`)

The author's working bot "X Brief" has two routines on in Grok Bot: "Daily X brief" and "Weekly X recap" (Fridays 09:00, Taipei; next run four days later, so a few minutes off could not skip a run). With v0.11.2-iml1s.16:

`gbot migrate run --account A --bot <X Brief> --to hermes --profile grok-xbrief-check --move-routines --routines weekly-x-recap --yes`

| Time (UTC) | Grok Bot (read back) | Hermes (`cron list`) |
| --- | --- | --- |
| 18:26:44, before | daily on, weekly on | (no profile) |
| 18:30:06, after the run (exit 0) | daily on, weekly **off** | daily paused, weekly **active** |

- The report: weekly-x-recap "paused in Grok Bot, then on in Hermes", no rollback; daily-x-brief "off at the destination, unchanged in Grok Bot" (not named in `--routines`). Read back 7/7, acceptance 6/6; the transcript had 221 rows (131 messages) over seq 1–226, with 4 deleted rows reported as such.
- Restored at 18:30:09: weekly-x-recap switched back on in Grok Bot and read back on; the test profile (with its cron jobs) deleted; the local archive deleted.
