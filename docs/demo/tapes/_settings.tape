# Shared look for every demo tape. Sourced by each tape; do not run directly.
# Each tape sets its own Set Width/Height before sourcing this file.
Set Shell "bash"
Set FontFamily "Hack Nerd Font Mono,JetBrains Mono,monospace"
Set FontSize 16
Set LineHeight 1.1
Set LetterSpacing 0
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 70ms
Set Framerate 20

# Hidden setup: fixture-only gh, throwaway HOME, no daemon, no personal config.
Hide
Type `export HOME=$DEMO_HOME XDG_CONFIG_HOME=$DEMO_HOME/.config PATH=$DEMO_BIN:$PATH GHUI_REPO=acme/rocket LAZYHUB_NO_DAEMON=1 PS1="$ " && cd "$HOME"`
Enter
Type "clear"
Enter
Show
