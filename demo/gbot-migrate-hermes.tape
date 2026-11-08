# VHS tape for the migration clip: `vhs demo/gbot-migrate-hermes.tape` from the repo root.
# It moves a real Grok Bot named "Demo · Trip Planner" (create one first: gbot bots create) to a new
# Hermes profile `grok-demo` with the guided `gbot migrate`, then asks the migrated bot one question.
# Archives go to ~/gbot-demo. The wizard shows logins with partially masked emails; "2" below is the
# login's number in that list. Remove the profile afterwards with `hermes profile delete grok-demo`.
# Waits are line-based (the last line on screen): a screen-based wait misses output longer than one screen.
Output demo/gbot-migrate-hermes.gif
Output demo/gbot-migrate-hermes.mp4

Set Shell "bash"
Set FontSize 15
Set Width 1440
Set Height 900
Set Padding 24
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful

Hide
Type "export PS1='$ ' GBOT_MIGRATIONS_DIR=$HOME/gbot-demo && alias gbot='node bin/gbot.mjs' && mkdir -p $HOME/gbot-demo && clear"
Enter
Sleep 1s
Show

Type "gbot migrate"
Sleep 800ms
Enter
Wait+Line@90s /Account number/
Sleep 1.5s
Type "2"
Enter
Wait+Line@120s /narrow the list/
Sleep 1s
Type "demo"
Enter
Wait+Line@30s /Bot number/
Sleep 1.5s
Type "1"
Enter
Wait+Line@30s /Destination number/
Sleep 2s
Type "1"
Enter
Sleep 3s
Hide
Wait+Line@20m /y\/N\]/
Show
Sleep 6s
Screenshot demo/gbot-migrate-preview.png
Type "y"
Enter
Sleep 3s
Hide
Wait+Line@40m /^\$\s*$/
Show
Sleep 6s
Screenshot demo/gbot-migrate-hermes-result.png
Type "clear"
Enter
Type "hermes -p grok-demo -z 'Who are you, and what is still open for my Kyoto trip?'"
Sleep 800ms
Enter
Hide
Wait+Line@6m /^\$\s*$/
Show
Sleep 7s
Screenshot demo/gbot-migrate-hermes-continues.png
