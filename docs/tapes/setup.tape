# Mission Control — Full Setup
# Shows install hooks → start server in one clean sequence

Output docs/tapes/setup.gif

Set Shell "zsh"
Set FontSize 16
Set Width 900
Set Height 500
Set Theme "Dracula"
Set Padding 20
Set TypingSpeed 45ms
Set PlaybackSpeed 0.5

# Step 1: Install hooks
Type "npx tsx src/index.ts install"
Enter
Sleep 4s

# Step 2: Start the server
Type "npx tsx src/index.ts"
Enter
Sleep 5s

# Let the banner display
Sleep 3s

Ctrl+C
Sleep 1s
