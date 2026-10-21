# grok-bot-cli

## Fork changes (ImL1s)

Fork tags are `v0.11.2-iml1s.N`. The package version stays `0.11.2`. Upstream entries follow after this section.

### Unreleased

- Every login the Grok Bot app has signed in (`sand-secrets.json` → `cursor-accounts`) stays reachable after the app shows a different login. The descriptor often keeps only the login on screen. `gbot accounts` lists both, with the email when the profile decrypts (otherwise the first 8 hex characters of the scope), `(app active)` for the app's current login, and `(no app session; gbot builds one from the saved login)` when that login has no descriptor entry. `--json` keeps `id`, `label`, `savedAtMs`, `lastSaved`, and `usable`, and adds `email`, `alias`, `appActive`, `hasDescriptorEntry`, and `exitCode` (`0` when the list succeeds; the command's exit code is taken from the result). `alias`, `unalias`, and `default` are arguments of `gbot accounts` (`gbot accounts alias <name> <selector>`), because this bundler rejects a command that is also a command group. `--account` and `GBOT_ACCOUNT` match an alias, an email, a descriptor label, or an id prefix of at least 8 hex characters. A descriptor entry is used as before. A saved login with no descriptor entry is described (`wake: false`) and, unless it is already `RUNNING` with gateway fields, woken; that session stays in memory and is not written to an app file. The refresh token is still never read. The app token is still sent only to https Cursor API hosts. `gbot wear pair` still sends descriptor sessions only. `gbot doctor` still inspects the descriptor and does not apply the config default.
- Aliases live in a config file with no tokens: `$XDG_CONFIG_HOME/grok-bot-cli/config.json` (default `~/.config/grok-bot-cli/config.json`) on macOS and Linux, `%APPDATA%\grok-bot-cli\config.json` on Windows, or `GBOT_CONFIG`. Mode 0600, atomic replace, created only when a command writes it. `gbot accounts alias <name> <selector>`, `unalias <name>`, `default <name>`, and `default --clear`. A name matches `^[A-Za-z0-9_-]{1,32}$`. Gateway commands resolve `--account`, then `GBOT_ACCOUNT`, then the config `default`, then the single-login rule. `gbot config path` prints the path. `gbot config export [--out <file>]` writes aliases, the default, emails, and `gbotVersion`, never tokens. `gbot config import <file> [--replace]` merges unless `--replace`. Exit 0 imported, 2 usage or invalid (nothing written), 3 imported and at least one alias scope is not signed in on this machine (`sign in to <email> in the Grok Bot app`).
- `scripts/install-fork.sh [ref]` and `scripts/install-fork.ps1` clone `https://gitlab.com/aa22396584/grok-bot-cli.git` into the cache (`$XDG_CACHE_HOME/grok-bot-cli/src`, default `~/.cache/...`), check out the ref (default `main`), run `npm ci` then `npm pack` (prepack fills `dist/` from the committed `artifact/`), and `npm install -g` that tarball. They then run `gbot --version` and `gbot accounts`. `--config <file>` imports it. Each alias is checked with `gbot wake --check --account <alias>`. `--dry-run` prints those steps and runs neither git nor npm. Both refuse root or Administrator unless `--allow-root` or `-AllowRoot`. They do not store or print tokens. The shell dry-run was tested with fake `git` and `npm` on `PATH`. The PowerShell script was checked by reading it. Neither script was run against GitLab here.
- A second EnsureSandBox reply that is still `HIBERNATED` after the wake budget is already gone is `WAKE_TIMEOUT` (`gbot wake` exits 4). A second `HIBERNATED` reply while budget remains is still `WAKE_FAILED`.
- The Windows `/f` search keeps an uninstall key path that contains spaces (the whole `HKEY_…` line, trimmed). A `DisplayName` of `Grok Bot` with no version suffix still leads to a `/v DisplayVersion` query on that full key.
- Test mode shares one secret-store helper (`src/core/secret-store.js`) for gateway sessions, `gbot wake`, and `gbot wear pair`. The real Keychain, `secret-tool`, or DPAPI is not called. A fixture password is used only when `GROK_BOT_TEST` is exactly `1` and `GBOT_TEST_KEYCHAIN_PASSWORD` is set.
- A gateway answer of HTTP 417 is reported as an asleep box when the proxy header `x-anyrun-failure-reason` is `pod_hibernated`, when it has no `failureCode`, or when its `failureCode` mentions sleep or hibernation (a 417 whose proxy reason is something else stays `kind: "client"`; the proxy reason is on the error as `failureReason`): `kind: "asleep"`, `code: "BOX_ASLEEP"`. Seen live on 2026-10-20: every call for a login answered 417 with an empty body and `x-anyrun-failure-reason: pod_hibernated`; a 417 without that header can also be `BOX_ASLEEP`. Selecting a bot of that login in the app woke it; opening the app or a bare `grokbot://` in the background (`open -g`) did not. Switching the app to that login was also observed to wake the box on 2026-10-20 (one owner session); that is an observation, not a rule. Other 417 failure codes stay `kind: "client"`. gbot now tries to wake the box itself; if that fails, the message says why.
- A send whose roster lookup fails (for example on an asleep box) is now `delivery: "rejected"`, with the caller's `clientNonce` when the caller passed one (the relay's queued submissions do; `gbot send` and the relay's manual send have none at that point): the prompt was never transmitted. Before, the error had no delivery state and the relay recorded it as unknown.
- The gateway read cap is now 16 MiB (was 2 MiB): `gbot skills list` on a real account passed 2 MiB. `GBOT_MAX_RESPONSE_BYTES` sets it to a byte count from 65536 (64 KiB) to 67108864 (64 MiB); any other value (`32M`, `0`, out of range) is ignored and the too-large error says so. Peak memory for one read is a few times the cap. The read still streams and stops at the cap. The unit test runner drops the variable from the developer's environment.
- `x-cursor-client-version` is `SAND_CLIENT_VERSION` when that is `major.minor.patch` (a fourth numeric part such as `0.72.1.0` is dropped), otherwise the installed Grok Bot app. macOS reads `Info.plist`. Windows runs `reg.exe` from `SystemRoot\System32` (not the current directory), looks up uninstall id `8db316bb-b3e2-5dd2-9554-ecccb62be362` under HKCU, HKLM, and HKLM WOW6432Node, then a narrow `reg query /f "Grok Bot" /d`. From that `/f` output gbot takes the `HKEY_…` key whose `DisplayName` matches `^Grok Bot(\s|$)`, queries that key with `/v DisplayVersion`, and if that query fails or the budget is gone, parses the version from the `DisplayName` suffix (`Grok Bot 0.72.1` becomes `0.72.1`). The lookup shares about a 3 second budget. Linux has no version lookup. Otherwise the version is `0.72.1`. An invalid value falls back to `0.72.1`. The installed version is cached for the process. A 401 "no longer supported" drops that cache only when the cached value came from the installed app, not from `SAND_CLIENT_VERSION` and not from the built-in default, and at most once per 10 minutes. Live on 2026-10-21, `0.20.0` made EnsureSandBox answer 401 "no longer supported" and `0.72.1` was accepted. That 401 names the version gbot sent and that `SAND_CLIENT_VERSION` can override it. During auto wake that failure is `wake.error` `CLIENT_VERSION_REJECTED`, not `unauthorized`.
- An app-login gateway call that fails with `BOX_ASLEEP` loads that login's saved access token and calls EnsureSandBox `{ "wake": true }`. The secrets file is parsed whole; gbot never decrypts or uses the refresh token and never writes an app file. The app login token is sent only to an https Cursor API host. `GROK_BOT_ALLOW_ANY_GATEWAY` does not apply to it (it still applies to a user-supplied `CURSOR_ACCESS_TOKEN`). Polling covers `STARTING`, `RUNNING` without gateway fields, and `unknown` that still names gateway fields. Each EnsureSandBox call uses the time left in an about-90-second budget, and at most 30 seconds, with `{ "wake": false }` about every 3 seconds. A `wake: true` answer that is still `HIBERNATED` waits the shorter of the poll interval and the time left, gets one more `wake: true`, and then `WAKE_FAILED`. If an EnsureSandBox call hits its per-call deadline while budget remains, gbot keeps polling. When the budget is used up and the box is still not ready, the failure is `WAKE_TIMEOUT` (`gbot wake` exits 4), not `WAKE_FAILED`. The original call is then retried once. Only these read-only methods wake and retry on a bare 417: `listAgents`, `getAgentThread`, `getAgentTranscriptTail`, and `getAgentWorkflows`. Those are the only read-only gateway methods. Every other method, including `sendPrompt`, wakes and retries only with positive sleep evidence (`failureReason` is `pod_hibernated`, or a `failureCode` matching sleep or hibernation); a bare 417 stays `BOX_ASLEEP` and is not resent. A `sendPrompt` retry uses the same `clientNonce` (a retry whose delivery is unknown stays unknown). One wake runs per login at a time. Aborting one waiter cancels that waiter (`delivery: "rejected"`, `reason: "cancelled"`). Aborting the last waiter drops the shared wake. `GBOT_AUTO_WAKE=0` turns this off. Both `GROK_BOT_GATEWAY_URL` and `GROK_BOT_GATEWAY_TOKEN` together are never woken. If waking fails, the error stays `code: "BOX_ASLEEP"` and gains `wake: { attempted: true, error }` plus a short reason. If the retry is still asleep, `wake` is `{ attempted: true, woke: true }`. `gbot send --json` includes `wake` and `failureReason` when present. `GBOT_DEBUG` logs one stderr line and no secrets.
- `gbot wake [--account <label|id>] [--check] [--json]` prints the account label, the run state before and after, and the seconds taken. `--check` only describes (`{ "wake": false }`). Without it, gbot wakes, waits for `RUNNING` (about 90 seconds), and lists bots once. A failed wake reports the backend `runState` when it has one. A legacy EnsureSandBox answer with gateway fields and no runState is ready, so `after` is `RUNNING`. Exit 0 running or `--check` ok, 2 usage (including both gateway override variables set: `gbot wake uses the saved app login; unset the override`), 3 could not wake, 4 the wake budget ran out before the box was ready. Errors are printed with control characters stripped. It never prints tokens, gateway URLs, or network tokens.
- Wake via `{ "wake": true }` with the app login token was verified live on macOS on 2026-10-21: a hibernated box became `RUNNING` in about 10 seconds, and `listAgents` through the returned gateway answered 200. On that day a new process using the stored gateway session with `GBOT_AUTO_WAKE=0` listed bots after the wake; the stored gateway URL and token stayed valid across hibernation in that case. That is an observation, not a guarantee. The Linux saved-login token path is implemented and has not been live-tested. The Windows saved-login token path and the registry lookup are implemented and have not been live-tested, except the registry values, which were read live on 2026-10-21 (`DisplayName` `Grok Bot 0.72.1`, `DisplayVersion` `0.72.1`, publisher `SpaceXAI`, install `D:\APP\Grok Bot`). gbot's lookup was not run on that machine.
- gbot reaches EnsureSandBox through `CURSOR_ACCESS_TOKEN` only when there is no usable app login and not both `GROK_BOT_GATEWAY_URL` and `GROK_BOT_GATEWAY_TOKEN` are set. That path sends `{ "wake": true }` with the client version above and polls a `STARTING` answer the same way (about 90 seconds), so a starting box is not reported as a dashboard API key. If that wake ends with no gateway fields and no run state, the error says the auth may be a dashboard API key. `GROK_BOT_ALLOW_ANY_GATEWAY` still applies to this user-supplied token. The same `{ "wake": true }` call was verified live on macOS on 2026-10-21.

### 0.11.2-iml1s.4

- `gbot wear pair <ip:port> [--account <label|id>]` sends the selected saved login's gateway session to the grok-bot-watch Wear OS app on the same network over GBWP/1 (ECDH P-256, HKDF-SHA256, AES-256-GCM, authenticated by the 60-bit code the watch shows). The code is typed at a hidden prompt and handed to the worker in a 0600 file, never in argv or an environment value. A typo in the check character is caught before any network access; the session is checked with the watch's own import rules before connecting; `GBOT_ACCOUNT` is ignored; nothing secret is printed. Exit codes 0/2/3/4/5/6 as listed in FORK.md.
- `loadGrokBotGatewaySelection` reads the saved logins in one decrypt pass and asks the OS secret store once.
- `wear pair` hardening after review: the wrapper refuses a production `--code` or `--code=…` anywhere on any `gbot` command line (only `wear pair` has that option) before any worker starts; an interruption or error after the session started to leave reports `unknown` (exit 6), not cancelled; an abort during connect stops at once; SIGHUP is handled like SIGTERM; unreadable saved logins (Keychain) and a test-mode secret store are reported as such; labels or ids that alias a secret are shown as `login <n>`.
- `wear pair` review round 2: the send is recorded before M3 and nothing is sent if that record fails (exit 1); after an interrupted send the wrapper also says on stderr that the session was already sent; `login <n>` placeholders never repeat a real label or id; only logins that all fail to decrypt are reported as a secret-store problem; FORK.md lists 130/143/129 for SIGINT/SIGTERM/SIGHUP before sending.
- Live sends are reported correctly: the cloud gateway answers `{"accepted":true}` without a `messageId`, which earlier versions reported as `delivery: "unknown"`. `accepted: true` or a string `messageId` now counts as accepted; anything else stays unknown.
- Every send receipt and send error carries the `clientNonce` that was posted. `gbot reconcile <bot> --nonce <n>` looks for that nonce in the latest 200 transcript entries and never resends.
- Gateway errors carry `kind` (`auth` for 401/403, `routing` for an unroutable 404, `unsupported` for `gateway/unknown-method`, `server`, `client`) and the host's `failureCode`.
- Note: `sendPrompt` to an id that is not on the roster answers 409 but still creates an empty "New Agent" placeholder, so `send` keeps resolving the target first.
- Internal: the unused top-level `src/transcript.js` is removed (the live module is `src/core/transcript.js`); the committed artifact manifest lists tracked files only; Linux CI runs the unit tests as the unprivileged `node` user.

### 0.11.2-iml1s.3

- Grok Bot app gateway descriptor version 3 is supported using the version 2 entries layout; unknown descriptor versions continue to be rejected.
- A first run without a Grok Bot login says to sign in to the Grok Bot app and run `gbot accounts`, instead of pointing at a macOS agents directory. `--dir` and `--files` keep the old error.
- The unit suite passes on Node 24: the Windows-collection test asks Node for TAP output.
- `npm run typecheck` passes again.
- Windows unit tests collect the same files as Linux and skip the Unix-socket suites listed in FORK.md.
- Docs: install from the release package file, disclaimer, privacy, troubleshooting, and platform matrix in FORK.md; CONTRIBUTING.md, SECURITY.md, issue and merge request templates. LICENSE names the fork's changes next to the upstream notice.

### 0.11.2-iml1s.2

- Windows checkouts keep LF, and the Windows unit job imports MCP clients by `file://` URL.
- `send --stdin` accepts a UTF-8 or UTF-16 byte-order mark. FORK.md documents the fork.

### 0.11.2-iml1s.1

- Synced to upstream 0.11.2. Kept the fork's `send --stdin`, `--json thread --normalized`, `thread --after`, and 15 second send deadline.
- Account selection: `gbot accounts`, `--account` after the subcommand, and `GBOT_ACCOUNT`.

## 0.11.2

### Patch Changes

- 3e4b05a: Update agent-bundle to the merged main preview (ae3473c36b) and rebuild the plugin artifact.
- 3ff286e: Update `@modelcontextprotocol/server` to 2.2.0 and rebuild the bundled Claude channel MCP artifact.

## 0.11.1

### Patch Changes

- ddfdc9d: Update agent-bundle to the 0.3.2 release preview (854e79f16e) and rebuild the plugin artifact, so `gbot-install install grokbot`, `uninstall grokbot`, and `doctor --host grokbot` stage the Cursor projection as a Grok Bot marketplace repository.
- 2c84000: Add `description` frontmatter to the `codex-send`, `codex-threads`, and `codex-wait` plugin commands so `claude plugin validate --strict` and `gbot-install doctor` no longer report AB6020 "No frontmatter block found".

## 0.11.0

### Minor Changes

- f581d51: Scaffold ChatGPT Desktop CDP adapter and MCP/CLI tools (`chatgpt_desktop_*`). List/search keep separate `host` / `modelProvider` filters; `list_hosts` discovers hosts and providers. Codex list-threads always passes `modelProviders: []`, pages via `nextCursor`, and falls back from `useStateDbOnly` when empty. Codex send/read/wait strip Desktop `local:` ids; remote-control "thread not loaded" maps to `REMOTE_THREAD_NOT_LOADED` with host. Thread reads use `thread/read` metadata + `thread/turns/list` (never deprecated `includeTurns`).
  
  Keep CDP loopback-only across discovery, bound and close sessions, serialize UI operations, distinguish partial replies and uncertain sends, and preserve dynamic remote/provider filtering and ordered empty-safe history reads.

### Patch Changes

- f581d51: Fix ChatGPT Desktop host discovery, bounded thread reads and searches, list pagination, CDP navigation and project clicks, status reachability, and result provenance. Add complete MCP and skill guidance, project filters, archived-thread reads and explicit unarchive-on-send support.
  
  Keep MCP Desktop results below the Agent Bundle document cap with resumable, lossless read fragments and byte-bounded list/search pages. Compact display titles while matching search against full titles, and align remote host counts with filtered inventory.
- f581d51: Page ChatGPT Desktop threads from a stable, sorted merged inventory so CDP and remote rows appear once in their timestamp range and requested page sizes are filled. Resolve project labels from Desktop assignments and workspace roots. Verify new-chat navigation and project scope before sending, and report unavailable project roots promptly.

## 0.10.2

### Patch Changes

- e746891: Explain local Codex socket placement, CODEX_APP_SERVER_SOCK, and machine-targeted Grok Bot Shell use in missing-socket errors.
- e746891: Support model and reasoning effort overrides for Codex sends and add local new-thread CLI and MCP routes.
- e746891: Add Claude Code and Cursor slash commands for sending to, listing, and waiting on Codex threads.
- e746891: Update Codex queue guidance and API pin for 0.158.0, with clear experimental-gate and unsupported-method errors.
- e746891: Keep Codex wait observing through notification floods, reconcile completion from turn history, and allow two-hour caller timeouts.
- 09e977c: Bump `@rstest/core` to 0.12.2.

## 0.10.1

### Patch Changes

- 3508def: Tell Grok Bot agents that Codex/Claude tools use local sockets only: on the box, do not call them — run `gbot` on the user's machine via Grok Bot Shell with a machineId after `codex app-server daemon start` / bootstrap. No remote transport.

## 0.10.0

### Minor Changes

- a619538: Add an opt-in native Claude Code channel, with private local messaging and correlated replies through `gbot claude send` and `claude_send`.

### Patch Changes

- 75521df: Update agent-bundle to the 0.3.1 release preview (899755dc6d) and rebuild the plugin artifact.
- 3f64ac2: Update agent-bundle to b4e38409f4 so generated executables no longer ship bundled dependencies' comments.
- 872eb61: Reduce the messaging skill's default context by loading bridge administration and diagnostic procedures only when needed.
- 657ed43: Update the Claude channel MCP server SDK to 2.1.0.

## 0.9.1

### Patch Changes

- f2482eb: Build the plugin with the agent-bundle 0.3.0 pkg.pr.new preview (4f62216f30).
- c49a0b8: Ship generated host marketplaces and the complete Agent Bundle artifact in the GitHub repository so Codex, Claude Code, and Cursor can install it without a local build.

## 0.9.0

### Minor Changes

- a1031eb: Add `gbot skills list|add|remove` for the account-wide Grok Bot skill library over the gateway (`getAgentWorkflows`, `importAgentWorkflowText`, `deleteAgentWorkflow`). Grok Bot has no per-bot skill attach: `add` makes a `SKILL.md` visible to every bot, `remove` deletes a `workflow` skill for every bot and refuses `managed`, `plugin`, and `automation` entries. Skills have no `--files` mode.

### Patch Changes

- fde32cd: Preserve nested Codex MCP overrides when the generated installer replaces an enabled plugin. Refuse replacement when plugin-level enablement is disabled or unknown.

## 0.8.0

### Minor Changes

- e5b5c87: Expose cross-host MCP messaging tools: hide Codex tools in Codex and Grok tools in truthfully identified Grok Bot clients, while retaining shared bridge controls.

## 0.7.0

### Minor Changes

- 8dd8d3d: Forward pending Grok auto-review and local-tool approval cards as Codex notices without treating chat replies as authorization. Add CLI and MCP commands to inspect requests and explicitly accept once or decline an exact current request.

### Patch Changes

- a31df6f: Allow automatic messaging to establish a checkpoint over older bot outputs without run IDs while continuing to reject new outputs without correlation IDs.
- 27966e6: Pin the Agent Bundle compiler and runtime to the same immutable preview commit so rebuilds do not depend on mutable pull-request tarballs.
- f2b08fb: Tighten Desktop private-stdio detection so probe-shell cmdlines that only mention ChatGPT.app + app-server + codex-app-tools no longer false-positive; keep the Resources/codex path match.
- 1e68988: Isolate relay workers by their desktop keyring environment so headless MCP callers cannot replace the authenticated worker used by desktop CLI callers.

## 0.6.0

### Minor Changes

- 0f86d73: Add Codex conversation tools to generated plugins and MCP: bounded thread discovery, guarded sends, completion waits, and event watching. Add CLI wait/watch and send --wait while preserving immediate send receipts.
- ae51078: Add managed Grok/Codex conversation delivery with native Codex reply routing, explicit durable links, scoped operator responses, background worker lifecycle controls, and packaged foreground service entry. Preserve manual sends when native identity is unavailable and distinguish accepted submissions from execution and return delivery.

## 0.5.0

### Minor Changes

- aeb5ebf: Use `gbot thread`, `GROK_BOT_GATEWAY_URL` with `GROK_BOT_GATEWAY_TOKEN`,
  `CURSOR_ACCESS_TOKEN`, `CURSOR_API_BASE_URL`, `GROK_BOT_AGENTS_DIR`, and `entries`
  transcript containers; remove the `chat` alias, the `GROK_BOT_ACCESS_TOKEN` and
  `SAND_ACCESS_TOKEN`, `SAND_BACKEND_URL`, `SAND_HOST_GATEWAY_*`, `SAND_GATEWAY_TOKEN`,
  `SAND_HOST_PORT`, `SAND_AGENTS_DIR`, and `SAND_DATA_ROOT` compatibility variables,
  implicit localhost gateway routing, and fallback transcript and entry-id shapes (#69).

## 0.4.5

### Patch Changes

- f7fbeea: Report Desktop shim configuration separately from attachment evidence. `gbot codex status` now includes `desktopShimConfigured` and no longer emits `attached-shim` merely because the wrapper is installed and selected. Preserve observed private-stdio processes and report managed attachment as unverified, including when the daemon is unreachable.
- 5395aa7: Refuse every non-loopback gateway or backend URL when `GROK_BOT_TEST=1` or `NODE_ENV=test`, ignoring `GROK_BOT_ALLOW_ANY_GATEWAY`, so the test suites can never send a prompt to a live thread. The unit and route-unit runners set `GROK_BOT_TEST=1`.

## 0.4.4

### Patch Changes

- 4563466: Report `attached-shim` from `gbot codex status` when the desktop-shim is active (installed wrapper that the Desktop-facing `CODEX_CLI_PATH` points at), outranking a stale-looking private-stdio process list.

## 0.4.3

### Patch Changes

- 53cfbee: Stack the must-fix set from the Codex reject of the Act-On-PR bridge and the unfinished follow-up accept bar: commit stdout BEFORE writing (dirty stdout never exits 1 / never fail-opens to stock Codex) with bounded stdout writes and termination, keep healthy idle reads untimed (separate absolute handshake/first-RPC deadline from mid-session write/lock budgets), clear the init timer only on the matching initialize response/error (notifications never satisfy it), stay silent on foreign serverRequest approvals (deferring turn-scoped ones until the turn id is known), require strict HTTP/1.1 101 plus accept, flush EOF-tail data before the WS Close, and keep the wrapper hardening (self-fallback refusal, bridge+python3+preflight gating, uninstall reporting, Linux status wording with shell-quoted path).

## 0.4.2

### Patch Changes

- f874c4e: Add `gbot codex desktop-shim install|uninstall|status`: installs a fail-open `CODEX_CLI_PATH` wrapper plus stdio-to-WebSocket bridge under `~/.codex/bin/` so ChatGPT Desktop shares the managed Codex app-server daemon (stock `app-server proxy` hangs for Desktop stdio). The wrapper preflights the socket and runs the bridge as a fallible child (no daemon start on the hot path), exports the `CODEX_HOME`-derived socket, the bridge handshake and first RPC run under absolute deadlines with accept validation and continuation assembly, the stdin commit point is byte-precise, `status` reads the macOS GUI-domain env, and `send` no longer answers another client's approvals outside its own turn. macOS persists the GUI env via LaunchAgent; uninstall restores stock Desktop/Codex behavior.

## 0.4.1

### Patch Changes

- 409e5c8: Update the development Node.js type definitions to v24. (#51)

## 0.4.0

### Minor Changes

- 1dc6d34: Ship `gbot` as one generated Agent Bundle CLI at the package root and add `gbot-install install|uninstall <cursor|codex|claude>` / `gbot-install doctor` for the bundled `grok-bot` MCP tools and `talk-to-grok-bot` skill; delete the nested `plugin/` project and the hand-written dispatcher. Breaking (pre-1.0): Node.js 22.19.0 or newer is required; options are command-local (`gbot send --history-dir DIR …`, no leading globals); `--json` is reserved anywhere before `--`, so put `--` before flag-like message text; `send` and every `codex` command write one JSON document to stdout with `exitCode` (failures keep `error`, `delivery`, `reason`, `mode` and exit 1), other commands print failures on stderr and exit 1; argument and schema errors exit 2; `--instructions` is gone (use `--description`) and `--notify`/`--hidden` take `on|off` only; `chat` records history rows as `event: "thread"`; the installed bundle is named `gbot` (uninstall an earlier source-built `grok-bot` plugin first). (#50)

### Patch Changes

- 4b3cd78: Make `gbot codex` dependable for automation and safe for agent relays: `codex status --json` reports `socketState`, a stable failure `mode` (`socket-absent`, `permission-denied`, `not-a-socket`, `connect-failed`, `handshake-failed`, `bad-response`, `windows-unsupported`), `schema.compatibility` separate from reachability, a bounded `codex --version` probe (`cliVersionProbe`), and `desktopAttached: "unknown"`; `codex list-threads` adds `--cursor`, bounds `--limit` to 1–200, rejects unknown arguments, validates the response shape, and strips terminal controls from every text field in JSON too. `codex send` and `send` accept `--correlation-id`, `--reply-to`, `--hop`, and `--envelope`, return receipts with `messageId` (sent as Codex's `clientUserMessageId`), `correlationId`, `replyTo`, `hop`, and `maxHops`, refuse relays at `GROK_BOT_MAX_HOPS` (default 4) with `reason: "hop-limit"`, honor the operator allowlist `GROK_BOT_CODEX_THREADS`, refuse `active` threads with `reason: "busy"` instead of steering a running turn (or, with `--when-busy queue` and `GROK_BOT_CODEX_EXPERIMENTAL=1`, hand them to Codex's experimental `thread/queue/add` and report `delivery: "queued"`; `codex queue <threadId>` lists that queue), and emit `reason`/`mode` in every `--json` send failure. Fixes #37, #38, #39.
- bf64783: Add `gbot thread --after ID` for exclusive client-side filtering of the bounded gateway tail, including no-op cursors and explicit gap-reset snapshots.

## 0.3.1

### Patch Changes

- HOLD-fix follow-up for the P1 bridge work: gateway reads count true bytes through a streaming reader that cancels on overflow; Codex transport uses an absolute handshake deadline, caps terminated headers and complete frames before decoding, guarantees socket destruction on close, and routes malformed RPC through failure handling; CLI `--json` failures emit structured errors with delivery and IDs; sends stay `unknown` without a confirmed receipt; MCP full reads add aggregate budgets with truncation metadata and a CLI continuation path.

## 0.3.0

### Minor Changes

- 82badce: Add `gbot codex status`, `gbot codex list-threads [--limit N]`, and `gbot codex send <threadId> <message...>`: attach to the local Codex app-server daemon socket (`$CODEX_HOME/app-server-control/app-server-control.sock`) with a built-in WebSocket client, list threads, and start a turn with documented JSON-RPC (`thread/resume` + `turn/start`). Reports an absent socket (no daemon or ChatGPT Desktop private mode), unknown threads, threads owned by another client, and refuses server approval requests instead of approving them. Method names are pinned to Codex 0.154.0.

### Patch Changes

- 93cb28e: Parse global `gbot` flags only before the command so `gbot codex send` keeps `--json` / `--dir` inside the message; refuse native Windows for `gbot codex` with a clear error; strip terminal controls from thread listings; run unit tests through `scripts/run-unit-tests.mjs` so Windows and Node 18 work without shell globs.
- ef6ce79: Send the gateway bearer only to `https` hosts on `*.cursor.sh`, `*.cursor.com`, or `*.cursorvm.com`, and the EnsureSandBox / Cursor access token only to `*.cursor.sh` / `*.cursor.com`; refuse cross-origin fetch redirects; redact Authorization (any scheme), Cookie, and named token fields from error output. `GROK_BOT_ALLOW_LOCAL_GATEWAY=1` admits loopback gateways and `GROK_BOT_ALLOW_ANY_GATEWAY=1` disables the host check; both warn once on stderr.
- d59fa95: Add opt-in local JSONL thread history (`GROK_BOT_HISTORY=on`) with offline `gbot history` search.
- a7415d7: P1 bridge follow-ups: preserve send receipts with rejected/accepted/unknown delivery states (Codex `CodexSendError` keeps thread/turn IDs, gateway `sendPrompt` returns `delivery` + `messageId` and marks post-write loss unknown); bound the Codex WebSocket transport (idempotent close settling pending requests, socket destroy on every failure, exact handshake validation, fragmentation/UTF-8/opcode handling, header/frame/message/buffer budgets); make `gbot_thread` bounded without losing replies (truncation metadata, `full` bounded full-read in tool and `--full` in CLI, safe string normalization, 1–200 limit consistency, gateway deadline and response-byte cap).
- 9b034ce: Validate group membership in gateway mode before sending mutations: deduplicate member references, enforce one to six bot members, reject nested groups, and reject bots as group targets.
- ab70a00: Strip C0/C1 controls (including CR, backspace, and BEL) from `gbot codex list-threads` text output, not only ESC sequences.
- 93cb28e: Fix `gbot thread` so bot replies (`send-message` entries) show their text instead of empty lines, by sharing transcript parsing with the grok-bot plugin.
- 3fe1287: Use the signed-in Grok Bot app session on Windows (`%APPDATA%\\Grok Bot`, DPAPI Safe Storage).

## 0.2.3

### Patch Changes

- 5519136: Use the signed-in Grok Bot app session on Linux: read `~/.config/Grok Bot/gateway-descriptor.json` (honouring `XDG_CONFIG_HOME`), decrypt Chromium `v11` payloads with the Secret Service password via `secret-tool` and `v10` payloads with the basic-text key, and apply Linux's single PBKDF2 round instead of the macOS 1003.

## 0.2.2

### Patch Changes

- ce452cd: Support version 2 Grok Bot gateway descriptors and report unusable app sessions clearly in `gbot doctor`.

## 0.2.1

### Patch Changes

- 13f6858: Remove redundant group-member normalization branches.

## 0.2.0

### Minor Changes

- 9691ea3: Add complete bot and group profile creation and update fields, including instructions, titles, avatar shape and color, notifications, and sidebar visibility.
