# Phone-size recording of `gbot migrate` to Hermes with the released package (portrait clip, 53 columns).
Output demo/promo/public/phone-hermes.mp4
Require gbot
Set Shell zsh
Set FontSize 30
Set Width 1000
Set Height 1120
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set WindowBar ""

Hide
Type "export PS1='$ ' GBOT_MIGRATIONS_DIR=$HOME/gbot-demo && mkdir -p $HOME/gbot-demo && clear"
Enter
Sleep 1s
Show
Type "gbot migrate"
Sleep 600ms
Enter
Hide
Wait+Line@90s /Account number/
Show
Sleep 1.2s
Type "2"
Enter
Hide
Wait+Line@120s /shows all/
Show
Sleep 800ms
Type "demo"
Enter
Hide
Wait+Line@30s /Bot number/
Show
Sleep 1.2s
Type "1"
Enter
Hide
Wait+Line@30s /Destination number/
Show
Sleep 1.5s
Type "1"
Enter
Hide
Wait+Line@40m /Routines number/
Show
Sleep 3.5s
Type "1"
Enter
Hide
Wait+Line@40m /y\/N\]/
Show
Sleep 5s
Type "y"
Enter
Sleep 1s
Hide
Wait+Line@60m /^\$\s*$/
Show
Sleep 6s
Hide
Type "clear"
Enter
Show
Type "hermes -p grok-demo -z 'Dates confirmed. Do the next item on your to-do list for the Kyoto trip, no booking: which hotel, dates, nights, budget, meals?'"
Sleep 500ms
Enter
Hide
Wait+Line@10m /^\$\s*$/
Show
Sleep 8s
