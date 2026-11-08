# 把 Grok Bot 搬到 Hermes、Muse 或 Your dot

[English](migration.md) | 繁體中文

`gbot migrate`（`v0.11.2-iml1s.7` 新增）把一個 Grok Bot 整個搬到別的 agent，然後在目的端讀回、再問它問題，確認它真的能接著做事。不是只做備份，也不會只留一包檔案給你自己貼。示範與截圖見 [README](../README.zh-TW.md#把-bot-搬到-hermesmuse-或-your-dot)。

## 步驟

在終端機直接打 `gbot migrate`，會依序問：來源帳號 → 要搬的 bot（可以選多個）→ 目的地 → 顯示差異 → 確認 → 自動匯入、讀回、驗收。每一步都是下面這些普通指令，也可以自己一步一步跑或寫進腳本：

```sh
gbot migrate                                                      # 引導模式
gbot migrate bots --account A                                     # 1. 列出這個登入的 bot
gbot migrate capture --account A --bot "Deploy QA"                # 2. 完整擷取成存檔（只讀）
gbot migrate preview ARCHIVE --to hermes                          # 3. 目的地會多出什麼、哪些搬不了
gbot migrate import ARCHIVE --to hermes --yes                     # 4. 匯入、讀回、驗收
gbot migrate check ARCHIVE --to hermes --accept                   # 之後隨時再驗一次
gbot migrate run --account A --bot "Deploy QA" --to hermes --yes  # 2–4 一次做完
```

`--to` 可以是 `hermes`、`muse`、`dot`。Muse 和 dot 透過 `trinity-cli migrate` 傳送（需要 trinity-cli v0.5.0 以上，加上 muse-web-cli v0.1.6 以上、chatgpt-dot-cli v0.2.6 以上：它們有 `send --attach` 與 `--attach-sha256`）。`--via drive` 另外要 [rclone](https://rclone.org) 和一個連到你 Google Drive 的 remote，以及在 Muse 或 dot 裡接好的 Google Drive 連接器。

![同一個 bot 搬到 Muse 和 Your dot：各一個 zip，在對方電腦上核對](../demo/gbot-migrate-muse-dot.gif)

同一個 bot 搬到 Muse 和 Your dot：各一個 zip（4.2 MB、329 個檔、兩則訊息），在對方自己的電腦上解壓，用加鹽 SHA-256 逐部分核對，再問驗收題（最後一次檢查兩邊都 7/7；Muse 在看不到搬家訊息的新聊天室問；dot 只有一個收件匣，報告會註明）。[MP4](../demo/gbot-migrate-muse-dot.mp4) · tape：[demo/gbot-migrate-muse-dot.tape](../demo/gbot-migrate-muse-dot.tape)。實際執行紀錄（英文；一個 903 列對話的 bot 和示範 bot，三個目的地）見 [verification/2026-11-08-full-migration.md](verification/2026-11-08-full-migration.md)。

## 選項

`preview`、`import`、`check`、`run` 都一樣；`check` 要用和 `import` 相同的選項。排程相關的選項三個目的地都適用，選了哪些排程也是計畫的一部分。

| 選項 | 預設 | 說明 |
| --- | --- | --- |
| `--via auto\|upload\|drive\|chat` | `auto` | Muse／dot。`upload`：整個交接資料夾壓成一個 zip 附檔，對方解壓。`drive`：同一個 zip 用 rclone 放到你的 Google Drive（先比對 MD5），請對方用它的 Google Drive 連接器下載、解壓；驗證通過後刪掉 Drive 上那份（`--keep-drive` 保留）。`chat`：一個檔一則訊息。`auto`：附檔放得下就 upload（Muse 256 MB、dot 20 MB），否則有設 Drive 就 drive，再不然 chat |
| `--drive-remote NAME:` | 環境變數 `GBOT_DRIVE_REMOTE` | 你 Google Drive 的 rclone remote（`rclone listremotes`）；`--via drive` 必填。建 remote 時用你自己的 Google OAuth client（[rclone 說明](https://rclone.org/drive/#making-your-own-client-id)）：rclone 內建的共用 client 有流量限制，2026 年內會停用；gbot 不綁定任何 client，換 remote 就好 |
| `--drive-folder PATH` | `gbot-migrations` | Drive 上放 zip 的資料夾 |
| `--history full\|recent:N\|none` | upload `full`，chat `recent:30` | 要帶多少對話 |
| `--skills all\|index\|none\|名稱,名稱` | upload `all`，chat `index` | `index` 只帶名稱與用途；Hermes 只接受 `all`、`none` |
| `--folder PATH` | `~/grok-bot/<bot>-<id 前 8 碼>` | 對方電腦上的資料夾（同名的 bot 也不會共用） |
| `--profile NAME` | `grok-<bot>` | Hermes 的 profile 名稱；`--into-existing`（import、run）加進一個不是這次搬家建立的既有 profile |
| `--activate-routines` | 關 | Grok Bot 裡開著的定時排程，在目的地直接建成啟用的（Hermes 的 cron job 不暫停；Muse／dot 會請它建排程）。Grok Bot 那份照樣在跑，兩邊都會執行 |
| `--move-routines` | 關 | 搬排程，**中間留一小段空檔、絕不兩邊同時跑**：目的地先建成暫停的（Muse／dot 先不建），匯入的讀回與驗收通過後先在 Grok Bot 關掉並確認已關，再在目的地打開並讀回確認（見[排程](#排程)）。`import` 要加這個 bot 的登入：`--account` |
| `--routines ID或名稱,…` | 全部開著的 | 只讓 `--activate-routines`／`--move-routines` 作用在這幾個排程（用逗號分開，比對擷取到的排程 id 或完整名稱；只能選 Grok Bot 裡開著的定時排程，寫錯會列出可以選的並停下，什麼都不改）。其他的照預設（Hermes 建成暫停的，Muse／dot 只記在 ROUTINES.md），也絕不會在 Grok Bot 被關掉 |
| `--accept` | import、run：開；check：關 | 驗收題（會用目的地的模型） |

擷取的選項：`--max-file-mb`（單檔上限，預設 8 MiB）、`--out`（預設 `~/.grok-bot-cli/migrations/<bot>-<時間>`）、`--time-zone`（排程時間用的時區；預設這台電腦的）。

## 抓了什麼（來源端，只讀）

| 項目 | 來源 | 範圍 |
| --- | --- | --- |
| 角色、名稱、說明 | `ListGrokBotAgents` | 完整 |
| 對話紀錄 | `ListGrokBotTranscriptEntries` 用 `beforeSeq` 一頁一頁往回讀，直到空頁或第一則；被省略的內容從 box 存放區的 blob 補回 | **全部**，不是最近 200 則；沒有內容的序號以「seq 缺口」列出（刪除、回滾或沒寫入） |
| 記憶 | box 存放區：這個 bot 自己的 `memory/`、所有 assistant 共用的 `user-memory/`、它加入的專案記憶 | 完整檔案 |
| Skills | box 存放區 `workflows/<名稱>/` 整個資料夾（帳號內所有 bot 共用） | 完整，含附屬檔 |
| 排程（routines） | `ListGrokBotAgentAutomations`（prompt、cron、時區、觸發條件、是否啟用） | 完整 |
| 進行中的任務 | `ListGrokBotAgentTodos`、`ListGrokBotAgentTasks`、`ListGrokBotTasks` | 完整 |
| 必要檔案 | 這個 bot 的附件、assets，以及角色、排程、記憶、對話裡提到的 `/home/box/…`、`/workspace/…` 檔案 | 單檔上限 `--max-file-mb` |
| 群組、隊友、連接器、文件庫 | 名單與設定 | 只列出 |

每一項都寫在存檔的 `REPORT.md` 和 `capture.json` 的 `coverage`：完整、部分、不適用或失敗，失敗會附原因。存放區列出的這個 bot 的記憶檔全部讀到才算「完整」（`complete`）；少一個（大小上限、blob 讀不到或雜湊不符、憑證路徑…）就是「部分」（`partial`），並逐一列出缺哪個、為什麼（`coverage.memory.missing`）；一個都沒讀到是「失敗」（`failed`）。沒讀到的記憶檔會出現在預覽的「沒搬」清單，以及匯入報告的 `memoryNotCaptured`（終端機輸出「Memory files not captured」）。存檔裡每個檔案都有 SHA-256，開檔時全部重新驗證，多一個或少一個檔都會拒絕。

已知的憑證路徑（`.secrets/`、`.ssh/`、`.npmrc`、`rclone.conf`、`glab-cli`、`*token*`…，同內容換了檔名也算）不讀；被提到時列為「需要在目的端重新登入」。這是一份名單，不是保證。對話、檔案和檔名裡出現的已知 token 格式（`ghp_…`、`glpat-…`、`sk-…`、`npm_…`、JWT、Bearer、私鑰…，也檢查 UTF-16 和跳脫／URL 編碼的寫法）只留在你本機的私人存檔（權限 0600），寫進目的地或送到雲端之前換成 `[redacted]`；遮不掉的整個檔案不送，並列在報告裡。這是已知格式的比對，不是所有秘密都認得出來。

## 搬到哪裡

| | Hermes | Muse | Your dot |
| --- | --- | --- | --- |
| 一個 bot 變成 | 一個新的 Hermes profile（`grok-<bot>`），彼此獨立，透過 Hermes 自己的 store 寫入 | 同一個 Muse 裡的一個專用副聊天室（Muse 只有一個，記憶共用） | 同一個 dot（一個帳號一個收件匣） |
| 持久存放 | profile 本身 | Muse 電腦上的交接資料夾 `~/grok-bot/<bot>-<id>/`，加一則明確要求長期記住的指標 | dot 電腦上的同樣資料夾，加同樣的指標 |
| 怎麼送過去 | 直接寫進 Hermes 自己的 store | 預設一個 zip 附檔（`muse-web-cli send --attach`，在 Muse 視窗上傳，和手動附檔一樣）；或經你的 Google Drive（它用 Google 連接器取回）；或逐檔訊息 | 預設一個 zip 附檔（`chatgpt-dot-cli send --attach`，和 dot app 一樣先上傳到訊息房間再送）；或經你的 Google Drive；或逐檔訊息 |
| 角色 | `SOUL.md` | `ROLE.md` | `ROLE.md` |
| 記憶 | `USER.md`、`MEMORY.md`（用 Hermes 自己的 MemoryStore，必要時調高新 profile 的上限） | `MEMORY.md` | `MEMORY.md` |
| 對話紀錄 | 全部（含副對話）匯入成可搜尋的 Hermes session，另有可讀副本 | zip：全部（`HISTORY.md`、`history/`）；逐檔：最近 30 則 | 同 Muse |
| Skills | `skills/grok-bot-imports/<名稱>/` 整個資料夾 | zip：`skills/<名稱>/` 整個資料夾＋`SKILLS.md`；逐檔：`SKILLS.md`（名稱與用途） | 同 Muse |
| 排程 | 定時的：`hermes cron create --paused`（同時區，名稱帶來源 id）；事件觸發的：`routines-not-scheduled.md` | `ROUTINES.md`（Muse 的排程沒有暫停狀態） | `ROUTINES.md` |
| 任務 | 記憶裡的「未完成任務」 | `TASKS.md` | `TASKS.md` |
| 檔案 | profile 的 `workspace/grok-bot/grok-box/…` | 只有 zip 會送（`box/…`，位元組不變）；逐檔訊息不送檔案，因為對方會重打一遍，腳本裡差一個空白就不一樣 | 同 Muse |
| 讀回 | Hermes 自己的 store：SOUL、記憶、skills、cron（排程、時區、暫停狀態）、session 內容摘要、檔案雜湊 | 請 Muse 在它電腦上跑一行只讀指令，印出每一部分的加鹽 SHA-256；Memory.md 只列為參考 | 同 Muse（dot 的記憶從外面讀不到） |
| 驗收題問在哪 | `hermes -p` 單次問答 | 新開、看不到搬家訊息的副聊天室，問完只刪這次開的那一個 | 同一個收件匣（報告會註明答案可能用到對話上下文） |

交接資料夾裡有 README、ROLE、MEMORY、TASKS、ROUTINES、SKILLS、HISTORY、`skills/`、`history/`、`box/` 與 MANIFEST.txt。

## 排程

**預設 Grok Bot 那邊什麼都不改**：排程照常在 Grok Bot 跑，gbot 不會去關它；只有選了 `--move-routines`（或引導模式選 3），才會在檢查通過後關掉選到的那幾個。排程在 Hermes 預設先暫停：Grok Bot 那份還在跑，兩邊同時開會重複執行。在 Grok Bot 關掉後，用 `hermes -p grok-<bot> cron resume <id>` 打開。Muse／dot 沒有「暫停的排程」，所以只記下內容；要它們直接建排程，用 `--activate-routines`。

引導模式在擷取完之後，如果這個 bot 有開著的定時排程，會問三選一（預設 1）：

1. 在目的地先關著，Grok Bot 照常跑（Grok Bot 什麼都不改）
2. 兩邊都跑：在目的地打開，Grok Bot 也照常跑（可能各跑一次）——等於 `--activate-routines`
3. 搬過去：檢查通過後先在 Grok Bot 暫停，再在目的地打開（中間一小段空檔，絕不兩邊同時跑）——等於 `--move-routines`

選 2 或 3 會再列出開著的排程（編號、名稱、時間），問「Which routines? Enter for all, or numbers like 1,3」：直接 Enter 是全部，打編號就只選那幾個（變成 `--routines`）。預覽逐一寫出每個排程的結果：目的地關著、目的地開著（可能各跑一次），或搬過去；會被暫停的，也寫出怎麼重新打開。

選 3 是**切換，中間留一小段空檔，絕不兩邊同時跑**，所以有副作用的排程（發訊息、合併 MR、付款…）不會被執行兩次。順序，每個排程各自：

1. 匯入時目的地的排程先建成暫停的（Hermes：cron job 暫停；讀回仍檢查它存在、時間和內容正確）。Muse／dot 沒有暫停的排程，所以這時先不請它建。
2. 匯入的讀回與驗收都通過後，才在 Grok Bot 關掉它：`SetGrokBotAgentAutomationEnabled` `{ agentId, automationId, isEnabled: false, timeZone }`（和 App 的排程開關同一個請求），再從回應確認它已關。
3. 只有確認已關的，才在目的地打開：Hermes 跑 `hermes -p <profile> cron resume <job id>`，再讀回確認它在跑；Muse／dot 這時才送「建這個排程」的那則訊息（每個排程自己一個 trinity 計畫，`<存檔>.<目的地>-switch-<id>.json`），再讀回它的排程。
4. 目的地打不開（讀回還是暫停或沒有）：把 Grok Bot 那個排程打開回來（`isEnabled: true`，確認已開），報告寫「rolled back」。連打開回來都失敗或結果不明時，報告寫出「ROUTINE MAY RUN NOWHERE」和確切的手動做法。目的地狀態不明（讀回失敗）時不打開回來（它可能已在目的地跑），報告寫怎麼確認。

只動原本開著、有選到、而且真的搬過去的定時排程，沒選的、事件觸發的（GitHub、Slack…）和原本就關著的都不動。每一步一個排程一次請求，不會自動重試。擷取本身仍然只讀，這些是驗證通過後另外的寫入，不喚醒雲端電腦。

- 驗證沒過（或 Muse／dot 沒跑驗收題）就一個都不關，報告寫 `source routines left on: verification did not pass`；目的地那份還是暫停的（Muse／dot 沒建），不會重複執行。修好後重跑同一個 `gbot migrate import`。
- 某個排程在 Grok Bot 關失敗或結果不明（逾時），目的地那份維持暫停，報告逐一列出原因和手動做法（在 Grok Bot App：Routines → 切換開關關掉，再在目的地打開），不會自動重試；結束碼 3。
- 報告（`routines`：每個開著的排程在目的地、在 Grok Bot 的狀態和是否 rolled back；`switchOver`：每一步的結果；`sourceRoutines`：每個關掉的請求）和終端機輸出列出每個排程。要重新打開：在 Grok Bot App：Routines → 切換開關。
- 切換時，一個排程在 Grok Bot 關掉到目的地打開之間有一小段空檔；剛好落在這段時間的那一次不會執行，但絕不會兩邊都跑。

## 驗收

對方說「存好了」不算數：實際跑過，Muse 不把 MR 這類短期狀態放進 Memory.md；dot 有一次寫 TASKS.md 被自己的審核擋下，仍回 saved。所以：

- **Hermes**：用 Hermes 自己的程式讀回每一項（角色、記憶、skills、cron 的排程／時區／狀態、每個 session 的內容摘要、檔案雜湊）；再用 `hermes -p` 問它是誰、記得你什麼、有哪些排程與未完成任務、去搜舊對話引用某一則、打開某個 skill、讀某個搬過去的檔案。
- **Muse／dot**：請對方在它自己的電腦上跑一行只讀的 `python3` 指令。資料夾和一個每次不同的隨機鹽以 base64 傳進去，指令照 `MANIFEST.txt` 把每一部分（每個主要檔案、`box/`、`skills/`、`history/`）算成加鹽的 SHA-256 印出來。沒有那些位元組就算不出來。gbot 逐列比對（每一部分都要剛好印一列、欄位對）：zip 比對位元組完全相同；逐檔訊息比對的是去掉空白與反斜線後的內容（對方把聊天文字寫成檔案時會吃掉跳脫用的反斜線）。這是很強的證據：對方在它的電腦上有這些位元組並跑了檢查；但它不是我們自己去讀那個資料夾（Muse 和 dot 沒有給外部讀檔的介面）。缺的或不一樣的部分會自動重送一次再驗；沒印出來的部分不猜、不重送，列為未驗證。
- 其他題目（它知不知道這個 bot、TASKS.md 裡有什麼、第一則對話、某個 skill 的步驟…）在 Muse 是在新開的副聊天室問；dot 只有一個收件匣，報告會註明。
- 每題答案都要以題號開頭（`Q1:`，`Q10:` 不算 `Q1:`），對方主動發的其他訊息（提醒、簡報）不會被當成答案。答錯的題目會再問一次，兩次的答案都留在報告裡。
- 答案必須含有只有搬過去的資料才有的字（MR 編號、帳號、檔案內容）；題目裡已經出現的字不算，常見英文詞也不算。這是行為測試，不是證明：通過代表它找得到並用得上搬過去的資料。這些問題會用目的地的模型，會用到一點額度。

## 送出的節奏與方式

- 一次只送一則，等到回覆才送下一則，兩次送出之間至少隔 20 秒（`trinity-cli migrate --min-interval`，中斷後續跑也算）；送出失敗、或對方的回覆是「太頻繁」，就停下，不重送。zip 方式整個搬家只有 2 則訊息加驗收題。
- 請求方式照官方前端：Muse 在 Muse 視窗裡附檔、輸入、按 Enter；dot 照 dot app 的做法先上傳到訊息房間、再送 `content{text, attachments}`、`request_id`、`timezone_offset_min`（不偽造 app 的完整性驗證）；Grok Bot 來源端只用 app 會用的唯讀 RPC，對話每頁 500+1 列、存放區一次 8 個請求，和 app 相同，而且不喚醒 box。

Muse／dot 的傳送可中斷續跑：每一步都有 nonce 和 ledger；停了就再跑同一個 `gbot migrate import`，已回覆的步驟跳過，狀態不明的先讀回聊天室，不會盲目重送。`gbot migrate check` 不送任何搬家內容；加 `--accept` 時會送驗收題。

## 目的端的設定

- Hermes：不用另外設定，用目前 Hermes 的預設模型與登入。
- Muse：在 Muse 視窗跑一次 `muse-web-cli login`；副聊天室走 api 後端（`trinity-cli login muse`）。
- dot：`codex login`。
- 目的端的連接器（GitHub、Slack、Gmail…）和 CLI 登入（glab、gh）在目的端重新連；OAuth 授權不會跟著搬。

## 結束碼

0 搬完並驗證；3 搬了但有項目沒驗過，或 `--move-routines` 有排程沒在 Grok Bot 關掉（看報告裡的 ✗）；2 選項不合法（一開始就被拒絕，什麼都沒做）；1 其他錯誤，包括沒加 `--yes`（什麼都沒匯入）和 `--routines` 寫了不存在的排程。報告寫在存檔旁邊：`<存檔>.<目的地>….report.json`。

## 給 agent 用

`gbot-install install claude`（或 `codex`、`cursor`）裝好 gbot 外掛後，agent 會拿到 `migrate-grok-bot` skill（原文在 `src/skills/migrate-grok-bot/SKILL.md`）。它照下面的方式搬，人也可以照著做：

1. `gbot --json migrate bots --account A`：列出 bot，和你確認要搬哪一個。
2. `gbot --json migrate capture --account A --bot "<名稱或 id>"`：只讀擷取，先告訴你缺了什麼。
3. `gbot --json migrate preview <存檔> --to hermes|muse|dot`：把預覽給你看，**等你明確同意**才往下。
4. `gbot --json migrate import <存檔> --to <目的地> --yes`：匯入、讀回、驗收；看結束碼和報告裡的 ✗。
5. 中斷或之後再驗：`gbot migrate check <存檔> --to <目的地> --accept`（Muse／dot 續跑用同一個 `import`，不會重送不確定的訊息）。

skill 的規則：沒有你的同意不匯入；不改、不刪 Grok Bot 那邊的 bot；不把存檔內容貼到對話裡（只報數量與名稱）；送 Muse／dot 照 App 的節奏，不加速重試；預設絕不關你 Grok Bot 裡的排程：`--move-routines` 只在你要求時用，只搬你說的那幾個時加 `--routines`。
