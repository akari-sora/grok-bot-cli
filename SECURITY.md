# Security policy

## Supported versions

Only the latest release gets security fixes.

## Reporting a vulnerability

Please do not report a security problem in a public issue or merge request.

1. Issues are turned off for this fork for now. Open a [confidential issue in trinity-cli](https://gitlab.com/aa22396584/trinity-cli/-/issues/new?issue[confidential]=true) and put `grok-bot-cli` in the title. If the problem is in upstream code, also report it privately to [ScriptedAlchemy/grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli/security).
2. Include the version (`gbot --version`), your OS, what you expected, what happened, and how to reproduce it.
3. Before you paste logs, replace tokens, cookies, credential file contents, account, chat, or bot ids, and message text with placeholders.

You should get a first reply within 7 days. After a fix is released, the report is made public with credit unless you ask otherwise.

In scope: fork-only code (see FORK.md), the release `.tgz`, and anything that could leak a token, an account or bot id, a message, or a local path.

Out of scope: problems in Grok Bot (Cursor) or xAI services themselves. Report those to the service.

## 回報安全問題

請不要用公開 issue 或 merge request 回報安全問題。

1. 這個 fork 目前沒有開 issue。請在 [trinity-cli 開機密 issue](https://gitlab.com/aa22396584/trinity-cli/-/issues/new?issue[confidential]=true)，標題寫 `grok-bot-cli`。問題在上游程式碼時，也私下回報給 ScriptedAlchemy/grok-bot-cli。
2. 附上版本（`gbot --version`）、作業系統、預期與實際結果、重現步驟。
3. 貼記錄前，把 token、cookie、憑證檔內容、帳號／聊天／bot id、訊息內容換成假值。

通常 7 天內會回覆。修正發布後會公開這份回報並致謝，除非你要求不具名。
