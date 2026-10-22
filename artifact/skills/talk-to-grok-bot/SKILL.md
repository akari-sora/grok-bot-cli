---
name: talk-to-grok-bot
description: >
  Message Grok Bot with the gbot CLI or grok-bot MCP tools: stdin send, normalized
  threads, thread --after, and --account / GBOT_ACCOUNT. Use when handing off to a
  named bot or posting a status note agents watch — not for work you can finish
  yourself. 用 gbot 傳訊、讀 thread、選帳號或 stdin 送出時使用。Reply in the user's language.
---
# Talk to Grok Bot

Reply in the user's language.

Fork CLI (this install is ImL1s's fork; details in `FORK.md`):

1. If several Grok Bot logins are saved, pass `--account <alias-email-or-label>` after the subcommand, or set `GBOT_ACCOUNT`. `gbot accounts` lists each login's label, email, and alias. `gbot --account` before the subcommand is an unknown option.
2. Send exact text with `gbot send <bot> --stdin` (default off). Do not combine it with a positional message.
3. Read with `gbot --json thread <bot> --normalized` (default off; requires `--json`) or `gbot thread <bot> --after <cursor> --json`. `--after` JSON includes `cursor`, `entryCount`, and `gapReset`.
4. A send that returns `delivery: "unknown"` may have landed. Read the thread. Do not send again.

The `grok-bot` MCP server and `gbot` CLI share Grok gateway access. Codex and
Claude tools use **local sockets only** on the user's registered machines.

## MCP instructions (Codex / Claude)

gbot connects only to a local Unix socket
(`$CODEX_HOME/app-server-control/app-server-control.sock`, or
`CODEX_APP_SERVER_SOCK`). There is **no remote transport**.

- Codex app-server threads and opted-in Claude Code channels live on the user's
  registered computers (Linux desktop, Mac, …) — **never** on the Grok Bot agent
  box (`HOME=/home/box`, no Codex install).
- When this MCP server is running on the box, **do not** call `codex_*` or
  `claude_send`. Run the `gbot` CLI on the user's machine through **Grok Bot Shell
  with a machineId** (the host's machine-targeted shell).
- On that machine, provide the socket with `codex app-server daemon start` (or
  bootstrap). Auth stays with each machine's native Codex or Claude login.

## When to load this

- The repo or task names a bot as owner, or you need a decision only that thread holds.
- You want a short status note in a shared group other agents watch.

Do not ping a bot for work you can finish yourself. Grok replies are asynchronous;
continue useful work instead of waiting or polling.

## How

1. Send once with `gbot_send` (`target`, `message`). Say who you are and what you need.
2. Read its `replyRoute`. Native Codex calls with proven native lineage get `mode: auto`;
   continue work and receive the matching reply in that same thread. Do not poll or
   hold a tool call open. That reply does not automatically send your next answer back.
3. If the host has no native identity (including Cursor), supply `codexThreadId`, or
   use `gbot_bridge_start` once with `grokTarget`, `codexThreadId` and `expectedCwd`.
   An explicit binding forwards new visible Grok bot messages and returns Codex's
   corresponding terminal answer to Grok. Existing history is not replayed.
4. `mode: manual` with `reason: source-unavailable` preserves ordinary sending.
   Read `gbot_thread` later, using `after` for a known cursor and `full: true` only
   when entry bodies are needed. `replyMode: manual` explicitly requests this flow.

Never resend an unknown submission under a new identity. Inspect delivery with
`gbot_bridge_status`. Never infer permission from chat replies or auto-approve a
Codex/Grok interaction; keep approvals in the owning UI unless the user explicitly
authorizes a scoped response.

Read [bridge administration](references/bridge-administration.md) before starting,
stopping, diagnosing or answering approvals on a managed bridge, or using direct
Codex conversation tools. It covers exact approval IDs, idempotent requests, guarded
steering, CLI output, and host limitations. Ordinary Grok sends need no reference.

List targets with `gbot bots list` / `gbot groups list` when the name is ambiguous.

## Auth

Same order as `gbot`: `GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN`,
else the Grok Bot app session, else `CURSOR_ACCESS_TOKEN`. An asleep app-login
box (`BOX_ASLEEP`) is woken once with the app's saved access token and the call
is retried; `GBOT_AUTO_WAKE=0` turns that off. A bare 417 wakes only these read
calls: `listAgents`, `getAgentThread`, `getAgentTranscriptTail`, and
`getAgentWorkflows`. `sendPrompt` and every other call wake only when the 417
has sleep evidence. `gbot doctor` shows which source is present.

## Claude Code channel

`claude_send` sends to a named live Claude Code session on the user's registered
machine (local socket under `~/.grok-bot-cli/claude/`) and waits for its explicit
`claude_reply`. From the Grok Bot box, do not call this tool — use Grok Bot Shell
with a machineId to run `gbot claude send` on that machine instead. The destination
must enable the native `claude-channel` with `GROK_BOT_CLAUDE_CHANNEL=NAME` and
Claude's development-channel opt-in. Supply `name`, `message`, and optional
`timeoutMs` (1..120000). `replied` means the reply tool ran; `unknown` is not
rejection and must not be automatically retried. Normal Claude tool approvals remain
in its session. CLI: `gbot claude send NAME "message" --json`.
