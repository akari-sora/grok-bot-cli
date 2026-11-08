# Phone video source

English | [繁體中文](README.zh-TW.md)

The vertical video `demo/gbot-migrate-phone.mp4` is a [Remotion](https://www.remotion.dev) composition (1080 × 1920, 30 fps).

1. Record the terminal clip with the released gbot on `PATH`: `vhs demo/gbot-migrate-phone.tape` (writes `demo/promo/public/phone-hermes.mp4`; needs a signed-in Grok Bot, Hermes, and the demo bot).
2. In `demo/promo`: `npm ci`, then `npx remotion render Promo out/gbot-migrate-phone.mp4 --crf=20`.

`demo/move-to-hermes-phone.mp4` is the `MoveToHermes` composition (`src/MoveToHermes.tsx`): a real Move to Hermes conversation from 2026-11-09, quoted and laid out as a chat; the final report is in `src/moveToHermesResult.ts`. Render it with `npx remotion render MoveToHermes out/move-to-hermes-phone.mp4 --crf=20`.

Scene timings in `src/Promo.tsx` follow the clip's cut points (`ffmpeg -i public/phone-hermes.mp4 -vf "select='gt(scene,0.08)',showinfo" -f null -`). Remotion is free for individuals and teams of up to three; see its license for companies.
