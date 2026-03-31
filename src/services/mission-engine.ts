import {
  type Mission,
  createMission as dbCreateMission,
  getMission,
  getMissions,
  updateMission,
} from "../db";
import { eventBus } from "./event-bus";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MissionStatus =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "blocked";

export interface CreateMissionInput {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null;
  readonly priority?: number;
  readonly depends_on?: readonly string[] | null;
}

export class MissionEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionEngineError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the depends_on field (stored as comma-separated string) into an array.
 */
function parseDeps(depsField: string | null): readonly string[] {
  if (!depsField || depsField.trim() === "") {
    return [];
  }
  return depsField
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

/**
 * Serialise a dependency array into the comma-separated storage format.
 */
function serialiseDeps(deps: readonly string[]): string | null {
  return deps.length > 0 ? deps.join(",") : null;
}

/**
 * Build an adjacency list from all missions and detect cycles using DFS.
 * Returns true if adding `newDeps` to `newId` would create a cycle.
 */
function wouldCreateCycle(
  newId: string,
  newDeps: readonly string[],
  allMissions: readonly Mission[],
): boolean {
  // Build adjacency: mission -> missions it depends on
  const graph = new Map<string, readonly string[]>();

  for (const m of allMissions) {
    graph.set(m.id, parseDeps(m.depends_on));
  }

  // Add the proposed edges
  graph.set(newId, newDeps);

  // DFS cycle detection
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): boolean {
    if (inStack.has(node)) {
      return true; // cycle found
    }
    if (visited.has(node)) {
      return false;
    }

    visited.add(node);
    inStack.add(node);

    const neighbours = graph.get(node) ?? [];
    for (const neighbour of neighbours) {
      if (dfs(neighbour)) {
        return true;
      }
    }

    inStack.delete(node);
    return false;
  }

  // Check for cycles starting from the new node
  return dfs(newId);
}

/**
 * Determine whether all dependencies of a mission are completed.
 */
function areDepsCompleted(
  deps: readonly string[],
  allMissions: readonly Mission[],
): boolean {
  if (deps.length === 0) {
    return true;
  }

  const missionMap = new Map(allMissions.map((m) => [m.id, m]));

  return deps.every((depId) => {
    const dep = missionMap.get(depId);
    return dep !== undefined && dep.status === "completed";
  });
}

// ---------------------------------------------------------------------------
// Mission Engine
// ---------------------------------------------------------------------------

/**
 * Create a new mission. Validates that all dependencies exist, checks for
 * dependency cycles, and sets the initial status based on whether
 * dependencies are already met.
 */
export function createMission(input: CreateMissionInput): Mission {
  const deps = input.depends_on ?? [];
  const allMissions = getMissions();

  // Validate that all referenced dependencies exist
  if (deps.length > 0) {
    const existingIds = new Set(allMissions.map((m) => m.id));
    const missing = deps.filter((d) => !existingIds.has(d));
    if (missing.length > 0) {
      throw new MissionEngineError(
        `Dependencies not found: ${missing.join(", ")}`,
      );
    }
  }

  // Check for cycles
  if (wouldCreateCycle(input.id, deps, allMissions)) {
    throw new MissionEngineError(
      `Adding dependencies [${deps.join(", ")}] to mission "${input.id}" would create a cycle`,
    );
  }

  // Determine initial status
  const depsCompleted = areDepsCompleted(deps, allMissions);
  const initialStatus: MissionStatus =
    deps.length > 0 && !depsCompleted ? "blocked" : "queued";

  const now = new Date().toISOString();

  const mission: Mission = {
    id: input.id,
    title: input.title,
    description: input.description ?? null,
    status: initialStatus,
    priority: input.priority ?? 0,
    assigned_agent_id: null,
    depends_on: serialiseDeps(deps),
    created_at: now,
    started_at: null,
    completed_at: null,
    result: null,
  };

  const created = dbCreateMission(mission);
  eventBus.emit("mission:update", created);
  return created;
}

/**
 * Assign a mission to an agent and transition it to the active state.
 */
export function assignMission(missionId: string, agentId: string): Mission {
  const mission = getMission(missionId);
  if (!mission) {
    throw new MissionEngineError(`Mission not found: ${missionId}`);
  }

  if (mission.status !== "queued") {
    throw new MissionEngineError(
      `Cannot assign mission "${missionId}": status is "${mission.status}", expected "queued"`,
    );
  }

  const now = new Date().toISOString();
  const updated = updateMission(missionId, {
    status: "active",
    assigned_agent_id: agentId,
    started_at: now,
  });

  if (!updated) {
    throw new MissionEngineError(`Failed to update mission: ${missionId}`);
  }

  eventBus.emit("mission:update", updated);
  return updated;
}

/**
 * Mark a mission as completed and unblock any downstream missions
 * whose dependencies are now fully satisfied.
 */
export function completeMission(missionId: string, result: string): Mission {
  const mission = getMission(missionId);
  if (!mission) {
    throw new MissionEngineError(`Mission not found: ${missionId}`);
  }

  if (mission.status !== "active") {
    throw new MissionEngineError(
      `Cannot complete mission "${missionId}": status is "${mission.status}", expected "active"`,
    );
  }

  const now = new Date().toISOString();
  const updated = updateMission(missionId, {
    status: "completed",
    completed_at: now,
    result,
  });

  if (!updated) {
    throw new MissionEngineError(`Failed to update mission: ${missionId}`);
  }

  eventBus.emit("mission:update", updated);

  // Check if any blocked missions can now be unblocked
  unblockReadyMissions();

  return updated;
}

/**
 * Mark a mission as failed.
 */
export function failMission(missionId: string, reason: string): Mission {
  const mission = getMission(missionId);
  if (!mission) {
    throw new MissionEngineError(`Mission not found: ${missionId}`);
  }

  if (mission.status !== "active" && mission.status !== "queued") {
    throw new MissionEngineError(
      `Cannot fail mission "${missionId}": status is "${mission.status}", expected "active" or "queued"`,
    );
  }

  const now = new Date().toISOString();
  const updated = updateMission(missionId, {
    status: "failed",
    completed_at: now,
    result: reason,
  });

  if (!updated) {
    throw new MissionEngineError(`Failed to update mission: ${missionId}`);
  }

  eventBus.emit("mission:update", updated);
  return updated;
}

/**
 * Return missions that are ready to be assigned: status is queued,
 * or status is blocked but all dependencies are now completed.
 */
export function getReadyMissions(): readonly Mission[] {
  const allMissions = getMissions();

  return allMissions.filter((m) => {
    if (m.status === "queued") {
      return true;
    }
    if (m.status === "blocked") {
      const deps = parseDeps(m.depends_on);
      return areDepsCompleted(deps, allMissions);
    }
    return false;
  });
}

/**
 * Scan all blocked missions and transition any whose dependencies
 * are now fully completed to the queued state.
 */
function unblockReadyMissions(): void {
  const allMissions = getMissions();
  const blockedMissions = allMissions.filter((m) => m.status === "blocked");

  for (const mission of blockedMissions) {
    const deps = parseDeps(mission.depends_on);
    if (areDepsCompleted(deps, allMissions)) {
      const updated = updateMission(mission.id, { status: "queued" });
      if (updated) {
        eventBus.emit("mission:update", updated);
      }
    }
  }
}
