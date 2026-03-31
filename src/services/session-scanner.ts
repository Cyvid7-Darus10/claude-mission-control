/**
 * Session Scanner — reads Claude Code's JSONL session logs for real token usage.
 *
 * Claude Code writes session transcripts to:
 *   ~/.claude/projects/{path-hash}/{session-id}.jsonl
 *
 * Each assistant message contains a `usage` block with actual token counts
 * and model info, enabling precise cost calculation instead of estimates.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Model pricing (per million tokens) — matches Anthropic's published rates
// ---------------------------------------------------------------------------

interface ModelPricing {
  readonly input: number;
  readonly output: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':   { input: 15,  output: 75,  cacheCreation: 18.75, cacheRead: 1.5 },
  'claude-opus-4-5':   { input: 15,  output: 75,  cacheCreation: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-6': { input: 3,   output: 15,  cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3,   output: 15,  cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-sonnet-4-0': { input: 3,   output: 15,  cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-haiku-4-5':  { input: 0.8, output: 4,   cacheCreation: 1,     cacheRead: 0.08 },
  'claude-haiku-3-5':  { input: 0.8, output: 4,   cacheCreation: 1,     cacheRead: 0.08 },
};

// Default to Sonnet pricing for unknown models
const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 };

function getPricing(model: string): ModelPricing {
  // Try exact match first
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // Try fuzzy: check if any known key is contained in the model string
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.includes(key) || key.includes(model)) return pricing;
  }
  // Check by tier keywords
  if (model.includes('opus')) return MODEL_PRICING['claude-opus-4-6'];
  if (model.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5'];
  return DEFAULT_PRICING;
}

function tokenCost(tokens: number, pricePerMillion: number): number {
  return (tokens / 1_000_000) * pricePerMillion;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionTokenUsage {
  readonly sessionId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly messageCount: number;
  readonly firstTimestamp: string;
  readonly lastTimestamp: string;
  readonly contextWindowUsed: number;   // last known context usage (tokens)
  readonly contextWindowPercent: number; // 0-100
  readonly isActive: boolean;           // session PID is still running
}

interface DailyTokenUsage {
  readonly date: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly messageCount: number;
  readonly sessions: number;
}

interface ModelUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly messageCount: number;
}

interface TokenSummary {
  readonly sessions: readonly SessionTokenUsage[];
  readonly daily: readonly DailyTokenUsage[];
  readonly models: readonly ModelUsage[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly totalMessages: number;
  readonly totalSessions: number;
  readonly activeSessions: number;
  readonly cacheHitRate: number;
}

// ---------------------------------------------------------------------------
// Cache — avoid re-parsing unchanged files
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly size: number;
  readonly mtime: number;
  readonly data: SessionTokenUsage;
}

const fileCache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB cap per file

function parseSessionFile(filePath: string, sessionId: string): SessionTokenUsage | null {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }

  if (stat.size > MAX_FILE_SIZE || stat.size === 0) return null;

  // Check cache
  const cached = fileCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) {
    return cached.data;
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let messageCount = 0;
  let cost = 0;
  let model = 'unknown';
  let firstTimestamp = '';
  let lastTimestamp = '';
  let lastContextUsed = 0; // last known context window usage (from cache_read + cache_creation)

  const lines = content.split('\n');
  for (const line of lines) {
    if (line.length < 10) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== 'assistant') continue;

    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const usage = msg.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    const msgModel = (msg.model as string) || 'unknown';
    if (model === 'unknown' && msgModel !== 'unknown') model = msgModel;

    const ts = entry.timestamp as string;
    if (ts) {
      if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
      if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
    }

    const inTok = (usage.input_tokens as number) || 0;
    const outTok = (usage.output_tokens as number) || 0;
    const cacheTok = (usage.cache_creation_input_tokens as number) || 0;
    const cacheReadTok = (usage.cache_read_input_tokens as number) || 0;

    inputTokens += inTok;
    outputTokens += outTok;
    cacheCreationTokens += cacheTok;
    cacheReadTokens += cacheReadTok;
    messageCount++;

    // Track last known context window usage (cache_read approximates context size)
    const thisContext = inTok + cacheTok + cacheReadTok;
    if (thisContext > 0) lastContextUsed = thisContext;

    // Calculate cost for this message
    const pricing = getPricing(msgModel);
    cost += tokenCost(inTok, pricing.input)
          + tokenCost(outTok, pricing.output)
          + tokenCost(cacheTok, pricing.cacheCreation)
          + tokenCost(cacheReadTok, pricing.cacheRead);
  }

  if (messageCount === 0) return null;

  // Context window size by model (tokens)
  const CONTEXT_WINDOWS: Record<string, number> = {
    'claude-opus-4-6': 200000,
    'claude-opus-4-5': 200000,
    'claude-sonnet-4-6': 200000,
    'claude-sonnet-4-5': 200000,
    'claude-sonnet-4-0': 200000,
    'claude-haiku-4-5': 200000,
    'claude-haiku-3-5': 200000,
  };
  const contextWindow = CONTEXT_WINDOWS[model] || 200000;
  const contextPercent = contextWindow > 0
    ? Math.min(100, parseFloat((lastContextUsed / contextWindow * 100).toFixed(1)))
    : 0;

  const result: SessionTokenUsage = {
    sessionId,
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    cost: parseFloat(cost.toFixed(6)),
    messageCount,
    firstTimestamp,
    lastTimestamp,
    contextWindowUsed: lastContextUsed,
    contextWindowPercent: contextPercent,
    isActive: false, // Set by scanner after checking PIDs
  };

  // Cache it
  fileCache.set(filePath, { size: stat.size, mtime: stat.mtimeMs, data: result });

  return result;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const CLAUDE_DIR = join(homedir(), '.claude', 'projects');
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

/**
 * Get active session IDs by reading ~/.claude/sessions/*.json
 * and checking if the PID is still running.
 */
function getActiveSessionIds(): Set<string> {
  const active = new Set<string>();
  if (!existsSync(SESSIONS_DIR)) return active;

  let files: string[];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return active;
  }

  for (const file of files) {
    try {
      const content = readFileSync(join(SESSIONS_DIR, file), 'utf-8');
      const meta = JSON.parse(content) as { pid?: number; sessionId?: string };
      if (meta.pid && meta.sessionId) {
        // Check if PID is still running
        try {
          process.kill(meta.pid, 0); // Signal 0 = test existence
          active.add(meta.sessionId);
        } catch {
          // PID not running — session is dead
        }
      }
    } catch {
      continue;
    }
  }
  return active;
}

/**
 * Scan all Claude Code JSONL session logs and compute token usage.
 * @param hoursBack - 0 means all time
 * @param projectFilter - optional project path hash to scope results
 */
export function scanSessions(hoursBack = 0, projectFilter?: string): TokenSummary {
  const since = hoursBack === 0
    ? '1970-01-01T00:00:00.000Z'
    : new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const sinceDate = since.slice(0, 10);

  const activeIds = getActiveSessionIds();
  const sessions: SessionTokenUsage[] = [];

  if (!existsSync(CLAUDE_DIR)) {
    return emptySummary();
  }

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(CLAUDE_DIR);
  } catch {
    return emptySummary();
  }

  // If a project filter is given, only scan that project
  if (projectFilter) {
    projectDirs = projectDirs.filter((d) => d === projectFilter);
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(CLAUDE_DIR, projectDir);
    let stat;
    try {
      stat = statSync(projectPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let files: string[];
    try {
      files = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = join(projectPath, file);

      const usage = parseSessionFile(filePath, sessionId);
      if (!usage) continue;

      // Filter by time range
      if (usage.lastTimestamp < since) continue;

      // Mark active sessions
      if (activeIds.has(sessionId)) {
        sessions.push({ ...usage, isActive: true });
      } else {
        sessions.push(usage);
      }
    }
  }

  // Sort by most recent first
  sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));

  // Aggregate daily
  const dailyMap = new Map<string, {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cost: number;
    messageCount: number;
    sessionIds: Set<string>;
  }>();

  for (const s of sessions) {
    // Use the date of the last activity for bucketing
    const date = s.lastTimestamp.slice(0, 10);
    if (date < sinceDate) continue;

    const existing = dailyMap.get(date);
    if (existing) {
      existing.inputTokens += s.inputTokens;
      existing.outputTokens += s.outputTokens;
      existing.cacheCreationTokens += s.cacheCreationTokens;
      existing.cacheReadTokens += s.cacheReadTokens;
      existing.cost += s.cost;
      existing.messageCount += s.messageCount;
      existing.sessionIds.add(s.sessionId);
    } else {
      dailyMap.set(date, {
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheCreationTokens: s.cacheCreationTokens,
        cacheReadTokens: s.cacheReadTokens,
        cost: s.cost,
        messageCount: s.messageCount,
        sessionIds: new Set([s.sessionId]),
      });
    }
  }

  const daily: DailyTokenUsage[] = Array.from(dailyMap.entries())
    .map(([date, d]) => ({
      date,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheCreationTokens: d.cacheCreationTokens,
      cacheReadTokens: d.cacheReadTokens,
      totalTokens: d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens,
      cost: parseFloat(d.cost.toFixed(6)),
      messageCount: d.messageCount,
      sessions: d.sessionIds.size,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Aggregate by model
  const modelMap = new Map<string, {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    messageCount: number;
  }>();

  for (const s of sessions) {
    const existing = modelMap.get(s.model);
    if (existing) {
      existing.inputTokens += s.inputTokens;
      existing.outputTokens += s.outputTokens;
      existing.cost += s.cost;
      existing.messageCount += s.messageCount;
    } else {
      modelMap.set(s.model, {
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cost: s.cost,
        messageCount: s.messageCount,
      });
    }
  }

  const models: ModelUsage[] = Array.from(modelMap.entries())
    .map(([model, m]) => ({
      model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.inputTokens + m.outputTokens,
      cost: parseFloat(m.cost.toFixed(6)),
      messageCount: m.messageCount,
    }))
    .sort((a, b) => b.cost - a.cost);

  // Totals
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;
  let totalMessages = 0;

  for (const s of sessions) {
    totalInputTokens += s.inputTokens;
    totalOutputTokens += s.outputTokens;
    totalCacheCreationTokens += s.cacheCreationTokens;
    totalCacheReadTokens += s.cacheReadTokens;
    totalCost += s.cost;
    totalMessages += s.messageCount;
  }

  const totalBillableInput = totalInputTokens + totalCacheCreationTokens + totalCacheReadTokens;
  const cacheHitRate = totalBillableInput > 0
    ? parseFloat((totalCacheReadTokens / totalBillableInput * 100).toFixed(1))
    : 0;

  return {
    sessions: sessions.slice(0, 20), // Top 20 most recent
    daily,
    models,
    totalInputTokens,
    totalOutputTokens,
    totalCacheCreationTokens,
    totalCacheReadTokens,
    totalTokens: totalInputTokens + totalOutputTokens + totalCacheCreationTokens + totalCacheReadTokens,
    totalCost: parseFloat(totalCost.toFixed(6)),
    totalMessages,
    totalSessions: sessions.length,
    activeSessions: sessions.filter((s) => s.isActive).length,
    cacheHitRate,
  };
}

function emptySummary(): TokenSummary {
  return {
    sessions: [],
    daily: [],
    models: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    totalMessages: 0,
    totalSessions: 0,
    activeSessions: 0,
    cacheHitRate: 0,
  };
}
