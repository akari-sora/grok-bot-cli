# Move to Hermes（替你跑 `gbot migrate` 的 Grok Bot bot）

[English](move-to-hermes.md) | 繁體中文

「Move to Hermes」是一個 Grok Bot bot，唯一的工作是把你其他的 bot 搬到 Hermes Agent，就像「移轉到 iOS」搬手機一樣。它自己不複製任何東西：每條命令先徵求同意，再在你自己的電腦上跑開源的 `gbot migrate`；`gbot migrate` 讀那台電腦上的 Grok Bot App 登入，寫進你本機的 Hermes（見 [migration.zh-TW.md](migration.zh-TW.md)）。

它的指示在 [templates/move-to-hermes.md](../templates/move-to-hermes.md)（英文，就是 bot 實際使用的內容）。

## 取得

- **從範本連結**：打開 <https://x.ai/bot/y2AFnYLdbz5T66loRBHar>（「Move to Hermes by ImL1s」，2026-11-08 發布），選 **Add to Grok Bot**。你的帳號裡會多一份自己的副本。
- **用 gbot 自己建**：

  ```sh
  gbot bots create --name "Move to Hermes" --title "Move your Grok Bot bots to Hermes" \
    --description "$(cat templates/move-to-hermes.md)"
  ```

- **不建新 bot**：把 [templates/move-to-hermes.md](../templates/move-to-hermes.md) 的內容貼到你已有的任何一個 bot 的對話裡。

接著說「move my bots to Hermes」（把我的 bot 搬到 Hermes）。它會檢查 `hermes` 和 `node`、檢查 `gbot migrate`、列出你的 bot、逐一預覽每次搬家，你說好之後才搬那個 bot。

## 開始前

- Hermes Agent 已安裝並登入，和 Grok Bot App 在同一台電腦上。
- Grok Bot 在 bot 要在你電腦上跑命令前會先問（預設的「Ask every time」）；每一條都要核准。團隊管理員可以關掉這個設定。
- macOS 會問一次是否允許存取鑰匙圈項目 `Grok Bot Safe Storage`，在 Mac 前面回答它。

## 分享

Grok Bot 用範本分享 bot。在終端機分三步：

```sh
gbot bots template "Move to Hermes"            # 1. bot 建立範本草稿
gbot bots template "Move to Hermes" --show     # 2. 檢查副本會拿到什麼
gbot bots template "Move to Hermes" --publish  # 3. 發布
```

1. 第一條命令用和 App 一樣的訊息請 bot 建立範本（已有範本時則是更新），等範本出現（最多 10 分鐘；`--wait <秒>` 可改），並把 `https://x.ai/bot/<share id>` 連結單獨印在一行。到第 3 步之前範本都是草稿（未發布）。如果以結束碼 3 結束（還沒有範本），稍後跑 `gbot bots template "Move to Hermes" --status`，不要再請一次。
2. `--show` 印出草稿的內容，也就是 bot 在對話裡以審核卡貼出的那個版本：名稱、說明、記憶項目、skills、排程、plugins。它不送任何東西。
3. `--publish` 發布那個版本（等同在 App 裡確認審核卡），並印出連結。`--publish` 逾時或遇到伺服器錯誤時可能其實已經成功：再跑之前先用 `--status` 確認。

不開終端機：在 bot 的對話裡請它「Create a public template of yourself that I can share with somebody else」，確認它貼出的審核卡，再分享連結。

範本是給每個人各自一份的副本：對方拿不到你的電腦、登入、記憶或對話紀錄。範本不帶腳本，所以 bot 會從它指示裡寫的 release 安裝 gbot。

## 限制

- 對方需要有 `migrate` 的 gbot release；bot 會檢查 `gbot migrate --help`，沒有時指向那個 release。
- 從範本建立的副本不會自己開始；說出你要做什麼。
- 這個 bot 不搬到 Muse 和 Your dot（那兩個還需要 trinity-cli 和各自的工具）；要搬到那裡，直接用 `gbot migrate`。
- 範本的每一條指示最多 500 字，超過的部分會被截掉（2026-11-08 實測），所以 bot 指示的每一步都要寫短；`--show` 會標出剛好到 500 字的項目。目前上線的是第 3 版。
- 已經加過舊版的人會保留舊版；重新加一次範本就是最新版。
- 每次起草都會在 bot 的對話裡留一張審核卡，最舊那張可能還顯示「發布」按鈕；在 App 裡按下去，就會把那個舊版本重新發布（2026-11-08 上線版本曾從 3 退回 1）。用 `gbot bots template "Move to Hermes" --status` 看 `activeVersion`；`--publish --template-version 3` 可以改回最新版。
