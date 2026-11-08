# Fork guide

English | [繁體中文](FORK.zh-TW.md)

ImL1s's fork of [ScriptedAlchemy/grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli), synced to upstream 0.11.2, with later upstream changes cherry-picked: five fixes in 0.11.2-iml1s.7 (the codex-dot skill, the Codex sender prefix and thread search, Codex delivery detail, `codex new` on newer daemons, the desktop shim passthrough) and, in 0.11.2-iml1s.11, the `gbot-install install grokbot` sideload (agent-bundle 0.4.0), the transcript lookup for a gateway's `{"accepted": true}`, the client version from the app's `desktop-status.json`, and upstream 0.12.5's dependency updates; see CHANGELOG.md. The package version string stays `0.11.2`. The fork revision is the git tag.

Upstream still owns the npm package. Do not `npm install -g grok-bot-cli`. GitLab (<https://gitlab.com/aa22396584/grok-bot-cli>) is the primary remote. The GitHub mirror is not a public install source.

## Disclaimer

Unofficial. This fork is not affiliated with, endorsed by, or supported by xAI, Cursor (Anysphere), or the upstream author. "Grok" and "Grok Bot" belong to their owners. `gbot` uses your own Grok Bot login and an undocumented gateway that can change or break at any time. Automated use may be limited by the Grok Bot terms; check them, and use it at your own risk. Report fork bugs here, not upstream.

## Install

Use Node.js 22.19+ (22.x) or 24.2+, with the Grok Bot desktop app signed in once on the same OS user. The generated CLI uses [`import.meta.main`](https://nodejs.org/api/esm.html#importmetamain), which is absent in Node 23 and Node 24.0–24.1; the launcher rejects those versions with a nonzero exit and a version diagnostic.

Do not `npm install -g` a `git+https://gitlab.com/...` spec. npm exits 0 and leaves a dangling `gbot` link. Install the release package file instead; one command does it on every OS and always gets the latest release (run it again to upgrade):

```sh
npm install -g https://gitlab.com/aa22396584/grok-bot-cli/-/releases/permalink/latest/downloads/grok-bot-cli-0.11.2.tgz
```

A specific release: `npm install -g https://gitlab.com/aa22396584/grok-bot-cli/-/releases/v0.11.2-iml1s.13/downloads/grok-bot-cli-0.11.2.tgz` (change the tag).

npm creates `gbot.cmd` on Windows, so `gbot` works from PowerShell and cmd.

From a clone (any OS). `dist/` is not in git, so build before linking:

```sh
npm ci
npm run build
npm link
```

To install or restore this fork on another machine without a `git+https` spec, use `scripts/install-fork.sh` (macOS/Linux) or `scripts/install-fork.ps1` (Windows). Those scripts are described under [Switching logins and restoring gbot on another machine](#switching-logins-and-restoring-gbot-on-another-machine). The shell script was tested with real git against a local `file://` repository and with fake `git`, `npm`, and `gbot` on `PATH`. The PowerShell script was checked by reading it. Neither script was run against GitLab.

## Verify, upgrade, uninstall

```sh
gbot --version
```

This prints `gbot 0.11.2`. That is the upstream package version, not the fork tag.

Upgrade by downloading the same `.tgz` and installing it again. Uninstall:

```sh
npm uninstall -g grok-bot-cli
```

If you used `npm link`, run `npm unlink -g grok-bot-cli` in the clone.

A pinned `GROK_BOT_RELAY_DIR` whose stored profile does not match this process refuses to start with `Relay profile mismatch`. The profile includes the account, gateway and token settings, thread limits, and the DISPLAY or DBUS session, so a profile can change for reasons other than an upgrade. Run again with the same account and environment to keep the directory. Managed commands show that error themselves, including when the worker is already stopped, and when a still-running worker only replies `Relay profile mismatch`. The message includes the upgrade steps. It does not adopt the old bindings and it does not keep running. If an older version wrote the directory, upgrade in this order:

1. With the **old** version, run `gbot codex bridge stop --worker`.
2. Move or rename that directory, or choose a new one.
3. Bind again.

The default directory's old state stays in `~/.grok-bot-cli/relay/<old hash>`. A pinned directory's socket path comes from the directory only, so it is the same after the upgrade. `bridge stop` reaches a still-running old worker on that socket, and the worker rejects the hello with `Relay profile mismatch`; it does not stop that worker. The default directory's socket path does change with the profile hash, so `bridge stop` does not reach that old worker. There is no pid file. Before upgrading, the old version's `gbot codex bridge status` includes `worker.pid`. The directory holds `control.sock` (or `/tmp/gbot-relay-<uid>/<hash>/control.sock` when the state path is long) and `worker.lock`. If the worker is still running, stop the process that has those files open (`lsof -t <dir>/worker.lock`), then move the directory. When login resolution fails, `bridge status` lists the state directories it can see and does not choose one. `bridge stop` then needs `GROK_BOT_RELAY_DIR` set to the directory you mean. An invalid `GBOT_ACCOUNT_SCOPE` still throws and does not list other workers. Starting a worker stays fail-closed.

## Login and several logins

`gbot` reads the app's encrypted gateway descriptor. It does not open a browser.

| OS | Session location | Secret |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Grok Bot` | Keychain item `Grok Bot Safe Storage` |
| Linux | `$XDG_CONFIG_HOME/Grok Bot` or `~/.config/Grok Bot` | `secret-tool` (`libsecret-tools`), except the basic-text v10 key |
| Windows | `%APPDATA%\Grok Bot` | DPAPI via PowerShell (`Local State`) |

With no `--account`, `GBOT_ACCOUNT`, or config default, gbot uses the descriptor's single entry, else its one app-active entry, else the only saved login. Several remaining logins and no choice is an error that lists labels. `gbot doctor` and `gbot wear pair` do not use that default. `gbot doctor` does resolve `--account` or `GBOT_ACCOUNT` as an alias, email, label, or id. `gbot wear pair --account` accepts those selectors and still ignores `GBOT_ACCOUNT` and the config default.

```sh
gbot accounts
gbot bots list --account "<label>"
```

```sh
export GBOT_ACCOUNT="<label>"   # PowerShell: $env:GBOT_ACCOUNT = "<label>"
gbot doctor
```

`--account` overrides `GBOT_ACCOUNT`, which overrides the config default. The flag must follow the subcommand. `gbot --account <label> bots list` exits 2 with `Unknown option: --account.`

`gbot accounts` lists every signed-in login and every descriptor entry. It never prints tokens. The full rules are in the next section.

`gbot accounts --json` is `{ "accounts": [{ "id", "label", "savedAtMs", "lastSaved", "usable", "email", "alias", "appActive", "hasDescriptorEntry" }] }`. Older fields stay. `email` and `alias` are `null` when absent.

## Switching logins and restoring gbot on another machine

The desktop app keeps the login it is showing in `gateway-descriptor.json`. Every signed-in login stays in `sand-secrets.json` under `cursor-accounts`. After the app switches logins, the other login can disappear from the descriptor. gbot still lists it. If that login has no descriptor entry, gbot builds a gateway session from the saved access token: EnsureSandBox `{ "wake": false }` first, then `{ "wake": true }` unless the box is already `RUNNING` and the answer has gateway fields. The session is not written to disk. `GBOT_AUTO_WAKE=0` describes the box and fails closed when it is not already running. The refresh token is never decrypted. The app token is sent only to https Cursor API hosts. EnsureSandBox errors redact the app access token, the gateway token, and the network token. A label or id that aliases a secret is printed as `login <n>`. `--json` `label` stays the descriptor label when there is one; `email` is a separate field. A single v1 descriptor and one saved login are one row only when that descriptor has no scope and no email. A contradicting scope or email stays a separate row, and that other scope is not attached to the descriptor session.

`gbot accounts` marks the app's current login `(app active)` and a login with no descriptor entry `(no app session; gbot builds one from the saved login)`. The label stays the descriptor label when there is one. Otherwise it is the email from the decrypted profile, or the first 8 hex characters of the scope when the profile cannot be decrypted. The email is printed on its own line when it differs from the label. Alias names are printed on their own line. A label or id that aliases a secret is `login <n>`.

Give a login a name and, if you want, make it the default. These are arguments of `gbot accounts` (this bundler cannot also make `accounts` a command group):

```sh
gbot accounts alias work owner@example.com
gbot accounts default work
gbot accounts unalias work
gbot accounts default --clear
```

An alias name matches `^[A-Za-z0-9_-]{1,32}$` and must not be an Object prototype key such as `__proto__`, `constructor`, or `prototype`. A selector is that alias, an email (case-insensitive), a descriptor label, or an id or scope prefix of at least 8 hex characters. More than one match is the same error as before. An explicit selector that does not resolve, or whose login cannot be used, fails and does not switch to `CURSOR_ACCESS_TOKEN` or another login.

Gateway commands (`gbot send`, `gbot wake`, and the rest that take `--account`) resolve in this order: `GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN` when both are set; otherwise `--account`, then `GBOT_ACCOUNT`, then the config `default`. With no selector, gbot uses the descriptor's single entry, else its one app-active entry, else the only saved login. Several remaining logins and none of those is an error. A saved-only login is used when it is explicitly selected or when it is the only login. `CURSOR_ACCESS_TOKEN` is used only when there is no app login, or when that implicit login cannot be decrypted or is expired. Host-policy and other backend errors stay failures. `gbot doctor` resolves `--account` or `GBOT_ACCOUNT` and does not apply the config default. `gbot wear pair` still sends a descriptor session only. Its `--account` accepts an alias, email, label, or id, and it still ignores `GBOT_ACCOUNT` and the config default. A login that exists only in `sand-secrets.json` is not offered to the watch. Relay and MCP keep a separate worker and session for each resolved account scope. `GBOT_ACCOUNT_SCOPE` is an internal variable gbot sets for its own relay and MCP workers. It must be exactly 64 lowercase hex characters. When it is set, it overrides `GBOT_ACCOUNT` and the config default. Any other value is an error.

The config file holds aliases and the default. It has no tokens. On macOS and Linux it is `$XDG_CONFIG_HOME/grok-bot-cli/config.json`, or `~/.config/grok-bot-cli/config.json` when `XDG_CONFIG_HOME` is unset. On Windows it is `%APPDATA%\grok-bot-cli\config.json`. `GBOT_CONFIG` overrides the path. `gbot config path` prints it. The file is mode 0600 and is created only when alias, default, or import writes it. The write uses a temp file in the same directory (mode 0600), fsync, and rename. If the rename fails, the old file stays and the error is reported. A merge import keeps the local default when the incoming `default` is null. A named default in the file still becomes the default. `--replace` replaces the alias map and the default. An unreadable existing config makes `gbot accounts` and `gbot accounts default --clear` exit 2. An explicit `--account` or `GBOT_ACCOUNT` that matches a label, email, or id still works when the config cannot be read. Import of a broken existing config exits 2 unless `--replace`.

Export and import move the names to another machine. The export includes emails, because a restore should name the same logins. It never includes tokens. Keep the file in a password manager (or another place you already trust with account names). Do not commit it.

```sh
gbot config export --out gbot-accounts.json
gbot config import gbot-accounts.json
gbot config import gbot-accounts.json --replace
```

Import merges aliases by name unless `--replace`, which replaces the alias map and the default. Exit codes: 0 imported and every alias scope is signed in here; 2 usage or an invalid file (nothing is written); 3 the file was imported and at least one alias scope is not in `cursor-accounts` on this machine. That case prints `sign in to <email> in the Grok Bot app` for each missing login. Sign in to that account in the app, then run gbot again. These exit codes were checked with synthetic fixtures, not with a live export.

On a new machine, install the fork and then import. Do not install with `npm install -g grok-bot-cli` or a `git+https` spec (that leaves a dangling `gbot` link).

```sh
scripts/install-fork.sh --config gbot-accounts.json
# Windows: scripts/install-fork.ps1 -Config gbot-accounts.json
scripts/install-fork.sh --dry-run --config gbot-accounts.json v0.11.2-iml1s.13
```

The script clones `https://gitlab.com/aa22396584/grok-bot-cli.git` into `$XDG_CACHE_HOME/grok-bot-cli/src` (default `~/.cache/grok-bot-cli/src`; on Windows, `%LOCALAPPDATA%\grok-bot-cli\src`). `--config` is made absolute before any directory change. The ref may contain only `[A-Za-z0-9._/-]`, must not start with `-`, and is passed to git after `--`. A ref after `--` is that ref (`-- v1.2` does not install `main`). The script fetches the ref, checks that the resolved commit matches `^[0-9a-f]{40}([0-9a-f]{24})?$`, checks it out with `git checkout --detach <sha>` (no path separator), prints it, and refuses a dirty cache. `npm pack` writes to an installer-owned temporary directory outside the checkout; that directory is removed after the run. The installer never deletes unknown cache files. A cache containing a `.tgz` left by an older installer is refused unchanged; preserve or move that cache and use a clean cache location rather than asking this installer to migrate it. It then runs `gbot --version` and `gbot accounts` (an accounts failure does not skip import), `gbot config import` when `--config` was given, and `gbot wake --check --account <alias>` for each alias. A failed import or wake exits non-zero. When import reports logins missing, wake checks for those aliases are skipped, the other aliases are still checked, and the script exits 3. It refuses to run as root or Administrator unless `--allow-root` (PowerShell `-AllowRoot`) is given. `--dry-run` and PowerShell `-DryRun` print the steps and do not run git or npm. The script does not store or print tokens. `scripts/install-fork.sh` is executable.

What was tested: on a POSIX host, the shell script with real git against a local `file://` bare repository (the fetched commit was checked out and `npm ci` ran, with fake `npm` and `gbot` on `PATH`) and with fake `git`, `npm`, and `gbot` on `PATH`, including a relative `--config`, two consecutive clean-cache runs, rejection and byte-for-byte preservation of a legacy tarball, a rejected ref, a failing step, `checkout --detach --` returning 128, a branch, a tag, a raw commit sha that is not a branch or tag name (that sha takes `git fetch origin -- <sha>`), and import exit 3 skipping the missing alias. The PowerShell script has a static source check that it names the same steps, checks `$LASTEXITCODE` after each native call, uses `[Console]::Error.WriteLine` before `exit 2`, refuses `checkout --detach --`, avoids fixed output files, uses a private pack directory, and sets `$ErrorActionPreference = "Continue"` around the `gbot config import` capture so Windows PowerShell 5.1 does not turn stderr into a terminating error before `$LASTEXITCODE` is read; it was not executed because PowerShell was unavailable on the test host. The scripts were not executed against GitLab. Two accounts in one process were checked with synthetic fixtures, not with a live account switch.

## Wake an asleep box (`gbot wake`)

A gateway call for a saved app login that fails with `code: "BOX_ASLEEP"` wakes that login's box and retries the call once, except a call that is not one of the read-only methods below and has no sleep evidence. gbot reads the access token the app saved for that login (the same account id as the gateway descriptor entry). The secrets file is parsed whole; gbot never decrypts or uses the refresh token and never writes an app file. It posts EnsureSandBox `{ "wake": true }` to an https Cursor API host (`*.cursor.sh` / `*.cursor.com`). `GROK_BOT_ALLOW_ANY_GATEWAY` does not apply to that app login token. It still applies to a user-supplied `CURSOR_ACCESS_TOKEN`. Test mode still allows loopback only.

`sendPrompt` wakes and resends only when the 417 carries sleep evidence. Only these read-only methods wake and retry on a bare 417 (no proxy reason and no failureCode): `listAgents`, `getAgentThread`, `getAgentTranscriptTail`, and `getAgentWorkflows`. Those are the only read-only gateway methods. Every other method wakes and retries only with positive sleep evidence: `failureReason` is `pod_hibernated`, or a `failureCode` matching sleep or hibernation. A bare 417 stays `BOX_ASLEEP` (the same label and hint) and is not resent.

Polling covers `STARTING`, `RUNNING` without gateway fields, and an `unknown` run state that still names gateway fields. `unknown` plus a gateway is not treated as ready. Each EnsureSandBox call uses the time left in an about-90-second budget, and at most 30 seconds. The poll is `{ "wake": false }` about every 3 seconds. If `{ "wake": true }` is still `HIBERNATED`, gbot waits the shorter of the poll interval and the time left, sends `{ "wake": true }` once more, and then fails with `WAKE_FAILED` instead of polling. If that second reply is still `HIBERNATED` and the budget is already gone, the error is `WAKE_TIMEOUT`, not `WAKE_FAILED`. If an EnsureSandBox call hits its per-call deadline while budget remains, gbot keeps polling with the time left. When the budget is used up and the box is still not ready, the failure is `WAKE_TIMEOUT` (`gbot wake` exits 4), not `WAKE_FAILED`. Calls for the same login share one wake. Aborting one waiter cancels that waiter at once. Aborting the last waiter drops the shared wake, so the next caller starts a fresh one. `GBOT_AUTO_WAKE=0` turns this off. Both `GROK_BOT_GATEWAY_URL` and `GROK_BOT_GATEWAY_TOKEN` together are never woken. Success is the call's own result. If waking fails, the error stays `code: "BOX_ASLEEP"` and adds `wake: { attempted: true, error }` and a short reason (`auto wake failed: …`). A 401 whose text says the version is no longer supported uses `wake.error` `CLIENT_VERSION_REJECTED` and keeps the version hint. If the one retry is still `BOX_ASLEEP`, the error has `wake: { attempted: true, woke: true }` and says the wake ran. A `sendPrompt` retry posts the same `clientNonce`. If that retry's delivery is unknown, it stays unknown: do not send again. Cancelling during the wake rejects the send (`delivery: "rejected"`, `reason: "cancelled"`) and does not resend. `gbot send --json` includes `wake` and `failureReason` when the error has them.

`x-cursor-client-version` is `SAND_CLIENT_VERSION` when that is `major.minor.patch` (`0.72.1.0` becomes `0.72.1`). Otherwise gbot reads the installed app. First, on every OS, `appVersion` in the `desktop-status.json` the running app writes to its data folder (macOS `~/Library/Application Support/Grok Bot`, Linux `$XDG_CONFIG_HOME/Grok Bot` or `~/.config/Grok Bot`, Windows `%APPDATA%\Grok Bot`); a missing file or a value that is not `major.minor.patch` goes on to the next source. Then macOS `CFBundleShortVersionString` in `/Applications/Grok Bot.app` then `~/Applications`. On Windows it queries `reg.exe` by absolute path under `SystemRoot\System32`. It looks up uninstall key `8db316bb-b3e2-5dd2-9554-ecccb62be362` under HKCU, then HKLM, then HKLM WOW6432Node, then a narrow `reg query /f "Grok Bot" /d`. From that `/f` output gbot takes the `HKEY_…` key whose `DisplayName` matches `^Grok Bot(\s|$)`. The key path may contain spaces; gbot keeps the whole line and trims it. It queries that key with `/v DisplayVersion`, and if that query fails or the budget is gone, parses the version from the `DisplayName` suffix (`Grok Bot 0.72.1` becomes `0.72.1`). A `DisplayName` of `Grok Bot` with no version suffix still queries `DisplayVersion` on the full key. The whole registry lookup shares about a 3 second budget. Linux has no source after `desktop-status.json`. Otherwise the built-in default is `0.72.1`. An invalid value uses `0.72.1` and does not read the app. The installed version is cached for the process. A 401 "no longer supported" drops that cache only when the cached value came from the installed app, not from `SAND_CLIENT_VERSION` and not from the built-in default, and at most once per 10 minutes. That 401 names the version gbot sent and that `SAND_CLIENT_VERSION` can override it. Live on 2026-10-21, `0.20.0` was rejected that way and `0.72.1` was accepted.

gbot reaches EnsureSandBox through `CURSOR_ACCESS_TOKEN` only when there is no usable app login and not both `GROK_BOT_GATEWAY_URL` and `GROK_BOT_GATEWAY_TOKEN` are set. That path uses the same client version, `{ "wake": true }`, and the same about-90-second poll, including a `STARTING` answer. If that wake ends with no gateway fields and no run state, the error says the auth may be a dashboard API key. `GROK_BOT_ALLOW_ANY_GATEWAY` still applies to this user-supplied token.

Wake via `{ "wake": true }` with the app login token was verified live on macOS on 2026-10-21: a hibernated box became `RUNNING` in about 10 seconds, and `listAgents` through the new gateway answered 200 about 3 seconds later. On that day, a new process using the app descriptor's stored gateway session with `GBOT_AUTO_WAKE=0` listed bots after the wake. The stored gateway URL and token stayed valid across hibernation in that case. That is an observation, not a guarantee. The Linux saved-login token path is implemented and has not been live-tested. The Windows saved-login token path and the registry lookup are implemented and have not been live-tested, except the registry values themselves, which were read on a Windows machine on 2026-10-21: key `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\8db316bb-b3e2-5dd2-9554-ecccb62be362`, `DisplayName` `Grok Bot 0.72.1`, `DisplayVersion` `0.72.1`, `Publisher` `SpaceXAI`, install directory `D:\APP\Grok Bot`. gbot's `reg.exe` lookup was not run on that machine.

```sh
gbot wake
gbot wake --account "<label>" --json
gbot wake --check
```

`--check` sends `{ "wake": false }` and prints the run state (`RUNNING`, `HIBERNATED`, `STARTING`, or `unknown`) without waking. Without `--check`, gbot wakes, waits for `RUNNING` (about 90 seconds), then lists bots once. The text is the account label, the state before and after, and the seconds taken. A legacy EnsureSandBox answer that has gateway fields and no runState is ready, and `after` is `RUNNING`. It never prints tokens, gateway URLs, or network tokens. `--account` is a saved label or id and overrides `GBOT_ACCOUNT`. If both `GROK_BOT_GATEWAY_URL` and `GROK_BOT_GATEWAY_TOKEN` are set, `gbot wake` exits 2 and prints `gbot wake uses the saved app login; unset the override`. It does not wake the override's gateway.

| Code | Meaning |
| --- | --- |
| 0 | Running, or `--check` succeeded. |
| 2 | Usage: an unknown flag, several logins and `--account` does not pick one, or both `GROK_BOT_GATEWAY_URL` and `GROK_BOT_GATEWAY_TOKEN` are set. |
| 3 | Could not wake (no saved login, a bad or expired token, or the backend refused). |
| 4 | Timed out before the box was ready (the wake budget ran out, including while it was still starting). |

`--json` prints those fields and `exitCode`. A failure also has `error`.

## Grok Bot 0.78.x: server-hosted bots

Grok Bot 0.78.4 (2026-11-03) hosts every bot on the server (`harness: "temporal"`). The app now calls `aiserver.v1.GrokBotService/<Rpc>` (Connect JSON) on the Cursor API host with the account access token for sends, rooms, deletes, and sidebar settings. On 2026-11-05 the box gateway (`/api/<method>` with the box gateway token) behaved like this:

| Gateway call | Result |
| --- | --- |
| `sendPrompt`, `createGroup`, `setAgentHiddenFromSidebar` | 502 `A Sand box session is not permitted on this endpoint.` |
| `listAgents` | 200, but stale: it kept bots the backend had deleted, and a room the backend had just created showed up only minutes later. |
| `deleteAgent` | 200, and nothing was deleted. |
| `updateAgent` | 200. Without `editedFields` only the box copy changed. With `editedFields` (what the app sends) the box passed an avatar edit to the server about 3 seconds later; a title edit had still not reached the server 30 seconds later. |
| `setAgentNotifyOnUpdates` | 200. The server's client state did not change. |
| `createAgent` | 200. The bot, its title, and its avatar appeared on the server. |
| `getAgentTranscriptTail`, `getAgentThread`, `getAgentWorkflows` | 200 and current. |

When the session has an access token, gbot uses these backend RPCs:

| Command | RPC |
| --- | --- |
| `send` | `SendGrokBotUserMessage` |
| `reconcile` | `GetGrokBotSendStatus`, then the transcript tail |
| `bots list`, `groups list`, `get`, and every name lookup | `ListGrokBotAgents`; notify and hidden from `ListGrokBotAgentStatuses` |
| `groups create` | `CreateGrokBotRoom`, then `UpdateGrokBotAgent` for `--title` and the avatar |
| `groups set`, `add`, `remove` | `SetGrokBotRoomMembers` |
| `bots update`, `groups update` | `UpdateGrokBotAgent` (numeric server id, only the changed fields); `--notify` and `--hidden` with `SetGrokBotAgentClientState` |
| `bots delete`, `groups delete` | `DeleteGrokBotAgent` (not found counts as deleted) |
| `approvals respond` | `ResolveGrokBotAutoReviewApproval` or `ResolveGrokBotLocalToolPermission` (mapped from the app, not live-tested) |
| `bots template` | `GetGrokBotTemplateForSourceAgent`; to create or update, `SendGrokBotUserMessage` with the `TEMPLATE_SHARE` initiator; `--show` `GetGrokBotTemplateVersion`; `--publish` `ActivateGrokBotTemplateVersion` |
| `migrate import`, `migrate run` with `--move-routines` | `SetGrokBotAgentAutomationEnabled` `{ agentId, automationId, isEnabled: false, timeZone }` per migrated routine (every one that was on, or only those `--routines` names), only after the import verified, with the backend-only session the capture uses (no box describe or wake); the answer must list the routine as off. The destination copy is turned on only after that (a short gap, never both running); `isEnabled: true` once, only to roll back a routine the destination could not turn on, and the answer must list it as on |

Since 0.11.2-iml1s.7, `bots create` calls `CreateGrokBotTemporalAgent` as the app does (the box gateway answered 404 on 0.78). `thread`, the tail that `reconcile` falls back to, the relay, `approvals list` and `approvals respond`, and the MCP thread tool read the transcript tail with `ListGrokBotTranscriptEntries` (`limit` N+1, newest page, oldest first; bodies left out of the page are read from the store, 8 at a time, and checked against their hash). A row whose body cannot be read is shown as `unreadable`, and a `--after` cursor stops before it so the next read gets it. On a 0.78 host the box gateway answers 404 to the skill library and to `thread --root` (checked 2026-11-08 with the box awake). `skills list` then reads the library from the box store through the backend (the manifest and each `SKILL.md`, as `gbot migrate` reads them; a large store takes a minute or two); `skills add` and `skills remove` say to add or remove the skill in the Grok Bot app or have a bot save it; `thread --root` says to read the conversation with `gbot thread` (no backend call maps a root message to its thread).

A session has an access token when it comes from a saved app login (gbot already reads that token for EnsureSandBox), from a descriptor login whose account also has a saved access token, or from `CURSOR_ACCESS_TOKEN` when there is no app login. The token is sent only to `CURSOR_API_BASE_URL` (default `https://api2.cursor.sh`), with the same headers as EnsureSandBox (`SAND_CLIENT_VERSION` and `SAND_BOX_NAMESPACE` still apply). An app login token goes only to an https Cursor API host, and `GROK_BOT_ALLOW_ANY_GATEWAY` does not apply to it. `GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN`, and a descriptor login without a saved access token, have no access token and keep the gateway calls. On a 0.78.x host their sends get the 502 above.

Send delivery: `ACCEPTED_BOX`, `ACCEPTED_TEMPORAL`, and `DUPLICATE` (the same nonce again) are `accepted`. `REFUSED` is `rejected` with the server's `failureCode`. A 4xx is `rejected`, except 408, 499 (Connect `canceled`), and any answer whose Connect code is `canceled`, `deadline_exceeded`, `unavailable`, `unknown`, or `internal`: those may have landed. Those, a timeout, a transport failure, a 5xx, or `UNSPECIFIED` ask `GetGrokBotSendStatus` for the same nonce once: `ACCEPTED` makes it `accepted`, `REJECTED` makes it a new `rejected` error (`SEND_REFUSED`, the server's rejection code as `failureCode`), and anything else stays `unknown`. Server text in errors is redacted before it is cut to 300 characters. gbot never resends, and never sends through the gateway after a backend send was tried. The nonce is the backend `messageId`. `reconcile` asks `GetGrokBotSendStatus` first and returns its answer as `sendStatus`. `ACCEPTED` is `delivered` (`entryId` is the echoed entry). `REJECTED` is `rejected`, with `rejectionCode` when the server gives one. Otherwise gbot reads the last 200 transcript entries as before: the nonce there is `delivered`. When it is not there, only `NOT_FOUND` is `not-found-in-tail`. Every other answer (`PENDING`, `UNKNOWN_DURABILITY`, `UNSPECIFIED`, or a value newer than this build) is `pending`, and so is a status read that failed (`sendStatus: "UNAVAILABLE"`): the message may still land, so do not resend. When the server has such a status but the transcript cannot be read (the box is asleep or failing), the result is still `pending`, with `tailError`; with no status, or `NOT_FOUND`, the read error stands.

Roster: the server is the source of truth for every agent it lists, and `ListGrokBotAgents` also returns box-harness bots. gbot reads the box roster too, and adds a bot only when the server does not list it and its harness is not `temporal`. A `temporal` box row the server does not list is stale and is dropped. That read does not retry an asleep box (no wake on 417). On a saved login, a box answer of 401, 403, or "could not be routed" still rebuilds the session first, as for any box call, and that rebuild can wake the box. If the box roster cannot be read, the server roster stands alone (`GBOT_DEBUG` says why). A name is matched against the server's bots first by exact name or title. Then the folded rule matches either half of a server bot's `name · title`: the plain name or the title. If a server bot matches only by the folded rule while a box-only row matches exactly, gbot refuses with `Ambiguous name … Use the id.`, because they may be one bot or two. Box-only rows are used only when no server bot matches. A server row with no `agentId` is skipped, as the app does, and a box row whose id is a server bot's `agentId` or `legacyAgentId` is not added again.

Whether the server roster is on is decided as the app decides it: `GetGrokBotRuntimeCapabilities` with `capabilities.durableIdentityEnabled` true. It is off when that is false or missing, or when that call answers `failed_precondition`. gbot asks once per session. With the roster off, gbot uses the box roster, prints `gbot: the server roster is off for this login …` on stderr, marks each record `roster: "box"` in `--json` (bots and groups, `send`, `reconcile`), and sends, edits, deletes, and creates groups through the box gateway as before 0.78.x. Any other error from that call, and any error from `ListGrokBotAgents` itself, fails the command: a guessed roster could point a send or a delete at the wrong bot. If the server marks its list `truncated`, names do not resolve, because the bot meant may be past the cut, and box-only rows are left out; give the bot or group id instead. An empty or whitespace-only name is refused. `ListGrokBotAgents` shows a bot with a title as `name · title` with no title (rooms keep their title); the plain name still resolves when nothing matches exactly. A bot the box created with a title already has ` · title` in its stored name, so `bots update --title` alone adds a second one (live: `name · old · new`). Give `--name` and `--title` together to replace both. Notify and hidden come from `ListGrokBotAgentStatuses`. Like the app, gbot takes notify from a client state only once that state was written (`updatedAtMs` above 0); before that, and with no client state, it shows notify on and not hidden. If that read fails, the list leaves notify and hidden out instead of failing.

Rooms: `CreateGrokBotRoom` gets a fresh v4 uuid as `agentId`, and gbot keeps the id in the answer. After a timeout or a 5xx the group may exist; run `gbot groups list` before trying again. `UpdateGrokBotAgent` edits a room's name, description, title, and avatar (checked live). `groups create` checks `--avatar-shape` and `--avatar-color` before it creates anything, and sets the title and avatar with the room's server id from the answer. If that second step fails, the error gives the new group's id. The `SetGrokBotRoomMembers` answer must be the room asked for; any other answer is an error (`ROOM_MISMATCH`) that says the members may have changed.

`--notify` is also sent to the box (`setAgentNotifyOnUpdates`), as the app does. A failure there is ignored (`GBOT_DEBUG` says why).

Approvals: `approvals respond` follows the app's dispatcher. An auto-review card goes to `ResolveGrokBotAutoReviewApproval` with `agentId`, `requestId`, `resolution` (`GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_APPROVED` or `_DENIED`), and `approvalPlatform: "desktop"`; that request has no entry id. A local tool card goes to `ResolveGrokBotLocalToolPermission` with `agentId`, `entryId`, `requestId`, and `resolution` (`GROK_BOT_LOCAL_TOOL_PERMISSION_CARD_RESOLUTION_ALLOW_ONCE` or `_DENY`). A `refusal` in that answer is an error with `code: "APPROVAL_REFUSED"`, the server's `failureCode`, and `delivery: "rejected"`. gbot still grants once or declines only: the app's ALWAYS and NEVER are never sent, and a stale, foreign, or truncated card is refused before any call. This is mapped from the app and not live-tested: a real pending card is needed, and `approvals respond` refuses a made-up card before any network call. A session without an access token still resolves cards on the box. Like the app, an auto-review card of a bot whose harness is not `temporal` goes to the box gateway, and a local tool card of such a bot moves on to the box gateway when the backend answers `unimplemented`. The answer carries `via` (`backend` or `box`). A backend answer is `delivery: "accepted"` only with `dispatched: true`; otherwise it is `delivery: "unknown"` with a note to check the card in the app. The app itself treats any answer without a refusal as done.

`connectGateway` still runs EnsureSandBox, and may wake the box, before a command that only needs the backend.

## Fork commands

`--stdin` (default `false`):

```sh
printf %s 'Exact UTF-8 message' | gbot send Researcher --stdin --json
```

Windows PowerShell, UTF-8 and no extra newline:

```powershell
node -e "process.stdout.write('Exact UTF-8 message')" | gbot send Researcher --stdin --json
```

Do not combine `--stdin` with a positional message. The text must be non-empty UTF-8, at most 64 KiB, with no NUL and no surrounding whitespace. A UTF-8 BOM or a UTF-16 BOM is accepted and removed. A trailing CR, LF, or CRLF is surrounding whitespace and is rejected. A CR LF between lines is kept.

Success JSON includes `delivery` (`accepted` or `unknown`), `kind` (`bot` or `group`), `exitCode: 0`, and `result`. `delivery: "accepted"` means the backend confirmed the send (see Grok Bot 0.78.x above), or, for a session without an access token, the gateway did (`{"accepted": true}` or a message id). When the gateway answers `{"accepted": true}` with no message id, gbot reads the last 20 transcript entries once (no wake) and reports the id of the user entry with this send's `clientNonce` as `messageId`; if that entry is not there yet or the read fails, the send stays `accepted` without `messageId`. `delivery: "unknown"` means the CLI cannot prove the send landed (timeout, network failure, HTTP 408 or 5xx, or a response with neither). Do not send again. The result carries the `clientNonce` it posted: `gbot reconcile <bot> --nonce <clientNonce>` looks for it in the last 200 transcript entries (`delivered` or `not-found-in-tail`) and never resends.

Sends use a 15 second deadline that includes the response body. Reads use 30 seconds. There is no automatic retry, except one retry of the same request after waking an asleep box. A `sendPrompt` retries only when the 417 carries sleep evidence (`pod_hibernated`, or a `failureCode` that matches sleep or hibernation). A failure JSON document includes `wake` and `failureReason` when the error has them. Redirects are rejected.

`--normalized` (default `false`) requires `--json`. Leading `--json` is accepted (`gbot --json thread …`).

```sh
gbot --json thread Researcher --normalized --limit 50
```

Shape: `{ "target": { "id", "name", "kind": "bot" | "group" }, "messages": [{ "id", "role", "text" }] }`. `role` is `user`, `assistant`, or `unknown`. With `--after`, the same object also has `cursor`, `entryCount`, and `gapReset`.

```sh
gbot thread Researcher --after "<cursor>" --json
```

`--after` has no default. `--limit` defaults to 40 (1–200). Entries are strictly after the cursor. `entryCount: 0` and `gapReset: false` means nothing new. An unknown cursor returns one bounded snapshot with `gapReset: true`.

Bot replies often arrive as `kind: "send-message"` with `message.type: "text"`. The normalized `role` is `unknown` unless the entry says `user` or `assistant`. That is still a reply. Do not treat `unknown` as a failed send.

`bots template` shares a server-hosted bot as a Grok Bot template, the way the 0.78 app does:

```sh
gbot bots template "Move to Hermes"            # create or update, then wait up to 600 s
gbot bots template "Move to Hermes" --status   # read only: the current template and link
gbot bots template "Move to Hermes" --show     # read only: review the draft's recipe
gbot bots template "Move to Hermes" --publish  # publish it
```

gbot reads `GetGrokBotTemplateForSourceAgent` for the bot. With no template it sends the bot the app's message `Create a public template of yourself that I can share with somebody else`; with one, `Update the shared template of yourself.` The message goes through `SendGrokBotUserMessage` with `initiator: "GROK_BOT_USER_MESSAGE_INITIATOR_TEMPLATE_SHARE"` and the send delivery rules in Grok Bot 0.78.x above, and the bot builds the template on the server. gbot then reads the template every 10 seconds until one appears (or, for an update, one with a newer `updatedAtMs`), for at most `--wait` seconds (default 600; `0` does not wait). The link `https://x.ai/bot/<shareId>` is printed on its own line. `--json` gives `action` (`created` or `updated`), `delivery`, `clientNonce`, and `template` (`shareId`, `link`, `name`, `published`, `visibility`, `activeVersion`, `updatedAtMs`). Exit 0: the template was seen. Exit 3: the message was accepted or its delivery is unknown, but no template appeared within `--wait` (`template: null` and a `hint`); check later with `gbot bots template <bot> --status`. gbot never sends the message again; running the command again asks the bot again. Exit 1: the message was rejected, or nothing was sent. `--status` sends nothing; it returns `template` (or `null`, "no template yet"), `hasTeam`, and `exportPolicy` when the server gives one. Templates are for server-hosted bots (the app has no box path for them): a box-only bot, a login whose server roster is off, a group, and a session without an access token are refused before anything is sent.

A new or updated template is a draft: live (2026-11-08) the first one came back with `published: false` and `activeVersion: 0`, and the bot posted a review card in its chat (`kind: "send-message"`, `message.type: "bot-template-share"`, with `shareId` and `version`). The app publishes the version only when that card is confirmed. `--show` reads a version as the app's review dialog does: `GetGrokBotTemplateVersion` with `{ shareId, version }`, then a GET of its presigned `blobGetUrl` (only the `grok-bot-templates` S3 bucket, no credentials, no redirects, at most 25 MiB, 20 s), and the recipe is checked as the app checks it: `profile` (`name`, `description`, avatar), `memory`, `skills`, `routines`, `plugins`, and an optional `gettingStarted` skill that must be one of the recipe's skills. It prints the name, the description, each memory entry (kind and first line), the skills, routines and plugins, the getting-started skill, and the link; `--json` gives the parsed `recipe` with `version`, `versionFrom`, `active`, `visibility`, and `createdAtMs`. `--publish` calls `ActivateGrokBotTemplateVersion` with `{ shareId, version }`, as confirming the card does, and prints `published`, the visibility, the active version, and the link. Both take the version from `--template-version N` (`--version` prints gbot's version); without it, from the newest review card for this template in the last 200 transcript entries (`versionFrom: "card"`), else from the active version (`"active"`); with neither, the command fails and asks for `--template-version`. Both need a template (`TEMPLATE_MISSING` otherwise). `--status`, `--show`, `--publish`, and `--wait` cannot be combined, and `--template-version` goes only with `--show` or `--publish`.

## Move a bot to Hermes, Muse or Your dot (`gbot migrate`)

Run `gbot migrate` in a terminal and follow the prompts, or use `gbot migrate bots|capture|preview|import|check|run`. It captures the whole bot read-only (every transcript page, all memory tiers, the skill library, routines, open tasks, needed files), imports it, reads the destination back and asks the migrated agent acceptance questions. Details, destination differences and limits: [docs/migration.md](docs/migration.md).

## Pair a Wear OS watch (`gbot wear pair`)

The watch app is [Grok Bot Wear](https://gitlab.com/aa22396584/grok-bot-wear) (unofficial; download the APK from its [releases](https://gitlab.com/aa22396584/grok-bot-wear/-/releases), step-by-step install in its [install guide](https://gitlab.com/aa22396584/grok-bot-wear/-/blob/main/docs/install.md), in Traditional Chinese).

`wear pair` ships in `v0.11.2-iml1s.4` and later. Install that release as in [Install](#install) (the Node.js versions listed in [Install](#install); the Grok Bot desktop app signed in on this computer), then check the login before pairing:

```sh
gbot accounts                        # saved logins, no credentials
gbot bots list --account "<label>"   # check that login still works before pairing
```

Sends the selected saved login's gateway session (gateway URL, token, routing headers, and the login label) to the grok-bot-watch Wear OS app on the same Wi-Fi, over the GBWP/1 pairing channel. This is provisioning from your computer, not a sign-in: the watch then uses a session the Grok Bot desktop app was issued, against the same undocumented gateway. When that session expires, pair again.

On the watch, choose 「從電腦配對」 on the Connect screen. It shows a code like `ABCD-EFGH-JKMN-P` and an address. In a terminal on the same network:

```sh
gbot wear pair 192.168.1.23:40123
gbot wear pair 192.168.1.23:40123 --account "<label>" --json
```

Type the code at the prompt. Input is hidden (echo off), at most 32 characters; Enter submits, Ctrl-C cancels. Case, dashes and spaces do not matter, and `I`/`L` read as `1`, `O` as `0`.

- Address: the dotted-decimal IPv4 address and port the watch shows (port 1024–65535) in 10/8, 172.16/12, 192.168/16, 100.64/10 or 169.254/16. No host names, no IPv6.
- Login: one saved login is used as is. With several, `--account` (label, id, or a unique id prefix of 8+ hex digits) is required. `GBOT_ACCOUNT` is ignored here, so an exported default never decides what leaves the computer. A label or id that equals or contains a token, a routing header value or a gateway host of any saved login is printed, and sent to the watch, as `login <n>` (a placeholder never repeats a real label or id, so it names exactly one login); `--account "login <n>"` selects it.
- Before connecting, `gbot` checks the last character of the code (a typo is reported and does not use up the code) and checks the session with the watch's own import rules (https on a Cursor host, a visible-ASCII token, at most 8 `x-` routing headers, at most 16 KiB). It then prints only the login label and the address.
- It never prints the token, routing headers, gateway host or the code. The code is never in the command line, an environment value, shell history, output or an error: the `gbot` wrapper writes it to a 0600 file in a fresh 0700 temporary directory and passes only that path to the worker, which reads and deletes the file before connecting. The wrapper removes the directory on exit, on errors, on Ctrl-C (SIGINT), SIGTERM and SIGHUP. A SIGKILL or a power loss between the prompt and that read can leave the file in the temporary directory.
- The 60-bit code is what authenticates the channel (ECDH P-256, HKDF-SHA256, HMAC-SHA256 tags, AES-256-GCM). The session is sent only after the watch proves it knows the code, and it is encrypted to that handshake. Never reuse a code: after any failure, generate a new one on the watch. The check character catches any single wrong character and any swap of two neighbours except `0`↔`Z`; such a swap is caught by the watch instead (wrong code).
- There are no retries. Deadlines: connect 5 s, the watch's answer within 15 s, its receipt within 20 s.
- Before the session is sent, Ctrl-C (SIGINT) ends with 130, SIGTERM with 143 and SIGHUP with 129 (the wrapper re-raises SIGHUP; shells report that as 129). Just before sending, the worker records the send in the wrapper's private directory; if that record cannot be written, nothing is sent (exit 1). Once the session has started to leave the computer, an interruption, a crash or an error never reports "cancelled": the result is `unknown` (exit 6), because the watch may have stored it, and stderr says "The session was already sent; the watch may have stored it." (the runtime's own "Aborted." line can come just before it).

`--json` prints `{ "account", "id", "target", "outcome", "exitCode" }`, where `outcome` is `paired`, `rejected`, `storage-failed` or `unknown`. A failure prints `{ "category", "error", "exitCode" }` with a fixed message. `exitCode` is part of the value because the CLI framework takes the exit code from it.

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Paired. | — |
| 1 | The saved logins could not be read (Keychain or secret store access; in test mode the message says the store is off), the watch would reject this session (nothing was sent, the code is still valid), the send could not be recorded (nothing was sent; generate a new code), or an internal error. | Allow Keychain access for this terminal, or `gbot doctor --account "<label>"`; sign in again in the Grok Bot app. |
| 2 | Usage: bad address, a typo in the code, not a code, several logins without `--account`, or not run in a terminal. | Fix the input. A typo does not use up the code. |
| 3 | The watch is unreachable. | Same Wi-Fi? Guest networks and some routers isolate clients. On macOS, allow this terminal app under System Settings > Privacy & Security > Local Network. Generate a new code if the watch already shows a failure. |
| 4 | Wrong code, not your watch, or the watch did not answer (busy, another protocol version, or this computer is on a different subnet: the watch closes connections from other subnets). | Generate a new code on the watch. Never reuse an old one. Check that both are on the same subnet. |
| 5 | The watch rejected or could not store the session. | Generate a new code and try again. |
| 6 | Sent, but no confirmation arrived, including Ctrl-C or a signal after the session was sent. | Check the watch screen. |
| 129 | SIGHUP before the session was sent (the wrapper ends by SIGHUP). | — |
| 130 | Ctrl-C (SIGINT) before the session was sent. | — |
| 143 | SIGTERM before the session was sent. | — |

For tests only, `--code <code>` and `GBOT_TEST_KEYCHAIN_PASSWORD` are honoured when `GROK_BOT_TEST=1`. Without it the wrapper refuses `--code` or `--code=…` anywhere on any `gbot` command line (no other command has a `--code` option; any position, also after `--account`, `--help` or `--`) with exit 2 before any worker starts, so the value is never passed on. A message word that is literally `--code` therefore has to go through `send --stdin`. In test mode (`GROK_BOT_TEST` or `NODE_ENV=test`) `wear pair` never reads the Keychain, `secret-tool` or DPAPI, and loopback addresses are allowed. `src/core/wear-pair.js` imports Node built-ins only, because the watch repository vendors it for a cross-language test. The known-answer vectors in `test/fixtures/` are copied from the watch repository; `test/fixtures/wear-pair-vectors.sha256` records their source and SHA-256.

## Exit codes and common errors

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Command finished. A send can be `delivery: "unknown"` and still exit 0. | If delivery is unknown, read the thread. Do not resend. |
| 1 | Usage error or gateway failure. Send failures are JSON on stdout with `exitCode: 1`. | Read `error` / `code`. Fix the flag or the login. |
| 2 | Unknown option, including `--account` before the subcommand. | Put `--account` after the subcommand. |

`bots template` also uses 3: the message went out (or its delivery is unknown) but no template appeared within `--wait`. Run `gbot bots template <bot> --status` later instead of sending again.

`--normalized` without `--json` throws `--normalized requires --json.` Other commands print the error on stderr.

## Safety

Do not put tokens, account keys, or message text into tickets or shell history. History is off unless `GROK_BOT_HISTORY=on`. Do not resend after `delivery: "unknown"`. Do not ask a bot to delete files, message other people, buy anything, or change account settings unless you mean that exact action. Codex and Claude channel commands need a local Unix socket; upstream rejects them on Windows (`windows-unsupported` / no Unix sockets).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `bots list`, `send`, or `thread` says no Grok Bot login, or that no agents directory was found | Sign in once in the Grok Bot app as the same OS user, then run `gbot accounts`. `gbot doctor` shows where it looked. |
| Several logins, no choice | `gbot accounts`, then `--account "<label>"` after the subcommand, set `GBOT_ACCOUNT`, or `gbot accounts default <alias>`. `gbot doctor` and `gbot wear pair` ignore that default. |
| `Unknown option: --account.` | Put `--account` after the subcommand. |
| Linux: `secret-tool` not found | Install `libsecret-tools` (Debian/Ubuntu) or `libsecret` (Fedora/Arch), unlock the keyring, and try again. |
| `delivery: "unknown"` | `gbot reconcile <bot> --nonce <clientNonce>`, or read the thread. Do not send again. |
| `Relay profile mismatch` on a pinned `GROK_BOT_RELAY_DIR` | That directory was written for a different account or environment, or by an older version. Run again with the same account and environment to keep it; if an older version wrote it, with the old version run `gbot codex bridge stop --worker`, then move or rename the directory (or pick a new one) and bind again. Sockets, the old worker and `lsof`: [Verify, upgrade, uninstall](#verify-upgrade-uninstall). |
| `gbot` not found after install | Open a new terminal. Check that `npm prefix -g` (its `bin` folder on macOS/Linux) is on PATH. |
| `... failed: 417 ...`, `code: "BOX_ASLEEP"` | The Grok Bot box for that login is asleep, and gbot tries to wake it itself; which calls wake and retry, the errors (`auto wake failed: …`, `CLIENT_VERSION_REJECTED`, `woke: true`), `GBOT_AUTO_WAKE=0` and the `CURSOR_ACCESS_TOKEN` path are in [Wake an asleep box](#wake-an-asleep-box-gbot-wake). Live on 2026-10-20 the proxy answered 417 with an empty body and `x-anyrun-failure-reason: pod_hibernated`; a 417 without that header can also be `BOX_ASLEEP`, while a 417 with another proxy reason is not; the error carries the proxy reason as `failureReason`. You can still open the Grok Bot app and select a bot of that login. Switching the app to that login was also observed to wake the box on 2026-10-20 (one owner session); that is an observation, not a rule. Opening the app or a bare `grokbot://` in the background (`open -g`) did not wake it. `gbot wake` does the same wake and prints the run state. |
| `Gateway response too large (over N bytes)` | Set `GBOT_MAX_RESPONSE_BYTES` to a byte count from 65536 to 67108864 (default 16 MiB) and retry. Other values are ignored; the error says so. |
| `EnsureSandBox failed: 4xx` | Often the client version: `x-cursor-client-version` `0.20.0` is rejected with 401 "no longer supported", and that 401 names the version gbot sent. The default is `0.72.1`; `SAND_CLIENT_VERSION` overrides it. What was live-tested (macOS wake on 2026-10-21) and what was not (Linux and Windows saved-login tokens, gbot's registry lookup): [Wake an asleep box](#wake-an-asleep-box-gbot-wake). |

## Privacy

- `gbot` talks only to the Cursor backend and the Grok Bot gateway URL the app saved (or `GROK_BOT_GATEWAY_URL`). It sends no telemetry.
- `gbot wear pair` also connects to the watch address you type, on your local network, and sends it the selected login's gateway session, encrypted to that pairing. Nothing else does.
- It reads the Grok Bot app's encrypted gateway descriptor and, to wake an asleep box, `sand-secrets.json` in the same directory. It decrypts the saved access token with the OS secret store (Keychain, `secret-tool`, or DPAPI). The secrets file is parsed whole. gbot never decrypts or uses the refresh token, never writes an app file, and never prints tokens. The app login token is sent only to an https Cursor API host. `GROK_BOT_ALLOW_ANY_GATEWAY` does not change that.
- It writes nothing unless you turn history on. `GROK_BOT_HISTORY=on` appends plain-text messages to `~/.grok-bot-cli/history.jsonl` (or `GROK_BOT_HISTORY_DIR`). Delete that file to remove it.
- Uninstalling the package leaves the app login untouched; sign out in the Grok Bot app to remove it.

## Related projects

- trinity-cli — one CLI over three always-on agents (Your dot, Grok Bot, Muse): <https://gitlab.com/aa22396584/trinity-cli>
- chatgpt-dot-cli — ChatGPT Your dot: <https://gitlab.com/aa22396584/chatgpt-dot-cli>
- grok-bot-cli (this fork, `gbot`) — Grok Bot: <https://gitlab.com/aa22396584/grok-bot-cli>
- muse-web-cli — Meta Muse via the web: <https://gitlab.com/aa22396584/muse-web-cli>

## Platforms

| OS | Node.js | Status | Evidence |
| --- | --- | --- | --- |
| macOS | 22.19+ (22.x) or 24.2+ | Supported | Checked locally: unit, route, and type checks |
| Linux | 22.19+ (22.x) | Supported | GitLab CI (`node:22-slim`): 696 tests, 671 pass, 0 fail, 25 skip (23 need Python; 2 use macOS-shaped descriptors) |
| Windows | 22.19+ (22.x) or 24.2+ | Supported except Codex/Claude channels and the relay | GitLab CI and isolated full CI script: 696 tests, 386 pass, 0 fail, 310 platform skips |

CI uses GitLab.com runners by default. Maintainers can point jobs at their own runners by setting the CI/CD variables `LINUX_RUNNER_TAG` and `WINDOWS_RUNNER_TAG`. Linux unit tests run in CI on `node:22-slim` (`unit`) and `node:26-slim` (`unit:node26`). Windows unit tests run when that runner is available. macOS is checked locally. Both jobs pass the same `test/*.test.js` list to `node --test`. Tracked text stays LF (`.gitattributes`), so a Windows checkout does not rewrite plugin command frontmatter to CRLF. The Windows unit job loads the MCP client with a `file://` URL because Node rejects a `C:` path in `import()`. Upstream Codex and Claude sockets stay Unix-only.

## Account profile verification (2026-10-22)

[MR !7](https://gitlab.com/aa22396584/grok-bot-cli/-/merge_requests/7), source `c7f18c6b7fbe4a982097eb58c64471c6eb6a7f62`, merged as `74704f554227fe71641af924b17ddadc3859e019`; both commits have the same Git tree. On macOS, the unit suite passed 695/695 and the route suite passed 94/94. Source validation, artifact build/validation, typecheck, and the three release configuration checks passed. MR !7 rounds 2–3 and MR !8 were reviewed only by that session's own reviewer. That is not an independent approval of this release. Claude and agy review attempts were blocked by quota/credits and supplied no approval. Codex was not available. A later pre-release review of `c2a5d2d` by two Opus reviewers asked for the changes in this round. This note does not claim approval for this round; the maintainer updates it after the re-review.

Linux passed on both the [source pipeline](https://gitlab.com/aa22396584/grok-bot-cli/-/pipelines/2974528600) and the [merged-main job](https://gitlab.com/aa22396584/grok-bot-cli/-/jobs/17368454058): 695 tests, 670 pass, 0 fail, 25 environment skips. The final runtime candidate passed 696/696 unit tests and 94/94 route tests on macOS. An isolated Windows run of the full CI script passed: 696 tests, 386 pass, 0 fail, 310 platform skips. With the normal `APPDATA` preserved, it detected that Node 24.1 lacks `import.meta.main`, downloaded Node 22.23.4, verified its SHA-256, and completed install, build, and tests; the job-owned runtime directory was removed. The fixture environments now isolate both `APPDATA` and `XDG_CONFIG_HOME`. The original protected `hx370` GitLab runner was offline during initial validation, and the optional hosted job exhausted its CI quota. The same runtime fixes at `113e1c671eaf882b792888416260468f47d331b1` also passed [pipeline 2974718228](https://gitlab.com/aa22396584/grok-bot-cli/-/pipelines/2974718228): [Linux job](https://gitlab.com/aa22396584/grok-bot-cli/-/jobs/17369336982), 696 tests / 671 pass / 0 fail / 25 skip; [Windows job](https://gitlab.com/aa22396584/grok-bot-cli/-/jobs/17369336988), 696 tests / 386 pass / 0 fail / 310 skip. Both jobs ran on temporary project runners; the original pending main Windows job was canceled as superseded, rather than counted as passing.

These checks use synthetic account fixtures. They do not prove a live account switch, Windows saved-login decryption, or a PowerShell installer run; the PowerShell installer checks remain static. No global CLI installation or npm publication was performed.

## Windows limitations

These files need Unix sockets, a shebang executable, or `process.getuid()`. Windows still collects them, and each test is skipped with `Unix sockets and Codex routes are unsupported on win32`:

- `test/claude-channel.test.js`
- `test/codex-bridge.test.js`
- `test/codex-conversation.test.js`
- `test/codex-session.test.js`
- `test/codex-surfaces.test.js`
- `test/relay-auth-recovery.test.js`
- `test/relay-engine.test.js`
- `test/relay-gateway-lifecycle.test.js`
- `test/relay-lifecycle.test.js`
- `test/relay-surfaces.test.js`
- `test/relay-worker.test.js`
