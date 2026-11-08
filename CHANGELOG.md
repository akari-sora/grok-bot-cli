# grok-bot-cli

## Fork changes (ImL1s)

Fork tags are `v0.11.2-iml1s.N`. The package version stays `0.11.2`. Upstream entries follow after this section.

### 0.11.2-iml1s.8

- `gbot bots template <bot>` shares a server-hosted bot as a Grok Bot template, the way the 0.78 app does: it reads `GetGrokBotTemplateForSourceAgent`, sends the bot the app's message (`Create a public template of yourself that I can share with somebody else`, or `Update the shared template of yourself.` when it already has one) through `SendGrokBotUserMessage` with the `TEMPLATE_SHARE` initiator, then reads the template every 10 s until it appears or gets a newer `updatedAtMs`, for at most `--wait` seconds (default 600; 0 does not wait). It prints the `https://x.ai/bot/<shareId>` link on its own line. Exit 0 when the template is seen; exit 3 when the message went out (or its delivery is unknown) but no template appeared in time, with a hint to run `gbot bots template <bot> --status` later; exit 1 when it was rejected or nothing was sent. The message is never sent again. `--status` only reads: the current template and link, or "no template yet". Box-only bots, a login whose server roster is off, groups, and sessions without an access token are refused before anything is sent (the app has no box path for templates). `--account` and `--json` as for the other `bots` commands. docs/move-to-hermes.md "Share it" uses it.
- Backend sends take an optional initiator (`user`, the default, or `template_share`); any other value is refused before anything is sent.
- The new template is a draft (live: `published: false`, `activeVersion: 0`) and the bot posts a review card (`bot-template-share`) in its chat; the app publishes only when the card is confirmed. `gbot bots template <bot> --show` reviews a version as the app's review dialog does: `GetGrokBotTemplateVersion` `{ shareId, version }`, then its presigned `blobGetUrl` (only the `grok-bot-templates` S3 bucket, no credentials, no redirects, 25 MiB cap), parsed with the app's recipe rules (profile, memory, skills, routines, plugins, optional `gettingStarted`); it prints a summary, and `--json` gives the parsed recipe. `gbot bots template <bot> --publish` calls `ActivateGrokBotTemplateVersion` `{ shareId, version }`, as confirming the card does, and prints published, visibility, active version and the link. The version is `--template-version N` (`--version` is reserved for gbot's own version), else the newest review card for the template in the last 200 transcript entries, else the active version. `--status`, `--show`, `--publish` and `--wait` are exclusive. `GetGrokBotTemplateVersion` joins the read allowlist; `assertStoreUrl`/`fetchStoreBytes` take the bucket, the migration store stays `sand-box-stores`.

### 0.11.2-iml1s.7

- `gbot migrate`: move a Grok Bot to Hermes, Muse or Your dot and check that it works there. `gbot migrate` alone (in a terminal) asks for the login, the bot(s) and the destination, previews the change, and after confirmation imports, reads the destination back and asks the migrated bot questions only the migrated data answers; `bots`, `capture`, `preview`, `import`, `check` and `run` are the same steps as commands. Capture is read-only (backend only, never wakes the box) and complete: every transcript page and side conversation, own, shared-user and project memory, the whole skill library, routines with schedule and time zone, todos and tasks, and the files the bot uses, each SHA-256 verified. Known token formats never leave the private archive; credential files are not read. Guide: docs/migration.md; real-run record: docs/verification/2026-11-08-full-migration.md.
- Hermes: a new profile per bot through Hermes' own stores (SOUL, MemoryStore, skill folders, paused cron jobs tagged with their routine, the whole history through `SessionDB.import_foreign_history`, workspace files), read back byte for byte; the preview of an existing profile lists what would be created, kept, repaired or be a conflict, and writes nothing.
- Muse and Your dot (through trinity-cli v0.5.0 `migrate`, muse-web-cli v0.1.6, chatgpt-dot-cli v0.2.6): a handoff folder on the agent's computer, sent as one zip attachment (`--via upload`), through your Google Drive (`--via drive`: rclone upload of the plan's exact bytes, MD5-checked, fetched by the agent's Google Drive connector, removed after a verified migration unless `--keep-drive`), or file by file (`--via chat`); `--history`, `--skills`, `--folder`. A salted SHA-256 per part checks the folder on the agent's computer, then questions in a new Muse chat. Sends are paced like the apps (one at a time, at least 20 s apart, stop on a rate limit) and use each app's request shape.
- Move to Hermes: templates/move-to-hermes.md is a Grok Bot bot's instructions that run `gbot migrate` on the user's computer, asking before each command (docs/move-to-hermes.md).
- `bots create` works on 0.78 again: it calls `CreateGrokBotTemporalAgent` as the app does instead of the removed box gateway (404).
- `thread`, `reconcile`'s tail, the relay, approvals and the MCP thread tool read a server-hosted bot's transcript with `ListGrokBotTranscriptEntries` (was 404 on 0.78); a row whose body cannot be read is marked `unreadable` and a `--after` cursor stops before it. `thread --root` still needs the box gateway.
- The earlier `migrate` snapshot commands (`targets`, `inspect`, `export`, `plan`, `apply`, `verify`) are replaced.
- From upstream 0.11.3–0.12.5, cherry-picked (source and tests; upstream authors kept): the codex-dot guidance skill for messaging the Dot assistant from Codex Desktop (026c9fa); Codex→Grok messages carry a "from Codex thread … reply via …" prefix, and `codex list-threads` / `codex_threads` sort by recent activity with `--query`, `--active-within` and cwd/provider/archived filters (c11781b); rejected Codex deliveries and failed turns say why, and the macOS daemon gets a higher open-file limit (efe5e4b); `codex new --cwd DIR "msg"` works on daemons without a rollout before the first turn (7fa32e1); the ChatGPT Desktop shim passes startup, sign-out and help/version commands to the real Codex CLI (a86461d). Upstream's 0.12.x session and reconnect rework is not taken: the fork's Grok Bot 0.78 backend, account selection and `gbot wake` replace it.
- Review: seven rounds with Codex (gpt-6-astra, max reasoning), until the last one found no blocker. Tests: 899 unit, 99 route; Hermes helper, official and real-install contracts.

### 0.11.2-iml1s.6

- Grok Bot 0.78.x support. The 0.78.4 desktop app (2026-11-03) hosts every bot on the server (`harness: "temporal"`) and calls `aiserver.v1.GrokBotService/<Rpc>` with the account access token. On 2026-11-05 the box gateway answered 502 `A Sand box session is not permitted on this endpoint.` to `sendPrompt`, `createGroup`, and `setAgentHiddenFromSidebar`. Its `listAgents` kept bots the backend had deleted and showed a room the backend had just created only minutes later, `deleteAgent` answered 200 and deleted nothing, and `updateAgent` without `editedFields` changed only the box copy. When the session has an access token (a saved app login, a descriptor login whose account has a saved access token, or `CURSOR_ACCESS_TOKEN`), gbot now uses the backend: `send` calls `SendGrokBotUserMessage`, `reconcile` asks `GetGrokBotSendStatus` before the transcript tail, the roster comes from `ListGrokBotAgents` with notify and hidden from `ListGrokBotAgentStatuses`, `groups create` calls `CreateGrokBotRoom`, member changes call `SetGrokBotRoomMembers`, deletes call `DeleteGrokBotAgent`, profile updates call `UpdateGrokBotAgent`, and `--notify` and `--hidden` call `SetGrokBotAgentClientState`. Details, the delivery rules, and the roster merge rule are in FORK.md.
- Send delivery on the backend: `ACCEPTED_BOX`, `ACCEPTED_TEMPORAL`, and `DUPLICATE` are `accepted`; `REFUSED` and a 4xx other than 408 are `rejected`; a timeout, transport failure, 408, 5xx, or `UNSPECIFIED` asks `GetGrokBotSendStatus` for the same nonce once and otherwise stays `unknown`. gbot never resends and never falls back to the gateway after a backend send was tried.
- `approvals respond` now resolves cards through the backend as the 0.78.4 app does: `ResolveGrokBotAutoReviewApproval` (`APPROVED` or `DENIED`, `approvalPlatform: "desktop"`, no entry id) and `ResolveGrokBotLocalToolPermission` (`ALLOW_ONCE` or `DENY`). A refusal is `code: "APPROVAL_REFUSED"` with the server's `failureCode`. gbot still never sends a persistent grant. Mapped from the app, not live-tested: it needs a real pending card, and a made-up card is refused before any network call.
- Review fixes. `reconcile` returns the backend send status as `sendStatus`: `REJECTED` is `rejected` (with `rejectionCode`), and `PENDING`, `UNKNOWN_DURABILITY`, or `UNSPECIFIED` with the nonce not in the tail is `pending` ("may still land; do not resend"), never not-found. When `ListGrokBotAgents` says `truncated`, only ids resolve (`ROSTER_TRUNCATED`), so a name cannot reach the wrong bot. An empty or whitespace-only name is refused, and an empty title never matches. `failed_precondition` or `unimplemented` from `ListGrokBotAgents` falls back to the box roster and the box gateway, as the app treats a disabled server roster; other errors still fail. A failed `ListGrokBotAgentStatuses` leaves notify and hidden out. The box merge also dedups on `legacyAgentId` and skips server rows without an `agentId`. Notify comes from a client state only once it was written (`updatedAtMs` above 0), as in the app. A `SetGrokBotRoomMembers` answer for another room, or with no room, is `ROOM_MISMATCH`.
- Second review fixes. A name resolves against server bots first (exact, then the plain name of a titled bot) and against box-only rows only when no server bot matches, so a box row can no longer shadow a titled server bot and route a send or delete to the box. Skills pick a bot the server lists by `agentId` or `legacyAgentId`, never a box-only row. A send answered with 499 or a Connect `canceled`, `deadline_exceeded`, `unavailable`, `unknown`, or `internal` is unknown and asks the send status; a status of `REJECTED` after a timeout or 5xx is a new `SEND_REFUSED` error without the "delivery is unknown" text, and the unknown suffix is no longer added twice. Server text is redacted before it is cut, including refusal messages. `groups create` checks the avatar before creating, reuses the room's server id, and names the created room if the title or avatar step fails. `updateAgent` sets notify and hidden on any server bot (they need only the uuid). Adding or removing a member reads the roster once. A test with test mode off pins that an app login token never goes to a non-Cursor backend, even with `GROK_BOT_ALLOW_ANY_GATEWAY`.
- Round 2 review fixes. The server roster is on only when `GetGrokBotRuntimeCapabilities` says `durableIdentityEnabled`, as in the app; that call is asked once per session, and with the roster off gbot says so on stderr and marks records `roster: "box"` in `--json`. An error from `ListGrokBotAgents` itself now always fails the command. Server records keep `harness`; an auto-review card of a non-temporal bot goes to the box gateway, and a local tool card of one moves on to the box gateway on `unimplemented`, as in the app. An approval answer with `dispatched: false` is `delivery: "unknown"`, not accepted. The folded name rule matches either half of `name · title`, and a server bot matched only that way next to an exact box-only match is ambiguous. A truncated roster leaves box-only rows out. `reconcile` reads every status except `NOT_FOUND`, and a failed status read (`UNAVAILABLE`), as `pending`, and keeps such a status as `pending` with `tailError` when the transcript cannot be read. `groups create` refuses a `CreateGrokBotRoom` answer without an `agentId` (the group may exist), and a new room without a numeric id gets no title or avatar call; the error names the created room.
- `bots create`, `thread`, `skills`, and `approvals list` stay on the box gateway. `bots create` was checked live: the box registered the bot on the server with its title and avatar. The box gateway `updateAgent` now sends `editedFields`, which is what makes the box pass the edit to the server.
- A session without an access token (`GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN`, or a descriptor login with no saved access token) keeps the gateway calls. On a 0.78.x host its sends are refused with 502.
- A bot with a title is listed by the server as `name · title`; its plain name still resolves when nothing matches exactly. A bot the box created with a title already has that title in its stored name, so `bots update --title` alone adds a second one; pass `--name` and `--title` together to replace both.
- Tests: `test/gateway-backend.test.js` covers each RPC's request and answer, the delivery states, not found on delete, the roster merge, and that no access token reaches an error. The saved-login send tests in `test/accounts-r2.test.js` and the `gbot send` CLI test now expect the backend send; a descriptor login without an access token still shows the box wake fields.

### 0.11.2-iml1s.5

- Supported Node.js is `^22.19.0 || >=24.2.0` (`engines`). Node 23 and 24.0–24.1 leave `import.meta.main` undefined, which made the launcher's child exit 0 without running a command; the launcher now prints `gbot cannot run on Node.js <version>: import.meta.main is unavailable. Use Node.js 22.19+ (22.x) or Node.js 24.2+.` and exits 1. Windows CI installs a checksum-verified supported Node in the job's private temporary directory, and tests no longer read the operator's APPDATA/XDG config.
- Installers accept a resolved commit only when it matches `^[0-9a-f]{40}([0-9a-f]{24})?$`, then run `git checkout --detach <sha>` with no path separator. `git checkout --detach -- <sha>` fails on git 2.50. On a POSIX host the shell script was run with real git against a local `file://` bare repository: it checked out a branch, a tag, and a raw sha via `git fetch origin -- <sha>`, and reached `npm ci`, with fake `npm` and `gbot` on `PATH`. The fake-git tests return 128 for `checkout --detach --`. The PowerShell script was checked statically, including a refusal of that checkout form and `[Console]::Error.WriteLine` before `exit 2`; it was not executed. Neither script was run against GitLab.
- When `gbot config import` exits 3, the installer skips `gbot wake --check` for aliases that import reported missing (`sign in to <email> in the Grok Bot app`), checks the other aliases, and exits 3. A fake `gbot` whose import exits 3 covers this. The PowerShell installer captures that import in a nested scope with `$ErrorActionPreference = "Continue"` and `2>&1`, so Windows PowerShell 5.1 does not turn the first stderr line into a terminating NativeCommandError before `$LASTEXITCODE` is read. It still reads an `ErrorRecord` from `Exception.Message`. It compares the resolved commit with `-cnotmatch`, so an uppercase hex sha fails closed.
- A descriptor gateway session is read again on every `connectGateway` and is not cached. Only a saved-login session built by EnsureSandBox stays cached by account scope. An auth failure (401/403) or a routing failure (404 whose body says it could not be routed) drops that cache and retries the call once. If that rebuild throws, the original rejection is rethrown. The rebuild failure stays on the internal error as `cause` and is not copied into the CLI or MCP result. A send the gateway explicitly refused stays `delivery: "rejected"`. A later relay send that fails while restoring the saved-login session, before the prompt is transmitted, stays `delivery: "rejected"` rather than `delivery-unknown`. A timeout or 5xx is not rebuilt and is not resent.
- A pinned `GROK_BOT_RELAY_DIR` whose stored profile does not match this process refuses to start with `Relay profile mismatch`. The profile includes the account, gateway and token settings, thread limits, and the DISPLAY or DBUS session, so a profile can change for reasons other than an upgrade. It does not adopt old bindings and it does not keep running. Upgrade a running relay in this order. (1) With the old version, run `gbot codex bridge stop --worker`. (2) Move or rename that directory, or choose a new `GROK_BOT_RELAY_DIR`. (3) Bind again. The default directory's old state stays in `~/.grok-bot-cli/relay/<old hash>`. A pinned directory's socket path comes from the directory only, so it is the same after the upgrade. `bridge stop` reaches a still-running old worker on that socket, and the worker rejects the hello with `Relay profile mismatch`; it does not stop that worker. The default directory's socket path does change with the profile hash, so `bridge stop` does not reach that old worker. There is no pid file. Before upgrading, the old version's `gbot codex bridge status` includes `worker.pid`. The directory holds `control.sock` (or `/tmp/gbot-relay-<uid>/<hash>/control.sock` when the state path is long) and `worker.lock`. If the worker is still running, stop the process that has those files open (`lsof -t <dir>/worker.lock`), then move the directory. Managed commands report `Relay profile mismatch`, including the upgrade steps, in the calling process when the stored profile differs, even if the worker has already exited. A still-running worker that only replies `Relay profile mismatch` is shown those same upgrade steps by the calling process. They do not replace that error with a startup timeout or with `Worker is not running`. Two selectors for the same resolved scope still share one profile hash. An unexpected error while resolving the profile fails closed and does not start a worker. When login resolution fails, `bridge status` lists the state directories under `~/.grok-bot-cli/relay` and does not choose one. A directory whose profile file is unreadable, whose state file is corrupt or locked, or whose relay files together exceed the storage cap, is listed as `unreadable` and does not fail the list. The stored profile is read through SQLite, not by scanning the database file. `bridge stop` does not list directories; set `GROK_BOT_RELAY_DIR` to the directory to stop. An explicit directory uses only the profile stored in that directory and returns no `directories` field. They do not pick another account. Starting a worker stays fail-closed. An invalid `GBOT_ACCOUNT_SCOPE` still throws for stop and status.
- A v1 descriptor merges with the only saved login only when that descriptor has no scope and no email. A contradicting scope or email stays a second row. A descriptor that names its own scope is never merged by email, even when that email matches another saved login, and that other scope is not attached. A scope is copied onto a descriptor session only when the descriptor's own scope or email proves it. `gbot wake` keeps the resolved scope when the descriptor session has none.
- `GBOT_ACCOUNT_SCOPE` is an internal variable gbot sets for its own relay and MCP workers. It must be exactly 64 lowercase hex characters; any other value is an error. When it is set, it overrides `GBOT_ACCOUNT` and the config default.
- An unsupported descriptor version fails closed and does not fall back to `CURSOR_ACCESS_TOKEN`.
- The Windows CI job pins its Node download to v22.23.4 and still checks SHA-256 against that release's `SHASUMS256.txt`.

- Every login the Grok Bot app has signed in (`sand-secrets.json` → `cursor-accounts`) stays reachable after the app shows a different login. The descriptor often keeps only the login on screen. `gbot accounts` lists both, with the email when the profile decrypts (otherwise the first 8 hex characters of the scope), `(app active)` for the app's current login, and `(no app session; gbot builds one from the saved login)` when that login has no descriptor entry. `--json` keeps `id`, `label` (the descriptor label when there is one, otherwise the email or scope prefix), `savedAtMs`, `lastSaved`, and `usable`, and adds `email` as its own field, plus `alias`, `appActive`, `hasDescriptorEntry`, and `exitCode` (`0` when the list succeeds; the command's exit code is taken from the result). `alias`, `unalias`, and `default` are arguments of `gbot accounts` (`gbot accounts alias <name> <selector>`), because this bundler rejects a command that is also a command group. `--account` and `GBOT_ACCOUNT` match an alias, an email, a descriptor label, or an id prefix of at least 8 hex characters. A descriptor entry is read again on every connect and is not cached. A saved login with no descriptor entry is described (`wake: false`) and, unless it is already `RUNNING` with gateway fields or `GBOT_AUTO_WAKE=0`, woken; that session stays in memory, is cached for the process by account scope until an auth failure (401/403) or a routing failure (404 that could not be routed) drops it and retries the call once, and is not written to an app file. A label or id that aliases a secret is shown as `login <n>` in `gbot accounts` and `gbot wake`. The refresh token is still never decrypted. The app token is still sent only to https Cursor API hosts. `gbot wear pair` still sends descriptor sessions only; `--account` accepts an alias, email, label, or id and still ignores `GBOT_ACCOUNT` and the config default. `gbot doctor` resolves `--account` or `GBOT_ACCOUNT` as an alias, email, label, or id and does not apply the config default. An explicit selector that does not resolve fails closed and does not use `CURSOR_ACCESS_TOKEN`. `CURSOR_ACCESS_TOKEN` is used only when there is no app login, or when an implicit login cannot be decrypted or is expired. `GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN` still override first. With no selector, gbot uses the descriptor's single entry, else its one app-active entry, else the only saved login. A single v1 descriptor (`id` `default`) and one saved login are one row only when that descriptor has no scope and no email. A contradicting scope or email stays a separate row. A descriptor that names its own scope is never merged by email, even when that email matches another saved login, and that other scope is not attached to the descriptor session. Relay and MCP workers are keyed by the resolved account scope. EnsureSandBox errors redact the app access token, the gateway token, and the network token.
- Aliases live in a config file with no tokens: `$XDG_CONFIG_HOME/grok-bot-cli/config.json` (default `~/.config/grok-bot-cli/config.json`) on macOS and Linux, `%APPDATA%\grok-bot-cli\config.json` on Windows, or `GBOT_CONFIG`. Mode 0600. The write creates a temp file in the same directory with mode 0600, fsyncs it, renames it, and fsyncs the directory where the platform allows that. A failed rename leaves the old file in place. The file is created only when a command writes it. `gbot accounts alias <name> <selector>`, `unalias <name>`, `default <name>`, and `default --clear`. A name matches `^[A-Za-z0-9_-]{1,32}$` and must not be an Object prototype key (`__proto__`, `constructor`, `prototype`, and the rest). Gateway commands resolve `--account`, then `GBOT_ACCOUNT`, then the config `default`, then the descriptor's single or app-active entry, then the only saved login. A merge import keeps the local default when the file's `default` is null; a named default in the file still applies, and `--replace` replaces the map and the default. Emails in the file must be a plain address with no control characters. `gbotVersion`, when present, must be a string. `gbot config path` prints the path. `gbot config export [--out <file>]` writes aliases, the default, emails, and `gbotVersion`, never tokens. `gbot config import <file> [--replace]` merges unless `--replace`. Exit 0 imported, 2 usage or invalid (nothing written), 3 imported and at least one alias scope is not signed in on this machine (`sign in to <email> in the Grok Bot app`).
- `scripts/install-fork.sh [ref]` and `scripts/install-fork.ps1` clone `https://gitlab.com/aa22396584/grok-bot-cli.git` into the cache (`$XDG_CACHE_HOME/grok-bot-cli/src`, default `~/.cache/...`), check out the ref (default `main`), run `npm ci` then `npm pack` (prepack fills `dist/` from the committed `artifact/`), and `npm install -g` that tarball. `--config` is resolved to an absolute path before any directory change. The ref may contain only `[A-Za-z0-9._/-]`, must not start with `-`, and after `--` is the ref (`-- v1.2` does not install `main`). The script fetches that ref, checks that the resolved commit matches `^[0-9a-f]{40}([0-9a-f]{24})?$`, and checks out that commit with `git checkout --detach <sha>`. It creates and removes the packed tarball in an installer-owned temporary directory outside the checkout. A dirty cache is refused without deleting unknown files; a legacy `.tgz` left in the cache is preserved and requires using a clean cache location. A failed `gbot config import` or `gbot wake --check` exits non-zero. Exit 3 means import reported logins missing: wake checks for those aliases are skipped, the other aliases are still checked, and the script exits 3. `gbot accounts` failing does not skip the import. PowerShell accepts `-DryRun` and `--dry-run`, uses the same cache layout (`%LOCALAPPDATA%\grok-bot-cli\src`), and checks `$LASTEXITCODE` after each git, npm, and gbot call. Both refuse root or Administrator unless `--allow-root` or `-AllowRoot`. They do not store or print tokens. On a POSIX host, the shell script was tested with real git against a local `file://` bare repository (the fetched commit was checked out and `npm ci` ran, with fake `npm` and `gbot`) and with fake `git`, `npm`, and `gbot` on `PATH` (relative `--config`, two consecutive runs, preserved legacy tarball rejection, a rejected ref, a failing step, `checkout --detach --` returning 128, and import exit 3 skipping the missing alias). The PowerShell script was checked statically, including native exit-code checks, `[Console]::Error.WriteLine` before `exit 2`, no `checkout --detach --`, no fixed output files, and its private pack directory; PowerShell was unavailable on that host. Neither script was run against GitLab. Two accounts in one process were checked with synthetic fixtures.
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
