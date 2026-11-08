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

A one-line bot turn showed up on the meter within two minutes (+0.0054 points); the full capture (transcript pages, memory, skills, routines, tasks, the box-store manifest and 321 files) did not move it, before or for three minutes after. This matches the code: the capture only calls read RPCs (`backendRead`) and never sends a message to a bot, so no bot runs. Only `--move-routines` writes to Grok Bot (the routine switch), and that is not a bot turn either.

The Move to Hermes route is different: each step is a turn of that bot and uses Grok Bot usage.
