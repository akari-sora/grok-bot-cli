# Fork guide

ImL1s's fork of [ScriptedAlchemy/grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli), synced to upstream 0.11.2, with five later upstream fixes cherry-picked in 0.11.2-iml1s.7 (the codex-dot skill, the Codex sender prefix and thread search, Codex delivery detail, `codex new` on newer daemons, the desktop shim passthrough; see CHANGELOG.md). The package version string stays `0.11.2`. The fork revision is the git tag.

Upstream still owns the npm package. Do not `npm install -g grok-bot-cli`. GitLab (https://gitlab.com/aa22396584/grok-bot-cli) is the primary remote. The GitHub mirror is not a public install source.

## English

### Disclaimer

Unofficial. This fork is not affiliated with, endorsed by, or supported by xAI, Cursor (Anysphere), or the upstream author. "Grok" and "Grok Bot" belong to their owners. `gbot` uses your own Grok Bot login and an undocumented gateway that can change or break at any time. Automated use may be limited by the Grok Bot terms; check them, and use it at your own risk. Report fork bugs here, not upstream.

### Install

Use Node.js 22.19+ (22.x) or 24.2+, with the Grok Bot desktop app signed in once on the same OS user. The generated CLI uses [`import.meta.main`](https://nodejs.org/api/esm.html#importmetamain), which is absent in Node 23 and Node 24.0–24.1; the launcher rejects those versions with a nonzero exit and a version diagnostic.

Do not `npm install -g` a `git+https://gitlab.com/...` spec. npm exits 0 and leaves a dangling `gbot` link. Download the package file from the `v0.11.2-iml1s.7` release and install that file.

macOS or Linux:

```sh
curl -fsSL -o grok-bot-cli-0.11.2.tgz "https://gitlab.com/-/project/86401528/uploads/3562acc9b72ba4f1f433acbb01d58c08/grok-bot-cli-0.11.2.tgz"
npm install -g ./grok-bot-cli-0.11.2.tgz
rm -f grok-bot-cli-0.11.2.tgz
```

Windows PowerShell:

```powershell
irm "https://gitlab.com/-/project/86401528/uploads/3562acc9b72ba4f1f433acbb01d58c08/grok-bot-cli-0.11.2.tgz" -OutFile grok-bot-cli-0.11.2.tgz
npm install -g .\grok-bot-cli-0.11.2.tgz
Remove-Item grok-bot-cli-0.11.2.tgz
```

npm creates `gbot.cmd` on Windows, so `gbot` works from PowerShell and cmd.

From a clone (any OS). `dist/` is not in git, so build before linking:

```sh
npm ci
npm run build
npm link
```

To install or restore this fork on another machine without a `git+https` spec, use `scripts/install-fork.sh` (macOS/Linux) or `scripts/install-fork.ps1` (Windows). Those scripts are described under [Switching logins and restoring gbot on another machine](#switching-logins-and-restoring-gbot-on-another-machine). The shell script was tested with real git against a local `file://` repository and with fake `git`, `npm`, and `gbot` on `PATH`. The PowerShell script was checked by reading it. Neither script was run against GitLab.

### Verify, upgrade, uninstall

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

### Login and several logins

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

### Switching logins and restoring gbot on another machine

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
scripts/install-fork.sh --dry-run --config gbot-accounts.json v0.11.2-iml1s.7
```

The script clones `https://gitlab.com/aa22396584/grok-bot-cli.git` into `$XDG_CACHE_HOME/grok-bot-cli/src` (default `~/.cache/grok-bot-cli/src`; on Windows, `%LOCALAPPDATA%\grok-bot-cli\src`). `--config` is made absolute before any directory change. The ref may contain only `[A-Za-z0-9._/-]`, must not start with `-`, and is passed to git after `--`. A ref after `--` is that ref (`-- v1.2` does not install `main`). The script fetches the ref, checks that the resolved commit matches `^[0-9a-f]{40}([0-9a-f]{24})?$`, checks it out with `git checkout --detach <sha>` (no path separator), prints it, and refuses a dirty cache. `npm pack` writes to an installer-owned temporary directory outside the checkout; that directory is removed after the run. The installer never deletes unknown cache files. A cache containing a `.tgz` left by an older installer is refused unchanged; preserve or move that cache and use a clean cache location rather than asking this installer to migrate it. It then runs `gbot --version` and `gbot accounts` (an accounts failure does not skip import), `gbot config import` when `--config` was given, and `gbot wake --check --account <alias>` for each alias. A failed import or wake exits non-zero. When import reports logins missing, wake checks for those aliases are skipped, the other aliases are still checked, and the script exits 3. It refuses to run as root or Administrator unless `--allow-root` (PowerShell `-AllowRoot`) is given. `--dry-run` and PowerShell `-DryRun` print the steps and do not run git or npm. The script does not store or print tokens. `scripts/install-fork.sh` is executable.

What was tested: on a POSIX host, the shell script with real git against a local `file://` bare repository (the fetched commit was checked out and `npm ci` ran, with fake `npm` and `gbot` on `PATH`) and with fake `git`, `npm`, and `gbot` on `PATH`, including a relative `--config`, two consecutive clean-cache runs, rejection and byte-for-byte preservation of a legacy tarball, a rejected ref, a failing step, `checkout --detach --` returning 128, a branch, a tag, a raw commit sha that is not a branch or tag name (that sha takes `git fetch origin -- <sha>`), and import exit 3 skipping the missing alias. The PowerShell script has a static source check that it names the same steps, checks `$LASTEXITCODE` after each native call, uses `[Console]::Error.WriteLine` before `exit 2`, refuses `checkout --detach --`, avoids fixed output files, uses a private pack directory, and sets `$ErrorActionPreference = "Continue"` around the `gbot config import` capture so Windows PowerShell 5.1 does not turn stderr into a terminating error before `$LASTEXITCODE` is read; it was not executed because PowerShell was unavailable on the test host. The scripts were not executed against GitLab. Two accounts in one process were checked with synthetic fixtures, not with a live account switch.

### Wake an asleep box (`gbot wake`)

A gateway call for a saved app login that fails with `code: "BOX_ASLEEP"` wakes that login's box and retries the call once, except a call that is not one of the read-only methods below and has no sleep evidence. gbot reads the access token the app saved for that login (the same account id as the gateway descriptor entry). The secrets file is parsed whole; gbot never decrypts or uses the refresh token and never writes an app file. It posts EnsureSandBox `{ "wake": true }` to an https Cursor API host (`*.cursor.sh` / `*.cursor.com`). `GROK_BOT_ALLOW_ANY_GATEWAY` does not apply to that app login token. It still applies to a user-supplied `CURSOR_ACCESS_TOKEN`. Test mode still allows loopback only.

`sendPrompt` wakes and resends only when the 417 carries sleep evidence. Only these read-only methods wake and retry on a bare 417 (no proxy reason and no failureCode): `listAgents`, `getAgentThread`, `getAgentTranscriptTail`, and `getAgentWorkflows`. Those are the only read-only gateway methods. Every other method wakes and retries only with positive sleep evidence: `failureReason` is `pod_hibernated`, or a `failureCode` matching sleep or hibernation. A bare 417 stays `BOX_ASLEEP` (the same label and hint) and is not resent.

Polling covers `STARTING`, `RUNNING` without gateway fields, and an `unknown` run state that still names gateway fields. `unknown` plus a gateway is not treated as ready. Each EnsureSandBox call uses the time left in an about-90-second budget, and at most 30 seconds. The poll is `{ "wake": false }` about every 3 seconds. If `{ "wake": true }` is still `HIBERNATED`, gbot waits the shorter of the poll interval and the time left, sends `{ "wake": true }` once more, and then fails with `WAKE_FAILED` instead of polling. If that second reply is still `HIBERNATED` and the budget is already gone, the error is `WAKE_TIMEOUT`, not `WAKE_FAILED`. If an EnsureSandBox call hits its per-call deadline while budget remains, gbot keeps polling with the time left. When the budget is used up and the box is still not ready, the failure is `WAKE_TIMEOUT` (`gbot wake` exits 4), not `WAKE_FAILED`. Calls for the same login share one wake. Aborting one waiter cancels that waiter at once. Aborting the last waiter drops the shared wake, so the next caller starts a fresh one. `GBOT_AUTO_WAKE=0` turns this off. Both `GROK_BOT_GATEWAY_URL` and `GROK_BOT_GATEWAY_TOKEN` together are never woken. Success is the call's own result. If waking fails, the error stays `code: "BOX_ASLEEP"` and adds `wake: { attempted: true, error }` and a short reason (`auto wake failed: …`). A 401 whose text says the version is no longer supported uses `wake.error` `CLIENT_VERSION_REJECTED` and keeps the version hint. If the one retry is still `BOX_ASLEEP`, the error has `wake: { attempted: true, woke: true }` and says the wake ran. A `sendPrompt` retry posts the same `clientNonce`. If that retry's delivery is unknown, it stays unknown: do not send again. Cancelling during the wake rejects the send (`delivery: "rejected"`, `reason: "cancelled"`) and does not resend. `gbot send --json` includes `wake` and `failureReason` when the error has them.

`x-cursor-client-version` is `SAND_CLIENT_VERSION` when that is `major.minor.patch` (`0.72.1.0` becomes `0.72.1`). Otherwise gbot reads the installed app: macOS `CFBundleShortVersionString` in `/Applications/Grok Bot.app` then `~/Applications`. On Windows it queries `reg.exe` by absolute path under `SystemRoot\System32`. It looks up uninstall key `8db316bb-b3e2-5dd2-9554-ecccb62be362` under HKCU, then HKLM, then HKLM WOW6432Node, then a narrow `reg query /f "Grok Bot" /d`. From that `/f` output gbot takes the `HKEY_…` key whose `DisplayName` matches `^Grok Bot(\s|$)`. The key path may contain spaces; gbot keeps the whole line and trims it. It queries that key with `/v DisplayVersion`, and if that query fails or the budget is gone, parses the version from the `DisplayName` suffix (`Grok Bot 0.72.1` becomes `0.72.1`). A `DisplayName` of `Grok Bot` with no version suffix still queries `DisplayVersion` on the full key. The whole lookup shares about a 3 second budget. Linux has no version lookup. Otherwise the built-in default is `0.72.1`. An invalid value uses `0.72.1` and does not read the app. The installed version is cached for the process. A 401 "no longer supported" drops that cache only when the cached value came from the installed app, not from `SAND_CLIENT_VERSION` and not from the built-in default, and at most once per 10 minutes. That 401 names the version gbot sent and that `SAND_CLIENT_VERSION` can override it. Live on 2026-10-21, `0.20.0` was rejected that way and `0.72.1` was accepted.

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

### Grok Bot 0.78.x: server-hosted bots

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
| `bots template` | `GetGrokBotTemplateForSourceAgent`; to create or update, `SendGrokBotUserMessage` with the `TEMPLATE_SHARE` initiator |

Since 0.11.2-iml1s.7, `bots create` calls `CreateGrokBotTemporalAgent` as the app does (the box gateway answered 404 on 0.78). `thread`, the tail that `reconcile` falls back to, the relay, `approvals list` and `approvals respond`, and the MCP thread tool read the transcript tail with `ListGrokBotTranscriptEntries` (`limit` N+1, newest page, oldest first; bodies left out of the page are read from the store, 8 at a time, and checked against their hash). A row whose body cannot be read is shown as `unreadable`, and a `--after` cursor stops before it so the next read gets it. `thread --root` and `skills` stay on the box gateway; the app has no backend call for a root thread.

A session has an access token when it comes from a saved app login (gbot already reads that token for EnsureSandBox), from a descriptor login whose account also has a saved access token, or from `CURSOR_ACCESS_TOKEN` when there is no app login. The token is sent only to `CURSOR_API_BASE_URL` (default `https://api2.cursor.sh`), with the same headers as EnsureSandBox (`SAND_CLIENT_VERSION` and `SAND_BOX_NAMESPACE` still apply). An app login token goes only to an https Cursor API host, and `GROK_BOT_ALLOW_ANY_GATEWAY` does not apply to it. `GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN`, and a descriptor login without a saved access token, have no access token and keep the gateway calls. On a 0.78.x host their sends get the 502 above.

Send delivery: `ACCEPTED_BOX`, `ACCEPTED_TEMPORAL`, and `DUPLICATE` (the same nonce again) are `accepted`. `REFUSED` is `rejected` with the server's `failureCode`. A 4xx is `rejected`, except 408, 499 (Connect `canceled`), and any answer whose Connect code is `canceled`, `deadline_exceeded`, `unavailable`, `unknown`, or `internal`: those may have landed. Those, a timeout, a transport failure, a 5xx, or `UNSPECIFIED` ask `GetGrokBotSendStatus` for the same nonce once: `ACCEPTED` makes it `accepted`, `REJECTED` makes it a new `rejected` error (`SEND_REFUSED`, the server's rejection code as `failureCode`), and anything else stays `unknown`. Server text in errors is redacted before it is cut to 300 characters. gbot never resends, and never sends through the gateway after a backend send was tried. The nonce is the backend `messageId`. `reconcile` asks `GetGrokBotSendStatus` first and returns its answer as `sendStatus`. `ACCEPTED` is `delivered` (`entryId` is the echoed entry). `REJECTED` is `rejected`, with `rejectionCode` when the server gives one. Otherwise gbot reads the last 200 transcript entries as before: the nonce there is `delivered`. When it is not there, only `NOT_FOUND` is `not-found-in-tail`. Every other answer (`PENDING`, `UNKNOWN_DURABILITY`, `UNSPECIFIED`, or a value newer than this build) is `pending`, and so is a status read that failed (`sendStatus: "UNAVAILABLE"`): the message may still land, so do not resend. When the server has such a status but the transcript cannot be read (the box is asleep or failing), the result is still `pending`, with `tailError`; with no status, or `NOT_FOUND`, the read error stands.

Roster: the server is the source of truth for every agent it lists, and `ListGrokBotAgents` also returns box-harness bots. gbot reads the box roster too, and adds a bot only when the server does not list it and its harness is not `temporal`. A `temporal` box row the server does not list is stale and is dropped. That read does not retry an asleep box (no wake on 417). On a saved login, a box answer of 401, 403, or "could not be routed" still rebuilds the session first, as for any box call, and that rebuild can wake the box. If the box roster cannot be read, the server roster stands alone (`GBOT_DEBUG` says why). A name is matched against the server's bots first by exact name or title. Then the folded rule matches either half of a server bot's `name · title`: the plain name or the title. If a server bot matches only by the folded rule while a box-only row matches exactly, gbot refuses with `Ambiguous name … Use the id.`, because they may be one bot or two. Box-only rows are used only when no server bot matches. A server row with no `agentId` is skipped, as the app does, and a box row whose id is a server bot's `agentId` or `legacyAgentId` is not added again.

Whether the server roster is on is decided as the app decides it: `GetGrokBotRuntimeCapabilities` with `capabilities.durableIdentityEnabled` true. It is off when that is false or missing, or when that call answers `failed_precondition`. gbot asks once per session. With the roster off, gbot uses the box roster, prints `gbot: the server roster is off for this login …` on stderr, marks each record `roster: "box"` in `--json` (bots and groups, `send`, `reconcile`), and sends, edits, deletes, and creates groups through the box gateway as before 0.78.x. Any other error from that call, and any error from `ListGrokBotAgents` itself, fails the command: a guessed roster could point a send or a delete at the wrong bot. If the server marks its list `truncated`, names do not resolve, because the bot meant may be past the cut, and box-only rows are left out; give the bot or group id instead. An empty or whitespace-only name is refused. `ListGrokBotAgents` shows a bot with a title as `name · title` with no title (rooms keep their title); the plain name still resolves when nothing matches exactly. A bot the box created with a title already has ` · title` in its stored name, so `bots update --title` alone adds a second one (live: `name · old · new`). Give `--name` and `--title` together to replace both. Notify and hidden come from `ListGrokBotAgentStatuses`. Like the app, gbot takes notify from a client state only once that state was written (`updatedAtMs` above 0); before that, and with no client state, it shows notify on and not hidden. If that read fails, the list leaves notify and hidden out instead of failing.

Rooms: `CreateGrokBotRoom` gets a fresh v4 uuid as `agentId`, and gbot keeps the id in the answer. After a timeout or a 5xx the group may exist; run `gbot groups list` before trying again. `UpdateGrokBotAgent` edits a room's name, description, title, and avatar (checked live). `groups create` checks `--avatar-shape` and `--avatar-color` before it creates anything, and sets the title and avatar with the room's server id from the answer. If that second step fails, the error gives the new group's id. The `SetGrokBotRoomMembers` answer must be the room asked for; any other answer is an error (`ROOM_MISMATCH`) that says the members may have changed.

`--notify` is also sent to the box (`setAgentNotifyOnUpdates`), as the app does. A failure there is ignored (`GBOT_DEBUG` says why).

Approvals: `approvals respond` follows the app's dispatcher. An auto-review card goes to `ResolveGrokBotAutoReviewApproval` with `agentId`, `requestId`, `resolution` (`GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_APPROVED` or `_DENIED`), and `approvalPlatform: "desktop"`; that request has no entry id. A local tool card goes to `ResolveGrokBotLocalToolPermission` with `agentId`, `entryId`, `requestId`, and `resolution` (`GROK_BOT_LOCAL_TOOL_PERMISSION_CARD_RESOLUTION_ALLOW_ONCE` or `_DENY`). A `refusal` in that answer is an error with `code: "APPROVAL_REFUSED"`, the server's `failureCode`, and `delivery: "rejected"`. gbot still grants once or declines only: the app's ALWAYS and NEVER are never sent, and a stale, foreign, or truncated card is refused before any call. This is mapped from the app and not live-tested: a real pending card is needed, and `approvals respond` refuses a made-up card before any network call. A session without an access token still resolves cards on the box. Like the app, an auto-review card of a bot whose harness is not `temporal` goes to the box gateway, and a local tool card of such a bot moves on to the box gateway when the backend answers `unimplemented`. The answer carries `via` (`backend` or `box`). A backend answer is `delivery: "accepted"` only with `dispatched: true`; otherwise it is `delivery: "unknown"` with a note to check the card in the app. The app itself treats any answer without a refusal as done.

`connectGateway` still runs EnsureSandBox, and may wake the box, before a command that only needs the backend.

### Fork commands

`--stdin` (default `false`):

```sh
printf %s 'Exact UTF-8 message' | gbot send Researcher --stdin --json
```

Windows PowerShell, UTF-8 and no extra newline:

```powershell
node -e "process.stdout.write('Exact UTF-8 message')" | gbot send Researcher --stdin --json
```

Do not combine `--stdin` with a positional message. The text must be non-empty UTF-8, at most 64 KiB, with no NUL and no surrounding whitespace. A UTF-8 BOM or a UTF-16 BOM is accepted and removed. A trailing CR, LF, or CRLF is surrounding whitespace and is rejected. A CR LF between lines is kept.

Success JSON includes `delivery` (`accepted` or `unknown`), `kind` (`bot` or `group`), `exitCode: 0`, and `result`. `delivery: "accepted"` means the backend confirmed the send (see Grok Bot 0.78.x above), or, for a session without an access token, the gateway did (`{"accepted": true}` or a message id). `delivery: "unknown"` means the CLI cannot prove the send landed (timeout, network failure, HTTP 408 or 5xx, or a response with neither). Do not send again. The result carries the `clientNonce` it posted: `gbot reconcile <bot> --nonce <clientNonce>` looks for it in the last 200 transcript entries (`delivered` or `not-found-in-tail`) and never resends.

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
```

gbot reads `GetGrokBotTemplateForSourceAgent` for the bot. With no template it sends the bot the app's message `Create a public template of yourself that I can share with somebody else`; with one, `Update the shared template of yourself.` The message goes through `SendGrokBotUserMessage` with `initiator: "GROK_BOT_USER_MESSAGE_INITIATOR_TEMPLATE_SHARE"` and the send delivery rules in Grok Bot 0.78.x above, and the bot builds the template on the server. gbot then reads the template every 10 seconds until one appears (or, for an update, one with a newer `updatedAtMs`), for at most `--wait` seconds (default 600; `0` does not wait). The link `https://x.ai/bot/<shareId>` is printed on its own line. `--json` gives `action` (`created` or `updated`), `delivery`, `clientNonce`, and `template` (`shareId`, `link`, `name`, `published`, `visibility`, `activeVersion`, `updatedAtMs`). Exit 0: the template was seen. Exit 3: the message was accepted or its delivery is unknown, but no template appeared within `--wait` (`template: null` and a `hint`); check later with `gbot bots template <bot> --status`. gbot never sends the message again; running the command again asks the bot again. Exit 1: the message was rejected, or nothing was sent. `--status` sends nothing; it returns `template` (or `null`, "no template yet"), `hasTeam`, and `exportPolicy` when the server gives one. Templates are for server-hosted bots (the app has no box path for them): a box-only bot, a login whose server roster is off, a group, and a session without an access token are refused before anything is sent.

### Move a bot to Hermes, Muse or Your dot (`gbot migrate`)

Run `gbot migrate` in a terminal and follow the prompts, or use `gbot migrate bots|capture|preview|import|check|run`. It captures the whole bot read-only (every transcript page, all memory tiers, the skill library, routines, open tasks, needed files), imports it, reads the destination back and asks the migrated agent acceptance questions. Details, destination differences and limits: [docs/migration.md](docs/migration.md).

### Pair a Wear OS watch (`gbot wear pair`)

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

### Exit codes and common errors

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Command finished. A send can be `delivery: "unknown"` and still exit 0. | If delivery is unknown, read the thread. Do not resend. |
| 1 | Usage error or gateway failure. Send failures are JSON on stdout with `exitCode: 1`. | Read `error` / `code`. Fix the flag or the login. |
| 2 | Unknown option, including `--account` before the subcommand. | Put `--account` after the subcommand. |

`bots template` also uses 3: the message went out (or its delivery is unknown) but no template appeared within `--wait`. Run `gbot bots template <bot> --status` later instead of sending again.

`--normalized` without `--json` throws `--normalized requires --json.` Other commands print the error on stderr.

### Safety

Do not put tokens, account keys, or message text into tickets or shell history. History is off unless `GROK_BOT_HISTORY=on`. Do not resend after `delivery: "unknown"`. Do not ask a bot to delete files, message other people, buy anything, or change account settings unless you mean that exact action. Codex and Claude channel commands need a local Unix socket; upstream rejects them on Windows (`windows-unsupported` / no Unix sockets).

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `bots list`, `send`, or `thread` says no Grok Bot login, or that no agents directory was found | Sign in once in the Grok Bot app as the same OS user, then run `gbot accounts`. `gbot doctor` shows where it looked. |
| Several logins, no choice | `gbot accounts`, then `--account "<label>"` after the subcommand, set `GBOT_ACCOUNT`, or `gbot accounts default <alias>`. `gbot doctor` and `gbot wear pair` ignore that default. |
| `Unknown option: --account.` | Put `--account` after the subcommand. |
| Linux: `secret-tool` not found | Install `libsecret-tools` (Debian/Ubuntu) or `libsecret` (Fedora/Arch), unlock the keyring, and try again. |
| `delivery: "unknown"` | `gbot reconcile <bot> --nonce <clientNonce>`, or read the thread. Do not send again. |
| `Relay profile mismatch` on a pinned `GROK_BOT_RELAY_DIR` | That directory was written for a different account or environment, or by an older version. A profile can change for reasons other than an upgrade. Run again with the same account and environment to keep it. Managed commands show this error themselves, including when the worker is already stopped, and when a still-running worker only replies `Relay profile mismatch`; the message includes the upgrade steps. If an older version wrote it, with the old version run `gbot codex bridge stop --worker`, then move or rename the directory (or pick a new one) and bind again. A pinned directory keeps the same socket path. A still-running old worker rejects the hello; the new CLI does not stop it. There is no pid file. Before upgrading, the old version's `bridge status` includes `worker.pid`. Otherwise stop the process that has the directory's `control.sock` or `worker.lock` open (`lsof -t <dir>/worker.lock`). The default directory's socket path does change with the profile hash. Default-directory state from the old version remains in `~/.grok-bot-cli/relay/<old hash>`. |
| `gbot` not found after install | Open a new terminal. Check that `npm prefix -g` (its `bin` folder on macOS/Linux) is on PATH. |
| `... failed: 417 ...`, `code: "BOX_ASLEEP"` | The Grok Bot box for that login is asleep. Live on 2026-10-20 the proxy answered 417 with an empty body and `x-anyrun-failure-reason: pod_hibernated`; a 417 without that header can also be `BOX_ASLEEP`, while a 417 with another proxy reason is not; the error carries the proxy reason as `failureReason`. gbot tries to wake the box itself. Only `listAgents`, `getAgentThread`, `getAgentTranscriptTail`, and `getAgentWorkflows` wake on a bare 417. Every other method, including `sendPrompt`, is resent only when that 417 has sleep evidence (`failureReason` `pod_hibernated`, or a `failureCode` matching sleep or hibernation). If waking fails, the message says why (`auto wake failed: …`, and `wake.error`). A 401 "no longer supported" during the wake is `CLIENT_VERSION_REJECTED` and names the version. If the retry is still asleep, `wake` is `{ attempted: true, woke: true }`. You can still open the Grok Bot app and select a bot of that login. Switching the app to that login was also observed to wake the box on 2026-10-20 (one owner session); that is an observation, not a rule. Opening the app or a bare `grokbot://` in the background (`open -g`) did not wake it. `GBOT_AUTO_WAKE=0` skips the automatic wake. `gbot wake` does the same wake and prints the run state, and exits 2 when both gateway override variables are set. gbot reaches EnsureSandBox through `CURSOR_ACCESS_TOKEN` only when there is no usable app login and not both `GROK_BOT_GATEWAY_URL` and `GROK_BOT_GATEWAY_TOKEN` are set. |
| `Gateway response too large (over N bytes)` | Set `GBOT_MAX_RESPONSE_BYTES` to a byte count from 65536 to 67108864 (default 16 MiB) and retry. Other values are ignored; the error says so. |
| `EnsureSandBox failed: 4xx` | `{ "wake": true }` with an app login token was verified live on macOS on 2026-10-21 (hibernated to `RUNNING` in about 10 seconds). `x-cursor-client-version` `0.20.0` is rejected with 401 "no longer supported"; the default is `0.72.1`, and `SAND_CLIENT_VERSION` overrides it. That 401 names the version gbot sent. The Linux and Windows saved-login token paths, and the Windows registry lookup, are implemented and have not been live-tested. The registry values listed above were read live; gbot's lookup was not run there. |

### Privacy

- `gbot` talks only to the Cursor backend and the Grok Bot gateway URL the app saved (or `GROK_BOT_GATEWAY_URL`). It sends no telemetry.
- `gbot wear pair` also connects to the watch address you type, on your local network, and sends it the selected login's gateway session, encrypted to that pairing. Nothing else does.
- It reads the Grok Bot app's encrypted gateway descriptor and, to wake an asleep box, `sand-secrets.json` in the same directory. It decrypts the saved access token with the OS secret store (Keychain, `secret-tool`, or DPAPI). The secrets file is parsed whole. gbot never decrypts or uses the refresh token, never writes an app file, and never prints tokens. The app login token is sent only to an https Cursor API host. `GROK_BOT_ALLOW_ANY_GATEWAY` does not change that.
- It writes nothing unless you turn history on. `GROK_BOT_HISTORY=on` appends plain-text messages to `~/.grok-bot-cli/history.jsonl` (or `GROK_BOT_HISTORY_DIR`). Delete that file to remove it.
- Uninstalling the package leaves the app login untouched; sign out in the Grok Bot app to remove it.

### Related projects / 相關專案

- trinity-cli — one CLI over three always-on agents (Your dot, Grok Bot, Muse): https://gitlab.com/aa22396584/trinity-cli
- chatgpt-dot-cli — ChatGPT Your dot: https://gitlab.com/aa22396584/chatgpt-dot-cli
- grok-bot-cli (this fork, `gbot`) — Grok Bot: https://gitlab.com/aa22396584/grok-bot-cli
- muse-web-cli — Meta Muse via the web: https://gitlab.com/aa22396584/muse-web-cli

Use this fork with trinity-cli: https://gitlab.com/aa22396584/trinity-cli

### Platforms

| OS | Node.js | Status | Evidence |
| --- | --- | --- | --- |
| macOS | 22.19+ (22.x) or 24.2+ | Supported | Checked locally: unit, route, and type checks |
| Linux | 22.19+ (22.x) | Supported | GitLab CI (`node:22-slim`): 696 tests, 671 pass, 0 fail, 25 skip (23 need Python; 2 use macOS-shaped descriptors) |
| Windows | 22.19+ (22.x) or 24.2+ | Supported except Codex/Claude channels and the relay | GitLab CI and isolated full CI script: 696 tests, 386 pass, 0 fail, 310 platform skips |

CI uses GitLab.com runners by default. Maintainers can point jobs at their own runners by setting the CI/CD variables `LINUX_RUNNER_TAG` and `WINDOWS_RUNNER_TAG`. Linux unit tests run in CI (`node:22-slim`). Windows unit tests run when that runner is available. macOS is checked locally. Both jobs pass the same `test/*.test.js` list to `node --test`. Tracked text stays LF (`.gitattributes`), so a Windows checkout does not rewrite plugin command frontmatter to CRLF. The Windows unit job loads the MCP client with a `file://` URL because Node rejects a `C:` path in `import()`. Upstream Codex and Claude sockets stay Unix-only.

### Account profile verification (2026-10-22)

[MR !7](https://gitlab.com/aa22396584/grok-bot-cli/-/merge_requests/7), source `c7f18c6b7fbe4a982097eb58c64471c6eb6a7f62`, merged as `74704f554227fe71641af924b17ddadc3859e019`; both commits have the same Git tree. On macOS, the unit suite passed 695/695 and the route suite passed 94/94. Source validation, artifact build/validation, typecheck, and the three release configuration checks passed. MR !7 rounds 2–3 and MR !8 were reviewed only by that session's own reviewer. That is not an independent approval of this release. Claude and agy review attempts were blocked by quota/credits and supplied no approval. Codex was not available. A later pre-release review of `c2a5d2d` by two Opus reviewers asked for the changes in this round. This note does not claim approval for this round; the maintainer updates it after the re-review.

Linux passed on both the [source pipeline](https://gitlab.com/aa22396584/grok-bot-cli/-/pipelines/2974528600) and the [merged-main job](https://gitlab.com/aa22396584/grok-bot-cli/-/jobs/17368454058): 695 tests, 670 pass, 0 fail, 25 environment skips. The final runtime candidate passed 696/696 unit tests and 94/94 route tests on macOS. An isolated Windows run of the full CI script passed: 696 tests, 386 pass, 0 fail, 310 platform skips. With the normal `APPDATA` preserved, it detected that Node 24.1 lacks `import.meta.main`, downloaded Node 22.23.4, verified its SHA-256, and completed install, build, and tests; the job-owned runtime directory was removed. The fixture environments now isolate both `APPDATA` and `XDG_CONFIG_HOME`. The original protected `hx370` GitLab runner was offline during initial validation, and the optional hosted job exhausted its CI quota. The same runtime fixes at `113e1c671eaf882b792888416260468f47d331b1` also passed [pipeline 2974718228](https://gitlab.com/aa22396584/grok-bot-cli/-/pipelines/2974718228): [Linux job](https://gitlab.com/aa22396584/grok-bot-cli/-/jobs/17369336982), 696 tests / 671 pass / 0 fail / 25 skip; [Windows job](https://gitlab.com/aa22396584/grok-bot-cli/-/jobs/17369336988), 696 tests / 386 pass / 0 fail / 310 skip. Both jobs ran on temporary project runners; the original pending main Windows job was canceled as superseded, rather than counted as passing.

These checks use synthetic account fixtures. They do not prove a live account switch, Windows saved-login decryption, or a PowerShell installer run; the PowerShell installer checks remain static. No global CLI installation or npm publication was performed.

### Windows limitations

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

## 繁體中文

### 聲明

非官方專案。這個 fork 與 xAI、Cursor（Anysphere）或上游作者沒有關係，也沒有得到他們的背書或支援。「Grok」與「Grok Bot」屬於各自的所有者。`gbot` 用你自己的 Grok Bot 登入和未公開的 gateway，隨時可能改變或失效。自動化使用可能受 Grok Bot 條款限制，請自行確認，風險自負。fork 的問題回報到這裡，不要回報給上游。

### 安裝

使用 Node.js 22.19+（22.x）或 24.2+，且同一個作業系統使用者已在 Grok Bot 桌面版登入一次。產生的 CLI 使用 [`import.meta.main`](https://nodejs.org/api/esm.html#importmetamain)；Node 23 與 Node 24.0–24.1 沒有此功能，啟動器會以非零結束碼與版本說明拒絕執行。GitLab（https://gitlab.com/aa22396584/grok-bot-cli）是主要遠端。

不要用 `npm install -g git+https://gitlab.com/...`。npm 會結束碼 0，但 `gbot` 是斷掉的連結。改下載 `v0.11.2-iml1s.7` 附的套件檔再安裝。

macOS 或 Linux：

```sh
curl -fsSL -o grok-bot-cli-0.11.2.tgz "https://gitlab.com/-/project/86401528/uploads/3562acc9b72ba4f1f433acbb01d58c08/grok-bot-cli-0.11.2.tgz"
npm install -g ./grok-bot-cli-0.11.2.tgz
rm -f grok-bot-cli-0.11.2.tgz
```

Windows PowerShell：

```powershell
irm "https://gitlab.com/-/project/86401528/uploads/3562acc9b72ba4f1f433acbb01d58c08/grok-bot-cli-0.11.2.tgz" -OutFile grok-bot-cli-0.11.2.tgz
npm install -g .\grok-bot-cli-0.11.2.tgz
Remove-Item grok-bot-cli-0.11.2.tgz
```

Windows 上 npm 會建立 `gbot.cmd`，PowerShell 與 cmd 都能執行 `gbot`。

從本機 clone。`dist/` 不在 git 裡，要先建置再 link：

```sh
npm ci
npm run build
npm link
```

要在另一台機器安裝或還原這個 fork，又不要用 `git+https`，用 `scripts/install-fork.sh`（macOS／Linux）或 `scripts/install-fork.ps1`（Windows）。說明在[切換登入，以及在另一台機器還原 gbot](#切換登入以及在另一台機器還原-gbot)。shell 腳本用 PATH 上的假 `git`、`npm` 與 `gbot` 測過。PowerShell 腳本是讀過內容檢查的。兩邊都沒有對 GitLab 實際執行。

### 確認、升級、移除

```sh
gbot --version
```

輸出是 `gbot 0.11.2`，這是上游套件版本，不是 fork 標籤。

升級就再下載同一個 `.tgz` 後安裝。移除：

```sh
npm uninstall -g grok-bot-cli
```

若用 `npm link`，在 clone 裡執行 `npm unlink -g grok-bot-cli`。

固定 `GROK_BOT_RELAY_DIR` 的 profile 和這次行程不同時，會以 `Relay profile mismatch` 拒絕啟動。profile 含帳號、gateway／token、執行緒限制、DISPLAY／DBUS，所以不只有升級會變。若只是換了帳號或環境，用原來的設定再跑一次。managed 命令會在呼叫端自己顯示這個錯誤，worker 已經停了也一樣；還在跑的舊 worker 若只回 `Relay profile mismatch`，呼叫端仍會顯示升級步驟。它不會收編舊的 binding，也不會繼續跑。若是舊版寫的，升級順序：

1. 用**舊版**執行 `gbot codex bridge stop --worker`。
2. 把那個目錄移走或改名，或改用新目錄。
3. 重新 bind。

預設目錄裡的舊狀態留在 `~/.grok-bot-cli/relay/<舊的 hash>`。固定目錄的 socket 路徑只由目錄決定，升級後相同。`bridge stop` 會連到還在跑的舊 worker，那個 worker 以 `Relay profile mismatch` 拒絕 hello，新 CLI 停不掉它。預設目錄的 socket 路徑會跟著 profile hash 改變，所以 `bridge stop` 碰不到那個舊 worker。沒有 pid 檔。升級前，舊版的 `gbot codex bridge status` 輸出裡有 `worker.pid`。目錄裡有 `control.sock`（路徑太長時在 `/tmp/gbot-relay-<uid>/<hash>/control.sock`）和 `worker.lock`。若 worker 還在跑，停掉正開著這兩個檔案的行程（`lsof -t <dir>/worker.lock`），再移走目錄。登入解析失敗時，`bridge status` 會列出看得到的狀態目錄，不會自己挑一個。這時 `bridge stop` 必須把 `GROK_BOT_RELAY_DIR` 指到你要停的那個目錄。不合法的 `GBOT_ACCOUNT_SCOPE` 仍會丟錯，不會去列出別的 worker。啟動 worker 維持 fail-closed。

### 登入與多個登入

`gbot` 讀取 App 已加密的 gateway descriptor，不會自己開瀏覽器。

| 系統 | 工作階段位置 | 密鑰 |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Grok Bot` | 鑰匙圈 `Grok Bot Safe Storage` |
| Linux | `$XDG_CONFIG_HOME/Grok Bot` 或 `~/.config/Grok Bot` | `secret-tool`（套件 `libsecret-tools`）；basic-text v10 除外 |
| Windows | `%APPDATA%\Grok Bot` | 透過 PowerShell 的 DPAPI（`Local State`） |

沒有 `--account`、`GBOT_ACCOUNT` 或設定檔預設時，gbot 用 descriptor 裡唯一的一筆，否則用唯一標成 app-active 的那筆，再否則用唯一的已存登入。剩下多筆又沒選擇會失敗並列出標籤。明確選擇器對不到就失敗，不會改用別的登入。`gbot doctor` 與 `gbot wear pair` 不用設定檔預設。

```sh
gbot accounts
gbot bots list --account "<label>"
```

```sh
export GBOT_ACCOUNT="<label>"   # PowerShell: $env:GBOT_ACCOUNT = "<label>"
gbot doctor
```

`--account` 覆寫 `GBOT_ACCOUNT`，`GBOT_ACCOUNT` 再覆寫設定檔的預設。旗標必須寫在子命令後面。`gbot --account <label> bots list` 會以結束碼 2 結束，並顯示 `Unknown option: --account.`

`gbot accounts` 列出每一個已登入的帳號與每一筆 descriptor。它不印 token。完整規則在下一節。

`gbot accounts --json` 的形狀是 `{ "accounts": [{ "id", "label", "savedAtMs", "lastSaved", "usable", "email", "alias", "appActive", "hasDescriptorEntry" }] }`。舊欄位保留。沒有 email 或別名時，那兩個欄位是 `null`。

### 切換登入，以及在另一台機器還原 gbot

桌面版把目前顯示的登入放在 `gateway-descriptor.json`。每一個已登入的帳號都留在 `sand-secrets.json` 的 `cursor-accounts`。App 切換登入之後，另一個登入可能從 descriptor 消失。gbot 仍會列出它。若那個登入沒有 descriptor 項目，gbot 用已存的 access token 在記憶體裡建立 gateway 工作階段：先送 EnsureSandBox `{ "wake": false }`，除非雲端電腦已經是 `RUNNING` 而且回答帶有 gateway 欄位，否則再送 `{ "wake": true }`。這個工作階段不會寫回磁碟。refresh token 不會被解密。App token 只送到 https 的 Cursor API 主機。

`gbot accounts` 把 App 目前的登入標成 `(app active)`。沒有 descriptor 項目的登入標成 `(no app session; gbot builds one from the saved login)`。有 descriptor 標籤時，標籤就是那個標籤；否則是解密後個人資料裡的 email，解不開時用 scope 的前 8 個十六進位字元。email 和標籤不同時，email 另起一行。別名另起一行。

替登入取名，需要的話設成預設。這些是 `gbot accounts` 的參數（這個打包器不能同時把 `accounts` 做成命令群組）：

```sh
gbot accounts alias work owner@example.com
gbot accounts default work
gbot accounts unalias work
gbot accounts default --clear
```

別名符合 `^[A-Za-z0-9_-]{1,32}$`。選擇器可以是別名、email（不分大小寫）、descriptor 標籤，或至少 8 個十六進位字元的 id／scope 前綴。對到一個以上時，錯誤形式與以前相同。

會吃 `--account` 的 gateway 命令（`gbot send`、`gbot wake` 等）依序使用：同時設了 `GROK_BOT_GATEWAY_URL` 與 `GROK_BOT_GATEWAY_TOKEN` 時用那組；否則 `--account`、`GBOT_ACCOUNT`、設定檔的 `default`。沒有選擇器時，用 descriptor 的唯一一筆，否則唯一的 app-active，再否則唯一的已存登入。剩下多筆就是錯誤。只存在已存登入、被明確選到，或它是唯一登入時，才會用它。`CURSOR_ACCESS_TOKEN` 只在沒有 app 登入，或那個隱含登入解不開或已過期時才用。明確選擇器失敗、不支援的 descriptor 版本、選到不能用的登入，以及其他後端錯誤，都不會改用別的帳號。`gbot doctor` 會解析 `--account` 或 `GBOT_ACCOUNT`，不用設定檔預設。`gbot wear pair` 仍只送 descriptor 裡的工作階段。它的 `--account` 接受別名、email、標籤或 id，仍忽略 `GBOT_ACCOUNT` 與設定檔預設。只存在於 `sand-secrets.json` 的登入不會被送到手錶。`GBOT_ACCOUNT_SCOPE` 是 gbot 給自己的 relay 與 MCP worker 設的內部變數，必須剛好是 64 個小寫十六進位字元；設了就蓋過 `GBOT_ACCOUNT` 與設定檔預設，其他值是錯誤。

設定檔只有別名與預設，沒有 token。macOS 與 Linux 是 `$XDG_CONFIG_HOME/grok-bot-cli/config.json`；沒設 `XDG_CONFIG_HOME` 時是 `~/.config/grok-bot-cli/config.json`。Windows 是 `%APPDATA%\grok-bot-cli\config.json`。`GBOT_CONFIG` 可以改路徑。`gbot config path` 印出路徑。檔案模式是 0600，只有 alias、default 或 import 寫入時才會建立。

匯出與匯入把這些名字搬到另一台機器。匯出包含 email，因為還原時要對到同一個登入。它不含 token。把這個檔案放在密碼管理器（或你已經用來放帳號名稱的地方）。不要提交進 git。

```sh
gbot config export --out gbot-accounts.json
gbot config import gbot-accounts.json
gbot config import gbot-accounts.json --replace
```

匯入預設依名稱合併；`--replace` 會換掉整份別名與預設。結束碼：0 已匯入且每個別名的 scope 在這台機器都已登入；2 用法錯誤或檔案不合法（不會寫入）；3 已匯入，但至少一個別名的 scope 不在這台機器的 `cursor-accounts`。後者會對每個缺少的登入印出 `sign in to <email> in the Grok Bot app`。先在 App 登入那個帳號，再執行 gbot。這些結束碼是用合成測試資料檢查的，不是用真實匯出檔。

在新機器上先安裝 fork，再匯入。不要用 `npm install -g grok-bot-cli`，也不要用 `git+https`（那會留下斷掉的 `gbot` 連結）。

```sh
scripts/install-fork.sh --config gbot-accounts.json
# Windows: scripts/install-fork.ps1 -Config gbot-accounts.json
scripts/install-fork.sh --dry-run --config gbot-accounts.json v0.11.2-iml1s.7
```

腳本把 `https://gitlab.com/aa22396584/grok-bot-cli.git` clone 到 `$XDG_CACHE_HOME/grok-bot-cli/src`（預設 `~/.cache/grok-bot-cli/src`；Windows 是 `%LOCALAPPDATA%\grok-bot-cli\src`）。`--config` 會先變成絕對路徑，再換目錄。ref 只能含 `[A-Za-z0-9._/-]`，不能以 `-` 開頭，並在 `--` 之後傳給 git。`-- v1.2` 不會改裝 `main`。腳本從遠端取出該 ref，確認解析出的 commit 符合 `^[0-9a-f]{40}([0-9a-f]{24})?$`，再用 `git checkout --detach <sha>`（不加路徑分隔的 `--`）檢出，印出它，並拒絕髒的 cache。`npm pack` 只會寫入 checkout 外由安裝程式建立的私有暫存目錄，並在結束時清除該目錄；安裝程式不會刪除未知的 cache 檔案。若 cache 含舊安裝程式留下的 `.tgz`，腳本會原樣保留並拒絕該 cache；請保留或移開舊 cache，使用乾淨的 cache 位置。它只安裝這次 `npm pack` 剛印出的檔案。需要 `npm ci` 是因為 `npm pack` 會跑 `agent-bundle prepack`，用已提交的 `artifact/` 填 `dist/`。接著執行 `gbot --version` 與 `gbot accounts`（accounts 失敗不會跳過 import）；有 `--config` 時執行 `gbot config import`；每個別名再跑 `gbot wake --check --account <別名>`。import 或 wake 失敗會以非 0 結束。import 回報尚未登入時，會跳過那些別名的 wake 檢查、仍檢查其餘別名，並以 3 結束。以 root 或 Administrator 執行會拒絕，除非加上 `--allow-root`（PowerShell 是 `-AllowRoot`）。`--dry-run` 與 PowerShell `-DryRun` 只印步驟，不跑 git 或 npm。腳本不儲存、也不印 token。`scripts/install-fork.sh` 可執行。

這次測了什麼：在 POSIX 主機用真實 git 對本機 `file://` bare repository 執行 shell 腳本（檢出取回的 commit，並跑到 `npm ci`；`npm` 與 `gbot` 是假的），也用 PATH 上的假 `git`、`npm` 與 `gbot` 測過相對的 `--config`、連續兩次乾淨 cache 安裝、拒絕舊 tarball 並逐位元組保留內容、被拒絕的 ref、失敗的步驟、`checkout --detach --` 回 128，以及 import 結束碼 3 時跳過缺少的別名。PowerShell 腳本只做靜態檢查：步驟一致、每個原生呼叫後檢查 `$LASTEXITCODE`、在 `exit 2` 前用 `[Console]::Error.WriteLine`、拒絕 `checkout --detach --`、不寫固定輸出檔，並使用私有打包目錄；測試主機沒有 PowerShell，因此未執行其 runtime 測試。腳本沒有對 GitLab 實際執行。同一個行程裡的兩個帳號是用合成 fixture 檢查的，不是實機切換。

### 喚醒睡眠中的雲端電腦（`gbot wake`）

已存 app 登入的 gateway 呼叫若失敗且 `code` 為 `"BOX_ASLEEP"`，gbot 會喚醒那個登入的雲端電腦，並把原本的呼叫重試一次；下面列出的唯讀方法以外、又沒有睡眠證據的呼叫除外。它讀 app 為那個登入存下的 access token（帳號 id 與 gateway descriptor 的 entry 相同）。secrets 檔會整份解析；gbot 不會解密或使用 refresh token，也不寫任何 app 檔案。它只對 https 的 Cursor API 主機（`*.cursor.sh`／`*.cursor.com`）送 EnsureSandBox `{ "wake": true }`。`GROK_BOT_ALLOW_ANY_GATEWAY` 不適用於這個 app 登入 token，但仍適用於使用者提供的 `CURSOR_ACCESS_TOKEN`。測試模式仍只允許 loopback。

`sendPrompt` 只有在 417 帶有睡眠證據時才會喚醒並重送。只有這些唯讀方法會在沒有 proxy 原因、也沒有 failureCode 的 bare 417 上喚醒並重試：`listAgents`、`getAgentThread`、`getAgentTranscriptTail`、`getAgentWorkflows`。這四個是僅有的唯讀 gateway 方法。其他方法只有在有明確睡眠證據時才會喚醒並重試：`failureReason` 是 `pod_hibernated`，或 `failureCode` 符合 sleep／hibernat。沒有這些的 417 仍是 `BOX_ASLEEP`（標籤與提示不變），不會重送。

輪詢涵蓋 `STARTING`、沒有 gateway 欄位的 `RUNNING`，以及仍帶 gateway 欄位的 `unknown`（帶 gateway 的 `unknown` 不算就緒）。每一次 EnsureSandBox 使用約 90 秒預算裡剩下的時間，而且最多 30 秒。輪詢是約每 3 秒送 `{ "wake": false }`。若 `{ "wake": true }` 仍是 `HIBERNATED`，gbot 先等輪詢間隔與剩餘時間中較短的那個，再送一次 `{ "wake": true }`，然後以 `WAKE_FAILED` 失敗，不再輪詢。若第二次回答仍是 `HIBERNATED` 而且預算已經用完，錯誤是 `WAKE_TIMEOUT`，不是 `WAKE_FAILED`。若某次 EnsureSandBox 碰到自己的呼叫期限而預算還有剩，gbot 會用剩下的時間繼續輪詢。預算用完而雲端電腦仍未就緒時，錯誤是 `WAKE_TIMEOUT`（`gbot wake` 結束碼 4），不是 `WAKE_FAILED`。同一個登入的並行呼叫共用一次喚醒。中止其中一個等待者會立刻取消那一個；最後一個等待者中止時，共用的喚醒會被拿掉，下一個呼叫者會重新開始。`GBOT_AUTO_WAKE=0` 關閉這件事。同時設了 `GROK_BOT_GATEWAY_URL` 和 `GROK_BOT_GATEWAY_TOKEN` 的工作階段不會被喚醒。成功時回的是該呼叫自己的結果。喚醒失敗時，錯誤仍是 `code: "BOX_ASLEEP"`，並加上 `wake: { attempted: true, error }` 與一句短原因（`auto wake failed: …`）。401 若寫版本已不再支援，`wake.error` 是 `CLIENT_VERSION_REJECTED`，並保留版本提示。若那一次重試仍是 `BOX_ASLEEP`，錯誤的 `wake` 是 `{ attempted: true, woke: true }`，並說明喚醒已跑過。`sendPrompt` 的重試使用同一個 `clientNonce`。若那次重試的 delivery 是 unknown，就維持 unknown：不要再送一次。喚醒途中取消會拒絕送出（`delivery: "rejected"`、`reason: "cancelled"`），不會重送。`gbot send --json` 在錯誤帶有 `wake` 與 `failureReason` 時會把它們印出來。

`x-cursor-client-version` 在 `SAND_CLIENT_VERSION` 是 `major.minor.patch` 時用那個值（`0.72.1.0` 會變成 `0.72.1`）。否則讀已安裝的 app：macOS 先看 `/Applications/Grok Bot.app` 再看 `~/Applications` 的 `CFBundleShortVersionString`。Windows 以絕對路徑執行 `SystemRoot\System32\reg.exe`，先查解除安裝鍵 `8db316bb-b3e2-5dd2-9554-ecccb62be362`（HKCU，然後 HKLM，然後 HKLM WOW6432Node），再以較窄的 `reg query /f "Grok Bot" /d` 搜尋。gbot 從那份 `/f` 輸出取出 `DisplayName` 符合 `^Grok Bot(\s|$)` 的 `HKEY_…` 鍵。鍵路徑可以含空白；gbot 保留整行並去掉首尾空白。再用 `/v DisplayVersion` 查那支鍵；若那次查詢失敗或預算已經用完，就從 `DisplayName` 尾端解析版本（`Grok Bot 0.72.1` 變成 `0.72.1`）。`DisplayName` 只有 `Grok Bot`、沒有版本尾碼時，仍會對完整的鍵查 `DisplayVersion`。所有查詢共用約 3 秒預算。Linux 不查版本。再不然內建預設是 `0.72.1`。不合法的值用 `0.72.1`，而且不去讀 app。已安裝版本會在這個行程裡快取。401「不再支援」只有在快取值來自已安裝的 app 時才會丟掉快取（不是 `SAND_CLIENT_VERSION`，也不是內建預設），而且 10 分鐘內最多重讀一次。那個 401 會標出 gbot 送出的版本，以及可以用 `SAND_CLIENT_VERSION` 覆寫。2026-10-21 實測：`0.20.0` 被這樣拒絕，`0.72.1` 被接受。

gbot 只有在沒有可用的 app 登入，而且並非同時設了 `GROK_BOT_GATEWAY_URL` 與 `GROK_BOT_GATEWAY_TOKEN` 時，才會經由 `CURSOR_ACCESS_TOKEN` 呼叫 EnsureSandBox。那條路用同一個 client 版本、`{ "wake": true }`，以及同樣約 90 秒的輪詢，包含 `STARTING`。若那次喚醒結束時沒有 gateway 欄位、也沒有 run state，錯誤會說這個 auth 可能是 dashboard API key。`GROK_BOT_ALLOW_ANY_GATEWAY` 仍適用於這個使用者提供的 token。

以 app 登入 token 送 `{ "wake": true }` 已在 2026-10-21 於 macOS 實測：睡眠中的雲端電腦約 10 秒變成 `RUNNING`，約 3 秒後用新的 gateway 呼叫 `listAgents` 得到 200。同一天，喚醒之後一個新行程以 app descriptor 存下的 gateway 工作階段、並設 `GBOT_AUTO_WAKE=0`，可以列出 bots。那次儲存的 gateway 網址與 token 在休眠後仍有效。這是觀察，不是保證。Linux 的已存登入 token 路徑有實作，尚未實測。Windows 的已存登入 token 路徑與登錄查詢有實作，尚未實測；例外是登錄值本身已在 2026-10-21 於 Windows 機器讀過：鍵 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\8db316bb-b3e2-5dd2-9554-ecccb62be362`，`DisplayName` `Grok Bot 0.72.1`，`DisplayVersion` `0.72.1`，`Publisher` `SpaceXAI`，安裝目錄 `D:\APP\Grok Bot`。gbot 的 `reg.exe` 查詢沒有在那台機器上跑過。

```sh
gbot wake
gbot wake --account "<標籤>" --json
gbot wake --check
```

`--check` 送 `{ "wake": false }`，印出執行狀態（`RUNNING`、`HIBERNATED`、`STARTING` 或 `unknown`），不喚醒。沒有 `--check` 時，gbot 會喚醒、等到 `RUNNING`（約 90 秒），然後列出 bots 一次。文字是帳號標籤、前後狀態，以及花費秒數。有 gateway 欄位、沒有 runState 的舊版 EnsureSandBox 回答算就緒，`after` 是 `RUNNING`。它不印 token、gateway 網址或 network token。`--account` 是已存的標籤或 id，會覆寫 `GBOT_ACCOUNT`。若同時設了 `GROK_BOT_GATEWAY_URL` 與 `GROK_BOT_GATEWAY_TOKEN`，`gbot wake` 以結束碼 2 結束，並印出 `gbot wake uses the saved app login; unset the override`。它不會喚醒覆寫的 gateway。

| 結束碼 | 意義 |
| --- | --- |
| 0 | 正在執行，或 `--check` 成功。 |
| 2 | 用法：不認識的旗標、多個登入且 `--account` 沒有選到一筆，或同時設了 `GROK_BOT_GATEWAY_URL` 與 `GROK_BOT_GATEWAY_TOKEN`。 |
| 3 | 叫不醒（沒有已存登入、token 壞了或過期，或後端拒絕）。 |
| 4 | 逾時，預算用完時雲端電腦還沒就緒（包含仍在啟動）。 |

`--json` 印出這些欄位和 `exitCode`。失敗時還有 `error`。

### Grok Bot 0.78.x：bot 改在伺服器上執行

Grok Bot 0.78.4（2026-11-03）把每個 bot 都放到伺服器上執行（`harness: "temporal"`）。App 現在送訊、建立與修改群組、刪除，以及側欄設定，都用帳號的 access token 呼叫 Cursor API 主機上的 `aiserver.v1.GrokBotService/<Rpc>`（Connect JSON）。2026-11-05 實測，雲端電腦 gateway（帶 gateway token 的 `/api/<method>`）的情況如下：

| Gateway 呼叫 | 結果 |
| --- | --- |
| `sendPrompt`、`createGroup`、`setAgentHiddenFromSidebar` | 502 `A Sand box session is not permitted on this endpoint.` |
| `listAgents` | 200，但是舊資料：後端已刪除的 bot 還在，後端剛建立的群組幾分鐘後才出現。 |
| `deleteAgent` | 200，但什麼都沒刪。 |
| `updateAgent` | 200。沒有 `editedFields` 時只改到雲端電腦上的副本。帶 `editedFields`（App 會帶）時，頭像的修改約 3 秒後轉到伺服器；title 的修改 30 秒後仍未到伺服器。 |
| `setAgentNotifyOnUpdates` | 200。伺服器上的 client state 沒有變。 |
| `createAgent` | 200。bot 連同 title 與頭像出現在伺服器上。 |
| `getAgentTranscriptTail`、`getAgentThread`、`getAgentWorkflows` | 200，資料是最新的。 |

Session 有 access token 時，gbot 改用這些後端 RPC：

| 命令 | RPC |
| --- | --- |
| `send` | `SendGrokBotUserMessage` |
| `reconcile` | 先 `GetGrokBotSendStatus`，再讀 transcript 尾端 |
| `bots list`、`groups list`、`get` 與所有名稱查詢 | `ListGrokBotAgents`；notify 與 hidden 來自 `ListGrokBotAgentStatuses` |
| `groups create` | `CreateGrokBotRoom`，`--title` 與頭像再用 `UpdateGrokBotAgent` |
| `groups set`、`add`、`remove` | `SetGrokBotRoomMembers` |
| `bots update`、`groups update` | `UpdateGrokBotAgent`（數字的伺服器 id，只送有改的欄位）；`--notify` 與 `--hidden` 用 `SetGrokBotAgentClientState` |
| `bots delete`、`groups delete` | `DeleteGrokBotAgent`（找不到視為已刪除） |
| `approvals respond` | `ResolveGrokBotAutoReviewApproval` 或 `ResolveGrokBotLocalToolPermission`（照 App 對應，沒有實測） |
| `bots template` | `GetGrokBotTemplateForSourceAgent`；建立或更新時用 `SendGrokBotUserMessage`，initiator 是 `TEMPLATE_SHARE` |

從 0.11.2-iml1s.7 起，`bots create` 跟 App 一樣呼叫 `CreateGrokBotTemporalAgent`（0.78 的雲端電腦 gateway 回 404）。`thread`、`reconcile` 退回去讀的 transcript 尾端、relay、`approvals list` 與 `approvals respond`，以及 MCP 的 thread 工具，都用 `ListGrokBotTranscriptEntries` 讀尾端（`limit` N+1，最新一頁，舊的在前；頁面裡省略的內文從 store 讀，一次 8 個，並核對雜湊）。讀不到內文的列顯示成 `unreadable`，`--after` 游標停在它前面，下次讀會再拿到它。`thread --root` 與 `skills` 仍走雲端電腦 gateway；App 沒有對應 root thread 的後端呼叫。

以下 session 有 access token：已存的 App 登入（gbot 本來就為 EnsureSandBox 讀這個 token）、該帳號另外存有 access token 的 descriptor 登入，以及沒有 App 登入時的 `CURSOR_ACCESS_TOKEN`。Token 只送到 `CURSOR_API_BASE_URL`（預設 `https://api2.cursor.sh`），header 與 EnsureSandBox 相同（`SAND_CLIENT_VERSION` 與 `SAND_BOX_NAMESPACE` 照樣適用）。App 登入的 token 只送到 https 的 Cursor API 主機，`GROK_BOT_ALLOW_ANY_GATEWAY` 對它無效。`GROK_BOT_GATEWAY_URL` 加 `GROK_BOT_GATEWAY_TOKEN`，以及沒有存 access token 的 descriptor 登入，都沒有 access token，照舊走 gateway。在 0.78.x 上它們的送訊會得到上面的 502。

送達狀態：`ACCEPTED_BOX`、`ACCEPTED_TEMPORAL` 與 `DUPLICATE`（同一個 nonce 再送一次）是 `accepted`。`REFUSED` 是 `rejected`，帶伺服器的 `failureCode`。4xx 是 `rejected`，但 408、499（Connect `canceled`），以及 Connect 代碼為 `canceled`、`deadline_exceeded`、`unavailable`、`unknown` 或 `internal` 的回應除外：這些可能已經送達。這些情況，加上逾時、傳輸失敗、5xx 或 `UNSPECIFIED`，會用同一個 nonce 問一次 `GetGrokBotSendStatus`：`ACCEPTED` 變成 `accepted`，`REJECTED` 變成新的 `rejected` 錯誤（`SEND_REFUSED`，伺服器的拒絕代碼放在 `failureCode`），其他維持 `unknown`。錯誤裡的伺服器文字會先遮蔽機密，再截到 300 字。gbot 絕不重送，試過後端送訊之後也絕不改走 gateway 送。Nonce 就是後端的 `messageId`。`reconcile` 先問 `GetGrokBotSendStatus`，回報的狀態放在 `sendStatus`。`ACCEPTED` 是 `delivered`（`entryId` 是回報的 entry）。`REJECTED` 是 `rejected`，伺服器有給時帶 `rejectionCode`。其他情況照舊讀最後 200 筆 transcript：找到 nonce 就是 `delivered`。找不到時，只有 `NOT_FOUND` 是 `not-found-in-tail`。其他回答（`PENDING`、`UNKNOWN_DURABILITY`、`UNSPECIFIED`，或比這個版本新的值）都是 `pending`，狀態讀取失敗也是（`sendStatus: "UNAVAILABLE"`）：訊息仍可能送達，不要重送。伺服器有這類狀態、但讀不到對話紀錄（雲端電腦睡著或出錯）時，結果仍是 `pending`，並附 `tailError`；沒有狀態或是 `NOT_FOUND` 時，照樣回報讀取錯誤。

名單：伺服器列出的每個 agent 都以伺服器為準，`ListGrokBotAgents` 也會列出 box harness 的 bot。gbot 也讀雲端電腦的名單，只在伺服器沒列出、且 harness 不是 `temporal` 時才加進來。伺服器沒列出的 `temporal` 列是舊資料，會丟掉。這次讀取遇到睡眠中的雲端電腦不會重試（417 不喚醒）。但已存的登入若遇到雲端電腦回 401、403 或「could not be routed」，仍會像其他雲端電腦呼叫一樣先重建 session，而重建可能喚醒雲端電腦。讀不到雲端電腦名單時只用伺服器名單（`GBOT_DEBUG` 會說原因）。名稱先以完整名稱或 title 比對伺服器的 bot，接著用折疊規則比對伺服器 bot 的 `name · title` 任一半：原名稱或 title。如果伺服器的 bot 只靠折疊規則符合，而只在雲端電腦上的列完全相同，gbot 會以 `Ambiguous name … Use the id.` 拒絕，因為兩者可能是同一個或兩個 bot。只有伺服器沒有符合的 bot 時，才用只在雲端電腦上的列。沒有 `agentId` 的伺服器列會照 App 的做法略過；id 等於某個伺服器 bot 的 `agentId` 或 `legacyAgentId` 的雲端電腦列不會重複加入。

伺服器名單是否開啟，照 App 的判斷方式：`GetGrokBotRuntimeCapabilities` 的 `capabilities.durableIdentityEnabled` 為 true。這個值為 false 或沒有，或這個呼叫回 `failed_precondition` 時，就是關閉。gbot 每個 session 只問一次。名單關閉時，gbot 改用雲端電腦名單，在 stderr 印出 `gbot: the server roster is off for this login …`，在 `--json` 的每筆記錄標上 `roster: "box"`（bot 與群組、`send`、`reconcile`），送訊、修改、刪除與建立群組都像 0.78.x 之前一樣走雲端電腦 gateway。這個呼叫的其他錯誤，以及 `ListGrokBotAgents` 本身的任何錯誤，都會讓命令失敗：猜出來的名單可能讓送訊或刪除打到錯的 bot。伺服器把名單標成 `truncated` 時不比對名稱，因為要找的 bot 可能在截斷之後，也不加入只在雲端電腦上的列；請改給 bot 或群組的 id。空白或只有空白字元的名稱會被拒絕。`ListGrokBotAgents` 把有 title 的 bot 顯示成 `name · title`、title 欄空白（群組保留 title）；沒有完全相同的名稱時，原本的名稱仍然查得到。雲端電腦建立時就帶 title 的 bot，存放的名稱裡已經有 ` · title`，所以只給 `bots update --title` 會再多一段（實測：`name · old · new`）。要換掉兩者就同時給 `--name` 與 `--title`。Notify 與 hidden 來自 `ListGrokBotAgentStatuses`。gbot 跟 App 一樣，client state 寫入過（`updatedAtMs` 大於 0）才採用其中的 notify；在那之前，以及沒有 client state 時，都顯示 notify 開、不隱藏。這個讀取失敗時，列表會省略 notify 與 hidden，而不是整個失敗。

群組：`CreateGrokBotRoom` 的 `agentId` 是新的 v4 uuid，gbot 用回應裡的 id。逾時或 5xx 之後群組可能已經建立；再試之前先跑 `gbot groups list`。`UpdateGrokBotAgent` 可以改群組的名稱、說明、title 與頭像（已實測）。`groups create` 會在建立任何東西之前先檢查 `--avatar-shape` 與 `--avatar-color`，並用回應裡的伺服器 id 設定 title 與頭像。第二步失敗時，錯誤會給出新群組的 id。`SetGrokBotRoomMembers` 回應的必須是要求的那個群組，否則是錯誤（`ROOM_MISMATCH`），並說明成員可能已經改變。

`--notify` 也會照 App 的做法送到雲端電腦（`setAgentNotifyOnUpdates`）。那邊失敗會被忽略（`GBOT_DEBUG` 會說原因）。

審批：`approvals respond` 照 App 的分派方式。auto-review 卡片送 `ResolveGrokBotAutoReviewApproval`，帶 `agentId`、`requestId`、`resolution`（`GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_APPROVED` 或 `_DENIED`）與 `approvalPlatform: "desktop"`；這個請求沒有 entry id。本機工具卡片送 `ResolveGrokBotLocalToolPermission`，帶 `agentId`、`entryId`、`requestId` 與 `resolution`（`GROK_BOT_LOCAL_TOOL_PERMISSION_CARD_RESOLUTION_ALLOW_ONCE` 或 `_DENY`）。回應裡有 `refusal` 時是錯誤，帶 `code: "APPROVAL_REFUSED"`、伺服器的 `failureCode` 與 `delivery: "rejected"`。gbot 仍然只允許一次或拒絕：App 的 ALWAYS 與 NEVER 絕不送出，過期、別人的或被截斷的卡片在任何呼叫之前就會被拒絕。這是照 App 對應的，沒有實測：需要一張真的待處理卡片，而 `approvals respond` 對假卡片在任何網路呼叫之前就會拒絕。沒有 access token 的 session 仍在雲端電腦上處理卡片。跟 App 一樣，harness 不是 `temporal` 的 bot 的 auto-review 卡片走雲端電腦 gateway；這種 bot 的本機工具卡片在後端回 `unimplemented` 時改走雲端電腦 gateway。回應帶 `via`（`backend` 或 `box`）。後端的回應只有在 `dispatched: true` 時才是 `delivery: "accepted"`，否則是 `delivery: "unknown"`，並提醒到 App 裡確認卡片。App 本身把沒有 refusal 的回應都當成完成。

`connectGateway` 在只需要後端的命令之前，仍會先跑 EnsureSandBox，可能喚醒雲端電腦。

### Fork 命令

`--stdin`（預設 `false`）：

```sh
printf %s 'Exact UTF-8 message' | gbot send Researcher --stdin --json
```

Windows PowerShell（UTF-8、不要多一個換行）：

```powershell
node -e "process.stdout.write('Exact UTF-8 message')" | gbot send Researcher --stdin --json
```

不要同時給 `--stdin` 和位置參數訊息。內容必須是非空 UTF-8、最多 64 KiB、沒有 NUL、兩端沒有空白。UTF-8 BOM 或 UTF-16 BOM 會被接受並去掉。結尾的 CR、LF 或 CRLF 算兩端空白，會被拒絕。行與行之間的 CR LF 會保留。

成功的 JSON 含 `delivery`（`accepted` 或 `unknown`）、`kind`（`bot` 或 `group`）、`exitCode: 0` 與 `result`。`accepted` 表示後端確認收到（見上面的 Grok Bot 0.78.x），沒有 access token 的 session 則是 gateway 確認收到（`{"accepted": true}` 或 message id）。`unknown` 表示 CLI 無法證明送出已落地（逾時、網路失敗、HTTP 408 或 5xx，或回應兩者都沒有）。不要再送一次。結果帶有這次送出的 `clientNonce`：`gbot reconcile <bot> --nonce <clientNonce>` 在最後 200 筆 transcript 裡找它（`delivered` 或 `not-found-in-tail`），不會重送。

送出期限 15 秒，含讀取回應本文。讀取期限 30 秒。不會自動重試，唯一的例外是喚醒睡眠中的雲端電腦後，把同一個請求重試一次。`sendPrompt` 只有在 417 帶有睡眠證據時才重試（`pod_hibernated`，或 `failureCode` 符合 sleep／hibernat）。失敗的 JSON 在錯誤帶有 `wake` 與 `failureReason` 時會包含它們。重新導向會被拒絕。

`--normalized`（預設 `false`）必須搭配 `--json`。`--json` 可以寫在子命令前面（`gbot --json thread …`）。

```sh
gbot --json thread Researcher --normalized --limit 50
```

形狀：`{ "target": { "id", "name", "kind": "bot" | "group" }, "messages": [{ "id", "role", "text" }] }`。`role` 是 `user`、`assistant` 或 `unknown`。加上 `--after` 時，同一個物件還有 `cursor`、`entryCount`、`gapReset`。

```sh
gbot thread Researcher --after "<cursor>" --json
```

`--after` 沒有預設。`--limit` 預設 40（1–200）。結果是游標之後的項目。`entryCount: 0` 且 `gapReset: false` 表示沒有新項目。不認識的游標會回一份有界快照，且 `gapReset: true`。

機器人回覆常常是 `kind: "send-message"`、`message.type: "text"`。除非項目寫明 `user` 或 `assistant`，正規化後的 `role` 會是 `unknown`。那仍然是回覆。不要把 `unknown` 當成送出失敗。

`bots template` 把伺服器上的 bot 分享成 Grok Bot 範本，做法和 0.78 App 一樣：

```sh
gbot bots template "Move to Hermes"            # 建立或更新，最多等 600 秒
gbot bots template "Move to Hermes" --status   # 只讀：目前的範本與連結
```

gbot 先讀這個 bot 的 `GetGrokBotTemplateForSourceAgent`。還沒有範本時，送給 bot 的是 App 的訊息 `Create a public template of yourself that I can share with somebody else`；已經有範本時是 `Update the shared template of yourself.`。訊息走 `SendGrokBotUserMessage`，`initiator: "GROK_BOT_USER_MESSAGE_INITIATOR_TEMPLATE_SHARE"`，送達規則同上面 Grok Bot 0.78.x 的送訊；範本由 bot 在伺服器上建立。之後 gbot 每 10 秒讀一次範本，直到範本出現（更新時則是 `updatedAtMs` 比原本新的範本），最多等 `--wait` 秒（預設 600；`0` 不等）。連結 `https://x.ai/bot/<shareId>` 單獨印在一行。`--json` 有 `action`（`created` 或 `updated`）、`delivery`、`clientNonce` 與 `template`（`shareId`、`link`、`name`、`published`、`visibility`、`activeVersion`、`updatedAtMs`）。結束碼 0：看到範本了。結束碼 3：訊息已被接受或送達未知，但 `--wait` 內沒有出現範本（`template: null`，附 `hint`）；稍後用 `gbot bots template <bot> --status` 查。gbot 不會再送一次訊息；再跑一次命令就是再請 bot 一次。結束碼 1：訊息被拒絕，或什麼都沒送出。`--status` 不送任何東西，回傳 `template`（沒有時是 `null`，「no template yet」）、`hasTeam`，伺服器有給時還有 `exportPolicy`。範本只給伺服器上的 bot（App 沒有走雲端電腦的做法）：只在雲端電腦名單上的 bot、伺服器名單關閉的登入、群組，以及沒有 access token 的 session，都會在送出任何東西之前被拒絕。

### 把 bot 搬到 Hermes、Muse 或 Your dot（`gbot migrate`）

在終端機跑 `gbot migrate` 照提示做，或用 `gbot migrate bots|capture|preview|import|check|run`。它只讀地完整擷取一個 bot（每一頁對話、三層記憶、Skills 庫、排程、未完成任務、必要檔案），匯入目的地、讀回比對，再問搬過去的 agent 驗收題。細節、三個目的地的差異與限制見 [docs/migration.md](docs/migration.md)。

### 配對 Wear OS 手錶（`gbot wear pair`）

手錶 App 是 [Grok Bot Wear](https://gitlab.com/aa22396584/grok-bot-wear)（非官方；APK 在它的 [Releases](https://gitlab.com/aa22396584/grok-bot-wear/-/releases)，逐步安裝見它的[安裝指南](https://gitlab.com/aa22396584/grok-bot-wear/-/blob/main/docs/install.md)）。

`wear pair` 從 `v0.11.2-iml1s.4` 起包含在套件裡。照上面的「安裝」裝好那個版本（使用「安裝」所列的 Node.js 版本；這台電腦已登入 Grok Bot 桌面版），配對前先確認登入：

```sh
gbot accounts                       # 列出存的登入，不印憑證
gbot bots list --account "<標籤>"   # 配對前先確認這個登入還能用
```

把選定登入的 gateway 工作階段（gateway 網址、token、路由 header 與登入標籤）經 GBWP/1 配對通道送到同一個 Wi-Fi 上的 grok-bot-watch Wear OS app。這是從電腦佈建，不是登入：手錶之後用的是 Grok Bot 桌面版拿到的工作階段，連的是同一個未公開的 gateway。工作階段過期時，再配對一次。

在手錶的連線畫面選「從電腦配對」。它會顯示像 `ABCD-EFGH-JKMN-P` 的配對碼和一個位址。在同一個網路上的終端機執行：

```sh
gbot wear pair 192.168.1.23:40123
gbot wear pair 192.168.1.23:40123 --account "<標籤>" --json
```

在提示處輸入配對碼。輸入不會顯示（echo 關閉），最多 32 個字元；Enter 送出，Ctrl-C 取消。大小寫、連字號和空白不影響，`I`／`L` 當成 `1`，`O` 當成 `0`。

- 位址：手錶顯示的十進位 IPv4 位址和連接埠（1024–65535），限 10/8、172.16/12、192.168/16、100.64/10 或 169.254/16。不接受主機名稱，也不接受 IPv6。
- 登入：只有一個已存登入時直接使用。有多個時必須給 `--account`（標籤、id，或 8 位以上十六進位的唯一 id 前綴）。這個命令忽略 `GBOT_ACCOUNT`，避免 export 的預設值決定什麼東西離開電腦。若標籤或 id 等於或包含任何已存登入的 token、路由 header 值或 gateway 主機，會印成（也以這個名稱送給手錶）`login <n>`（這個代稱不會與任何真實標籤或 id 重複，只對應一個登入）；可用 `--account "login <n>"` 選它。
- 連線前，`gbot` 會檢查配對碼最後一個字元（打錯會直接提示，不會用掉這組碼），並用手錶自己的匯入規則檢查工作階段（Cursor 主機上的 https、可見 ASCII 的 token、最多 8 個 `x-` 路由 header、最多 16 KiB）。之後只印出登入標籤和位址。
- 它不印 token、路由 header、gateway 主機或配對碼。配對碼不會出現在命令列、環境變數值、shell 歷史、輸出或錯誤裡：`gbot` wrapper 把它寫進新建 0700 暫存目錄裡的 0600 檔案，只把路徑交給 worker；worker 在連線前讀取並刪除那個檔案。wrapper 在結束、錯誤、Ctrl-C（SIGINT）、SIGTERM 與 SIGHUP 時都會刪掉那個目錄。若在輸入完到讀取之間遇到 SIGKILL 或斷電，檔案可能留在暫存目錄裡。
- 通道靠 60 位元的配對碼驗證（ECDH P-256、HKDF-SHA256、HMAC-SHA256 標籤、AES-256-GCM）。手錶先證明它知道配對碼，工作階段才會送出，而且以這次交握的金鑰加密。不要重用配對碼：任何失敗後都在手錶上產生新的碼。檢查字元能抓到任何一個打錯的字元，以及任何兩個相鄰字元互換，唯一例外是 `0`↔`Z`；這種互換會在手錶端失敗（配對碼錯誤）。
- 不會自動重試。期限：連線 5 秒，手錶回應 15 秒內，回條 20 秒內。
- 工作階段送出前：Ctrl-C（SIGINT）結束碼 130，SIGTERM 為 143，SIGHUP 為 129（wrapper 會重新觸發 SIGHUP，shell 回報為 129）。即將送出前，worker 會先在 wrapper 的私有目錄記下「已送出」；若記錄寫不進去，就什麼都不送（結束碼 1）。工作階段一旦開始送出，中斷、當掉或錯誤都不會回報「已取消」，結果是 `unknown`（結束碼 6），因為手錶可能已經存下；stderr 會顯示「The session was already sent; the watch may have stored it.」（執行環境自己的「Aborted.」可能出現在它前面）。

`--json` 印出 `{ "account", "id", "target", "outcome", "exitCode" }`，`outcome` 是 `paired`、`rejected`、`storage-failed` 或 `unknown`。失敗時印出 `{ "category", "error", "exitCode" }`，訊息是固定的。`exitCode` 放在值裡，是因為 CLI 框架從那裡取結束碼。

| 結束碼 | 意義 | 怎麼做 |
| --- | --- | --- |
| 0 | 已配對。 | — |
| 1 | 讀不到已存登入（Keychain 或密鑰儲存的存取權限；測試模式下訊息會說明密鑰儲存已關閉）、手錶會拒收這個工作階段（什麼都沒送出，配對碼仍有效）、無法記錄送出（什麼都沒送出；請產生新的碼），或內部錯誤。 | 允許這個終端機存取 Keychain，或執行 `gbot doctor --account "<標籤>"`；在 Grok Bot app 重新登入。 |
| 2 | 用法錯誤：位址不對、配對碼打錯、不是配對碼、多個登入卻沒給 `--account`，或不是在終端機執行。 | 修正輸入。打錯字不會用掉配對碼。 |
| 3 | 連不到手錶。 | 是同一個 Wi-Fi 嗎？訪客網路和部分路由器會隔離裝置。macOS 要在「系統設定 > 隱私權與安全性 > 區域網路」允許這個終端機 app。手錶若已顯示失敗，產生新的碼。 |
| 4 | 配對碼錯誤、不是你的手錶，或手錶沒有回應（忙碌、協定版本不同，或電腦和手錶不在同一個子網路：手錶會關閉來自其他子網路的連線）。 | 在手錶上產生新的碼。不要重用舊碼。確認兩者在同一個子網路。 |
| 5 | 手錶拒收或無法儲存工作階段。 | 產生新的碼再試一次。 |
| 6 | 已送出，但沒有收到確認，包括送出後按 Ctrl-C 或收到訊號。 | 看手錶畫面。 |
| 129 | 送出前收到 SIGHUP（wrapper 以 SIGHUP 結束）。 | — |
| 130 | 送出前按 Ctrl-C（SIGINT）。 | — |
| 143 | 送出前收到 SIGTERM。 | — |

僅供測試：`GROK_BOT_TEST=1` 時才接受 `--code <碼>` 與 `GBOT_TEST_KEYCHAIN_PASSWORD`。沒有它時，只要任何 `gbot` 命令列上任何位置出現 `--code` 或 `--code=…`（其他命令都沒有 `--code` 選項；任何位置，包括 `--account`、`--help` 或 `--` 之後），wrapper 都會在啟動任何 worker 前拒絕（結束碼 2），這個值不會被往下傳。因此訊息裡剛好是 `--code` 的字詞要改用 `send --stdin` 送出。測試模式（`GROK_BOT_TEST` 或 `NODE_ENV=test`）下，`wear pair` 不讀 Keychain、`secret-tool` 或 DPAPI，並允許 loopback 位址。`src/core/wear-pair.js` 只 import Node 內建模組，因為手錶 repo 會把它原樣收錄做跨語言測試。`test/fixtures/` 裡的已知答案向量複製自手錶 repo；來源與 SHA-256 記在 `test/fixtures/wear-pair-vectors.sha256`。

### 結束碼與常見錯誤

| 結束碼 | 意義 | 怎麼做 |
| --- | --- | --- |
| 0 | 命令完成。送出即使是 `delivery: "unknown"` 也可能是 0。 | delivery 是 unknown 時先讀 thread，不要重送。 |
| 1 | 用法錯誤或 gateway 失敗。送出失敗時 stdout 是含 `exitCode: 1` 的 JSON。 | 看 `error` / `code`。修正旗標或登入。 |
| 2 | 不認識的選項，包含子命令前的 `--account`。 | 把 `--account` 放到子命令後面。 |

`bots template` 另外會用 3：訊息已送出（或送達未知），但 `--wait` 內沒有出現範本。稍後跑 `gbot bots template <bot> --status`，不要再送一次。

沒有 `--json` 就用 `--normalized` 會丟出 `--normalized requires --json.` 其他命令的錯誤在 stderr。

### 安全

不要把 token、帳號鍵或訊息正文貼進工單或 shell 歷史。除非 `GROK_BOT_HISTORY=on`，否則不寫歷史。`delivery: "unknown"` 之後不要重送。除非你就是要做那件事，否則不要叫 bot 刪檔、傳訊給別人、購買，或改帳號設定。Codex 與 Claude channel 需要本機 Unix socket；上游在 Windows 上會拒絕（`windows-unsupported`，沒有 Unix socket）。

### 疑難排解

| 症狀 | 修法 |
| --- | --- |
| `bots list`、`send` 或 `thread` 說沒有 Grok Bot 登入，或找不到 agents 目錄 | 用同一個系統使用者在 Grok Bot app 登入一次，再跑 `gbot accounts`。`gbot doctor` 會列出它找過的位置。 |
| 有多個登入、選不出來 | `gbot accounts`，再把 `--account "<標籤>"` 放在子命令後面，設 `GBOT_ACCOUNT`，或 `gbot accounts default <別名>`。`gbot doctor` 與 `gbot wear pair` 忽略那個預設。 |
| `Unknown option: --account.` | 把 `--account` 放到子命令後面。 |
| Linux 找不到 `secret-tool` | 安裝 `libsecret-tools`（Debian／Ubuntu）或 `libsecret`（Fedora／Arch），解鎖 keyring 後再試。 |
| `delivery: "unknown"` | `gbot reconcile <bot> --nonce <clientNonce>`，或先讀 thread，不要重送。 |
| 固定的 `GROK_BOT_RELAY_DIR` 出現 `Relay profile mismatch` | 那個目錄的 profile 和這次行程不同（換了帳號或環境，或是舊版寫的）。profile 不只有升級會變。若只是換了帳號或環境，用原來的設定再跑一次。managed 命令會在呼叫端自己顯示這個錯誤，worker 已經停了也一樣；還在跑的舊 worker 若只回 `Relay profile mismatch`，呼叫端仍會顯示升級步驟。若是舊版寫的，先用舊版執行 `gbot codex bridge stop --worker`，再把目錄移走或改名（或換一個新目錄）然後重新 bind。固定目錄的 socket 路徑不變。還在跑的舊 worker 會拒絕 hello，新 CLI 停不掉它。沒有 pid 檔。升級前，舊版的 `bridge status` 輸出裡有 `worker.pid`。否則停掉正開著目錄裡 `control.sock` 或 `worker.lock` 的行程（`lsof -t <dir>/worker.lock`）。預設目錄的 socket 路徑會跟著 profile hash 改變。舊版預設目錄的狀態留在 `~/.grok-bot-cli/relay/<舊的 hash>`。 |
| 裝完找不到 `gbot` | 開新的終端機。確認 `npm prefix -g`（macOS／Linux 是它底下的 `bin`）在 PATH 上。 |
| `... failed: 417 ...`，`code: "BOX_ASLEEP"` | 那個登入的 Grok Bot 雲端電腦在睡眠。2026-10-20 實測時，proxy 以空本文和 `x-anyrun-failure-reason: pod_hibernated` 回答 417；沒有那個標頭的 417 也可以是 `BOX_ASLEEP`，但 proxy 標頭寫的是別的原因時就不算；錯誤的 `failureReason` 欄位會帶出 proxy 原因。gbot 會自己嘗試喚醒。只有 `listAgents`、`getAgentThread`、`getAgentTranscriptTail`、`getAgentWorkflows` 會在 bare 417 上喚醒。其他方法（包括 `sendPrompt`）只有在那個 417 有睡眠證據時才會重送（`failureReason` 是 `pod_hibernated`，或 `failureCode` 符合 sleep／hibernat）。若失敗，訊息會說明原因（`auto wake failed: …`，以及 `wake.error`）。喚醒途中的 401「不再支援」是 `CLIENT_VERSION_REJECTED`，並標出版本。若重試仍在睡眠，`wake` 是 `{ attempted: true, woke: true }`。你仍可打開 Grok Bot app，點選那個登入底下的一個 bot。2026-10-20 也曾觀察到把 app 切到那個登入會喚醒（一次擁有者的工作階段）；那是觀察，不是規則。在背景開啟 app 或單獨的 `grokbot://`（`open -g`）叫不醒。`GBOT_AUTO_WAKE=0` 會跳過自動喚醒。`gbot wake` 做同一件事並印出執行狀態；兩個 gateway 覆寫變數都設了時以結束碼 2 結束。gbot 只有在沒有可用的 app 登入，而且並非同時設了 `GROK_BOT_GATEWAY_URL` 與 `GROK_BOT_GATEWAY_TOKEN` 時，才會經由 `CURSOR_ACCESS_TOKEN` 呼叫 EnsureSandBox。 |
| `Gateway response too large (over N bytes)` | 把 `GBOT_MAX_RESPONSE_BYTES` 設成 65536 到 67108864 之間的位元組數（預設 16 MiB）後再試。其他值會被忽略，錯誤訊息會說明。 |
| 出現 `EnsureSandBox failed: 4xx` | 以 app 登入 token 送 `{ "wake": true }` 已在 2026-10-21 於 macOS 實測（睡眠約 10 秒變成 `RUNNING`）。`x-cursor-client-version` `0.20.0` 會被 401「不再支援」拒絕；預設是 `0.72.1`，可用 `SAND_CLIENT_VERSION` 覆寫。那個 401 會標出 gbot 送出的版本。Linux 與 Windows 的已存登入 token 路徑，以及 Windows 登錄查詢，有實作、尚未實測。上面列出的登錄值是實機讀到的；gbot 的查詢沒有在那台機器上跑過。 |

### 隱私

- `gbot` 只連 Cursor 後端和 app 存下的 Grok Bot gateway 網址（或 `GROK_BOT_GATEWAY_URL`）。沒有遙測。
- `gbot wear pair` 另外會連到你輸入的區域網路手錶位址，把選定登入的 gateway 工作階段加密後送給它。其他命令都不會。
- 它讀 Grok Bot app 加密的 gateway descriptor，喚醒睡眠中的雲端電腦時也讀同一目錄的 `sand-secrets.json`。它用系統的密鑰儲存（Keychain、`secret-tool` 或 DPAPI）解密已存的 access token。secrets 檔會整份解析。gbot 不會解密或使用 refresh token，不寫 app 檔案，也不印 token。app 登入 token 只送到 https 的 Cursor API 主機。`GROK_BOT_ALLOW_ANY_GATEWAY` 不會改變這一點。
- 除非打開歷史，否則它不寫任何檔。`GROK_BOT_HISTORY=on` 會把訊息明文附加到 `~/.grok-bot-cli/history.jsonl`（或 `GROK_BOT_HISTORY_DIR`）。刪掉那個檔就清掉了。
- 移除套件不會動到 app 的登入；要移除登入，在 Grok Bot app 登出。

### 相關專案

- trinity-cli — 一個 CLI 管三個常駐 agent（Your dot、Grok Bot、Muse）：https://gitlab.com/aa22396584/trinity-cli
- chatgpt-dot-cli — ChatGPT Your dot：https://gitlab.com/aa22396584/chatgpt-dot-cli
- grok-bot-cli（這個 fork，`gbot`）— Grok Bot：https://gitlab.com/aa22396584/grok-bot-cli
- muse-web-cli — 網頁上的 Meta Muse：https://gitlab.com/aa22396584/muse-web-cli

與 trinity-cli 一起用：https://gitlab.com/aa22396584/trinity-cli

### 平台

| 系統 | Node.js | 狀態 | 依據 |
| --- | --- | --- | --- |
| macOS | 22.19+（22.x）或 24.2+ | 支援 | 在本機檢查：單元、路由、型別 |
| Linux | 22.19+（22.x） | 支援 | GitLab CI（`node:22-slim`）：696 項，671 通過、0 失敗、25 略過（23 項需要 Python，2 項使用 macOS 格式 descriptor） |
| Windows | 22.19+（22.x）或 24.2+ | 支援；Codex／Claude channel 與 relay 除外 | GitLab CI 與隔離完整 CI 腳本：696 項，386 通過、0 失敗、310 項平台條件略過 |

CI 預設使用 GitLab.com 的 runner。維護者可設定 CI/CD 變數 `LINUX_RUNNER_TAG` 與 `WINDOWS_RUNNER_TAG`，把 job 指到自己的 runner。Linux 單元測試在 CI 跑（`node:22-slim`）。Windows 單元測試在該 runner 可用時執行。macOS 在本機確認。兩個 job 都把同一份 `test/*.test.js` 清單交給 `node --test`。追蹤的文字檔維持 LF（`.gitattributes`），Windows checkout 不會把 plugin 指令的 frontmatter 改成 CRLF。Windows 單元測試用 `file://` 載入 MCP client，因為 Node 的 `import()` 不接受 `C:` 路徑。上游的 Codex 與 Claude socket 仍只有 Unix。

### 帳戶設定驗證（2026-10-22）

[MR !7](https://gitlab.com/aa22396584/grok-bot-cli/-/merge_requests/7) 的 source `c7f18c6b7fbe4a982097eb58c64471c6eb6a7f62` 已合併為 `74704f554227fe71641af924b17ddadc3859e019`，兩者 Git tree 相同。macOS 單元測試 695/695、路由測試 94/94 通過；source validation、artifact 建置與驗證、型別檢查及三項 release configuration 檢查通過。native 獨立重審批准最終候選。Claude 與 agy 審查受額度或 credits 阻擋，沒有外部批准結論。

Linux 的 [source pipeline](https://gitlab.com/aa22396584/grok-bot-cli/-/pipelines/2974528600) 與[合併後 main job](https://gitlab.com/aa22396584/grok-bot-cli/-/jobs/17368454058) 都通過：695 項，670 通過、0 失敗、25 項環境條件略過。最終 runtime 候選在 macOS 通過單元測試 696/696 與路由測試 94/94。隔離 Windows 環境實跑完整 CI 腳本通過：696 項，386 通過、0 失敗、310 項平台條件略過。保留正常 `APPDATA`，探測出 Node 24.1 缺少 `import.meta.main` 後，自動下載 Node 22.23.4、核對 SHA-256，完成安裝、建置與測試，並清除該次專屬 runtime 暫存。fixture 環境已隔離 `APPDATA` 與 `XDG_CONFIG_HOME`。初次驗證時，原 protected `hx370` GitLab runner 離線，可選 hosted job 的 CI 額度用盡。同一份 runtime 修正 `113e1c671eaf882b792888416260468f47d331b1` 的 [pipeline 2974718228](https://gitlab.com/aa22396584/grok-bot-cli/-/pipelines/2974718228) 亦已通過：[Linux job](https://gitlab.com/aa22396584/grok-bot-cli/-/jobs/17369336982) 為 696 項、671 通過、0 失敗、25 略過；[Windows job](https://gitlab.com/aa22396584/grok-bot-cli/-/jobs/17369336988) 為 696 項、386 通過、0 失敗、310 略過。兩者使用本輪臨時專案 runner；原本排隊的 main Windows job 已因新修正取代而取消，沒有算成通過。

上述帳戶檢查使用合成 fixture，沒有驗證真實帳戶切換、Windows 已存登入解密或 PowerShell 安裝器實跑；PowerShell 安裝器仍只有靜態檢查。本輪沒有全域安裝 CLI 或發布 npm。

### Windows 限制

這些檔案需要 Unix socket、shebang 執行檔或 `process.getuid()`。Windows 仍會收集它們，每則測試以 `Unix sockets and Codex routes are unsupported on win32` 略過：

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
