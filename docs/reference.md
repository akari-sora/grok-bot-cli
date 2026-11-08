# gbot reference

English | [繁體中文](reference.zh-TW.md)

The [README](../README.md) covers install, quick start and moving a bot. This page has the rest. The fork's full rules are in [FORK.md](../FORK.md); moving a bot is in [migration.md](migration.md).

- [Command reference](#command-reference)
- [Several logins](#several-logins)
- [Grok Bot 0.78: server-hosted bots](#grok-bot-078-server-hosted-bots)
- [Delivery, reconcile and exit codes](#delivery-reconcile-and-exit-codes)
- [Agent integrations](#agent-integrations)
- [Upstream reference](#upstream-reference): Claude Code channel, Grok ↔ Codex replies, Codex threads, ChatGPT Desktop, MCP tools, gateway URL policy, local history
- [Platforms and limits](#platforms-and-limits)
- [Upstream fixes in this fork](#upstream-fixes-in-this-fork)

## Command reference

Every command below exists in this fork; `gbot <command> --help` shows its options. Options are command-local and go after the subcommand; only `--json` may also come first (`gbot --json thread …`). `--json` prints the canonical JSON result.

```sh
# Logins and the box
gbot accounts
gbot accounts alias work owner@example.com
gbot accounts unalias work
gbot accounts default work
gbot accounts default --clear
gbot config path
gbot config export --out gbot-accounts.json
gbot config import gbot-accounts.json --replace
gbot doctor
gbot wake
gbot wake --check --json

# Bots, groups and skills
gbot bots list
gbot bots create --name Researcher
gbot bots create --name Writer
gbot bots get Researcher
gbot bots update Researcher --description "Research the launch" --notify on
gbot bots template Researcher
gbot bots template Researcher --status
gbot bots template Researcher --show
gbot bots template Researcher --publish
gbot groups create --name Launch --member Researcher --description "Ship together"
gbot groups add Launch Writer
gbot groups members Launch
gbot groups remove Launch Writer
gbot groups set Launch --member Researcher --member Writer
gbot groups update Launch --title "Launch room" --hidden off
gbot skills list
gbot skills add ./skills/poteto-mode
gbot skills remove poteto-mode
gbot groups delete Launch
gbot bots delete Writer

# Messages
gbot send Researcher "Summarize the launch status."
printf %s 'Exact UTF-8 message' | gbot send Researcher --stdin --json
gbot thread Researcher
gbot --json thread Researcher --normalized --limit 50
gbot thread Researcher --after "<cursor>" --json
gbot reconcile Researcher --nonce "<clientNonce>"
gbot approvals list Researcher
gbot approvals respond --target Researcher --entry-id "<entryId>" --request-id "<requestId>" --decision decline
gbot history Researcher --search timeout

# Move a bot (migration.md)
gbot migrate
gbot migrate run --bot Researcher --to hermes --yes

# Codex, Claude Code and ChatGPT Desktop (on the same machine as gbot)
gbot codex status
gbot codex list-threads --query launch --active-within 7d
gbot codex send THREAD_ID "Grok here: the build is green."
gbot codex new --cwd ~/project "Start here"
gbot codex wait THREAD_ID TURN_ID --timeout-ms 1800000
gbot codex bridge status --json
gbot codex desktop-shim status
gbot claude send review "Reply with GBOT_CLAUDE_OK" --json
gbot chatgpt-desktop status

# Wear OS watch
gbot wear pair 192.168.1.23:40123
```

`update` fields: `--name`, `--description` (the app's Instructions field), `--title`, `--avatar-shape`, `--avatar-color`, `--notify on|off`, `--hidden on|off`. `gbot skills` manages the one skill library every bot of the login shares; `remove` takes an id or exact name and refuses team, plugin and routine entries. `--normalized` needs `--json` and returns `{ target, messages: [{ id, role, text }] }`; a bot reply often has `role: "unknown"`, which is still a reply. `send --stdin`, `thread --after` and `bots template` in full: [FORK.md](../FORK.md#fork-commands).

## Several logins

```sh
gbot accounts                                  # every signed-in login, no tokens
gbot accounts alias work owner@example.com
gbot accounts default work
gbot bots list --account work
gbot config export --out gbot-accounts.json    # aliases and emails, never tokens
gbot config import gbot-accounts.json          # on another machine
```

Commands pick the login in this order: `GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN` when both are set; otherwise `--account`, then `GBOT_ACCOUNT`, then the config default, then the descriptor's single or app-active entry, then the only saved login. Several logins and no choice is an error, and a selector that does not resolve fails without switching to another login. `--account` goes after the subcommand. `CURSOR_ACCESS_TOKEN` is used only when there is no app login, or when that implicit login cannot be decrypted or is expired. A login the app no longer shows still works: gbot builds a session from the saved login in memory. `gbot doctor` and `gbot wear pair` do not use the config default. Full rules and the config file location: [FORK.md](../FORK.md#login-and-several-logins).

## Grok Bot 0.78: server-hosted bots

![gbot on Grok Bot 0.78: create a bot and a group, send, read the reply, delete](../demo/gbot-0784-demo.gif)

Recorded live on 2026-11-05 against Grok Bot 0.78.4 with this fork: create a bot and a group, send a message, read the bot's reply, then delete both. [MP4](../demo/gbot-0784-demo.mp4) · tape: [demo/gbot-0784.tape](../demo/gbot-0784.tape) (it uses a real account and deletes what it creates).

Grok Bot 0.78.4 (2026-11-03) hosts every bot on the server. On 2026-11-05 its box gateway answered sends, group creation and sidebar hiding with 502, kept deleted bots in its roster, and deleted nothing. When the session has an access token, gbot calls the same backend RPCs as the app (`aiserver.v1.GrokBotService`, Connect JSON):

| Command | RPC |
| --- | --- |
| `send` | `SendGrokBotUserMessage` |
| `reconcile` | `GetGrokBotSendStatus`, then the transcript tail |
| `bots list`, `groups list`, `get`, name lookups | `ListGrokBotAgents`; notify and hidden from `ListGrokBotAgentStatuses` |
| `bots create` | `CreateGrokBotTemporalAgent` |
| `groups create` | `CreateGrokBotRoom`, then `UpdateGrokBotAgent` for `--title` and the avatar |
| `groups set`, `add`, `remove` | `SetGrokBotRoomMembers` |
| `bots update`, `groups update` | `UpdateGrokBotAgent`; `--notify` and `--hidden` with `SetGrokBotAgentClientState` |
| `bots delete`, `groups delete` | `DeleteGrokBotAgent` |
| `approvals respond` | `ResolveGrokBotAutoReviewApproval` or `ResolveGrokBotLocalToolPermission` (mapped from the app, not live-tested) |
| `thread`, the `reconcile` tail, the relay, `approvals list`, the MCP thread tool | `ListGrokBotTranscriptEntries` |
| `migrate import`, `migrate run` with `--move-routines` | `SetGrokBotAgentAutomationEnabled` `{ agentId, automationId, isEnabled: false, timeZone }`, after the import verified; `isEnabled: true` only to roll back a routine the destination could not turn on |

`thread --root` and `skills` use the box gateway; on a 0.78 host it answers 404, and `skills list` then reads the library through the backend. A session without an access token (`GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN`, or a descriptor login with no saved access token) keeps the gateway calls, and on 0.78.x its sends get the 502. The `bots template` RPCs, roster merge, name matching, delivery states and the live gateway observations: [FORK.md](../FORK.md#grok-bot-078x-server-hosted-bots).

## Delivery, reconcile and exit codes

Sends have a 15-second deadline and reads 30 seconds, both including the response body. There is no automatic retry, except one retry of the same request after waking an asleep box; redirects are rejected. A send result has `delivery`: `accepted` (the backend confirmed it, or for a session without an access token the gateway did), `rejected`, or `unknown` (timeout, network failure, HTTP 408 or 5xx, or no confirmation). Do not resend an unknown send. Run `gbot reconcile <bot> --nonce <clientNonce>`: it asks the backend send status, then looks for that nonce in the last 200 transcript entries, and never sends. The answer is `delivered`, `rejected` (with `rejectionCode`), `pending` (it may still land; do not resend), or `not-found-in-tail`.

| Command | Exit codes |
| --- | --- |
| most commands | 0 done (a send can be `delivery: "unknown"` and still exit 0); 1 usage error or gateway failure (with `--json`, `send`, `wake` and the `codex` commands print the failure as a JSON document with `exitCode` on stdout); 2 unknown option, including `--account` before the subcommand |
| `gbot wake` | 0 running, or `--check` succeeded; 2 usage; 3 could not wake; 4 timed out before the box was ready |
| `gbot bots template` | 0 the template was seen, or `--status`, `--show` or `--publish` succeeded; 3 the message went out (or its delivery is unknown) but no template appeared within `--wait`: run `--status` later, do not send again; 1 rejected, or nothing sent |
| `gbot migrate` | 0 migrated and verified; 3 imported but something did not verify (or with `--move-routines` a routine was not paused); 2 an invalid option (nothing ran); 1 other errors, including a missing `--yes` (nothing was imported) |
| `gbot config import` | 0 imported; 2 invalid file (nothing written); 3 imported, but some aliased logins are not signed in on this machine |
| `gbot wear pair` | 0 paired; 1–6 and 129/130/143 as listed in [FORK.md](../FORK.md#pair-a-wear-os-watch-gbot-wear-pair) |

Common errors and fixes: [FORK.md](../FORK.md#troubleshooting).

## Agent integrations

The package carries an agent plugin named `gbot` for Codex, Claude Code and Cursor: a `grok-bot` MCP server (Grok messages, Codex threads, the managed Grok ↔ Codex bridge, ChatGPT Desktop), a `claude-channel` MCP server for Claude Code, the `talk-to-grok-bot`, `chatgpt-desktop`, `codex-dot` and `migrate-grok-bot` skills, and the `/gbot:codex-send`, `/gbot:codex-threads` and `/gbot:codex-wait` commands. Install it with `gbot-install`, which comes with the same release file:

```sh
gbot-install install codex
gbot-install install claude
gbot-install install cursor
gbot-install install grokbot
gbot-install doctor
```

`--replace` overwrites an existing copy; `gbot-install uninstall <host>` removes it. The plugin bundles its own gateway client and worker, so it does not need `gbot` on `PATH`. Plugin marketplaces that point at the upstream GitHub repository install upstream's plugin, without this fork's changes.

- `migrate-grok-bot` runs `gbot migrate`: preview first, import only after an explicit yes, then read back and check ([migration.md](migration.md#for-agents-claude-code-codex-cursor)).
- `codex-dot` routes Codex Desktop's own `codex_app` tools (`list_threads`, `read_thread`, `send_message_to_thread`) to the Dot assistant; it does not add a CLI command or a server.

`gbot-install install grokbot` stages the Cursor projection as a marketplace repository under `~/.grokbot/agent-bundle/marketplaces/gbot` (`GROK_BOT_HOME` overrides `~/.grokbot`). On a computer that has Grok Bot's plugin data and its clone of the `scriptedalchemy/plugins` marketplace (the Grok Bot box keeps them in `/home/box/agent-data`), it also sideloads this fork's plugin there: a `gbot/` folder and a `marketplace.json` entry in the clone commit Grok Bot already uses, and `plugins/cache/scriptedalchemy-plugins/gbot/<commit>/` with `.cache-complete`. The data folder is `GROK_BOT_AGENT_DATA_DIR`, else the first of `/home/box/agent-data`, `~/.grokbot/agent-data` and `~/Library/Application Support/Grok Bot/agent-data` that has a `plugins/` folder. Without it, or without the clone, the install only stages, and the `sideload` field of `--json` says why. Every path it writes is in the install receipt, and `uninstall grokbot` removes exactly those. `--sideload-repo <owner/repo>`, `--sideload-slug <slug>` and `--no-sideload` (or `GROK_BOT_SIDELOAD_REPO`, `GROK_BOT_SIDELOAD_SLUG`, `GROK_BOT_SIDELOAD=0`) retarget or skip it, and `gbot-install doctor --host grokbot` reports the plugin (`AB7334`) and the sideload (`AB7335`). Grok Bot's plugin sync (at startup, on a sign-in change, and every 24 hours) keeps the sideloaded cache copy only while the account's plugin listing names gbot from that marketplace; when the marketplace moves to a new commit Grok Bot replaces the clone, so run `gbot-install install grokbot` again. This was checked against a temporary copy of that folder layout (`test/gbot-install-grokbot.test.js`), not against a live Grok Bot.

## Upstream reference

Taken from the upstream README and corrected for this fork.

### Messaging a live Claude Code session

Claude Code has a native [Channels API](https://code.claude.com/docs/en/channels-reference), so this needs no desktop shim. The Claude plugin includes an opt-in `claude-channel` MCP server; Codex and Grok callers use `claude_send`, or `gbot claude send`, to send a message and receive Claude's explicit reply. Channels live on the machine that runs Claude Code, not on the Grok Bot box (`HOME=/home/box`). gbot has no remote transport: from the box, run `gbot claude send` on that computer through Grok Bot Shell with a machineId.

After `gbot-install install claude`, start a named session:

```sh
GROK_BOT_CLAUDE_CHANNEL=review claude --dangerously-load-development-channels plugin:gbot@gbot-marketplace
# From another terminal on the same machine and OS user:
gbot claude send review "Reply with GBOT_CLAUDE_OK" --json
```

Accept Claude's development-channel prompt. Custom channels are a research preview and need session opt-in and any applicable organization policy. The development flag permits this channel; it does not bypass tool approvals. `claude_send` takes `name`, `message` and optional `timeoutMs` (default 60000, maximum 120000). Claude answers with `claude_reply` and the incoming `request_id`; only that reply completes the call, and a notification alone is not proof. Timeout or disconnect returns `unknown`; do not resend automatically.

Each name selects one live session. Sockets live in `~/.grok-bot-cli/claude/` (directory 0700, sockets 0600) and reach local processes of the same OS user only. No TCP listener, automatic approval, history scraping or background daemon is installed. Without `GROK_BOT_CLAUDE_CHANNEL` the channel is off. A second session with the same name fails rather than taking over the first. A crashed process can leave a socket: confirm the named session is stopped before removing it.

### Automatic Grok ↔ Codex replies

In a native Codex invocation, `gbot_send` sends once and returns a durable exchange receipt. Matching Grok replies arrive in the originating Codex thread automatically; that thread's next answer goes back to Grok only if you send again. The background worker outlives the MCP caller. Host tool-approval policy still applies.

Without native identity (including Cursor), pass `codexThreadId` on the send, or bind once with `gbot_bridge_start` (`grokTarget`, `codexThreadId`, optional `expectedCwd`). New visible Grok messages then arrive in that Codex thread, and its terminal answer returns to Grok. Existing history is not replayed. Without a source or an explicit route, `gbot_send` does an ordinary send and returns `replyRoute: {mode: "manual", reason: "source-unavailable"}`; read later with `gbot_thread`. A failed automatic-route start never falls back to an untracked send.

```sh
# CLI sends stay manual unless routing is requested.
gbot send --reply-mode auto --codex-thread-id THREAD_ID Researcher "Please investigate"
gbot codex bridge start --codex-thread-id THREAD_ID --expected-cwd /project Researcher --json
gbot codex bridge status --json
gbot codex send --reply-to-grok Researcher THREAD_ID "Investigate and return your final answer"
gbot codex bridge stop --binding-id BINDING_ID --json
# Stop the worker; pending records stay for a later restart.
gbot codex bridge stop --worker --json
```

Messages a Codex thread sends to Grok Bot (`gbot_send` with a native or explicit `codexThreadId`, the managed bridge and its returned answers, and `gbot send` run inside a Codex terminal where `CODEX_THREAD_ID` is set) start with `[from Codex thread <id> @ <machine>, cwd <cwd>; reply: codex_send({threadId:"<id>", message:"..."}) via MCP on <machine> (or CLI: gbot codex send <id> "...")]`. `<machine>` is the hostname; `GROK_BOT_MACHINE_NAME` overrides it.

`gbot_bridge_status` / `gbot codex bridge status` separates worker health, binding coverage, submission, execution, return delivery and pending interactions. `unknown` is not rejection: check status before resending. `--request-id` replays a tracked send exactly, without another submission. `gbot_codex_respond` / `gbot codex bridge respond` answers a pending interaction with the current `interactionId`, `generation`, `threadId` and `turnId`, plus a one-time `decision: accept|decline|cancel` or `answersJson`; session permissions stay in the Codex UI.

Relay state lives in `~/.grok-bot-cli/relay/` (or `GROK_BOT_RELAY_DIR`), with a separate worker and session per resolved login. A pinned directory whose stored profile does not match refuses to start with `Relay profile mismatch`; upgrade steps are in [FORK.md](../FORK.md#verify-upgrade-uninstall). `gbot codex bridge run --lifetime-ms N` runs the relay in the foreground for up to 23 hours; the packaged `dist/scripts/gbot-relay.mjs` runs without that limit. Network reconnects are automatic; a dead worker needs a new tracked send or `bridge start`.

### Codex threads (`gbot codex`)

`gbot codex` talks to a local [Codex app-server](https://learn.chatgpt.com/docs/app-server) daemon over its control socket (`$CODEX_HOME/app-server-control/app-server-control.sock`, or `CODEX_APP_SERVER_SOCK`), with the documented JSON-RPC methods.

```sh
codex app-server daemon start
gbot codex status
gbot codex list-threads --limit 10
gbot codex list-threads --query launch --active-within 7d
gbot codex send THREAD_ID "Grok here: the build is green, please continue."
gbot codex send --model gpt-6-astra --effort high THREAD_ID "Review this change"
gbot codex new --cwd ~/project --model gpt-6-astra --effort high "Start here"
gbot codex wait THREAD_ID TURN_ID --timeout-ms 1800000
```

- `send` resumes the thread, starts a turn, prints the turn id and returns; Codex keeps working after gbot disconnects. Options go before the thread id. Every command accepts `--json`.
- `list-threads` lists newest activity first across every model provider (`--sort updated|created|recency`, `--order asc|desc`). `--query` matches name, title, preview or an id prefix across every page; `--active-within 7d`, `--since`, `--cwd`, `--model-provider`, `--source-kind` and `--archived` filter; `--cursor` takes the previous `nextCursor`. The `codex_threads` MCP tool takes the same fields.
- `new` starts a thread in `--cwd` with an optional model, effort and first message, also on daemons that write no rollout before the first turn. `--expected-cwd` guards the directory.
- Busy threads: only `idle` and `notLoaded` threads start a turn. An `active` thread is refused with `reason: "busy"` unless you pass `--when-busy queue` (needs `GROK_BOT_CODEX_EXPERIMENTAL=1`; `gbot codex queue THREAD_ID` shows what waits) or `--when-busy steer` with `--expected-turn-id`. `systemError` is `reason: "thread-error"`, usually an unhealthy daemon. Decision record: [codex-busy-threads.md](codex-busy-threads.md).
- Receipts: `delivery` is `accepted` (turn started), `queued`, `rejected` (nothing was sent; `reason` says why), or `unknown` (look for `messageId` in the thread before resending). A failed turn also says why.
- Every send carries `messageId`, `correlationId`, optional `replyTo` and `hop`. Sends at `hop >= GROK_BOT_MAX_HOPS` (default 4) are refused, which stops two agents from acknowledging each other forever. `GROK_BOT_CODEX_THREADS=id,id` limits sends to approved threads.
- gbot never approves commands or file changes: an approval request during `send` is refused (`approval-refused`). For unattended sends set `approval_policy = "never"` in the daemon's `config.toml`.
- Codex must run on the same machine as gbot; gbot has no remote transport. From the Grok Bot box, run `gbot` on your computer through Grok Bot Shell with a machineId. Native Windows is not supported (Unix socket); use WSL, Linux or macOS. `gbot codex status --json` reports `socketState`, `mode`, the daemon and CLI versions, and `exitCode` (0 only for a usable daemon).

### ChatGPT Desktop

ChatGPT Desktop runs its own private stdio app-server and does not publish the shared control socket ([openai/codex#41014](https://github.com/openai/codex/issues/41014), [openai/codex#41112](https://github.com/openai/codex/issues/41112)). Two ways in:

```sh
gbot codex desktop-shim install    # wrapper + bridge into ~/.codex/bin; LaunchAgent on macOS
gbot codex desktop-shim status
gbot codex desktop-shim uninstall
```

The shim is a `CODEX_CLI_PATH` wrapper that turns Desktop's `codex … app-server` spawn into a stdio ↔ WebSocket bridge onto the managed daemon socket, with no Desktop binary patches. It passes one-shot startup configuration, sign-out, help, version and every non-`app-server` request to the real `codex`, and falls back to stock Codex on any preflight or pre-session failure, before any stdin byte is consumed. Deadlines: `CODEX_BRIDGE_CONNECT_TIMEOUT` (10 s), `CODEX_BRIDGE_FIRST_MESSAGE_TIMEOUT` (30 s), `CODEX_BRIDGE_IO_TIMEOUT` (30 s). On macOS a LaunchAgent keeps `CODEX_CLI_PATH` in the GUI environment across logins and starts the daemon with a raised open-file limit; quit and relaunch ChatGPT after install. Desktop's spawn-time app-tools MCP overrides are not forwarded to the managed daemon.

```sh
osascript -e 'tell application "ChatGPT" to quit' \
  && open -a /Applications/ChatGPT.app --args --remote-debugging-port=9222
gbot chatgpt-desktop status
gbot chatgpt-desktop threads --limit 20
gbot chatgpt-desktop search "launch"
gbot chatgpt-desktop read THREAD_ID --full --limit 200
gbot chatgpt-desktop send --project Launch "hello"
```

`gbot chatgpt-desktop` drives Desktop over local CDP (`127.0.0.1` only). List, search and read prefer the Codex app-server; send, new chats and waits use CDP. Results report `backend: "cdp" | "app-server"`. Details: [chatgpt-desktop-cdp.md](chatgpt-desktop-cdp.md).

### MCP tools

The `grok-bot` MCP server has `gbot_send`, `gbot_thread`, `gbot_grok_approvals`, `gbot_grok_respond`; `codex_threads`, `codex_send`, `codex_new`, `codex_wait`, `codex_watch`; `gbot_bridge_start`, `gbot_bridge_status`, `gbot_bridge_stop`, `gbot_codex_respond`; `claude_send`; and `chatgpt_desktop_status`, `chatgpt_desktop_list_hosts`, `chatgpt_desktop_list_threads`, `chatgpt_desktop_search_threads`, `chatgpt_desktop_read_thread`, `chatgpt_desktop_open_thread`, `chatgpt_desktop_send`, `chatgpt_desktop_wait_reply`.

`gbot_thread` returns a small receipt by default (`summary`, `cursor`, `entryCount`, `gapReset`). Pass the cursor back as `after` for the entries after it, and `full: true` for bounded entry bodies.

The MCP tools pick the login as `gbot` does without `--account`: `GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN` when both are set, otherwise `GBOT_ACCOUNT`, then the config default, then the descriptor's single or app-active entry; `CURSOR_ACCESS_TOKEN` only when there is no app login. They need outbound HTTPS and read access to the app's session folder (`~/Library/Application Support/Grok Bot` on macOS, `~/.config/Grok Bot` on Linux, `%APPDATA%\Grok Bot` on Windows). Run `gbot doctor` in the same sandbox to see which sources are visible.

To route a repository's agents to a bot, add a note to its `AGENTS.md`:

```md
## Grok Bot

Use the `grok-bot` MCP tools to coordinate with Grok Bot. Send questions and
handoffs to the `General` bot with `gbot_send` (first line: who you are and what
you need), then read the reply with `gbot_thread`. Do not block a turn waiting
for it.
```

### Gateway URL policy

gbot sends credentials only to expected hosts:

- Gateway URLs (box and API): `https` on `*.cursor.sh`, `*.cursor.com` or `*.cursorvm.com`.
- Backend URLs (`EnsureSandBox`, the 0.78 RPCs, `CURSOR_API_BASE_URL`): `https` on `*.cursor.sh` or `*.cursor.com` only, never `*.cursorvm.com`.
- `GROK_BOT_ALLOW_LOCAL_GATEWAY=1` permits `127.0.0.1`, `localhost` and `::1` for gateways only, with a stderr warning.
- `GROK_BOT_ALLOW_ANY_GATEWAY=1` disables host checks for a gateway URL and a user-supplied `CURSOR_ACCESS_TOKEN` (break-glass only). It does not apply to the app login token, which goes only to an https Cursor API host.

All gateway and backend fetches reject redirects, so credentials are not followed across them.

### Local history

Recording is opt-in. With `GROK_BOT_HISTORY=on`, successful `send` and `thread` observations are appended as plain-text JSONL to `~/.grok-bot-cli/history.jsonl` (`--history-dir` or `GROK_BOT_HISTORY_DIR` moves it; `--no-history` skips one command). New directories are 0700 and files 0600. Message text is kept as typed; credentials and raw response metadata are not.

```sh
export GROK_BOT_HISTORY=on
gbot send Researcher "Investigate the startup timeout"
gbot history Researcher --search timeout
gbot history --path
```

## Platforms and limits

| OS | Node.js | Status |
| --- | --- | --- |
| macOS | 22.19+ (22.x) or 24.2+ | Supported |
| Linux | 22.19+ (22.x) | Supported |
| Windows | 22.19+ (22.x) or 24.2+ | Supported except Codex/Claude channels and the relay |

- The app session is read from `~/Library/Application Support/Grok Bot` (Keychain `Grok Bot Safe Storage`), `$XDG_CONFIG_HOME/Grok Bot` or `~/.config/Grok Bot` (`secret-tool`, package `libsecret-tools`), or `%APPDATA%\Grok Bot` (DPAPI).
- Codex and Claude channel commands and the relay need a local Unix socket; gbot has no remote transport.
- The gateway is undocumented and can change. `approvals respond` on the backend, and the Linux and Windows saved-login wake, are implemented but not live-tested.
- gbot sends no telemetry. Local message history is off unless `GROK_BOT_HISTORY=on`. Test evidence per OS (CI on Linux with Node 22 and 26, and on Windows), privacy and Windows limitations: [FORK.md](../FORK.md#platforms).

## Upstream fixes in this fork

Cherry-picked from upstream 0.11.3–0.12.5, with their authors ([CHANGELOG.md](../CHANGELOG.md)):

- the codex-dot skill (026c9fa);
- a Codex sender prefix on Codex→Grok messages, and `codex list-threads` sorted by activity with `--query`, `--active-within` and filters (c11781b);
- the reason for a rejected Codex delivery or a failed turn, and a higher open-file limit for the macOS daemon (efe5e4b);
- `codex new --cwd DIR "msg"` on newer Codex daemons (7fa32e1);
- the desktop shim passes startup, sign-out, help and version to the real Codex CLI (a86461d);
- `gbot-install install grokbot` sideloads the plugin into Grok Bot's own plugin folders (agent-bundle 0.4.0; eb93aaf, def7ad4);
- a gateway's bare `{"accepted": true}` gets the transcript entry id as `messageId` (92bdd62, adapted);
- the client version comes from the app's `desktop-status.json` first (from 0f29266);
- upstream 0.12.5's dependency updates (MCP server 2.4.0, zod 4.6.7, React 19.3.1) and Node 26 in CI.

Upstream's 0.12.x session and reconnect rework is not taken: the fork's 0.78 backend, account selection and `gbot wake` cover that ground.
