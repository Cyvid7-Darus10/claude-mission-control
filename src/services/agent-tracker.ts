import {
  type Agent,
  type Event,
  upsertAgent,
  getAgent,
  getAgents,
  updateAgent,
} from "../db";
import { eventBus } from "./event-bus";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_THRESHOLD_MS = 60_000; // 60 seconds
const DISCONNECTED_THRESHOLD_MS = 300_000; // 300 seconds
const CHECK_INTERVAL_MS = 10_000; // 10 seconds

// Track which agents already have names so we don't overwrite
const namedAgents = new Set<string>();

// ---------------------------------------------------------------------------
// Agent name derivation — give agents meaningful names on first contact
// ---------------------------------------------------------------------------

// NATO-inspired codenames for main agents (deterministic by session hash)
const CODENAMES = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo",
  "Foxtrot", "Golf", "Hotel", "India", "Juliet",
  "Kilo", "Lima", "Mike", "November", "Oscar",
  "Papa", "Quebec", "Romeo", "Sierra", "Tango",
];

function hashForCodename(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

/**
 * Derive a human-readable name for an agent.
 *
 * Strategy:
 * - Subagents: use their description (from Agent tool) or "Sub-<short-id>"
 * - Main agents: use NATO codename + project folder, e.g. "Alpha (mission-control)"
 */
function deriveName(
  agentId: string,
  sessionId: string,
  isSubagent: boolean,
  cwd: string | null,
  toolInput: Record<string, unknown> | null,
): string {
  if (isSubagent) {
    // Subagents spawned by Agent tool often have a description
    if (toolInput && typeof toolInput.description === "string") {
      const desc = toolInput.description;
      return desc.length > 30 ? desc.slice(0, 27) + "..." : desc;
    }
    // Fallback: short subagent ID
    const shortId = agentId.split(":").pop() ?? agentId;
    return `Sub-${shortId.slice(0, 6)}`;
  }

  // Main agent: project folder + codename suffix for disambiguation
  const codename = CODENAMES[hashForCodename(sessionId) % CODENAMES.length];
  const project = cwd ? cwd.split("/").filter(Boolean).pop() : null;
  return project ? `${project} — ${codename}` : codename;
}

// ---------------------------------------------------------------------------
// Activity derivation — turn tool calls into human-readable descriptions
// ---------------------------------------------------------------------------

function shortPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  return parts.length <= 2 ? parts.join("/") : parts.slice(-2).join("/");
}

function deriveActivity(toolName: string | null, toolInput: string | null): string | null {
  if (!toolName) return null;

  let input: Record<string, unknown> = {};
  if (toolInput) {
    try {
      const parsed = JSON.parse(toolInput);
      if (typeof parsed === "object" && parsed !== null) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON
    }
  }

  switch (toolName) {
    case "Edit":
    case "Write":
      return typeof input.file_path === "string"
        ? `editing ${shortPath(input.file_path)}`
        : `${toolName.toLowerCase()}ing file`;
    case "Read":
      return typeof input.file_path === "string"
        ? `reading ${shortPath(input.file_path)}`
        : "reading file";
    case "Bash": {
      const cmd = typeof input.command === "string" ? input.command : "";
      if (cmd.startsWith("npm test") || cmd.startsWith("npx vitest")) return "running tests";
      if (cmd.startsWith("npm run build") || cmd.startsWith("npx tsc")) return "building";
      if (cmd.startsWith("git ")) return `git ${cmd.split(" ")[1] ?? ""}`.trim();
      if (cmd.startsWith("npm install") || cmd.startsWith("npm i ")) return "installing deps";
      const short = cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd;
      return `running: ${short}`;
    }
    case "Grep":
      return typeof input.pattern === "string"
        ? `searching: ${input.pattern}`
        : "searching code";
    case "Glob":
      return typeof input.pattern === "string"
        ? `finding: ${input.pattern}`
        : "finding files";
    case "Agent":
      return typeof input.description === "string"
        ? `spawning: ${input.description}`
        : "spawning subagent";
    default:
      return toolName.toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// Agent Tracker
// ---------------------------------------------------------------------------

class AgentTracker {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * Process an incoming event and upsert the agent record.
   * Updates last_seen_at, status, cwd, and model from the event payload.
   * Broadcasts an enriched agent object with current_tool activity summary.
   */
  trackEvent(
    event: Event,
    context?: { cwd?: string | null; model?: string | null },
  ): Agent {
    const now = new Date().toISOString();
    const id = event.agent_id ?? event.session_id ?? "unknown";
    const sessionId = event.session_id ?? "";

    // Use context from the hook payload (cwd, model) if provided
    const cwd = context?.cwd ?? null;
    const model = context?.model ?? null;

    // Parse tool_input for subagent description
    let parsedInput: Record<string, unknown> | null = null;
    if (event.tool_input) {
      try {
        const input: unknown = JSON.parse(event.tool_input);
        if (typeof input === "object" && input !== null) {
          parsedInput = input as Record<string, unknown>;
        }
      } catch {
        // tool_input is not JSON — ignore
      }
    }

    // Derive name only if this agent hasn't been named yet
    const isSubagent = id.includes(":") && !id.endsWith(":main");
    const existingAgent = getAgent(id);
    let name: string | null = null;

    if (!namedAgents.has(id) && !existingAgent?.name) {
      name = deriveName(id, sessionId, isSubagent, cwd, parsedInput);
      namedAgents.add(id);
    } else if (existingAgent?.name) {
      namedAgents.add(id); // already named in DB (e.g. user renamed)
    }

    const agentRecord: Agent = {
      id,
      session_id: sessionId,
      agent_id: event.agent_id ?? "main",
      name,  // null preserves existing name via COALESCE
      status: "active",
      cwd,
      model,
      current_mission_id: event.mission_id ?? null,
      first_seen_at: now,
      last_seen_at: now,
    };

    const result = upsertAgent(agentRecord);

    // Derive human-readable activity from the tool call
    const currentTool = deriveActivity(event.tool_name, event.tool_input);

    // Broadcast enriched agent data (includes current_tool for the dashboard)
    eventBus.emit("agent:update", { ...result, current_tool: currentTool } as Agent & { current_tool: string | null });
    return result;
  }

  /**
   * Start the periodic sweep that marks agents as idle or disconnected
   * based on how long since they were last seen.
   */
  start(): void {
    if (this.intervalHandle !== null) {
      return; // already running
    }

    // Run an immediate sweep on startup to fix stale agents from before restart
    this.sweep();

    this.intervalHandle = setInterval(() => {
      this.sweep();
    }, CHECK_INTERVAL_MS);

    // Allow the process to exit even if the interval is running
    if (this.intervalHandle.unref) {
      this.intervalHandle.unref();
    }
  }

  /**
   * Stop the periodic sweep.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Run a single sweep: check all agents and transition their status
   * based on last_seen_at timestamps.
   */
  sweep(): void {
    const now = Date.now();
    const agents = getAgents();

    for (const agent of agents) {
      if (agent.status === "disconnected") {
        // Already at the terminal lifecycle state — skip
        continue;
      }

      const lastSeen = new Date(agent.last_seen_at).getTime();
      const elapsed = now - lastSeen;

      let newStatus: string | null = null;

      if (elapsed >= DISCONNECTED_THRESHOLD_MS && agent.status !== "disconnected") {
        newStatus = "disconnected";
      } else if (elapsed >= IDLE_THRESHOLD_MS && agent.status === "active") {
        newStatus = "idle";
      }

      if (newStatus !== null) {
        const updated = updateAgent(agent.id, { status: newStatus });
        if (updated) {
          eventBus.emit("agent:update", updated);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const agentTracker = new AgentTracker();
