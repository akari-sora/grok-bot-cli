# 搬到 Hermes、Muse、dot 或其他工具

本文件擴充原本的 [搬家工具用法](migration-toolkit.md)。來源仍只匯出實際可取得的資料，不會把最近 200 則當成完整歷史。

## 一次匯出，多個目的地

以下使用已從這個分支編譯的 `gbot`。未安裝分支版時，把 `gbot` 換成 repo 裡的 `node bin/gbot.mjs`。

```sh
gbot migrate targets
gbot migrate export --account personal --out ../grok-backup

gbot migrate plan ../grok-backup --to hermes --include-skills
gbot migrate apply ../grok-backup --to hermes --include-skills --out ../hermes-package --yes
gbot migrate verify ../grok-backup --out ../hermes-package

gbot migrate plan ../grok-backup --to muse
gbot migrate apply ../grok-backup --to muse --out ../muse-package --yes
gbot migrate verify ../grok-backup --out ../muse-package
```

`--to` 支援 `openclaw`、`hermes`、`muse`、`dot`、`portable`。每個目的地用不同的新目錄，不覆寫現有設定；`verify` 從 manifest 判斷目的地，不需要再指定 `--to`。

## Hermes：接官方匯入器，不複製多個人格

Hermes 現在有官方 `agent-importers` 插件，支援 `grok-bot-export` JSON。本工具產生該格式，不需要先經過 OpenClaw，也不需要 Trinity。

多個 Grok Bot 的明確角色指令會變成同一個 Hermes Agent 的不同 task-role Skills。名稱由來源 ID 決定，即使兩個 Bot 同名也不混在一起。`ROLE-MAP.json` 保留來源名稱對照。`--include-skills` 另外加入實際取得的使用者 workflow 本文；插件 Skills、排程、缺失的記憶不會被猜測成可執行功能。

檢查 `hermes-package/grok-bot-export.json` 後，在已支援官方插件的 Hermes 版本執行：

```sh
hermes import-agent grok-bot --source ../hermes-package/grok-bot-export.json --dry-run
hermes import-agent grok-bot --source ../hermes-package/grok-bot-export.json
```

第二行會進入官方確認流程。需要指定既有 profile 時使用 Hermes 的 `-p`；本工具不自動建立 profile、不更新 Hermes、不安裝插件，也不改動既有 SOUL、memory、OAuth 或模型設定。舊版 Hermes 可能沒有此命令；先確認 `hermes import-agent --help` 與該 profile 的插件狀態。

原始已取得的對話、群組與排程文字仍保存於 `archive/snapshot.json`，不會丟棄，但不會當成已還原的原生聊天紀錄。官方匯入器可能遮罩 token 形狀的文字、跳過衝突；以它的逐項結果為準。

## Muse／dot：交接背景，不冒充記憶匯入

目前檢查到的 `muse-web-cli` / `chatgpt-dot-cli` 與 Trinity 能力是傳訊與讀回，不是任意匯入原生聊天資料庫或保證寫入長期記憶。

因此 `--to muse` / `--to dot` 產生分段交接包：`handoff/index.json` 列出每個 Bot 的片段、順序、大小與 SHA-256；完整已取得資料另外保留在 archive。Unicode 分段不丟字，單段 payload 上限 8192 bytes；這是本工具設定，不是宣稱平台的正式 context 上限。片段以歷史證據標示，不要求接收者執行舊任務。

可以沿用你現有的三位一體 CLI。先在 index 裡選定一個來源 Bot，檢查目的端目前聊天室及要傳送的內容，再一次傳一個已審核片段。POSIX shell 範例：

```sh
trinity-cli ask muse < ../muse-package/handoff/bot-ID/part-00001.txt
```

把 `bot-ID` 換成 index 裡實際產生的路徑；dot 使用 `trinity-cli ask dot`。本工具不會自動執行這些命令。不要直接迴圈傳全部 Bot，也不要對未知送達狀態盲目重送。Trinity 的新一次 ask 會建立新 nonce，不是跨執行的去重重試。

重要限制：目前 Trinity 的 Muse adapter 最後仍把內文作為 muse-web-cli 子程序 argv 傳遞。頂層從 stdin 讀取不代表內文全程不出現在程序參數。私密資料應先審核；嚴格的無 argv 外洩需求需要另補 Muse 的 stdin 傳輸。既有 Trinity 對無法辨認的目前聊天室也有降級行為，不能把它當成嚴格目的地驗證。

收到回覆只能證明某種訊息交接，不代表完整 ingest、永久記憶、Skills 安裝或排程還原。長歷史應保留原始檔，而不是靠大量訊息把 context 塞滿。

## 三個 repo 的分工

`grok-bot-cli` 負責來源擷取、共同備份格式、目的格式轉換和檔案驗證。`trinity-cli` 適合做可選的登入工具協調、座位選擇、傳訊、nonce 帳本和讀回。`muse-web-cli` / `chatgpt-dot-cli` 維持各平台傳輸與登入責任。

所以這次不修改 Trinity 的核心，也不讓它成為所有搬家的必要依賴。`hand` 只轉交一則既有訊息，不拿來當全量搬家；`brief push` 也不能假裝寫入 Muse 指令。

## 其他目的地

`--to portable` 產生平台無關資料包，供尚未支援的平台自行匯入。這不是宣稱所有平台都已支援。增加目的地應加專用轉換器與合約測試，不要將任意資料送進任意平台後統稱搬家成功。

研究、實作與驗收門檻見 [多目的地計畫](migration-multitarget-plan.md)。
