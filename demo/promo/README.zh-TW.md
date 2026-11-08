# 手機版影片原始檔

[English](README.md) | 繁體中文

直式影片 `demo/gbot-migrate-phone.mp4` 是一個 [Remotion](https://www.remotion.dev) 作品（1080 × 1920、30 fps）。

1. 把已發布的 gbot 放在 `PATH` 上錄終端機片段：`vhs demo/gbot-migrate-phone.tape`（輸出 `demo/promo/public/phone-hermes.mp4`；需要已登入的 Grok Bot、Hermes 和示範 bot）。
2. 在 `demo/promo` 裡：`npm ci`，再 `npx remotion render Promo out/gbot-migrate-phone.mp4 --crf=20`。

`demo/move-to-hermes-phone.mp4` 是 `MoveToHermes` 作品（`src/MoveToHermes.tsx`）：2026-11-09 一次真實的 Move to Hermes 對話，原文排成聊天畫面；最後的報告在 `src/moveToHermesResult.ts`。輸出：`npx remotion render MoveToHermes out/move-to-hermes-phone.mp4 --crf=20`。

`src/Promo.tsx` 的場景時間依片段的切點設定（`ffmpeg -i public/phone-hermes.mp4 -vf "select='gt(scene,0.08)',showinfo" -f null -`）。Remotion 對個人和三人以下團隊免費，公司使用請看它的授權。
