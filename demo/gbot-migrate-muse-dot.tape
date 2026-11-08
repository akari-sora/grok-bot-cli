# VHS tape for the Muse and Your dot clip: `vhs demo/gbot-migrate-muse-dot.tape` from the repo root,
# after demo/gbot-migrate-hermes.tape (it reuses the newest archive in ~/gbot-demo). It previews the
# Muse delivery, then imports the same bot into Muse and into Your dot: one zip each, read back and
# checked. Needs trinity-cli, muse-web-cli (logged in) and chatgpt-dot-cli (codex login).
Output demo/gbot-migrate-muse-dot.gif
Output demo/gbot-migrate-muse-dot.mp4

Set Shell "bash"
Set FontSize 15
Set Width 1440
Set Height 900
Set Padding 24
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful

Hide
Type "export PS1='$ ' GBOT_MIGRATIONS_DIR=$HOME/gbot-demo && alias gbot='node bin/gbot.mjs' && A=$(cd $HOME/gbot-demo && ls -td demo-*/ | head -1 | tr -d /) && cd $HOME/gbot-demo && clear"
Enter
Sleep 1s
Show

Type "gbot migrate preview $A --to muse"
Sleep 800ms
Enter
Wait+Line@3m /^\$\s*$/
Sleep 6s
Screenshot demo/gbot-migrate-muse-preview.png
Type "clear"
Enter
Type "gbot migrate import $A --to muse --yes"
Sleep 800ms
Enter
Sleep 4s
Hide
Wait+Line@60m /^\$\s*$/
Show
Sleep 7s
Screenshot demo/gbot-migrate-muse-result.png
Type "clear"
Enter
Type "gbot migrate import $A --to dot --yes"
Sleep 800ms
Enter
Sleep 4s
Hide
Wait+Line@60m /^\$\s*$/
Show
Sleep 7s
Screenshot demo/gbot-migrate-dot-result.png
