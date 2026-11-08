# gbot — Grok Bot CLI (ImL1s fork)

Manage Grok Bot bots, groups and messages from your terminal, and move a bot to Hermes, Muse or Your dot.

在終端機管理 Grok Bot 的 bot、群組和訊息，也能把 bot 搬到 Hermes、Muse 或 Your dot。

[![pipeline](https://gitlab.com/aa22396584/grok-bot-cli/badges/main/pipeline.svg)](https://gitlab.com/aa22396584/grok-bot-cli/-/pipelines)
[![release](https://gitlab.com/aa22396584/grok-bot-cli/-/badges/release.svg)](https://gitlab.com/aa22396584/grok-bot-cli/-/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

- Canonical repository and issues: https://gitlab.com/aa22396584/grok-bot-cli
- Releases and downloads: https://gitlab.com/aa22396584/grok-bot-cli/-/releases
- GitHub mirror: https://github.com/akari-sora/grok-bot-cli (open issues and merge requests on GitLab)

Unofficial: not affiliated with, endorsed by, or supported by xAI, Cursor (Anysphere), or the upstream author. "Grok" and "Grok Bot" belong to their owners. gbot uses your own Grok Bot login and an undocumented gateway that can change or break at any time. Automated use may be limited by the Grok Bot terms; use it at your own risk.

非官方：與 xAI、Cursor（Anysphere）或上游作者沒有關係，也沒有得到他們的背書或支援。「Grok」與「Grok Bot」屬於各自的所有者。gbot 用你自己的 Grok Bot 登入和未公開的 gateway，隨時可能改變或失效。自動化使用可能受 Grok Bot 條款限制，風險自負。

![gbot migrate: a Grok Bot moved to Hermes, read back, and answering from its migrated memory](demo/gbot-migrate-hermes.gif)

`gbot migrate` asks for the login, the bot and the destination, shows what will change, and after you confirm it imports, reads the destination back and asks the migrated bot questions only the migrated data answers. Recorded live on 2026-11-08 with a real bot made for the demo ("Demo · Trip Planner"): Hermes gets a new profile with the bot's role, memory, skill folders, its routine (paused), the whole conversation and its files; every part is read back through Hermes (7/7); then the bot, now in Hermes, says what is still open for the Kyoto trip. [MP4](demo/gbot-migrate-hermes.mp4) · tape: [demo/gbot-migrate-hermes.tape](demo/gbot-migrate-hermes.tape)

`gbot migrate` 會依序問登入、bot、目的地，先列出目的地會多什麼，確認後匯入、從目的地讀回，再問搬過去的 bot 只有搬過去的資料才答得出來的問題。2026-11-08 用為示範建立的真實 bot（Demo · Trip Planner）實際錄製：Hermes 多一個新 profile，含角色、記憶、skill 資料夾、排程（先暫停）、完整對話和檔案，每一項都透過 Hermes 讀回（7/7）；最後搬到 Hermes 的 bot 說出京都行程還有哪件事沒做。

## What this fork adds / 這個 fork 多了什麼

- **Move a bot** (`gbot migrate`): a read-only, complete capture of one Grok Bot (every transcript page, memory, the skill library, routines, tasks, the files it uses), import into Hermes, Muse or Your dot, read-back, and questions to the migrated agent. [docs/migration.md](docs/migration.md)
- **Move to Hermes**: a Grok Bot bot whose instructions run `gbot migrate` on your computer and ask before each command; it can be shared as a Grok Bot template. [docs/move-to-hermes.md](docs/move-to-hermes.md) · [templates/move-to-hermes.md](templates/move-to-hermes.md)
- **Grok Bot 0.78 server-hosted bots**: sends, the roster, rooms, edits, deletes, approvals and `bots create` go through the backend RPCs the 0.78 app uses; `thread`, the `reconcile` tail and the relay read the transcript with `ListGrokBotTranscriptEntries`. [FORK.md](FORK.md#grok-bot-078x-server-hosted-bots)
- **Several logins**: `gbot accounts` lists every login the app has signed in, with aliases, a default, and `gbot config export` / `import` (no tokens) for another machine. [FORK.md](FORK.md#login-and-several-logins)
- **Wake an asleep box**: a call that fails with `BOX_ASLEEP` wakes the box and retries once; `gbot wake` and `gbot wake --check`. [FORK.md](FORK.md#wake-an-asleep-box-gbot-wake)
- **Sends and reads for scripts**: `send --stdin` (exact UTF-8, kept out of the process arguments), `--json thread --normalized`, `thread --after`, and `gbot reconcile` for a send whose delivery is unknown. [FORK.md](FORK.md#fork-commands)
- **Wear OS watch**: `gbot wear pair` sends a login's gateway session to the [Grok Bot Wear](https://gitlab.com/aa22396584/grok-bot-wear) watch app on the same Wi-Fi. [FORK.md](FORK.md#pair-a-wear-os-watch-gbot-wear-pair)
- **Windows and Linux**: unit tests in GitLab CI on both, LF checkouts on Windows, the installed app version read from the Windows registry, and a PowerShell restore script. [FORK.md](FORK.md#platforms)
- **Upstream fixes from 0.11.3–0.12.5**, cherry-picked with their authors: the codex-dot skill (026c9fa); a Codex sender prefix on Codex→Grok messages, and `codex list-threads` sorted by activity with `--query`, `--active-within` and filters (c11781b); the reason for a rejected Codex delivery or a failed turn, and a higher open-file limit for the macOS daemon (efe5e4b); `codex new --cwd DIR "msg"` on newer Codex daemons (7fa32e1); the desktop shim passes startup, sign-out, help and version to the real Codex CLI (a86461d). Upstream's 0.12.x session and reconnect rework is not taken: the fork's 0.78 backend, account selection and `gbot wake` cover that ground. [CHANGELOG.md](CHANGELOG.md)

中文：

- **搬 bot**（`gbot migrate`）：只讀、完整地擷取一個 Grok Bot（每一頁對話、記憶、Skills 庫、排程、任務、它用到的檔案），匯入 Hermes、Muse 或 Your dot，讀回比對，再問搬過去的 agent 驗收題。[docs/migration.md](docs/migration.md)
- **Move to Hermes**：一個 Grok Bot bot，它的指示會在你的電腦上跑 `gbot migrate`，每條命令先徵求同意；可以用 Grok Bot 範本分享。[docs/move-to-hermes.md](docs/move-to-hermes.md) · [templates/move-to-hermes.md](templates/move-to-hermes.md)
- **Grok Bot 0.78：bot 在伺服器上執行**：送訊、名單、群組、修改、刪除、核准與 `bots create` 都改走 0.78 App 用的後端 RPC；`thread`、`reconcile` 讀的尾端與 relay 用 `ListGrokBotTranscriptEntries` 讀對話。[FORK.md](FORK.md#grok-bot-078x-server-hosted-bots)
- **多個登入**：`gbot accounts` 列出 App 登入過的每個帳號，可設別名、預設，並用 `gbot config export`／`import`（不含 token）搬到另一台機器。[FORK.md](FORK.md#login-and-several-logins)
- **喚醒睡眠中的雲端電腦**：呼叫遇到 `BOX_ASLEEP` 時自動喚醒並重試一次；也有 `gbot wake` 與 `gbot wake --check`。[FORK.md](FORK.md#wake-an-asleep-box-gbot-wake)
- **給腳本用的送訊與讀取**：`send --stdin`（UTF-8 原樣送出，不出現在行程參數裡）、`--json thread --normalized`、`thread --after`，以及送達狀態不明時用的 `gbot reconcile`。[FORK.md](FORK.md#fork-commands)
- **Wear OS 手錶**：`gbot wear pair` 把一個登入的 gateway session 送到同一個 Wi-Fi 上的 [Grok Bot Wear](https://gitlab.com/aa22396584/grok-bot-wear) 手錶 App。[FORK.md](FORK.md#pair-a-wear-os-watch-gbot-wear-pair)
- **Windows 與 Linux**：兩個平台都在 GitLab CI 跑單元測試、Windows checkout 維持 LF、從 Windows 登錄檔讀已安裝的 App 版本，另有 PowerShell 還原腳本。[FORK.md](FORK.md#platforms)
- **上游 0.11.3–0.12.5 的修正**（cherry-pick，保留原作者）：codex-dot skill（026c9fa）；Codex 傳給 Grok 的訊息帶寄件者前綴，`codex list-threads` 依最近活動排序並支援 `--query`、`--active-within` 與篩選（c11781b）；Codex 送達被拒或 turn 失敗時說明原因，macOS daemon 的開檔上限調高（efe5e4b）；較新的 Codex daemon 上也能用 `codex new --cwd DIR "msg"`（7fa32e1）；desktop shim 把啟動、登出、help 與 version 交給真正的 Codex CLI（a86461d）。上游 0.12.x 的 session／重新連線改寫沒有採用：fork 的 0.78 後端、帳號選擇與 `gbot wake` 已經處理這些情況。[CHANGELOG.md](CHANGELOG.md)

## Install / 安裝

Requires Node.js `^22.19.0 || >=24.2.0` (22.19+ on 22.x, or 24.2+; Node 23 and 24.0–24.1 lack `import.meta.main`, and the launcher refuses them) and the Grok Bot desktop app, signed in once on the same OS user. Install the package file attached to the GitLab release.

需要 Node.js `^22.19.0 || >=24.2.0`（22.x 的 22.19 以上，或 24.2 以上；Node 23 與 24.0–24.1 沒有 `import.meta.main`，啟動器會拒絕執行），以及在同一個作業系統使用者下登入過一次的 Grok Bot 桌面版。安裝 GitLab release 附的套件檔。

macOS or Linux / macOS 或 Linux：

```sh
curl -fsSL -o grok-bot-cli-0.11.2.tgz "https://gitlab.com/-/project/86401528/uploads/d6d8e60bcb21311e7788b2c492090422/grok-bot-cli-0.11.2.tgz"
npm install -g ./grok-bot-cli-0.11.2.tgz
rm -f grok-bot-cli-0.11.2.tgz
```

Windows PowerShell:

```powershell
irm "https://gitlab.com/-/project/86401528/uploads/d6d8e60bcb21311e7788b2c492090422/grok-bot-cli-0.11.2.tgz" -OutFile grok-bot-cli-0.11.2.tgz
npm install -g .\grok-bot-cli-0.11.2.tgz
Remove-Item grok-bot-cli-0.11.2.tgz
```

```sh
gbot --version   # gbot 0.11.2
```

`gbot --version` prints `gbot 0.11.2`, the upstream package version. The fork revision is the git tag (`v0.11.2-iml1s.N`). Upgrade by installing a newer release's file the same way; uninstall with `npm uninstall -g grok-bot-cli`. Building from a clone and the restore scripts are in [FORK.md](FORK.md#install).

`gbot --version` 印出 `gbot 0.11.2`，這是上游套件版本；fork 的版本看 git 標籤（`v0.11.2-iml1s.N`）。升級就用同樣方式安裝新 release 的檔案；移除用 `npm uninstall -g grok-bot-cli`。從 clone 建置與還原腳本見 [FORK.md](FORK.md#install)。

> [!WARNING]
> Do not run `npm install -g grok-bot-cli`: that npm name is upstream's package, without this fork's changes. Do not install a `git+https://…` spec either: npm exits 0 and leaves a dangling `gbot` link.
>
> 不要執行 `npm install -g grok-bot-cli`：npm 上這個名字是上游的套件，沒有這個 fork 的改動。也不要安裝 `git+https://…`：npm 會以結束碼 0 結束，卻留下斷掉的 `gbot` 連結。

## Quick start / 快速開始

1. Open the Grok Bot desktop app and sign in once. gbot reads the app's encrypted session; there is no token to copy.
2. List the logins, then the bots, send a message and read the thread:

```sh
gbot accounts                                          # the logins the app has signed in
gbot bots list
printf %s 'Summarize the launch status.' | gbot send "<bot>" --stdin
gbot thread "<bot>"
```

With several logins, add `--account <alias|email|label>` after the subcommand, set `GBOT_ACCOUNT`, or set a default with `gbot accounts default <alias>`. `printf %s` sends the text without a trailing newline; `--stdin` rejects surrounding whitespace.

1. 打開 Grok Bot 桌面版並登入一次。gbot 讀 App 已加密的 session，不需要複製 token。
2. 列出登入、列出 bot、送訊息、讀 thread（命令同上）。

有多個登入時，在子命令後面加 `--account <別名|email|標籤>`、設定 `GBOT_ACCOUNT`，或用 `gbot accounts default <別名>` 設預設。`printf %s` 送出的文字結尾不會多一個換行；`--stdin` 會拒絕兩端有空白的內容。

## Move a bot to Hermes, Muse or Your dot / 把 bot 搬到 Hermes、Muse 或 Your dot

New in `v0.11.2-iml1s.7`. Run `gbot migrate` in a terminal for the guided flow (login → bot or bots → destination → preview → confirm → import, read back, questions), or run each step yourself:

`v0.11.2-iml1s.7` 新增。在終端機打 `gbot migrate` 照提示走（登入 → 一個或多個 bot → 目的地 → 預覽 → 確認 → 匯入、讀回、驗收），或自己一步一步跑：

```sh
gbot migrate                                                      # guided / 引導模式
gbot migrate bots --account A                                     # 1. list the bots of a login / 列出 bot
gbot migrate capture --account A --bot "Deploy QA"                # 2. read-only capture / 只讀擷取
gbot migrate preview ARCHIVE --to hermes                          # 3. what the destination gets / 目的地會多什麼
gbot migrate import ARCHIVE --to hermes --yes                     # 4. import, read back, ask / 匯入、讀回、驗收
gbot migrate check ARCHIVE --to hermes --accept                   # check again later / 之後再驗一次
gbot migrate run --account A --bot "Deploy QA" --to hermes --yes  # 2–4 in one go / 一次做完
```

![The same bot moved to Muse and to Your dot: one zip each, checked on their computer](demo/gbot-migrate-muse-dot.gif)

The same bot to Muse and to Your dot: one zip each (4.2 MB, 329 files, two messages), unzipped on the agent's own computer, checked part by part with a salted SHA-256, then asked questions (7/7 on both in the final check; on Muse in a new chat that cannot see the migration; a dot has one inbox, and the report says so). [MP4](demo/gbot-migrate-muse-dot.mp4) · tape: [demo/gbot-migrate-muse-dot.tape](demo/gbot-migrate-muse-dot.tape)

同一個 bot 搬到 Muse 和 Your dot：各一個 zip（4.2 MB、329 個檔、兩則訊息），在對方自己的電腦上解壓，用加鹽 SHA-256 逐部分核對，再問驗收題（最後一次檢查兩邊都 7/7；Muse 在看不到搬家訊息的新聊天室問；dot 只有一個收件匣，報告會註明）。

| Preview / 預覽 | Hermes result / 結果 | Continues the work / 接手工作 |
| --- | --- | --- |
| ![gbot migrate preview for Hermes](demo/gbot-migrate-preview.png) | ![Hermes import result](demo/gbot-migrate-hermes-result.png) | ![The migrated bot in Hermes names the open task](demo/gbot-migrate-hermes-continues.png) |
| **Muse preview / 預覽** | **Muse result / 結果** | **Your dot result / 結果** |
| ![gbot migrate preview for Muse](demo/gbot-migrate-muse-preview.png) | ![Muse import result](demo/gbot-migrate-muse-result.png) | ![Your dot import result](demo/gbot-migrate-dot-result.png) |

**Where it goes.** Hermes: each bot becomes its own new profile (`grok-<bot>`) written through Hermes' own stores: role, memory, the whole history as searchable sessions, whole skill folders, scheduled routines as paused cron jobs, and files. Muse and Your dot: a handoff folder on the agent's own computer (`~/grok-bot/<bot>-<first 8 of its id>/`), plus one message asking it to remember where that folder is. Muse and dot are delivered by `trinity-cli migrate` (trinity-cli v0.5.0+, muse-web-cli v0.1.6+, chatgpt-dot-cli v0.2.6+).

**Options for Muse and dot** (the same on `preview`, `import`, `check` and `run`):

- `--to hermes|muse|dot`: the destination.
- `--via auto|upload|drive|chat`: `auto` (default) sends one zip attachment when it fits (Muse 256 MB, dot 20 MB), else uses your Google Drive when a remote is set, else sends file by file. `drive` needs [rclone](https://rclone.org), `--drive-remote` (or `GBOT_DRIVE_REMOTE`) and the agent's Google Drive connector.
- `--history full|recent:N|none`: how much conversation (upload `full`, chat `recent:30`).
- `--skills all|index|none|a,b`: which skills (`index` is names and purpose only; Hermes takes `all` or `none`).
- `--folder PATH`: the folder on the agent's computer.
- `--activate-routines` (every destination): create the scheduled routines that are on in Grok Bot as active schedules; the Grok Bot copies keep running.
- `--move-routines` (every destination): move them: create them active, then pause them in Grok Bot once the import check passes (`SetGrokBotAgentAutomationEnabled`, one request per routine, never retried). Give `import` the bot's login with `--account`. The guided flow asks when a bot has routines that are on.

**What is checked.** Hermes is read back through Hermes' own code, then asked questions with `hermes -p`. Muse and dot run one read-only command on their computer that prints a salted SHA-256 for each part; then they get questions whose answers need words only the migrated data has. That is a behavioural test, not a proof. Known credential paths are not read, and known token formats are replaced with `[redacted]` before anything leaves the private local archive (a match on known formats, not every secret). Routines start paused in Hermes; after turning the Grok Bot copy off, run `hermes -p grok-<bot> cron resume <id>`, or import with `--move-routines`, which turns them on at the destination and pauses them in Grok Bot only after the import verified (nothing is paused when it did not; turn one back on in the Grok Bot app: Routines → toggle). Exit codes: 0 migrated and verified, 3 imported but something did not verify (or a routine was not paused), 2 usage or missing `--yes`, 1 other errors.

**Without a terminal.** The **Move to Hermes** bot asks before each command and runs `gbot migrate` on your computer. Add it from its public template: https://x.ai/bot/y2AFnYLdbz5T66loRBHar. Create it with `gbot bots create --name "Move to Hermes" --description "$(cat templates/move-to-hermes.md)"`, or share it as a Grok Bot template: `gbot bots template "Move to Hermes"` prints the x.ai link, `--show` reviews the draft and `--publish` publishes it ([docs/move-to-hermes.md](docs/move-to-hermes.md)). It moves bots to Hermes only.

Guide, destination differences and limits: [docs/migration.md](docs/migration.md). The real-run record (a 903-row bot and the demo bot, all three destinations): [docs/verification/2026-11-08-full-migration.md](docs/verification/2026-11-08-full-migration.md).

**搬到哪裡。** Hermes：每個 bot 變成一個新的 profile（`grok-<bot>`），透過 Hermes 自己的 store 寫入：角色、記憶、完整對話（可搜尋的 session）、整個 skill 資料夾、排程（暫停的 cron job）與檔案。Muse 和 Your dot：在對方自己的電腦上放一個交接資料夾（`~/grok-bot/<bot>-<id 前 8 碼>/`），再加一則訊息請它長期記住資料夾在哪。Muse 和 dot 透過 `trinity-cli migrate` 傳送（trinity-cli v0.5.0 以上、muse-web-cli v0.1.6 以上、chatgpt-dot-cli v0.2.6 以上）。

**Muse／dot 的選項**（`preview`、`import`、`check`、`run` 都一樣）：

- `--to hermes|muse|dot`：目的地。
- `--via auto|upload|drive|chat`：`auto`（預設）放得下就送一個 zip 附檔（Muse 256 MB、dot 20 MB），否則有設 remote 就經你的 Google Drive，再不然逐檔送。`drive` 需要 [rclone](https://rclone.org)、`--drive-remote`（或 `GBOT_DRIVE_REMOTE`），以及對方接好的 Google Drive 連接器。
- `--history full|recent:N|none`：帶多少對話（upload 預設 `full`，chat 預設 `recent:30`）。
- `--skills all|index|none|a,b`：帶哪些 skill（`index` 只帶名稱與用途；Hermes 只接受 `all` 或 `none`）。
- `--folder PATH`：對方電腦上的資料夾。
- `--activate-routines`（三個目的地都適用）：Grok Bot 裡開著的定時排程，在目的地建成啟用的；Grok Bot 那份照樣在跑。
- `--move-routines`（三個目的地都適用）：搬排程：在目的地建成啟用的，匯入的檢查通過後再在 Grok Bot 關掉（`SetGrokBotAgentAutomationEnabled`，一個排程一個請求，不會重試）。`import` 要用 `--account` 指定這個 bot 的登入。引導模式遇到有開著排程的 bot 會問。

**怎麼驗。** Hermes 用 Hermes 自己的程式讀回，再用 `hermes -p` 問問題。Muse 和 dot 在它們的電腦上跑一行只讀指令，印出每一部分的加鹽 SHA-256；接著問只有搬過去的資料才答得出來的問題。這是行為測試，不是證明。已知的憑證路徑不讀；已知格式的 token 在離開本機私人存檔前換成 `[redacted]`（只比對已知格式，不是所有秘密都認得出來）。排程在 Hermes 預設先暫停；在 Grok Bot 關掉原本那份後，用 `hermes -p grok-<bot> cron resume <id>` 打開；或匯入時加 `--move-routines`：在目的地打開，匯入驗證通過後才在 Grok Bot 關掉（沒通過就一個都不關；要重新打開，在 Grok Bot App：Routines → 切換開關）。結束碼：0 搬完並驗證；3 搬了但有項目沒驗過（或有排程沒關掉）；2 參數錯誤或沒有 `--yes`；1 其他錯誤。

**不開終端機。** **Move to Hermes** bot 會在你的電腦上逐條徵求同意、替你跑 `gbot migrate`。從公開範本加入：https://x.ai/bot/y2AFnYLdbz5T66loRBHar。用上面的 `gbot bots create` 命令建立，或用 Grok Bot 範本分享：`gbot bots template "Move to Hermes"` 會印出 x.ai 連結，`--show` 檢查草稿，`--publish` 發布（見 [docs/move-to-hermes.md](docs/move-to-hermes.md)）。它只搬到 Hermes。

使用說明、三個目的地的差異與限制見 [docs/migration.md](docs/migration.md)；實際執行紀錄（一個 903 列對話的 bot 和示範 bot，三個目的地）見 [docs/verification/2026-11-08-full-migration.md](docs/verification/2026-11-08-full-migration.md)。

## Grok Bot 0.78: server-hosted bots / Grok Bot 0.78：bot 在伺服器上執行

![gbot on Grok Bot 0.78: create a bot and a group, send, read the reply, delete](demo/gbot-0784-demo.gif)

Recorded live on 2026-11-05 against Grok Bot 0.78.4 with this fork: create a bot and a group, send a message, read the bot's reply, then delete both. [MP4](demo/gbot-0784-demo.mp4) · tape: [demo/gbot-0784.tape](demo/gbot-0784.tape) (it uses a real account and deletes what it creates).

2026-11-05 用這個 fork 對 Grok Bot 0.78.4 實際錄製：建立 bot 和群組、送訊息、讀 bot 的回覆，最後把兩個都刪掉。

Grok Bot 0.78.4 (2026-11-03) hosts every bot on the server. On 2026-11-05 its box gateway answered sends, group creation and sidebar hiding with 502, kept deleted bots in its roster, and deleted nothing. When the session has an access token, gbot calls the same backend RPCs as the app (`aiserver.v1.GrokBotService`, Connect JSON):

Grok Bot 0.78.4（2026-11-03）把每個 bot 都放到伺服器上執行。2026-11-05 實測，雲端電腦 gateway 對送訊、建立群組與側欄隱藏回 502，名單留著已刪除的 bot，刪除也沒有作用。Session 有 access token 時，gbot 改用和 App 相同的後端 RPC（`aiserver.v1.GrokBotService`，Connect JSON）：

| Command / 命令 | RPC |
| --- | --- |
| `send` | `SendGrokBotUserMessage` |
| `reconcile` | `GetGrokBotSendStatus`, then the transcript tail / 再讀 transcript 尾端 |
| `bots list`, `groups list`, `get`, name lookups / 名稱查詢 | `ListGrokBotAgents`; notify and hidden from `ListGrokBotAgentStatuses` |
| `bots create` | `CreateGrokBotTemporalAgent` |
| `groups create` | `CreateGrokBotRoom`, then `UpdateGrokBotAgent` for `--title` and the avatar |
| `groups set`, `add`, `remove` | `SetGrokBotRoomMembers` |
| `bots update`, `groups update` | `UpdateGrokBotAgent`; `--notify` and `--hidden` with `SetGrokBotAgentClientState` |
| `bots delete`, `groups delete` | `DeleteGrokBotAgent` |
| `approvals respond` | `ResolveGrokBotAutoReviewApproval` or `ResolveGrokBotLocalToolPermission` (mapped from the app, not live-tested / 照 App 對應，未實測) |
| `thread`, the `reconcile` tail, the relay, `approvals list`, the MCP thread tool | `ListGrokBotTranscriptEntries` |
| `migrate import`, `migrate run` with `--move-routines` | `SetGrokBotAgentAutomationEnabled` `{ agentId, automationId, isEnabled: false, timeZone }`, after the import verified / 匯入驗證通過後 |

`thread --root` and `skills` stay on the box gateway. A session without an access token (`GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN`, or a descriptor login with no saved access token) keeps the gateway calls, and on 0.78.x its sends get the 502. Roster merge, name matching, delivery states and the live gateway observations: [FORK.md](FORK.md#grok-bot-078x-server-hosted-bots).

`thread --root` 與 `skills` 仍走雲端電腦 gateway。沒有 access token 的 session（`GROK_BOT_GATEWAY_URL` 加 `GROK_BOT_GATEWAY_TOKEN`，或沒有存 access token 的 descriptor 登入）照舊走 gateway，在 0.78.x 上送訊會收到 502。名單合併、名稱比對、送達狀態與 gateway 實測紀錄見 [FORK.md](FORK.md#grok-bot-078x-server-hosted-bots)。

## Several logins / 多個登入

```sh
gbot accounts                                  # every signed-in login, no tokens
gbot accounts alias work owner@example.com
gbot accounts default work
gbot bots list --account work
gbot config export --out gbot-accounts.json    # aliases and emails, never tokens
gbot config import gbot-accounts.json          # on another machine
```

Commands pick the login in this order: `GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN` when both are set; otherwise `--account`, then `GBOT_ACCOUNT`, then the config default, then the descriptor's single or app-active entry, then the only saved login. Several logins and no choice is an error, and a selector that does not resolve fails without switching to another login. `--account` goes after the subcommand. `CURSOR_ACCESS_TOKEN` is used only when there is no app login, or when that implicit login cannot be decrypted or is expired. A login the app no longer shows still works: gbot builds a session from the saved login in memory. `gbot doctor` and `gbot wear pair` do not use the config default. Full rules and the config file location: [FORK.md](FORK.md#login-and-several-logins).

選擇登入的順序：`GROK_BOT_GATEWAY_URL` 與 `GROK_BOT_GATEWAY_TOKEN` 都有設時用它們；否則依序是 `--account`、`GBOT_ACCOUNT`、設定檔的預設、descriptor 裡唯一一筆或 app-active 的那筆，最後是唯一的已存登入。有多個登入又沒選擇會失敗；選擇器對不到也會失敗，不會改用別的登入。`--account` 要寫在子命令後面。`CURSOR_ACCESS_TOKEN` 只在沒有 App 登入，或那個隱含的登入無法解密或已過期時使用。App 已不再顯示的登入仍然可用：gbot 在記憶體裡用已存的登入建出 session。`gbot doctor` 與 `gbot wear pair` 不用設定檔的預設。完整規則與設定檔位置見 [FORK.md](FORK.md#login-and-several-logins)。

## Command reference / 命令總覽

Every command below exists in this fork; `gbot <command> --help` shows its options. Options are command-local and go after the subcommand; only `--json` may also come first (`gbot --json thread …`). `--json` prints the canonical JSON result.

以下命令在這個 fork 都有；`gbot <命令> --help` 列出選項。選項寫在子命令後面；只有 `--json` 也可以寫在前面（`gbot --json thread …`）。`--json` 印出標準 JSON 結果。

```sh
# Logins and the box / 登入與雲端電腦
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

# Bots, groups and skills / bot、群組與 skill
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

# Messages / 訊息
gbot send Researcher "Summarize the launch status."
printf %s 'Exact UTF-8 message' | gbot send Researcher --stdin --json
gbot thread Researcher
gbot --json thread Researcher --normalized --limit 50
gbot thread Researcher --after "<cursor>" --json
gbot reconcile Researcher --nonce "<clientNonce>"
gbot approvals list Researcher
gbot approvals respond --target Researcher --entry-id "<entryId>" --request-id "<requestId>" --decision decline
gbot history Researcher --search timeout

# Move a bot / 搬 bot
gbot migrate
gbot migrate run --bot Researcher --to hermes --yes

# Codex, Claude Code and ChatGPT Desktop (on the same machine as gbot / 與 gbot 同一台機器)
gbot codex status
gbot codex list-threads --query launch --active-within 7d
gbot codex send THREAD_ID "Grok here: the build is green."
gbot codex new --cwd ~/project "Start here"
gbot codex wait THREAD_ID TURN_ID --timeout-ms 1800000
gbot codex bridge status --json
gbot codex desktop-shim status
gbot claude send review "Reply with GBOT_CLAUDE_OK" --json
gbot chatgpt-desktop status

# Wear OS watch / 手錶
gbot wear pair 192.168.1.23:40123
```

`update` fields: `--name`, `--description` (the app's Instructions field), `--title`, `--avatar-shape`, `--avatar-color`, `--notify on|off`, `--hidden on|off`. `gbot skills` manages the one skill library every bot of the login shares; `remove` takes an id or exact name and refuses team, plugin and routine entries. `--normalized` needs `--json` and returns `{ target, messages: [{ id, role, text }] }`; a bot reply often has `role: "unknown"`, which is still a reply.

`update` 欄位：`--name`、`--description`（App 的 Instructions 欄）、`--title`、`--avatar-shape`、`--avatar-color`、`--notify on|off`、`--hidden on|off`。`gbot skills` 管理這個登入所有 bot 共用的同一個 Skills 庫；`remove` 接受 id 或完整名稱，團隊、plugin 與排程來源的項目會被拒絕。`--normalized` 必須搭配 `--json`，回傳 `{ target, messages: [{ id, role, text }] }`；bot 的回覆常常是 `role: "unknown"`，那仍然是回覆。

## Agent integrations / 給 agent 用的整合

**Moving a bot with an agent.** The plugin's `migrate-grok-bot` skill lets Claude Code, Codex or Cursor run `gbot migrate` for you: preview first, import only after your yes, then read back and check ([docs/migration.md](docs/migration.md#for-agents-claude-code-codex-cursor)). 外掛裡的 `migrate-grok-bot` skill 讓 Claude Code、Codex 或 Cursor 替你跑 `gbot migrate`：先預覽、等你同意才匯入、再讀回驗收。

The package also carries an agent plugin named `gbot` for Codex, Claude Code and Cursor: a `grok-bot` MCP server (Grok messages, Codex threads, the managed Grok ↔ Codex bridge, ChatGPT Desktop), a `claude-channel` MCP server for Claude Code, the `talk-to-grok-bot`, `chatgpt-desktop` and `codex-dot` skills, and the `/gbot:codex-send`, `/gbot:codex-threads` and `/gbot:codex-wait` commands. Install it with `gbot-install`, which comes with the same release file:

套件裡也有一個名為 `gbot` 的 agent plugin，給 Codex、Claude Code 與 Cursor 用：`grok-bot` MCP server（Grok 訊息、Codex thread、受管理的 Grok ↔ Codex bridge、ChatGPT Desktop）、給 Claude Code 的 `claude-channel` MCP server、`talk-to-grok-bot`、`chatgpt-desktop` 與 `codex-dot` 三個 skill，以及 `/gbot:codex-send`、`/gbot:codex-threads`、`/gbot:codex-wait` 命令。用同一個 release 檔附帶的 `gbot-install` 安裝：

```sh
gbot-install install codex
gbot-install install claude
gbot-install install cursor
gbot-install doctor
```

`--replace` overwrites an existing copy; `gbot-install uninstall <host>` removes it. The plugin bundles its own gateway client and worker, so it does not need `gbot` on `PATH`. Plugin marketplaces that point at the upstream GitHub repository install upstream's plugin, without this fork's changes. The `codex-dot` skill routes Codex Desktop's own `codex_app` tools (`list_threads`, `read_thread`, `send_message_to_thread`) to the Dot assistant; it does not add a CLI command or a server.

`--replace` 覆寫已安裝的版本；`gbot-install uninstall <host>` 移除。plugin 內含自己的 gateway client 與 worker，不需要 `PATH` 上有 `gbot`。指向上游 GitHub repo 的 plugin marketplace 裝到的是上游的 plugin，沒有這個 fork 的改動。`codex-dot` skill 把 Codex Desktop 自己的 `codex_app` 工具（`list_threads`、`read_thread`、`send_message_to_thread`）導向 Dot 助理；它不新增 CLI 命令，也不是一個 server。以下參考資料為英文，取自上游 README 並依這個 fork 修正。

<details>
<summary>Reference: Claude Code channel, Grok ↔ Codex replies, Codex threads, ChatGPT Desktop, MCP tools, gateway URL policy, local history</summary>

#### Messaging a live Claude Code session

Claude Code has a native [Channels API](https://code.claude.com/docs/en/channels-reference), so this needs no desktop shim. The Claude plugin includes an opt-in `claude-channel` MCP server; Codex and Grok callers use `claude_send`, or `gbot claude send`, to send a message and receive Claude's explicit reply. Channels live on the machine that runs Claude Code, not on the Grok Bot box (`HOME=/home/box`). gbot has no remote transport: from the box, run `gbot claude send` on that computer through Grok Bot Shell with a machineId.

After `gbot-install install claude`, start a named session:

```sh
GROK_BOT_CLAUDE_CHANNEL=review claude --dangerously-load-development-channels plugin:gbot@gbot-marketplace
# From another terminal on the same machine and OS user:
gbot claude send review "Reply with GBOT_CLAUDE_OK" --json
```

Accept Claude's development-channel prompt. Custom channels are a research preview and need session opt-in and any applicable organization policy. The development flag permits this channel; it does not bypass tool approvals. `claude_send` takes `name`, `message` and optional `timeoutMs` (default 60000, maximum 120000). Claude answers with `claude_reply` and the incoming `request_id`; only that reply completes the call, and a notification alone is not proof. Timeout or disconnect returns `unknown`; do not resend automatically.

Each name selects one live session. Sockets live in `~/.grok-bot-cli/claude/` (directory 0700, sockets 0600) and reach local processes of the same OS user only. No TCP listener, automatic approval, history scraping or background daemon is installed. Without `GROK_BOT_CLAUDE_CHANNEL` the channel is off. A second session with the same name fails rather than taking over the first. A crashed process can leave a socket: confirm the named session is stopped before removing it.

#### Automatic Grok ↔ Codex replies

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

Relay state lives in `~/.grok-bot-cli/relay/` (or `GROK_BOT_RELAY_DIR`), with a separate worker and session per resolved login. A pinned directory whose stored profile does not match refuses to start with `Relay profile mismatch`; upgrade steps are in [FORK.md](FORK.md#verify-upgrade-uninstall). `gbot codex bridge run --lifetime-ms N` runs the relay in the foreground for up to 23 hours; the packaged `dist/scripts/gbot-relay.mjs` runs without that limit. Network reconnects are automatic; a dead worker needs a new tracked send or `bridge start`.

#### Codex threads (`gbot codex`)

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
- Busy threads: only `idle` and `notLoaded` threads start a turn. An `active` thread is refused with `reason: "busy"` unless you pass `--when-busy queue` (needs `GROK_BOT_CODEX_EXPERIMENTAL=1`; `gbot codex queue THREAD_ID` shows what waits) or `--when-busy steer` with `--expected-turn-id`. `systemError` is `reason: "thread-error"`, usually an unhealthy daemon. Decision record: [docs/codex-busy-threads.md](docs/codex-busy-threads.md).
- Receipts: `delivery` is `accepted` (turn started), `queued`, `rejected` (nothing was sent; `reason` says why), or `unknown` (look for `messageId` in the thread before resending). A failed turn also says why.
- Every send carries `messageId`, `correlationId`, optional `replyTo` and `hop`. Sends at `hop >= GROK_BOT_MAX_HOPS` (default 4) are refused, which stops two agents from acknowledging each other forever. `GROK_BOT_CODEX_THREADS=id,id` limits sends to approved threads.
- gbot never approves commands or file changes: an approval request during `send` is refused (`approval-refused`). For unattended sends set `approval_policy = "never"` in the daemon's `config.toml`.
- Codex must run on the same machine as gbot; gbot has no remote transport. From the Grok Bot box, run `gbot` on your computer through Grok Bot Shell with a machineId. Native Windows is not supported (Unix socket); use WSL, Linux or macOS. `gbot codex status --json` reports `socketState`, `mode`, the daemon and CLI versions, and `exitCode` (0 only for a usable daemon).

#### ChatGPT Desktop

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

`gbot chatgpt-desktop` drives Desktop over local CDP (`127.0.0.1` only). List, search and read prefer the Codex app-server; send, new chats and waits use CDP. Results report `backend: "cdp" | "app-server"`. Details: [docs/chatgpt-desktop-cdp.md](docs/chatgpt-desktop-cdp.md).

#### MCP tools

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

#### Gateway URL policy

gbot sends credentials only to expected hosts:

- Gateway URLs (box and API): `https` on `*.cursor.sh`, `*.cursor.com` or `*.cursorvm.com`.
- Backend URLs (`EnsureSandBox`, the 0.78 RPCs, `CURSOR_API_BASE_URL`): `https` on `*.cursor.sh` or `*.cursor.com` only, never `*.cursorvm.com`.
- `GROK_BOT_ALLOW_LOCAL_GATEWAY=1` permits `127.0.0.1`, `localhost` and `::1` for gateways only, with a stderr warning.
- `GROK_BOT_ALLOW_ANY_GATEWAY=1` disables host checks for a gateway URL and a user-supplied `CURSOR_ACCESS_TOKEN` (break-glass only). It does not apply to the app login token, which goes only to an https Cursor API host.

All gateway and backend fetches reject redirects, so credentials are not followed across them.

#### Local history

Recording is opt-in. With `GROK_BOT_HISTORY=on`, successful `send` and `thread` observations are appended as plain-text JSONL to `~/.grok-bot-cli/history.jsonl` (`--history-dir` or `GROK_BOT_HISTORY_DIR` moves it; `--no-history` skips one command). New directories are 0700 and files 0600. Message text is kept as typed; credentials and raw response metadata are not.

```sh
export GROK_BOT_HISTORY=on
gbot send Researcher "Investigate the startup timeout"
gbot history Researcher --search timeout
gbot history --path
```

</details>

## Delivery, reconcile and exit codes / 送達、對帳與結束碼

Sends have a 15-second deadline and reads 30 seconds, both including the response body. There is no automatic retry, except one retry of the same request after waking an asleep box; redirects are rejected. A send result has `delivery`: `accepted` (the backend confirmed it, or for a session without an access token the gateway did), `rejected`, or `unknown` (timeout, network failure, HTTP 408 or 5xx, or no confirmation). Do not resend an unknown send. Run `gbot reconcile <bot> --nonce <clientNonce>`: it asks the backend send status, then looks for that nonce in the last 200 transcript entries, and never sends. The answer is `delivered`, `rejected` (with `rejectionCode`), `pending` (it may still land; do not resend), or `not-found-in-tail`.

送出期限 15 秒、讀取 30 秒，都含讀取回應本文。不會自動重試，唯一的例外是喚醒睡眠中的雲端電腦後把同一個請求重試一次；重新導向會被拒絕。送出結果的 `delivery` 是 `accepted`（後端確認收到；沒有 access token 的 session 則是 gateway 確認）、`rejected`，或 `unknown`（逾時、網路失敗、HTTP 408 或 5xx，或沒有確認）。`unknown` 不要重送，改跑 `gbot reconcile <bot> --nonce <clientNonce>`：它先問後端的送出狀態，再到最後 200 筆 transcript 找那個 nonce，永遠不會重送。結果是 `delivered`、`rejected`（附 `rejectionCode`）、`pending`（可能還會送達，不要重送）或 `not-found-in-tail`。

| Command / 命令 | Exit codes / 結束碼 |
| --- | --- |
| most commands / 大部分命令 | 0 done (a send can be `delivery: "unknown"` and still exit 0); 1 usage error or gateway failure (with `--json`, `send`, `wake` and the `codex` commands print the failure as a JSON document with `exitCode` on stdout); 2 unknown option, including `--account` before the subcommand |
| `gbot wake` | 0 running, or `--check` succeeded; 2 usage; 3 could not wake; 4 timed out before the box was ready |
| `gbot bots template` | 0 the template was seen, or `--status`, `--show` or `--publish` succeeded; 3 the message went out (or its delivery is unknown) but no template appeared within `--wait`: run `--status` later, do not send again; 1 rejected, or nothing sent |
| `gbot migrate` | 0 migrated and verified; 3 imported but something did not verify; 2 usage or missing `--yes`; 1 other errors |
| `gbot config import` | 0 imported; 2 invalid file (nothing written); 3 imported, but some aliased logins are not signed in on this machine |
| `gbot wear pair` | 0 paired; 1–6 and 129/130/143 as listed in [FORK.md](FORK.md#pair-a-wear-os-watch-gbot-wear-pair) |

Common errors and fixes: [FORK.md](FORK.md#troubleshooting). 常見錯誤與處理見 [FORK.md](FORK.md#troubleshooting)。

## Platforms and limits / 平台與限制

| OS / 系統 | Node.js | Status / 狀態 |
| --- | --- | --- |
| macOS | 22.19+ (22.x) or 24.2+ | Supported / 支援 |
| Linux | 22.19+ (22.x) | Supported / 支援 |
| Windows | 22.19+ (22.x) or 24.2+ | Supported except Codex/Claude channels and the relay / 支援；Codex／Claude channel 與 relay 除外 |

- The app session is read from `~/Library/Application Support/Grok Bot` (Keychain `Grok Bot Safe Storage`), `$XDG_CONFIG_HOME/Grok Bot` or `~/.config/Grok Bot` (`secret-tool`, package `libsecret-tools`), or `%APPDATA%\Grok Bot` (DPAPI).
- Codex and Claude channel commands and the relay need a local Unix socket; gbot has no remote transport.
- The gateway is undocumented and can change. `approvals respond` on the backend, and the Linux and Windows saved-login wake, are implemented but not live-tested.
- gbot sends no telemetry. Local message history is off unless `GROK_BOT_HISTORY=on`. Test evidence per OS, privacy and Windows limitations: [FORK.md](FORK.md#platforms).

- App 的 session 讀自 `~/Library/Application Support/Grok Bot`（鑰匙圈 `Grok Bot Safe Storage`）、`$XDG_CONFIG_HOME/Grok Bot` 或 `~/.config/Grok Bot`（`secret-tool`，套件 `libsecret-tools`），或 `%APPDATA%\Grok Bot`（DPAPI）。
- Codex、Claude channel 命令與 relay 需要本機 Unix socket；gbot 沒有遠端傳輸。
- gateway 沒有公開文件，隨時可能改變。後端的 `approvals respond`，以及 Linux、Windows 用已存登入喚醒，都已實作但沒有實測。
- gbot 不送遙測資料。本機訊息歷史預設關閉，`GROK_BOT_HISTORY=on` 才會記錄。各平台的測試依據、隱私與 Windows 限制見 [FORK.md](FORK.md#platforms)。

## Related projects / 相關專案

- [trinity-cli](https://gitlab.com/aa22396584/trinity-cli): one CLI over three always-on agents (Your dot, Grok Bot, Muse); it delivers `gbot migrate` to Muse and Your dot. / 一個 CLI 管三個常駐 agent（Your dot、Grok Bot、Muse），也負責把 `gbot migrate` 送到 Muse 和 Your dot。
- [muse-web-cli](https://gitlab.com/aa22396584/muse-web-cli): Meta Muse via the web. / 網頁上的 Meta Muse。
- [chatgpt-dot-cli](https://gitlab.com/aa22396584/chatgpt-dot-cli): ChatGPT Your dot.
- [grok-bot-wear](https://gitlab.com/aa22396584/grok-bot-wear): Grok Bot on a Wear OS watch, paired with `gbot wear pair`. / Wear OS 手錶上的 Grok Bot，用 `gbot wear pair` 配對。

## Credits and license / 致謝與授權

Fork of [ScriptedAlchemy/grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli) by Zack Jackson (MIT), synced to upstream 0.11.2 with selected later fixes. The fork's changes are MIT as well ([LICENSE](LICENSE)). Report fork bugs on GitLab, not upstream. Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md). Fork guide: [FORK.md](FORK.md). Changes: [CHANGELOG.md](CHANGELOG.md).

這是 Zack Jackson 的 [ScriptedAlchemy/grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli)（MIT）的 fork，同步到上游 0.11.2，並挑選了之後的修正。fork 的改動同樣採用 MIT（[LICENSE](LICENSE)）。fork 的問題回報到 GitLab，不要回報給上游。參與開發見 [CONTRIBUTING.md](CONTRIBUTING.md)，安全問題見 [SECURITY.md](SECURITY.md)，fork 說明見 [FORK.md](FORK.md)，變更紀錄見 [CHANGELOG.md](CHANGELOG.md)。
