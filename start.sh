#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p data

echo ""
echo "  ███╗   ███╗██╗███████╗███████╗██╗ ██████╗ ███╗   ██╗"
echo "  ████╗ ████║██║██╔════╝██╔════╝██║██╔═══██╗████╗  ██║"
echo "  ██╔████╔██║██║███████╗███████╗██║██║   ██║██╔██╗ ██║"
echo "  ██║╚██╔╝██║██║╚════██║╚════██║██║██║   ██║██║╚██╗██║"
echo "  ██║ ╚═╝ ██║██║███████║███████║██║╚██████╔╝██║ ╚████║"
echo "  ╚═╝     ╚═╝╚═╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝"
echo ""
echo "   ██████╗ ██████╗ ███╗   ██╗████████╗██████╗  ██████╗ ██╗     "
echo "  ██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔══██╗██╔═══██╗██║     "
echo "  ██║     ██║   ██║██╔██╗ ██║   ██║   ██████╔╝██║   ██║██║     "
echo "  ██║     ██║   ██║██║╚██╗██║   ██║   ██╔══██╗██║   ██║██║     "
echo "  ╚██████╗╚██████╔╝██║ ╚████║   ██║   ██║  ██║╚██████╔╝███████╗"
echo "   ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚══════╝"
echo ""
echo "  Mission Tracker for Claude Code"
echo ""

# Load fnm if available (for Node 22)
if [ -d "$HOME/.local/share/fnm" ]; then
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)" 2>/dev/null
  fnm use 22 2>/dev/null || true
fi

# Check dependencies
command -v node >/dev/null 2>&1 || { echo "Error: node not found"; exit 1; }

UV="$HOME/.local/bin/uv"
if ! command -v "$UV" &>/dev/null; then
  UV="$(command -v uv 2>/dev/null || true)"
fi
if [ -z "$UV" ]; then
  echo "  Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
fi

# Setup backend venv
echo "  Setting up backend venv..."
cd backend
if [ ! -d .venv ]; then
  "$UV" venv .venv
fi
source .venv/bin/activate
"$UV" pip install -q -r requirements.txt 2>/dev/null
cd ..

# Install frontend deps
echo "  Installing frontend dependencies..."
cd frontend
npm install --silent 2>/dev/null
cd ..

# Start backend (in venv)
echo "  Starting Mission Control API on port 18801..."
cd backend
source .venv/bin/activate
python3 -m uvicorn app:app --host 0.0.0.0 --port 18801 --reload &
API_PID=$!
cd ..

# Start frontend
echo "  Starting Mission Control Dashboard on port 3100..."
cd frontend
npx vite --port 3100 &
UI_PID=$!
cd ..

echo ""
echo "  +------------------------------------------------+"
echo "  |  Dashboard  -> http://localhost:3100            |"
echo "  |  API + MCP  -> http://localhost:18801           |"
echo "  |  API Docs   -> http://localhost:18801/docs      |"
echo "  +------------------------------------------------+"
echo ""
echo "  Connect Claude Code:"
echo "  claude mcp add mission-control --transport http http://localhost:18801/mcp"
echo ""
echo "  Press Ctrl+C to stop all services."
echo ""

cleanup() {
    echo ""
    echo "  Shutting down Mission Control..."
    kill $API_PID $UI_PID 2>/dev/null
    wait $API_PID $UI_PID 2>/dev/null
    echo "  Done."
}

trap cleanup EXIT INT TERM
wait
