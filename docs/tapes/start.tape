# Mission Control — Server Start
# Records the server startup banner and access code display

Output docs/tapes/start.gif

Set Shell "zsh"
Set FontSize 16
Set Width 900
Set Height 500
Set Theme "Dracula"
Set Padding 20
Set TypingSpeed 50ms
Set PlaybackSpeed 0.5

Type "npx tsx src/index.ts"
Enter
Sleep 5s

# Show the banner
Sleep 3s

Ctrl+C
Sleep 1s
