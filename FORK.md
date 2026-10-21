# Fork guide

ImL1s's fork of [ScriptedAlchemy/grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli), synced to upstream 0.11.2. The package version string stays `0.11.2`. The fork revision is the git tag.

Upstream still owns the npm package. Do not `npm install -g grok-bot-cli`. GitLab (https://gitlab.com/aa22396584/grok-bot-cli) is the primary remote. The GitHub mirror is not a public install source.

## English

### Disclaimer

Unofficial. This fork is not affiliated with, endorsed by, or supported by xAI, Cursor (Anysphere), or the upstream author. "Grok" and "Grok Bot" belong to their owners. `gbot` uses your own Grok Bot login and an undocumented gateway that can change or break at any time. Automated use may be limited by the Grok Bot terms; check them, and use it at your own risk. Report fork bugs here, not upstream.

### Install

Requires Node.js 22.19.0 or newer and the Grok Bot desktop app signed in once on the same OS user.

Do not `npm install -g` a `git+https://gitlab.com/...` spec. npm exits 0 and leaves a dangling `gbot` link. Download the package file from the `v0.11.2-iml1s.4` release and install that file.

macOS or Linux:

```sh
curl -fsSL -o grok-bot-cli-0.11.2.tgz "https://gitlab.com/-/project/86401528/uploads/ebe0bbf1fc9cd8bc15994e459ec25d29/grok-bot-cli-0.11.2.tgz"
npm install -g ./grok-bot-cli-0.11.2.tgz
rm -f grok-bot-cli-0.11.2.tgz
```

Windows PowerShell:

```powershell
irm "https://gitlab.com/-/project/86401528/uploads/ebe0bbf1fc9cd8bc15994e459ec25d29/grok-bot-cli-0.11.2.tgz" -OutFile grok-bot-cli-0.11.2.tgz
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

To install or restore this fork on another machine without a `git+https` spec, use `scripts/install-fork.sh` (macOS/Linux) or `scripts/install-fork.ps1` (Windows). Those scripts are described under [Switching logins and restoring gbot on another machine](#switching-logins-and-restoring-gbot-on-another-machine). The dry-run was tested; the scripts were not run against GitLab in this change.

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

### Login and several logins

`gbot` reads the app's encrypted gateway descriptor. It does not open a browser.

| OS | Session location | Secret |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Grok Bot` | Keychain item `Grok Bot Safe Storage` |
| Linux | `$XDG_CONFIG_HOME/Grok Bot` or `~/.config/Grok Bot` | `secret-tool` (`libsecret-tools`), except the basic-text v10 key |
| Windows | `%APPDATA%\Grok Bot` | DPAPI via PowerShell (`Local State`) |

One saved login is used automatically. Several logins and no choice is an error that lists labels, unless a config default alias is set (see below). `gbot doctor` and `gbot wear pair` do not use that default.

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

The desktop app keeps the login it is showing in `gateway-descriptor.json`. Every signed-in login stays in `sand-secrets.json` under `cursor-accounts`. After the app switches logins, the other login can disappear from the descriptor. gbot still lists it. If that login has no descriptor entry, gbot builds a gateway session from the saved access token: EnsureSandBox `{ "wake": false }` first, then `{ "wake": true }` unless the box is already `RUNNING` and the answer has gateway fields. The session is not written to disk. The refresh token is never read. The app token is sent only to https Cursor API hosts.

`gbot accounts` marks the app's current login `(app active)` and a login with no descriptor entry `(no app session; gbot builds one from the saved login)`. The label is the email from the decrypted profile, or the first 8 hex characters of the scope when the profile cannot be decrypted. Alias names are printed on their own line.

Give a login a name and, if you want, make it the default. These are arguments of `gbot accounts` (this bundler cannot also make `accounts` a command group):

```sh
gbot accounts alias work owner@example.com
gbot accounts default work
gbot accounts unalias work
gbot accounts default --clear
```

An alias name matches `^[A-Za-z0-9_-]{1,32}$`. A selector is that alias, an email (case-insensitive), a descriptor label, or an id or scope prefix of at least 8 hex characters. More than one match is the same error as before.

Gateway commands (`gbot send`, `gbot wake`, and the rest that take `--account`) resolve in this order: `--account`, then `GBOT_ACCOUNT`, then the config `default`, then the single saved login. Several logins and none of those is an error. `gbot doctor` still inspects the descriptor and does not apply the config default. `gbot wear pair` still sends a descriptor session only, and still ignores `GBOT_ACCOUNT` and the config default. A login that exists only in `sand-secrets.json` is not offered to the watch.

The config file holds aliases and the default. It has no tokens. On macOS and Linux it is `$XDG_CONFIG_HOME/grok-bot-cli/config.json`, or `~/.config/grok-bot-cli/config.json` when `XDG_CONFIG_HOME` is unset. On Windows it is `%APPDATA%\grok-bot-cli\config.json`. `GBOT_CONFIG` overrides the path. `gbot config path` prints it. The file is mode 0600 and is created only when alias, default, or import writes it.

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
scripts/install-fork.sh --dry-run --config gbot-accounts.json v0.11.2-iml1s.4
```

The script clones `https://gitlab.com/aa22396584/grok-bot-cli.git` into `$XDG_CACHE_HOME/grok-bot-cli/src` (default `~/.cache/grok-bot-cli/src`), checks out the ref (`main` if you omit it), runs `npm ci` and `npm pack`, and installs that tarball globally. `npm ci` is required because `npm pack` runs `agent-bundle prepack`, which fills `dist/` from the committed `artifact/`. It then runs `gbot --version`, `gbot accounts`, `gbot config import` when `--config` was given, and `gbot wake --check --account <alias>` for each alias, and prints a summary. It refuses to run as root or Administrator unless `--allow-root` (PowerShell `-AllowRoot`) is given. `--dry-run` prints the steps and does not run git or npm. The script does not store or print tokens.

What was tested: the shell script's `--dry-run` with fake `git` and `npm` on `PATH`, and a static check that the PowerShell script names the same steps. The scripts were not executed against GitLab, and a live switch between two Grok accounts was not run in this change.

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

Success JSON includes `delivery` (`accepted` or `unknown`), `kind` (`bot` or `group`), `exitCode: 0`, and `result`. `delivery: "accepted"` means the gateway confirmed the send (`{"accepted": true}` or a message id). `delivery: "unknown"` means the CLI cannot prove the send landed (timeout, network failure, HTTP 408 or 5xx, or a response with neither). Do not send again. The result carries the `clientNonce` it posted: `gbot reconcile <bot> --nonce <clientNonce>` looks for it in the last 200 transcript entries (`delivered` or `not-found-in-tail`) and never resends.

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

### Pair a Wear OS watch (`gbot wear pair`)

The watch app is [Grok Bot Wear](https://gitlab.com/aa22396584/grok-bot-wear) (unofficial; download the APK from its [releases](https://gitlab.com/aa22396584/grok-bot-wear/-/releases), step-by-step install in its [install guide](https://gitlab.com/aa22396584/grok-bot-wear/-/blob/main/docs/install.md), in Traditional Chinese).

`wear pair` ships in `v0.11.2-iml1s.4` and later. Install that release as in [Install](#install) (Node.js 22.19.0 or newer; the Grok Bot desktop app signed in on this computer), then check the login before pairing:

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
| macOS | 22.19+ and 24 | Supported | Checked locally: unit, route, and type checks |
| Linux | 22.19+ | Supported | Unit tests in GitLab CI (`node:22-slim`). 23 desktop-shim tests skip because the image has no `python3` |
| Windows | 22.19+ | Supported except Codex/Claude channels and the relay | Unit tests in GitLab CI. Unix-socket suites skip, listed below |

CI uses GitLab.com runners by default. Maintainers can point jobs at their own runners by setting the CI/CD variables `LINUX_RUNNER_TAG` and `WINDOWS_RUNNER_TAG`. Linux unit tests run in CI (`node:22-slim`). Windows unit tests run when that runner is available. macOS is checked locally. Both jobs pass the same `test/*.test.js` list to `node --test`. Tracked text stays LF (`.gitattributes`), so a Windows checkout does not rewrite plugin command frontmatter to CRLF. The Windows unit job loads the MCP client with a `file://` URL because Node rejects a `C:` path in `import()`. Upstream Codex and Claude sockets stay Unix-only.

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

需要 Node.js 22.19.0 以上，且同一個作業系統使用者已在 Grok Bot 桌面版登入一次。GitLab（https://gitlab.com/aa22396584/grok-bot-cli）是主要遠端。

不要用 `npm install -g git+https://gitlab.com/...`。npm 會結束碼 0，但 `gbot` 是斷掉的連結。改下載 `v0.11.2-iml1s.4` 附的套件檔再安裝。

macOS 或 Linux：

```sh
curl -fsSL -o grok-bot-cli-0.11.2.tgz "https://gitlab.com/-/project/86401528/uploads/ebe0bbf1fc9cd8bc15994e459ec25d29/grok-bot-cli-0.11.2.tgz"
npm install -g ./grok-bot-cli-0.11.2.tgz
rm -f grok-bot-cli-0.11.2.tgz
```

Windows PowerShell：

```powershell
irm "https://gitlab.com/-/project/86401528/uploads/ebe0bbf1fc9cd8bc15994e459ec25d29/grok-bot-cli-0.11.2.tgz" -OutFile grok-bot-cli-0.11.2.tgz
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

要在另一台機器安裝或還原這個 fork，又不要用 `git+https`，用 `scripts/install-fork.sh`（macOS／Linux）或 `scripts/install-fork.ps1`（Windows）。說明在[切換登入，以及在另一台機器還原 gbot](#切換登入以及在另一台機器還原-gbot)。這次只測了 dry-run，沒有對 GitLab 實際執行腳本。

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

### 登入與多個登入

`gbot` 讀取 App 已加密的 gateway descriptor，不會自己開瀏覽器。

| 系統 | 工作階段位置 | 密鑰 |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Grok Bot` | 鑰匙圈 `Grok Bot Safe Storage` |
| Linux | `$XDG_CONFIG_HOME/Grok Bot` 或 `~/.config/Grok Bot` | `secret-tool`（套件 `libsecret-tools`）；basic-text v10 除外 |
| Windows | `%APPDATA%\Grok Bot` | 透過 PowerShell 的 DPAPI（`Local State`） |

只有一個登入時會直接使用。有多個又沒指定時會失敗並列出標籤，除非設定了設定檔的預設別名（見下一節）。`gbot doctor` 與 `gbot wear pair` 不用那個預設。

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

桌面版把目前顯示的登入放在 `gateway-descriptor.json`。每一個已登入的帳號都留在 `sand-secrets.json` 的 `cursor-accounts`。App 切換登入之後，另一個登入可能從 descriptor 消失。gbot 仍會列出它。若那個登入沒有 descriptor 項目，gbot 用已存的 access token 在記憶體裡建立 gateway 工作階段：先送 EnsureSandBox `{ "wake": false }`，除非雲端電腦已經是 `RUNNING` 而且回答帶有 gateway 欄位，否則再送 `{ "wake": true }`。這個工作階段不會寫回磁碟。refresh token 不會被讀。App token 只送到 https 的 Cursor API 主機。

`gbot accounts` 把 App 目前的登入標成 `(app active)`。沒有 descriptor 項目的登入標成 `(no app session; gbot builds one from the saved login)`。標籤是解密後個人資料裡的 email；解不開時用 scope 的前 8 個十六進位字元。別名另起一行。

替登入取名，需要的話設成預設。這些是 `gbot accounts` 的參數（這個打包器不能同時把 `accounts` 做成命令群組）：

```sh
gbot accounts alias work owner@example.com
gbot accounts default work
gbot accounts unalias work
gbot accounts default --clear
```

別名符合 `^[A-Za-z0-9_-]{1,32}$`。選擇器可以是別名、email（不分大小寫）、descriptor 標籤，或至少 8 個十六進位字元的 id／scope 前綴。對到一個以上時，錯誤形式與以前相同。

會吃 `--account` 的 gateway 命令（`gbot send`、`gbot wake` 等）依序使用：`--account`、`GBOT_ACCOUNT`、設定檔的 `default`、然後唯一的一筆登入。有多筆又都沒指定就是錯誤。`gbot doctor` 仍只看 descriptor，不用設定檔預設。`gbot wear pair` 仍只送 descriptor 裡的工作階段，而且仍忽略 `GBOT_ACCOUNT` 與設定檔預設。只存在於 `sand-secrets.json` 的登入不會被送到手錶。

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
scripts/install-fork.sh --dry-run --config gbot-accounts.json v0.11.2-iml1s.4
```

腳本把 `https://gitlab.com/aa22396584/grok-bot-cli.git` clone 到 `$XDG_CACHE_HOME/grok-bot-cli/src`（預設 `~/.cache/grok-bot-cli/src`），檢出指定的 ref（省略時是 `main`），執行 `npm ci` 與 `npm pack`，再全域安裝那個 tarball。需要 `npm ci` 是因為 `npm pack` 會跑 `agent-bundle prepack`，用已提交的 `artifact/` 填 `dist/`。接著執行 `gbot --version`、`gbot accounts`；有 `--config` 時執行 `gbot config import`；每個別名再跑 `gbot wake --check --account <別名>`，然後印摘要。以 root 或 Administrator 執行會拒絕，除非加上 `--allow-root`（PowerShell 是 `-AllowRoot`）。`--dry-run` 只印步驟，不跑 git 或 npm。腳本不儲存、也不印 token。

這次測了什麼：shell 腳本的 `--dry-run`（PATH 上是假的 `git` 與 `npm`），以及靜態檢查 PowerShell 腳本有寫出同樣的步驟。腳本沒有對 GitLab 實際執行，這次也沒有用兩個真實的 Grok 帳號切換。

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

成功的 JSON 含 `delivery`（`accepted` 或 `unknown`）、`kind`（`bot` 或 `group`）、`exitCode: 0` 與 `result`。`accepted` 表示 gateway 確認收到（`{"accepted": true}` 或 message id）。`unknown` 表示 CLI 無法證明送出已落地（逾時、網路失敗、HTTP 408 或 5xx，或回應兩者都沒有）。不要再送一次。結果帶有這次送出的 `clientNonce`：`gbot reconcile <bot> --nonce <clientNonce>` 在最後 200 筆 transcript 裡找它（`delivered` 或 `not-found-in-tail`），不會重送。

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

### 配對 Wear OS 手錶（`gbot wear pair`）

手錶 App 是 [Grok Bot Wear](https://gitlab.com/aa22396584/grok-bot-wear)（非官方；APK 在它的 [Releases](https://gitlab.com/aa22396584/grok-bot-wear/-/releases)，逐步安裝見它的[安裝指南](https://gitlab.com/aa22396584/grok-bot-wear/-/blob/main/docs/install.md)）。

`wear pair` 從 `v0.11.2-iml1s.4` 起包含在套件裡。照上面的「安裝」裝好那個版本（Node.js 22.19.0 以上；這台電腦已登入 Grok Bot 桌面版），配對前先確認登入：

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
| macOS | 22.19+ 與 24 | 支援 | 在本機檢查：單元、路由、型別 |
| Linux | 22.19+ | 支援 | GitLab CI 跑單元測試（`node:22-slim`）。映像檔沒有 `python3`，23 則 desktop-shim 測試略過 |
| Windows | 22.19+ | 支援；Codex／Claude channel 與 relay 除外 | GitLab CI 跑單元測試。需要 Unix socket 的測試略過，清單在下面 |

CI 預設使用 GitLab.com 的 runner。維護者可設定 CI/CD 變數 `LINUX_RUNNER_TAG` 與 `WINDOWS_RUNNER_TAG`，把 job 指到自己的 runner。Linux 單元測試在 CI 跑（`node:22-slim`）。Windows 單元測試在該 runner 可用時執行。macOS 在本機確認。兩個 job 都把同一份 `test/*.test.js` 清單交給 `node --test`。追蹤的文字檔維持 LF（`.gitattributes`），Windows checkout 不會把 plugin 指令的 frontmatter 改成 CRLF。Windows 單元測試用 `file://` 載入 MCP client，因為 Node 的 `import()` 不接受 `C:` 路徑。上游的 Codex 與 Claude socket 仍只有 Unix。

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
