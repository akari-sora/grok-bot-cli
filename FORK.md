# Fork guide

ImL1s's fork of [ScriptedAlchemy/grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli), synced to upstream 0.11.2. The package version string stays `0.11.2`. The fork revision is the git tag.

Upstream still owns the npm package. Install from git, not `npm install -g grok-bot-cli`.

## English

### Install

Requires Node.js 22.19.0 or newer and the Grok Bot desktop app signed in once on the same OS user.

macOS or Linux:

```sh
npm install -g github:ImL1s/grok-bot-cli#v0.11.2-iml1s.2
```

Windows PowerShell:

```powershell
npm install -g "github:ImL1s/grok-bot-cli#v0.11.2-iml1s.2"
```

npm creates `gbot.cmd` on Windows, so `gbot` works from PowerShell and cmd. Quote the spec so `#` is not a comment.

From a clone (any OS, after `npm install`):

```sh
npm link
```

### Verify, upgrade, uninstall

```sh
gbot --version
```

This prints `0.11.2`. That is the upstream package version, not the fork tag.

Upgrade by installing the same git spec again. Uninstall:

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

One saved login is used automatically. Several logins and no choice is an error that lists labels.

```sh
gbot accounts
gbot bots list --account "<label>"
```

```sh
export GBOT_ACCOUNT="<label>"   # PowerShell: $env:GBOT_ACCOUNT = "<label>"
gbot doctor
```

`--account` overrides `GBOT_ACCOUNT`. There is no default label. The flag must follow the subcommand. `gbot --account <label> bots list` exits 2 with `Unknown option: --account.`

`gbot accounts` prints labels only (email or display name when the descriptor has one, otherwise the app's account key), plus which row was saved last. It does not know which login the app window is showing. It never prints tokens.

`gbot accounts --json` is `{ "accounts": [{ "id", "label", "savedAtMs", "lastSaved", "usable" }] }`. `id` is the label when the descriptor has no separate name.

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

Success JSON includes `delivery` (`accepted` or `unknown`), `kind` (`bot` or `group`), `exitCode: 0`, and `result`. `delivery: "accepted"` means the gateway returned a message id. `delivery: "unknown"` means the CLI cannot prove the send landed (timeout, network failure, HTTP 408 or 5xx, or a response without a message id). Do not send again. Read the thread first.

Sends use a 15 second deadline that includes the response body. Reads use 30 seconds. There is no automatic retry. Redirects are rejected.

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

### Exit codes and common errors

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Command finished. A send can be `delivery: "unknown"` and still exit 0. | If delivery is unknown, read the thread. Do not resend. |
| 1 | Usage error or gateway failure. Send failures are JSON on stdout with `exitCode: 1`. | Read `error` / `code`. Fix the flag or the login. |
| 2 | Unknown option, including `--account` before the subcommand. | Put `--account` after the subcommand. |

`--normalized` without `--json` throws `--normalized requires --json.` Other commands print the error on stderr.

### Safety

Do not put tokens, account keys, or message text into tickets or shell history. History is off unless `GROK_BOT_HISTORY=on`. Do not resend after `delivery: "unknown"`. Do not ask a bot to delete files, message other people, buy anything, or change account settings unless you mean that exact action. Codex and Claude channel commands need a local Unix socket; upstream rejects them on Windows (`windows-unsupported` / no Unix sockets).

### Related projects / 相關專案

- trinity-cli — one CLI over three always-on agents (Your dot, Grok Bot, Muse): https://gitlab.com/aa22396584/trinity-cli
- chatgpt-dot-cli — ChatGPT Your dot: https://gitlab.com/aa22396584/chatgpt-dot-cli
- grok-bot-cli (this fork, `gbot`) — Grok Bot: https://gitlab.com/aa22396584/grok-bot-cli (mirror https://github.com/ImL1s/grok-bot-cli)
- muse-web-cli — Meta Muse via the web: https://gitlab.com/aa22396584/muse-web-cli

Use this fork with trinity-cli: https://gitlab.com/aa22396584/trinity-cli

### Platforms

Linux unit tests run in CI on the grok-box runner (`node:22-slim`). Windows unit tests run on a GitLab.com hosted Windows runner when compute minutes are available. macOS is checked locally. Tracked text stays LF (`.gitattributes`), so a Windows checkout does not rewrite plugin command frontmatter to CRLF. The Windows unit job loads the MCP client with a `file://` URL because Node rejects a `C:` path in `import()`. Upstream Codex and Claude sockets stay Unix-only.

## 繁體中文

### 安裝

需要 Node.js 22.19.0 以上，且同一個作業系統使用者已在 Grok Bot 桌面版登入一次。

macOS 或 Linux：

```sh
npm install -g github:ImL1s/grok-bot-cli#v0.11.2-iml1s.2
```

Windows PowerShell：

```powershell
npm install -g "github:ImL1s/grok-bot-cli#v0.11.2-iml1s.2"
```

Windows 上 npm 會建立 `gbot.cmd`，PowerShell 與 cmd 都能執行 `gbot`。規格請加引號，避免 `#` 被當成註解。

從本機 clone（先 `npm install`）：

```sh
npm link
```

### 確認、升級、移除

```sh
gbot --version
```

輸出是 `0.11.2`，這是上游套件版本，不是 fork 標籤。

升級就再安裝一次同一個 git 規格。移除：

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

只有一個登入時會直接使用。有多個又沒指定時會失敗並列出標籤。

```sh
gbot accounts
gbot bots list --account "<label>"
```

```sh
export GBOT_ACCOUNT="<label>"   # PowerShell: $env:GBOT_ACCOUNT = "<label>"
gbot doctor
```

`--account` 覆寫 `GBOT_ACCOUNT`。沒有預設標籤。旗標必須寫在子命令後面。`gbot --account <label> bots list` 會以結束碼 2 結束，並顯示 `Unknown option: --account.`

`gbot accounts` 只印標籤（descriptor 有 email 或顯示名稱就用那個，否則用 App 的帳號鍵），並標出最後儲存的一筆。它不知道視窗目前選哪一個，也不印 token。

`gbot accounts --json` 的形狀是 `{ "accounts": [{ "id", "label", "savedAtMs", "lastSaved", "usable" }] }`。沒有另外的名稱時，`id` 就是標籤。

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

成功的 JSON 含 `delivery`（`accepted` 或 `unknown`）、`kind`（`bot` 或 `group`）、`exitCode: 0` 與 `result`。`accepted` 表示 gateway 回了 message id。`unknown` 表示 CLI 無法證明送出已落地（逾時、網路失敗、HTTP 408 或 5xx，或回應沒有 message id）。不要再送一次。先讀 thread。

送出期限 15 秒，含讀取回應本文。讀取期限 30 秒。不會自動重試。重新導向會被拒絕。

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

### 結束碼與常見錯誤

| 結束碼 | 意義 | 怎麼做 |
| --- | --- | --- |
| 0 | 命令完成。送出即使是 `delivery: "unknown"` 也可能是 0。 | delivery 是 unknown 時先讀 thread，不要重送。 |
| 1 | 用法錯誤或 gateway 失敗。送出失敗時 stdout 是含 `exitCode: 1` 的 JSON。 | 看 `error` / `code`。修正旗標或登入。 |
| 2 | 不認識的選項，包含子命令前的 `--account`。 | 把 `--account` 放到子命令後面。 |

沒有 `--json` 就用 `--normalized` 會丟出 `--normalized requires --json.` 其他命令的錯誤在 stderr。

### 安全

不要把 token、帳號鍵或訊息正文貼進工單或 shell 歷史。除非 `GROK_BOT_HISTORY=on`，否則不寫歷史。`delivery: "unknown"` 之後不要重送。除非你就是要做那件事，否則不要叫 bot 刪檔、傳訊給別人、購買，或改帳號設定。Codex 與 Claude channel 需要本機 Unix socket；上游在 Windows 上會拒絕（`windows-unsupported`，沒有 Unix socket）。

### 相關專案

- trinity-cli — 一個 CLI 管三個常駐 agent（Your dot、Grok Bot、Muse）：https://gitlab.com/aa22396584/trinity-cli
- chatgpt-dot-cli — ChatGPT Your dot：https://gitlab.com/aa22396584/chatgpt-dot-cli
- grok-bot-cli（這個 fork，`gbot`）— Grok Bot：https://gitlab.com/aa22396584/grok-bot-cli（鏡像 https://github.com/ImL1s/grok-bot-cli）
- muse-web-cli — 網頁上的 Meta Muse：https://gitlab.com/aa22396584/muse-web-cli

與 trinity-cli 一起用：https://gitlab.com/aa22396584/trinity-cli

### 平台

Linux 單元測試在 grok-box runner 的 CI 跑（`node:22-slim`）。Windows 單元測試在有計算分鐘時跑 GitLab.com 的託管 Windows runner。macOS 在本機確認。追蹤的文字檔維持 LF（`.gitattributes`），Windows checkout 不會把 plugin 指令的 frontmatter 改成 CRLF。Windows 單元測試用 `file://` 載入 MCP client，因為 Node 的 `import()` 不接受 `C:` 路徑。上游的 Codex 與 Claude socket 仍只有 Unix。
