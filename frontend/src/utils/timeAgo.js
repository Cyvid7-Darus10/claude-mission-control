/**
 * Converts a date string to a human-readable relative time (e.g. "5m ago", "2h ago").
 * Handles both SQLite "2026-03-10 09:19:20" and ISO "2026-03-10T13:33:44+00:00" formats.
 */
export function timeAgo(dateStr) {
  if (!dateStr) return '';
  let normalized = dateStr;
  if (!normalized.includes('T')) normalized = normalized.replace(' ', 'T');
  if (!normalized.endsWith('Z') && !normalized.includes('+')) normalized += 'Z';
  const ts = new Date(normalized).getTime();
  if (isNaN(ts)) return '';
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
