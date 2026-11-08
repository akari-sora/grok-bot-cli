# Move to Hermes (a Grok Bot bot that runs `gbot migrate` for you)

English | [繁體中文](move-to-hermes.zh-TW.md)

"Move to Hermes" is a Grok Bot bot whose only job is to move your other bots to Hermes Agent, the way Move to iOS moves a phone. It does not copy anything itself: it asks before each command and runs the open-source `gbot migrate` on your own computer, which reads the Grok Bot app login there and writes into your local Hermes (see [migration.md](migration.md)).

Its instructions are [templates/move-to-hermes.md](../templates/move-to-hermes.md). A real run, laid out for phones (51 s): [demo/move-to-hermes-phone.mp4](../demo/move-to-hermes-phone.mp4).

## Get it

- **From the template link**: open <https://x.ai/bot/y2AFnYLdbz5T66loRBHar> ("Move to Hermes by ImL1s", published 2026-11-08) and choose **Add to Grok Bot**. You get your own copy in your account.
- **Create it yourself with gbot**:

  ```sh
  gbot bots create --name "Move to Hermes" --title "Move your Grok Bot bots to Hermes" \
    --description "$(cat templates/move-to-hermes.md)"
  ```

- **Without a new bot**: paste the text of [templates/move-to-hermes.md](../templates/move-to-hermes.md) into a chat with any bot you already have.

Then say "move my bots to Hermes". It checks `hermes` and `node`, checks `gbot migrate`, lists your bots, previews each move, and moves a bot only after you say yes.

## Before you start

- Hermes Agent installed and signed in on the same computer as the Grok Bot app.
- Grok Bot asks before a bot runs a command on your computer (the default, "Ask every time"); approve each one. A team admin can turn this off.
- macOS asks once for Keychain access to `Grok Bot Safe Storage`, so be at the Mac.

## Share it

Grok Bot shares a bot as a template. From a terminal, in three steps:

```sh
gbot bots template "Move to Hermes"            # 1. the bot builds a draft template
gbot bots template "Move to Hermes" --show     # 2. review what a copy gets
gbot bots template "Move to Hermes" --publish  # 3. publish it
```

1. The first command asks the bot to create its template (or to update the one it has) with the same message the app sends, waits for the template (up to 10 minutes; `--wait <seconds>` changes that), and prints the `https://x.ai/bot/<share id>` link on its own line. The template is a draft (not published) until step 3. When it ends with exit 3 (no template yet), run `gbot bots template "Move to Hermes" --status` later instead of asking again.
2. `--show` prints the draft's recipe, the version the bot posted in its chat as a review card: name, description, memory entries, skills, routines, plugins. It sends nothing.
3. `--publish` publishes that version, as confirming the review card in the app does, and prints the link. If `--publish` times out or gets a server error it may still have gone through: check with `--status` before running it again.

Without a terminal: in the bot's chat ask it to "Create a public template of yourself that I can share with somebody else", confirm the review card it posts, then share the link.

A template is a copy for each person: they never get your computer, logins, memory or conversation history. A template does not carry scripts, so the bot installs gbot from the release named in its instructions.

## Limits

- The recipient needs a gbot release that has `migrate`; the bot checks `gbot migrate --help` and points to the release otherwise.
- A copy from a template does not start on its own; say what you want.
- Each step is a turn of the bot, so a move uses some Grok Bot usage. With none left, run `gbot migrate` yourself or through an agent: it only reads from Grok Bot and never messages a bot.
- Muse and Your dot are not in this bot (they also need trinity-cli and the seat tools); use `gbot migrate` directly for those.
- A template keeps each instruction step to 500 characters and cuts the rest (seen 2026-11-08), so keep every step in the bot's instructions shorter; `--show` marks an entry that reached 500 characters. The template that is live now is version 4.
- Someone who added an older version keeps it; adding the template again gets the current one.
- Each draft leaves a review card in the bot's chat, and the oldest card can still show a Publish button. Pressing it in the app publishes that old version again (on 2026-11-08 the live version once fell back from 3 to 1). Check with `gbot bots template "Move to Hermes" --status` (`activeVersion`); `--publish --template-version 4` puts the current one back.
