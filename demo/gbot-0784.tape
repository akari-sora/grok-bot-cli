# VHS tape for the 0.78.x promo clip: `vhs demo/gbot-0784.tape` from the repo root.
# It drives a real Grok Bot account through the built CLI, using a throwaway bot and group that it deletes at the end.
# Nothing account-specific is shown: no bot list, no account id, no email. Pick the login with GBOT_DEMO_ACCOUNT=<alias>.
Output demo/gbot-0784-demo.gif
Output demo/gbot-0784-demo.mp4

Set Shell "bash"
Set FontSize 20
Set Width 1400
Set Height 760
Set Padding 28
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set WindowBarSize 40

Hide
Type "export PS1='$ ' GBOT_ACCOUNT=${GBOT_DEMO_ACCOUNT:-} && alias gbot='node bin/gbot.mjs' && clear"
Enter
Sleep 1s
Show

Type "# gbot: create Grok Bot bots, groups and chats from your terminal"
Enter
Sleep 600ms
Type "# now on the Grok Bot 0.78 backend (sends, rooms, roster, deletes)"
Enter
Sleep 1200ms

Type "gbot bots create --name demo-helper --description 'Answers in one short line'"
Enter
Sleep 5s

Type "gbot groups create --name demo-room --member demo-helper"
Enter
Sleep 5s

Type "printf 'Say hello to the gbot demo in one short line.' | gbot send demo-helper --stdin"
Enter
Sleep 6s

Type "# the bot answers in its own thread"
Enter
Hide
Sleep 14s
Show
Type "gbot thread demo-helper | tail -3"
Enter
Sleep 7s

Type "gbot bots delete demo-room && gbot bots delete demo-helper"
Enter
Sleep 7s

Type "# canonical repo: gitlab.com/aa22396584/grok-bot-cli"
Enter
Sleep 2500ms
