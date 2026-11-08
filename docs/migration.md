# 把 Grok Bot 搬到 Hermes、Muse 或 Your dot

[中文](#中文) · [English](#english)

## 中文

`gbot migrate` 把一個 Grok Bot 整個搬到別的 agent，然後在目的端讀回、再問它問題，確認它真的能接著做事。不是只做備份，也不會只留一包檔案給你自己貼。

```sh
gbot migrate
```

在終端機直接打 `gbot migrate`，會依序問：來源帳號 → 要搬的 bot（可以選多個）→ 目的地 → 顯示差異 → 確認 → 自動匯入、讀回、驗收。每一步都是下面這些普通指令，也可以自己一步一步跑或寫進腳本：

```sh
gbot migrate bots --account A                         # 1. 列出這個登入的 bot
gbot migrate capture --account A --bot "Deploy QA"    # 2. 完整擷取成存檔（只讀）
gbot migrate preview ARCHIVE --to hermes              # 3. 目的地會多出什麼、哪些搬不了
gbot migrate import ARCHIVE --to hermes --yes         # 4. 匯入、讀回、驗收
gbot migrate check ARCHIVE --to hermes --accept       # 之後隨時再驗一次
gbot migrate run --account A --bot "Deploy QA" --to hermes --yes   # 2–4 一次做完
```

`--to` 可以是 `hermes`、`muse`、`dot`。Muse 和 dot 透過 `trinity-cli migrate` 傳送（需要有 `migrate --check-only` 的 trinity-cli，加上 `muse-web-cli`、`chatgpt-dot-cli`，兩者都要有 `send --attach`）。

Muse／dot 的選項（`preview`、`import`、`check`、`run` 都一樣；`check` 要用和 `import` 相同的選項）：

| 選項 | 預設 | 說明 |
| --- | --- | --- |
| `--via auto\|upload\|chat` | `auto` | `upload`：整個交接資料夾壓成一個 zip 附檔，對方解壓。`chat`：一個檔一則訊息。`auto`：放得下就 upload（Muse 256 MB、dot 20 MB），否則 chat |
| `--history full\|recent:N\|none` | upload `full`，chat `recent:30` | 要帶多少對話 |
| `--skills all\|index\|none\|名稱,名稱` | upload `all`，chat `index` | `index` 只帶名稱與用途；Hermes 只接受 `all`、`none` |
| `--folder PATH` | `~/grok-bot/<bot>` | 對方電腦上的資料夾 |

### 抓了什麼（來源端，只讀）

| 項目 | 來源 | 範圍 |
| --- | --- | --- |
| 角色、名稱、說明 | `ListGrokBotAgents` | 完整 |
| 對話紀錄 | `ListGrokBotTranscriptEntries` 用 `beforeSeq` 一頁一頁往回讀，直到空頁或第一則；被省略的內容從 box 存放區的 blob 補回 | **全部**，不是最近 200 則；沒有內容的序號以「seq 缺口」列出（刪除、回滾或沒寫入） |
| 記憶 | box 存放區：這個 bot 自己的 `memory/`、所有 assistant 共用的 `user-memory/`、它加入的專案記憶 | 完整檔案 |
| Skills | box 存放區 `workflows/<名稱>/` 整個資料夾（帳號內所有 bot 共用） | 完整，含附屬檔 |
| 排程（routines） | `ListGrokBotAgentAutomations`（prompt、cron、時區、觸發條件、是否啟用） | 完整 |
| 進行中的任務 | `ListGrokBotAgentTodos`、`ListGrokBotAgentTasks`、`ListGrokBotTasks` | 完整 |
| 必要檔案 | 這個 bot 的附件、assets，以及角色、排程、記憶、對話裡提到的 `/home/box/…`、`/workspace/…` 檔案 | 單檔上限 `--max-file-mb`（預設 8） |
| 群組、隊友、連接器、文件庫 | 名單與設定 | 只列出 |

每一項都寫在存檔的 `REPORT.md` 和 `capture.json` 的 `coverage`：完整、部分、不適用或失敗，失敗會附原因。存檔裡每個檔案都有 SHA-256，開檔時全部重新驗證，多一個或少一個檔都會拒絕。

已知的憑證路徑（`.secrets/`、`.ssh/`、`.npmrc`、`rclone.conf`、`glab-cli`、`*token*`…，同內容換了檔名也算）不讀；被提到時列為「需要在目的端重新登入」。這是一份名單，不是保證。對話或檔案裡出現的已知 token 格式（`ghp_…`、`glpat-…`、`sk-…`、`npm_…`、JWT、Bearer、私鑰…）只留在你本機的私人存檔（權限 0600），寫進目的地或送到雲端之前換成 `[redacted]`；遮不掉的（例如被編碼過的）整個檔案不送，並列在報告裡。

### 搬到哪裡（三個目的地不一樣）

| | Hermes | Muse | Your dot |
| --- | --- | --- | --- |
| 一個 bot 變成 | 一個新的 Hermes profile（`grok-<bot>`），彼此獨立 | 同一個 Muse 裡的一個專用副聊天室（Muse 只有一個，記憶共用） | 同一個 dot（一個帳號一個收件匣） |
| 持久存放 | profile 本身 | Muse 電腦上的交接資料夾 `~/grok-bot/<bot>/`，加一則明確要求長期記住的指標 | dot 電腦上的同樣資料夾，加同樣的指標 |
| 怎麼送過去 | 直接寫進 Hermes 自己的 store | 預設一個 zip 附檔（`muse-web-cli send --attach`，在 Muse 視窗上傳，和手動附檔一樣）；或逐檔訊息 | 預設一個 zip 附檔（`chatgpt-dot-cli send --attach`，和 dot app 一樣先上傳到訊息房間再送）；或逐檔訊息 |
| 角色 | `SOUL.md` | `ROLE.md` | `ROLE.md` |
| 記憶 | `USER.md`、`MEMORY.md`（用 Hermes 自己的 MemoryStore，必要時調高上限） | `MEMORY.md` | `MEMORY.md` |
| 對話紀錄 | 全部（含副對話）匯入成可搜尋的 Hermes session，另有可讀副本 | zip：全部（`HISTORY.md`、`history/`）；逐檔：最近 30 則 | 同 Muse |
| Skills | `skills/grok-bot-imports/<名稱>/` 整個資料夾 | zip：`skills/<名稱>/` 整個資料夾＋`SKILLS.md`；逐檔：`SKILLS.md`（名稱與用途） | 同 Muse |
| 排程 | `hermes cron create --paused`（同時區，名稱帶來源 id） | `ROUTINES.md`（Muse 的排程沒有暫停狀態） | `ROUTINES.md` |
| 任務 | 記憶裡的「未完成任務」 | `TASKS.md` | `TASKS.md` |
| 檔案 | profile 的 `workspace/grok-bot/grok-box/…` | zip：`box/…`（它的資料與用到的檔案）；逐檔：小的文字檔 | 同 Muse |
| 讀回 | Hermes 自己的 store：SOUL、記憶、skills、cron（排程、時區、暫停狀態）、session 內容摘要、檔案雜湊 | 請 Muse 在它電腦上跑一行只讀指令，印出每一部分的加鹽 SHA-256；Memory.md 只列為參考 | 同 Muse（dot 的記憶從外面讀不到） |
| 驗收題問在哪 | `hermes -p` 單次問答 | 新開、看不到搬家訊息的副聊天室，問完只刪這次開的那一個 | 同一個收件匣（報告會註明答案可能用到對話上下文） |

排程在 Hermes 一律先暫停：Grok Bot 那份還在跑，兩邊同時開會重複執行。在 Grok Bot 關掉後，用 `hermes -p grok-<bot> cron resume <id>` 打開。Muse／dot 沒有「暫停的排程」，所以只記下內容；要它們直接建排程，用 `--activate-routines`。

### 驗收：不是只看檔案，也不信對方說「存好了」

實際跑過才知道：Muse 和 dot 都會回「saved」，但不一定真的存了（dot 有一次寫 TASKS.md 被自己的審核擋下，仍回 saved；Muse 不把 MR 這類短期狀態放進 Memory.md）。所以：

- **Hermes**：匯入後用 Hermes 自己的程式讀回每一項；再用 `hermes -p` 問它是誰、記得你什麼、有哪些排程與未完成任務、去搜舊對話引用某一則、打開某個 skill、讀某個搬過去的檔案。
- **Muse／dot**：請對方在它自己的電腦上跑一行只讀的 `python3` 指令。資料夾和一個每次不同的隨機鹽以 base64 傳進去，指令照 `MANIFEST.txt` 把每一部分（每個主要檔案、`box/`、`skills/`、`history/`）算成加鹽的 SHA-256 印出來。沒有那些位元組就算不出來，所以對得上就代表資料夾真的在、內容一樣：zip 比對位元組完全相同；逐檔訊息比對的是去掉空白與反斜線後的內容（對方把聊天文字寫成檔案時會吃掉跳脫用的反斜線）。缺的或不一樣的部分會自動重送一次再驗。
- 其他題目（它知不知道這個 bot、TASKS.md 裡有什麼、第一則對話、某個 skill 的步驟…）在 Muse 是在新開的副聊天室問；dot 只有一個收件匣，報告會註明。
- 每題答案都要以題號開頭（`Q1:`，`Q10:` 不算 `Q1:`），對方主動發的其他訊息（提醒、簡報）不會被當成答案。答錯的題目會再問一次，兩次的答案都留在報告裡。
- 答案必須含有只有搬過去的資料才有的字（MR 編號、帳號、檔案內容）；題目裡已經出現的字不算，常見英文詞也不算。這是行為測試，不是證明：通過代表它找得到並用得上搬過去的資料。這些問題會用目的地的模型，會用到一點額度。

### 送出的節奏與方式

- 一次只送一則，等到回覆才送下一則，兩次送出之間至少隔 20 秒（`trinity-cli migrate --min-interval`）；對方回「太頻繁」就停下，不重送。zip 方式整個搬家只有 2 則訊息加驗收題。
- 請求方式照官方前端：Muse 在 Muse 視窗裡附檔、輸入、按 Enter；dot 照 dot app 的做法先上傳到訊息房間、再送 `content{text, attachments}`、`request_id`、`timezone_offset_min`（不偽造 app 的完整性驗證）；Grok Bot 來源端只用 app 會用的唯讀 RPC，對話每頁 500+1 列、存放區一次 8 個請求，和 app 相同，而且不喚醒 box。

Muse／dot 的傳送可中斷續跑：每一步都有 nonce 和 ledger；停了就再跑同一個 `gbot migrate import`，已回覆的步驟跳過，狀態不明的先讀回聊天室，不會盲目重送。`gbot migrate check` 只讀回和問題目，一則搬家訊息都不送。

### 需要你做的事

- Hermes：沒有。用目前 Hermes 的預設模型與登入。
- Muse：第一次要在 Muse 視窗登入（`muse-web-cli login`），副聊天室要 api 後端（`trinity-cli login muse`）。
- dot：`codex login`。
- 目的端的連接器（GitHub、Slack、Gmail…）和 CLI 登入（glab、gh）要重新連，OAuth 授權不能帶走。

### 結束碼

0 搬完並驗證；3 搬了但有項目沒驗過（看報告裡的 ✗）；2 參數錯誤或沒有 `--yes`；1 其他錯誤。報告寫在存檔旁邊：`<存檔>.<目的地>….report.json`。

## English

`gbot migrate` moves one Grok Bot to another agent, reads the destination back, and asks the migrated agent questions to prove it can carry on with the work. It is not a backup and it does not leave you a bundle to paste by hand.

```sh
gbot migrate
```

In a terminal, `gbot migrate` asks for the source login, the bot (or several), the destination, shows the diff, asks to confirm, then imports, reads back and runs the acceptance checks. Each step is a plain command you can also run yourself:

```sh
gbot migrate bots --account A
gbot migrate capture --account A --bot "Deploy QA"
gbot migrate preview ARCHIVE --to hermes
gbot migrate import ARCHIVE --to hermes --yes
gbot migrate check ARCHIVE --to hermes --accept
gbot migrate run --account A --bot "Deploy QA" --to hermes --yes
```

`--to` is `hermes`, `muse` or `dot`. Muse and dot are delivered by `trinity-cli migrate` (a trinity-cli with `migrate --check-only`, plus `muse-web-cli` and `chatgpt-dot-cli` with `send --attach`).

Muse/dot options (same on `preview`, `import`, `check`, `run`; give `check` the options of the import): `--via auto|upload|chat` (default `auto`: one zip attachment the agent unzips when it fits — Muse 256 MB, dot 20 MB — else file by file), `--history full|recent:N|none` (default: upload `full`, chat `recent:30`), `--skills all|index|none|a,b` (default: upload `all`, chat `index`; Hermes takes `all` or `none`), `--folder PATH` (default `~/grok-bot/<bot>`).

**Capture (read-only).** Identity from `ListGrokBotAgents`; the whole conversation through `ListGrokBotTranscriptEntries`, paged back with `beforeSeq` to the first row, omitted bodies filled from box-store blobs, server-deleted rows reported as sequence gaps; the three memory tiers from the box store (the bot's own `memory/`, every assistant's shared `user-memory/` shard, joined projects); the whole user skill library (`workflows/<name>/`, shared by all bots); automations with prompt, cron, time zone, trigger and enabled state; todos and tasks; the bot's attachments and assets plus `/home/box/…` and `/workspace/…` files named in its role, routines, memory or conversation (`--max-file-mb`, default 8). Groups, teammates, connectors and library docs are listed. Every area's status is in `REPORT.md` and `capture.json` → `coverage`. Every archived file has a SHA-256 and is re-verified when the archive is opened; extra or missing files are refused.

Known credential paths are not read (a name list, not a guarantee; the same bytes under another name count too). Known token formats stay only in the private local archive (mode 0600) and are replaced with `[redacted]` before anything is written to a destination or sent to a cloud agent; a file whose token cannot be replaced in place (an encoded one) is not sent and is listed in the report.

**Destinations differ.** Hermes: each bot becomes its own new profile (`grok-<bot>`): role → `SOUL.md`; memory → `USER.md`/`MEMORY.md` through Hermes' MemoryStore (limits raised for the new profile when needed); the whole history, side conversations included → searchable Hermes sessions; whole skill folders → `skills/grok-bot-imports/`; scheduled routines → `hermes cron create --paused` (tagged with the source id); event routines → `routines-not-scheduled.md`; files → `workspace/grok-bot/grok-box/`. Muse is one agent with shared memory and many chats (each bot gets a side chat); a dot is one agent with one inbox. Both get a handoff folder on their own computer (`~/grok-bot/<bot>/`: README, ROLE, MEMORY, TASKS, ROUTINES, SKILLS, HISTORY, `skills/`, `history/`, `box/`, MANIFEST.txt), sent as one zip attachment by default or file by file in chat, plus one message asking them to remember a pointer to that folder long-term.

**Acceptance.** Saying "saved" is not proof: in real runs Muse kept MR state out of Memory.md and a dot's file write was blocked by its own review while it still replied "saved". Hermes is read back through Hermes' own code (role, memory, skills, cron schedule/time zone/state, per-session content digests, file digests), then asked questions with `hermes -p`. Muse and dot run one read-only `python3` command on their computer; the folder and a fresh random salt arrive base64-encoded, and it prints a salted SHA-256 for each part listed in MANIFEST.txt. Those values need the bytes, so a match shows the folder is there with the same content: exact bytes for a zip, content without whitespace and backslashes for chat delivery (agents drop escape backslashes when they write chat text to a file). A missing or different part is re-sent once and checked again. The other questions go to a fresh Muse side chat that cannot see the migration (only that chat is deleted afterwards); a dot has one inbox, and the report says so. Every answer must start with its marker (`Q1:`; `Q10:` is not `Q1:`) so the agent's own alerts are not taken as answers; a failed question is asked once more and both answers are kept. An answer passes only with a keyword only the migrated data has and the question itself does not contain. This is a behavioural test, not a proof.

**Pace and request style.** One message at a time, each after the previous reply, at least 20 s apart (`trinity-cli migrate --min-interval`); a rate-limit answer stops the run without resending. A zip migration is two messages plus the questions. Requests follow the official front ends: Muse is driven in the Muse window (attach, type, Enter); the dot gets what the dot app sends (room upload, then `content{text, attachments}`, `request_id`, `timezone_offset_min`; the app's integrity attestation is not imitated); the Grok Bot source uses only read RPCs the app uses, pages transcripts at 500+1 rows and reads the store 8 requests at a time like the app, and never wakes the box.

Muse/dot delivery is resumable and never resends an uncertain message: run the same `gbot migrate import` again. `gbot migrate check` only reads back and asks; it sends no migration message.

Exit codes: 0 migrated and verified; 3 imported but something did not verify (see ✗ in the report); 2 usage or missing `--yes`; 1 other errors. The report is written next to the archive.
