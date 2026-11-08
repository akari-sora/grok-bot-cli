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

`--to` 可以是 `hermes`、`muse`、`dot`。Muse 和 dot 透過 `trinity-cli migrate` 傳送（需要有 `migrate` 指令的 trinity-cli，加上 `muse-web-cli`、`chatgpt-dot-cli`）。

### 抓了什麼（來源端，只讀）

| 項目 | 來源 | 範圍 |
| --- | --- | --- |
| 角色、名稱、說明 | `ListGrokBotAgents` | 完整 |
| 對話紀錄 | `ListGrokBotTranscriptEntries` 用 `beforeSeq` 一頁一頁往回讀到第一則；被省略的內容從 box 存放區的 blob 補回 | **全部**，不是最近 200 則；伺服器刪掉的列以「seq 缺口」列出 |
| 記憶 | box 存放區：這個 bot 自己的 `memory/`、所有 assistant 共用的 `user-memory/`、它加入的專案記憶 | 完整檔案 |
| Skills | box 存放區 `workflows/<名稱>/` 整個資料夾（帳號內所有 bot 共用） | 完整，含附屬檔 |
| 排程（routines） | `ListGrokBotAgentAutomations`（prompt、cron、時區、觸發條件、是否啟用） | 完整 |
| 進行中的任務 | `ListGrokBotAgentTodos`、`ListGrokBotAgentTasks`、`ListGrokBotTasks` | 完整 |
| 必要檔案 | 這個 bot 的附件、assets，以及角色、排程、記憶、對話裡提到的 `/home/box/…`、`/workspace/…` 檔案 | 單檔上限 `--max-file-mb`（預設 8） |
| 群組、隊友、連接器、文件庫 | 名單與設定 | 只列出 |

每一項都寫在存檔的 `REPORT.md` 和 `capture.json` 的 `coverage`：完整、部分、不適用或失敗，失敗會附原因。存檔裡每個檔案都有 SHA-256，開檔時全部重新驗證，多一個或少一個檔都會拒絕。

憑證路徑（`.secrets/`、`.ssh/`、`glab-cli`、`*token*`…）一律不讀；被提到時列為「需要在目的端重新登入」。對話或檔案裡出現的 token（`ghp_…`、`glpat-…`、`sk-…`、JWT、Bearer…）只留在你本機的私人存檔（權限 0600），寫進目的地或送到雲端之前都換成 `[redacted]`。

### 搬到哪裡（三個目的地不一樣）

| | Hermes | Muse | Your dot |
| --- | --- | --- | --- |
| 一個 bot 變成 | 一個新的 Hermes profile（`grok-<bot>`），彼此獨立 | 同一個 Muse 裡的一個專用副聊天室（Muse 只有一個，記憶共用） | 同一個 dot（一個帳號一個收件匣） |
| 持久存放 | profile 本身 | Muse 電腦上的 `~/grok-bot/<bot>/` 檔案，加一條明確要求長期記住的指標 | dot 電腦上的 `~/grok-bot/<bot>/` 檔案，加同樣的指標 |
| 角色 | `SOUL.md` | `ROLE.md` | `ROLE.md` |
| 記憶 | `USER.md`、`MEMORY.md`（用 Hermes 自己的 MemoryStore，必要時調高上限） | `MEMORY.md` 檔 | `MEMORY.md` 檔 |
| 對話紀錄 | 全部匯入成可搜尋的 Hermes session（`session_search`），另有可讀副本 | 最近 30 則存成 `HISTORY.md`；完整的留在存檔 | 同 Muse |
| Skills | `skills/grok-bot-imports/<名稱>/` 整個資料夾 | `SKILLS.md`（名稱與用途） | 同 Muse |
| 排程 | `hermes cron create --paused`（同時區） | `ROUTINES.md`（Muse 的排程沒有暫停狀態） | `ROUTINES.md` |
| 任務 | 記憶裡的「未完成任務」 | `TASKS.md` | `TASKS.md` |
| 檔案 | profile 的 `workspace/grok-bot/grok-box/…` | `~/grok-bot/<bot>/box/…`（小的文字檔） | 同 Muse |
| 讀回 | Hermes 自己的 store：SOUL、記憶、skills、cron、session、檔案雜湊 | 請 Muse 在它電腦上算每個檔的 SHA-256；Memory.md 只列為參考 | 同 Muse（dot 的記憶從外面讀不到） |
| 驗收題問在哪 | `hermes -p` 單次問答 | 新開、看不到搬家訊息的副聊天室，問完刪除 | 同一個收件匣（報告會註明答案可能用到對話上下文） |

排程在 Hermes 一律先暫停：Grok Bot 那份還在跑，兩邊同時開會重複執行。在 Grok Bot 關掉後，用 `hermes -p grok-<bot> cron resume <id>` 打開。Muse／dot 沒有「暫停的排程」，所以只記下內容；要它們直接建排程，用 `--activate-routines`。

### 驗收：不是只看檔案，也不信對方說「存好了」

實際跑過才知道：Muse 和 dot 都會回「saved」，但不一定真的存了（dot 有一次寫 TASKS.md 被自己的審核擋下，仍回 saved；Muse 不把 MR 這類短期狀態放進 Memory.md）。所以：

- **Hermes**：匯入後用 Hermes 自己的程式讀回每一項；再用 `hermes -p` 問它是誰、記得你什麼、有哪些排程與未完成任務、去搜舊對話引用某一則、打開某個 skill、讀某個搬過去的檔案。
- **Muse／dot**：請對方在它自己的電腦上跑一行只讀的指令，貼回每個搬過去的檔案的 SHA-256（忽略空白）。模型不可能從對話算出雜湊，所以對得上就代表檔案真的在、內容一樣；缺的或不一樣的檔案會自動重送一次再驗。其他題目（它知不知道這個 bot、TASKS.md 裡有什麼…）在 Muse 是在新開的副聊天室問，答案只能來自它的記憶和檔案。
- 每題答案都要以題號開頭（`Q1:`…），對方主動發的其他訊息（提醒、簡報）不會被當成答案。答錯的題目會再問一次，兩次的答案都留在報告裡。
- 答案必須含有只有搬過去的資料才有的字（MR 編號、帳號、檔案內容），常見英文詞不算。這些問題會用目的地的模型，會用到一點額度。

Muse／dot 的傳送可中斷續跑：每一步都有 nonce 和 ledger；停了就再跑同一個 `gbot migrate import`，已回覆的步驟跳過，狀態不明的先讀回聊天室，不會盲目重送。

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

`--to` is `hermes`, `muse` or `dot`. Muse and dot are delivered by `trinity-cli migrate` (needs a trinity-cli with the `migrate` command, plus `muse-web-cli` and `chatgpt-dot-cli`).

**Capture (read-only).** Identity from `ListGrokBotAgents`; the whole conversation through `ListGrokBotTranscriptEntries`, paged back with `beforeSeq` to the first row, omitted bodies filled from box-store blobs, server-deleted rows reported as sequence gaps; the three memory tiers from the box store (the bot's own `memory/`, every assistant's shared `user-memory/` shard, joined projects); the whole user skill library (`workflows/<name>/`, shared by all bots); automations with prompt, cron, time zone, trigger and enabled state; todos and tasks; the bot's attachments and assets plus `/home/box/…` and `/workspace/…` files named in its role, routines, memory or conversation (`--max-file-mb`, default 8). Groups, teammates, connectors and library docs are listed. Every area's status is in `REPORT.md` and `capture.json` → `coverage`. Every archived file has a SHA-256 and is re-verified when the archive is opened; extra or missing files are refused.

Credential paths are never read. Token-shaped values stay only in the private local archive (mode 0600) and are replaced with `[redacted]` before anything is written to a destination or sent to a cloud agent.

**Destinations differ.** Hermes: each bot becomes its own new profile (`grok-<bot>`): role → `SOUL.md`; memory → `USER.md`/`MEMORY.md` through Hermes' MemoryStore (limits raised for the new profile when needed); full history → searchable Hermes sessions; whole skill folders → `skills/grok-bot-imports/`; scheduled routines → `hermes cron create --paused`; event routines → `routines-not-scheduled.md`; files → `workspace/grok-bot/grok-box/`. Muse is one agent with shared memory and many chats; a dot is one agent with one inbox. Both keep the durable copy as files on their own computer (`~/grok-bot/<bot>/ROLE.md`, `MEMORY.md`, `TASKS.md`, `ROUTINES.md`, `SKILLS.md`, `HISTORY.md`, and small text files under `box/`), plus one message explicitly asking them to remember a pointer to that folder long-term. Muse gets a side chat per bot.

**Acceptance.** Saying "saved" is not proof: in real runs Muse kept MR state out of Memory.md and a dot's file write was blocked by its own review while it still replied "saved". Hermes is read back through Hermes' own code, then asked questions with `hermes -p`. Muse and dot are asked to run a read-only command on their computer that prints a SHA-256 (whitespace ignored) for every migrated file; a model cannot produce those from the conversation, and a missing or different file is re-sent once and checked again. The other questions go to a fresh Muse side chat that cannot see the migration (deleted afterwards); a dot has one inbox, and the report says so. Every answer must start with its marker (`Q1:` …) so the agent's own alerts are not taken as answers; a failed question is asked once more and both answers are kept. An answer passes only when it contains tokens only the migrated data has.

Muse/dot delivery is resumable and never resends an uncertain message: run the same `gbot migrate import` again.

Exit codes: 0 migrated and verified; 3 imported but something did not verify (see ✗ in the report); 2 usage or missing `--yes`; 1 other errors. The report is written next to the archive.
