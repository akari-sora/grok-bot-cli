# gbot 參考

[English](reference.md) | 繁體中文

安裝、快速開始和搬 bot 在 [README](../README.zh-TW.md)。這頁是其餘的部分。fork 的完整規則在 [FORK.zh-TW.md](../FORK.zh-TW.md)；搬 bot 的細節在 [migration.zh-TW.md](migration.zh-TW.md)。

- [命令總覽](#命令總覽)
- [多個登入](#多個登入)
- [Grok Bot 0.78 伺服器上的 bot](#grok-bot-078-伺服器上的-bot)
- [送達、對帳與結束碼](#送達對帳與結束碼)
- [給 agent 用的整合](#給-agent-用的整合)
- [上游參考](#上游參考)
- [平台與限制](#平台與限制)
- [這個 fork 採用的上游修正](#這個-fork-採用的上游修正)

## 命令總覽

以下命令在這個 fork 都有；`gbot <命令> --help` 列出選項。選項寫在子命令後面；只有 `--json` 也可以寫在前面（`gbot --json thread …`）。`--json` 印出標準 JSON 結果。

```sh
# 登入與雲端電腦
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

# bot、群組與 skill
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

# 訊息
gbot send Researcher "Summarize the launch status."
printf %s 'Exact UTF-8 message' | gbot send Researcher --stdin --json
gbot thread Researcher
gbot --json thread Researcher --normalized --limit 50
gbot thread Researcher --after "<cursor>" --json
gbot reconcile Researcher --nonce "<clientNonce>"
gbot approvals list Researcher
gbot approvals respond --target Researcher --entry-id "<entryId>" --request-id "<requestId>" --decision decline
gbot history Researcher --search timeout

# 搬 bot（migration.zh-TW.md）
gbot migrate
gbot migrate run --bot Researcher --to hermes --yes

# Codex、Claude Code 與 ChatGPT Desktop（與 gbot 同一台機器）
gbot codex status
gbot codex list-threads --query launch --active-within 7d
gbot codex send THREAD_ID "Grok here: the build is green."
gbot codex new --cwd ~/project "Start here"
gbot codex wait THREAD_ID TURN_ID --timeout-ms 1800000
gbot codex bridge status --json
gbot codex desktop-shim status
gbot claude send review "Reply with GBOT_CLAUDE_OK" --json
gbot chatgpt-desktop status

# Wear OS 手錶
gbot wear pair 192.168.1.23:40123
```

`update` 欄位：`--name`、`--description`（App 的 Instructions 欄）、`--title`、`--avatar-shape`、`--avatar-color`、`--notify on|off`、`--hidden on|off`。`gbot skills` 管理這個登入所有 bot 共用的同一個 Skills 庫；`remove` 接受 id 或完整名稱，團隊、plugin 與排程來源的項目會被拒絕。`--normalized` 必須搭配 `--json`，回傳 `{ target, messages: [{ id, role, text }] }`；bot 的回覆常常是 `role: "unknown"`，那仍然是回覆。`send --stdin`、`thread --after` 與 `bots template` 的完整說明見 [FORK.zh-TW.md](../FORK.zh-TW.md#fork-命令)。

## 多個登入

```sh
gbot accounts                                  # 每個已登入的帳號，不含 token
gbot accounts alias work owner@example.com
gbot accounts default work
gbot bots list --account work
gbot config export --out gbot-accounts.json    # 別名與 email，絕不含 token
gbot config import gbot-accounts.json          # 在另一台機器上
```

選擇登入的順序：`GROK_BOT_GATEWAY_URL` 與 `GROK_BOT_GATEWAY_TOKEN` 都有設時用它們；否則依序是 `--account`、`GBOT_ACCOUNT`、設定檔的預設、descriptor 裡唯一一筆或 app-active 的那筆，最後是唯一的已存登入。有多個登入又沒選擇會失敗；選擇器對不到也會失敗，不會改用別的登入。`--account` 要寫在子命令後面。`CURSOR_ACCESS_TOKEN` 只在沒有 App 登入，或那個隱含的登入無法解密或已過期時使用。App 已不再顯示的登入仍然可用：gbot 在記憶體裡用已存的登入建出 session。`gbot doctor` 與 `gbot wear pair` 不用設定檔的預設。完整規則與設定檔位置見 [FORK.zh-TW.md](../FORK.zh-TW.md#登入與多個登入)。

## Grok Bot 0.78 伺服器上的 bot

![gbot 對 Grok Bot 0.78：建立 bot 和群組、送訊、讀回覆、刪除](../demo/gbot-0784-demo.gif)

2026-11-05 用這個 fork 對 Grok Bot 0.78.4 實際錄製：建立 bot 和群組、送訊息、讀 bot 的回覆，最後把兩個都刪掉。[MP4](../demo/gbot-0784-demo.mp4) · tape：[demo/gbot-0784.tape](../demo/gbot-0784.tape)（用真實帳號，會刪掉自己建的東西）。

Grok Bot 0.78.4（2026-11-03）把每個 bot 都放到伺服器上執行。2026-11-05 實測，雲端電腦 gateway 對送訊、建立群組與側欄隱藏回 502，名單留著已刪除的 bot，刪除也沒有作用。Session 有 access token 時，gbot 改用和 App 相同的後端 RPC（`aiserver.v1.GrokBotService`，Connect JSON）：

| 命令 | RPC |
| --- | --- |
| `send` | `SendGrokBotUserMessage` |
| `reconcile` | `GetGrokBotSendStatus`，再讀 transcript 尾端 |
| `bots list`、`groups list`、`get`、名稱查詢 | `ListGrokBotAgents`；通知與隱藏讀 `ListGrokBotAgentStatuses` |
| `bots create` | `CreateGrokBotTemporalAgent` |
| `groups create` | `CreateGrokBotRoom`，再用 `UpdateGrokBotAgent` 設 `--title` 與頭像 |
| `groups set`、`add`、`remove` | `SetGrokBotRoomMembers` |
| `bots update`、`groups update` | `UpdateGrokBotAgent`；`--notify` 與 `--hidden` 用 `SetGrokBotAgentClientState` |
| `bots delete`、`groups delete` | `DeleteGrokBotAgent` |
| `approvals respond` | `ResolveGrokBotAutoReviewApproval` 或 `ResolveGrokBotLocalToolPermission`（照 App 對應，未實測） |
| `thread`、`reconcile` 讀的尾端、relay、`approvals list`、MCP 的 thread 工具 | `ListGrokBotTranscriptEntries` |
| `migrate import`、`migrate run` 加 `--move-routines` | `SetGrokBotAgentAutomationEnabled` `{ agentId, automationId, isEnabled: false, timeZone }`，匯入驗證通過後；`isEnabled: true` 只在目的地打不開、要打開回來時用 |

`thread --root` 與 `skills` 走雲端電腦 gateway；0.78 的主機對它們回 404，這時 `skills list` 改經後端讀 Skills 庫。沒有 access token 的 session（`GROK_BOT_GATEWAY_URL` 加 `GROK_BOT_GATEWAY_TOKEN`，或沒有存 access token 的 descriptor 登入）照舊走 gateway，在 0.78.x 上送訊會收到 502。`bots template` 的 RPC、名單合併、名稱比對、送達狀態與 gateway 實測紀錄見 [FORK.zh-TW.md](../FORK.zh-TW.md#grok-bot-078xbot-改在伺服器上執行)。

## 送達、對帳與結束碼

送出期限 15 秒、讀取 30 秒，都含讀取回應本文。不會自動重試，唯一的例外是喚醒睡眠中的雲端電腦後把同一個請求重試一次；重新導向會被拒絕。送出結果的 `delivery` 是 `accepted`（後端確認收到；沒有 access token 的 session 則是 gateway 確認）、`rejected`，或 `unknown`（逾時、網路失敗、HTTP 408 或 5xx，或沒有確認）。`unknown` 不要重送，改跑 `gbot reconcile <bot> --nonce <clientNonce>`：它先問後端的送出狀態，再到最後 200 筆 transcript 找那個 nonce，永遠不會重送。結果是 `delivered`、`rejected`（附 `rejectionCode`）、`pending`（可能還會送達，不要重送）或 `not-found-in-tail`。

| 命令 | 結束碼 |
| --- | --- |
| 大部分命令 | 0 完成（送出可能是 `delivery: "unknown"` 但仍是 0）；1 參數錯誤或 gateway 失敗（加 `--json` 時，`send`、`wake` 與 `codex` 命令會把失敗以帶 `exitCode` 的 JSON 印在 stdout）；2 未知選項，包括寫在子命令前面的 `--account` |
| `gbot wake` | 0 運作中，或 `--check` 成功；2 參數錯誤；3 喚醒失敗；4 雲端電腦就緒前逾時 |
| `gbot bots template` | 0 看到範本了，或 `--status`、`--show`、`--publish` 成功；3 訊息已送出（或送達未知）但 `--wait` 內沒有出現範本：稍後跑 `--status`，不要再送；1 被拒絕，或什麼都沒送出 |
| `gbot migrate` | 0 搬完並驗證；3 搬了但有項目沒驗過（或 `--move-routines` 有排程沒關掉）；2 選項不合法（什麼都沒做）；1 其他錯誤，包括沒加 `--yes`（什麼都沒匯入） |
| `gbot config import` | 0 已匯入；2 檔案無效（什麼都沒寫）；3 已匯入，但有別名對應的登入不在這台機器上 |
| `gbot wear pair` | 0 配對完成；1–6 與 129/130/143 見 [FORK.zh-TW.md](../FORK.zh-TW.md#配對-wear-os-手錶gbot-wear-pair) |

常見錯誤與處理見 [FORK.zh-TW.md](../FORK.zh-TW.md#疑難排解)。

## 給 agent 用的整合

套件裡有一個名為 `gbot` 的 agent plugin，給 Codex、Claude Code 與 Cursor 用：`grok-bot` MCP server（Grok 訊息、Codex thread、受管理的 Grok ↔ Codex bridge、ChatGPT Desktop）、給 Claude Code 的 `claude-channel` MCP server、`talk-to-grok-bot`、`chatgpt-desktop`、`codex-dot` 與 `migrate-grok-bot` 四個 skill，以及 `/gbot:codex-send`、`/gbot:codex-threads`、`/gbot:codex-wait` 命令。用同一個 release 檔附帶的 `gbot-install` 安裝：

```sh
gbot-install install codex
gbot-install install claude
gbot-install install cursor
gbot-install install grokbot
gbot-install doctor
```

`--replace` 覆寫已安裝的版本；`gbot-install uninstall <host>` 移除。plugin 內含自己的 gateway client 與 worker，不需要 `PATH` 上有 `gbot`。指向上游 GitHub repo 的 plugin marketplace 裝到的是上游的 plugin，沒有這個 fork 的改動。

- `migrate-grok-bot` 替你跑 `gbot migrate`：先預覽、明確同意才匯入、再讀回驗收（[migration.zh-TW.md](migration.zh-TW.md#給-agent-用)）。
- `codex-dot` 把 Codex Desktop 自己的 `codex_app` 工具（`list_threads`、`read_thread`、`send_message_to_thread`）導向 Dot 助理；它不新增 CLI 命令，也不是一個 server。

`gbot-install install grokbot` 把 Cursor 版本整理成一個 marketplace repo，放在 `~/.grokbot/agent-bundle/marketplaces/gbot`（`GROK_BOT_HOME` 可取代 `~/.grokbot`）。如果這台電腦有 Grok Bot 的 plugin 資料，以及它 clone 的 `scriptedalchemy/plugins` marketplace（Grok Bot 的雲端電腦放在 `/home/box/agent-data`），也會把這個 fork 的 plugin 側載進去：在 Grok Bot 已在用的那個 clone commit 裡加上 `gbot/` 資料夾與 `marketplace.json` 的一筆項目，並寫入帶 `.cache-complete` 的 `plugins/cache/scriptedalchemy-plugins/gbot/<commit>/`。資料夾是 `GROK_BOT_AGENT_DATA_DIR`，否則依序找 `/home/box/agent-data`、`~/.grokbot/agent-data`、`~/Library/Application Support/Grok Bot/agent-data` 裡第一個有 `plugins/` 的。找不到資料夾或 clone 時只會整理 marketplace，`--json` 的 `sideload` 欄位會說明原因。寫入的每個路徑都記在安裝收據裡，`uninstall grokbot` 只移除這些路徑。`--sideload-repo <owner/repo>`、`--sideload-slug <slug>`、`--no-sideload`（或 `GROK_BOT_SIDELOAD_REPO`、`GROK_BOT_SIDELOAD_SLUG`、`GROK_BOT_SIDELOAD=0`）可改目標或略過側載；`gbot-install doctor --host grokbot` 回報 plugin（`AB7334`）與側載狀態（`AB7335`）。Grok Bot 的 plugin 同步（啟動、切換登入、每 24 小時）只在帳號的 plugin 清單有列出那個 marketplace 的 gbot 時保留側載的快取；marketplace 換到新 commit 時 Grok Bot 會換掉 clone，這時再跑一次 `gbot-install install grokbot`。這是用暫存的同樣資料夾結構測過的（`test/gbot-install-grokbot.test.js`），沒有在實際的 Grok Bot 上測過。

## 上游參考

這部分取自上游 README 並依這個 fork 修正，只有英文：Claude Code channel、Grok ↔ Codex 自動回覆、Codex thread、ChatGPT Desktop、MCP 工具、gateway 網址規則、本機歷史，見 [reference.md](reference.md#upstream-reference)。

## 平台與限制

| 系統 | Node.js | 狀態 |
| --- | --- | --- |
| macOS | 22.19+（22.x）或 24.2+ | 支援 |
| Linux | 22.19+（22.x） | 支援 |
| Windows | 22.19+（22.x）或 24.2+ | 支援；Codex／Claude channel 與 relay 除外 |

- App 的 session 讀自 `~/Library/Application Support/Grok Bot`（鑰匙圈 `Grok Bot Safe Storage`）、`$XDG_CONFIG_HOME/Grok Bot` 或 `~/.config/Grok Bot`（`secret-tool`，套件 `libsecret-tools`），或 `%APPDATA%\Grok Bot`（DPAPI）。
- Codex、Claude channel 命令與 relay 需要本機 Unix socket；gbot 沒有遠端傳輸。
- gateway 沒有公開文件，隨時可能改變。後端的 `approvals respond`，以及 Linux、Windows 用已存登入喚醒，都已實作但沒有實測。
- gbot 不送遙測資料。本機訊息歷史預設關閉，`GROK_BOT_HISTORY=on` 才會記錄。各平台的測試依據（Linux 在 CI 用 Node 22 與 26，Windows 也在 CI 跑）、隱私與 Windows 限制見 [FORK.zh-TW.md](../FORK.zh-TW.md#平台)。

## 這個 fork 採用的上游修正

從上游 0.11.3–0.12.5 cherry-pick，保留原作者（[CHANGELOG.md](../CHANGELOG.md)）：

- codex-dot skill（026c9fa）；
- Codex 傳給 Grok 的訊息帶寄件者前綴，`codex list-threads` 依最近活動排序並支援 `--query`、`--active-within` 與篩選（c11781b）；
- Codex 送達被拒或 turn 失敗時說明原因，macOS daemon 的開檔上限調高（efe5e4b）；
- 較新的 Codex daemon 上也能用 `codex new --cwd DIR "msg"`（7fa32e1）；
- desktop shim 把啟動、登出、help 與 version 交給真正的 Codex CLI（a86461d）；
- `gbot-install install grokbot` 把 plugin 側載進 Grok Bot 自己的 plugin 資料夾（agent-bundle 0.4.0；eb93aaf、def7ad4）；
- gateway 只回 `{"accepted": true}` 時，以 transcript 裡那筆的 id 當 `messageId`（92bdd62，有調整）；
- client 版本先讀 App 的 `desktop-status.json`（取自 0f29266）；
- 上游 0.12.5 的相依套件更新（MCP server 2.4.0、zod 4.6.7、React 19.3.1）與 CI 的 Node 26。

上游 0.12.x 的 session／重新連線改寫沒有採用：fork 的 0.78 後端、帳號選擇與 `gbot wake` 已經處理這些情況。
