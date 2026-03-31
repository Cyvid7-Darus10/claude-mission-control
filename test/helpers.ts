import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Create a fresh temp directory for MC_DATA_DIR.
 * Must be called BEFORE importing any src/ modules (they read env on import).
 */
export function setupTestDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-test-'));
  process.env.MC_DATA_DIR = dir;
  return dir;
}

/**
 * Clean up the temp directory.
 */
export function teardownTestDb(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
