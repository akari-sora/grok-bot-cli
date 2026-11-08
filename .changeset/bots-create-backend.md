---
"grok-bot-cli": patch
---

`gbot bots create` works on Grok Bot 0.78 again: it creates the bot through the backend (`CreateGrokBotTemporalAgent`, as the app does) instead of the removed box gateway, which answered 404.
