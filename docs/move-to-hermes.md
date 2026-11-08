# Move to Hermes (a Grok Bot bot that runs `gbot migrate` for you)

"Move to Hermes" is a Grok Bot bot whose only job is to move your other bots to Hermes Agent, the way Move to iOS moves a phone. It does not copy anything itself: it asks before each command and runs the open-source `gbot migrate` on your own computer, which reads the Grok Bot app login there and writes into your local Hermes (see [migration.md](migration.md)).

Its instructions are [templates/move-to-hermes.md](../templates/move-to-hermes.md).

## Get it

- **From a template link** (when one is published): open the `https://x.ai/bot/<share id>` link, choose **Add to Grok Bot**. You get your own copy in your account.
- **Create it yourself with gbot**:

  ```sh
  gbot bots create --name "Move to Hermes" --title "Move your Grok Bot bots to Hermes" \
    --description "$(cat templates/move-to-hermes.md)"
  ```

- **Without a new bot**: paste the text of templates/move-to-hermes.md into a chat with any bot you already have.

Then say "move my bots to Hermes". It checks `hermes` and `node`, checks `gbot migrate`, lists your bots, previews each move, and moves a bot only after you say yes.

## Before you start

- Hermes Agent installed and signed in on the same computer as the Grok Bot app.
- Grok Bot asks before a bot runs a command on your computer (the default, "Ask every time"); approve each one. A team admin can turn this off.
- macOS asks once for Keychain access to `Grok Bot Safe Storage`, so be at the Mac.

## Share it

Grok Bot shares a bot as a template: in the bot's chat ask it to "Create a public template of yourself that I can share with somebody else", then share the `https://x.ai/bot/<share id>` link. A template is a copy for each person: they never get your computer, logins, memory or conversation history. A template does not carry scripts, so the bot installs gbot from the release named in its instructions.

## Limits

- The recipient needs a gbot release that has `migrate`; the bot checks `gbot migrate --help` and points to the release otherwise.
- A copy from a template does not start on its own; say what you want.
- Muse and Your dot are not in this bot (they also need trinity-cli and the seat tools); use `gbot migrate` directly for those.
