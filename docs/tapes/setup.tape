# Mission Control — Full Setup
# Shows install hooks → start server with QR code

Output docs/tapes/setup.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1000
Set Height 700
Set Theme "Dracula"
Set Padding 20
Set TypingSpeed 40ms
Set PlaybackSpeed 0.5

# Step 1: Install hooks
Type "npx tsx src/index.ts install"
Enter
Sleep 4s

# Step 2: Start the server
Type "npm start"
Enter
Sleep 6s

# Let the banner + QR code display
Sleep 4s

Ctrl+C
Sleep 1s
