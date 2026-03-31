# Competitive Research — AI Agent Dashboards & Orchestration

> Research conducted March 31, 2026. Stars and status may have changed.

## Landscape

### Tier 1: High-Star Projects (1,000+)

| Project | Stars | What It Does | Key Takeaway |
|---------|-------|-------------|--------------|
| [claude-hud](https://github.com/jarrodwatts/claude-hud) | 15,441 | Inline terminal statusline for Claude Code | Proves massive demand for "at-a-glance" visibility |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | 6,731 | Go TUI managing multiple agents in tmux | Terminal-first, no web UI, no missions |
| [builderz-labs/mission-control](https://github.com/builderz-labs/mission-control) | 3,600 | Enterprise 32-panel orchestration | Trust scoring, security audit, skills marketplace |
| [parruda/swarm](https://github.com/parruda/swarm) | 1,689 | Ruby agent framework with semantic memory | Single-process, YAML config |
| [disler/observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) | 1,300 | Hook-based real-time timeline | Color-coded multi-agent events via WebSocket |
| [multi-agent-shogun](https://github.com/yohey-w/multi-agent-shogun) | 1,165 | Samurai hierarchy orchestrator | YAML coordination, Android companion app |
| [sniffly](https://github.com/chiphuyen/sniffly) | 1,191 | Privacy-first usage analytics | Per-project cost forensics, shareable dashboards |

### Tier 2: Notable Projects (50-999)

| Project | Stars | What It Does | Key Takeaway |
|---------|-------|-------------|--------------|
| [claude_code_agent_farm](https://github.com/Dicklesworthstone/claude_code_agent_farm) | 764 | 50 parallel agents with locks | File-based coordination prevents merge conflicts |
| [agent-flow](https://github.com/patoles/agent-flow) | 524 | Interactive agent decision graph | Visualize agent decisions as clickable node trees |
| [MeisnerDan/mission-control](https://github.com/MeisnerDan/mission-control) | 317 | Task command center | Eisenhower matrix, autonomous daemon |
| [codex-orchestrator](https://github.com/kingbootoshi/codex-orchestrator) | 259 | Claude strategist + Codex workers | Cross-model delegation pattern |
| [agent-council](https://github.com/team-attention/agent-council) | 124 | Multi-LLM voting council | Multiple agents debate and vote on decisions |
| [cj-vana/claude-swarm](https://github.com/cj-vana/claude-swarm) | 85 | MCP-based governance | Confidence monitoring, crash recovery |
| [affaan-m/claude-swarm](https://github.com/affaan-m/claude-swarm) | 84 | htop-style TUI | Opus plans, Haiku executes (cost optimization) |

### Tier 3: Emerging (<50 stars)

| Project | Stars | What It Does | Key Takeaway |
|---------|-------|-------------|--------------|
| [agenttop](https://github.com/vicarious11/agenttop) | 42 | Cross-tool unified monitor | Anti-pattern detection (correction spirals, marathon sessions) |
| [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) | 34 | Full dashboard with DAG | Kanban board, compaction detection |
| [abtop](https://github.com/graykode/abtop) | 28 | htop for agents (Rust) | Zero-auth, read-only, orphan port detection |
| [claude-swarm-ui](https://github.com/parruda/claude-swarm-ui) | 27 | Browser-based vibe coding | Rails + ttyd web terminal |
| [claude-devfleet](https://github.com/LEC-AI/claude-devfleet) | 12 | Mission-based fleet (our fork source) | Sub-mission delegation, QR mobile access |

## Market Gap

**Nobody combines real-time monitoring + mission assignment + agent interaction in a simple, single-command package.**

- claude-hud = terminal only, no missions
- claude-squad = TUI only, no web dashboard
- disler/observability = read-only monitoring
- builderz-labs/mission-control = enterprise overkill (32 panels)
- agent-flow = read-only visualization

**Our position:** Simple web dashboard (one command to start) that shows what agents are doing AND lets you assign missions and send instructions.

## Ideas We're Incorporating

| Feature | Source | How We'll Use It |
|---------|--------|-----------------|
| Kanban mission board | MeisnerDan/mission-control | Drag missions between Queued → Active → Done columns |
| Color-coded agent timeline | disler/observability | Each agent gets a color, events stack vertically |
| Interactive node graph | agent-flow | Toggle view showing agent decision tree |
| Anti-pattern detection | agenttop | Alert on correction spirals, stuck agents, repeated prompts |
| Cost forensics | sniffly | Per-mission cost breakdown with model info |
| Confidence scoring | builderz-labs/mission-control | Visual indicator of agent progress/confidence |
| Hook-based architecture | disler/observability | PostToolUse/PreToolUse hooks → HTTP → WebSocket → dashboard |
| Instruction injection | Original (our design) | PreToolUse hook GETs instructions, writes to stderr |

## Architecture Patterns Observed

Most successful projects converge on:
- **Isolation:** tmux sessions + git worktrees
- **Data source:** Claude Code hooks or JSONL logs
- **Real-time:** WebSocket or SSE
- **Storage:** SQLite with WAL mode
- **Frontend:** React/Vue for web, Rich/Ratatui for terminal

**Our differentiation:** Zero-framework vanilla JS dashboard embedded in npm package. No build step. No Python. Just `npx claude-mission-control`.
