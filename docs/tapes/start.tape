# Mission Control — Server Start
# Records the server startup banner with QR code and access code

Output docs/tapes/start.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1000
Set Height 700
Set Theme "Dracula"
Set Padding 20
Set TypingSpeed 40ms
Set PlaybackSpeed 0.5

Type "npm start"
Enter
Sleep 6s

# Show the banner with QR code
Sleep 4s

Ctrl+C
Sleep 1s
