---
"grok-bot-cli": patch
---

`gbot thread`, `gbot reconcile`, the relay, approvals and the MCP thread tool read a server-hosted bot's recent messages from the Grok Bot 0.78 backend (`ListGrokBotTranscriptEntries`, as the app does) instead of the removed box gateway, which answered 404. `gbot thread --root` still needs the box gateway (the app has no backend call for it).
