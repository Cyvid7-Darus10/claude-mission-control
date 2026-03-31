import {
  type Agent,
  type Event,
  upsertAgent,
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

// ---------------------------------------------------------------------------
// Agent Tracker
// ---------------------------------------------------------------------------

export class AgentTracker {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * Process an incoming event and upsert the agent record.
   * Updates last_seen_at, status, cwd, and model from the event payload.
   */
  trackEvent(event: Event): Agent {
    const now = new Date().toISOString();

    // Extract cwd and model from tool_input if available
    let cwd: string | null = null;
    let model: string | null = null;

    if (event.tool_input) {
      try {
        const input: unknown = JSON.parse(event.tool_input);
        if (typeof input === "object" && input !== null) {
          const record = input as Record<string, unknown>;
          if (typeof record.cwd === "string") {
            cwd = record.cwd;
          }
          if (typeof record.model === "string") {
            model = record.model;
          }
        }
      } catch {
        // tool_input is not JSON — ignore
      }
    }

    const agentRecord: Agent = {
      id: event.agent_id ?? event.session_id ?? "unknown",
      session_id: event.session_id ?? "",
      agent_id: event.agent_id ?? "main",
      name: null,
      status: "active",
      cwd,
      model,
      current_mission_id: event.mission_id ?? null,
      first_seen_at: now,
      last_seen_at: now,
    };

    const result = upsertAgent(agentRecord);
    eventBus.emit("agent:update", result);
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
