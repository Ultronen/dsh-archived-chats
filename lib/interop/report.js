function clone(value, seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 20 || seen.has(value)) return null;
  seen.add(value);
  const result = Array.isArray(value) ? value.slice(0, 10000).map((item) => clone(item, seen, depth + 1)) : {};
  if (!Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      result[key] = clone(child, seen, depth + 1);
    }
  }
  seen.delete(value);
  return result;
}

function list(value) {
  return Array.isArray(value) ? value.slice(0, 10000).map((item) => clone(item)) : [];
}

export function createInteropReport({
  source = '',
  sessions = [],
  losses = [],
  conflicts = [],
  warnings = [],
} = {}) {
  const report = {
    source: typeof source === 'string' ? source.normalize('NFKC').trim() : '',
    sessions: list(sessions),
    losses: list(losses),
    conflicts: list(conflicts),
    warnings: list(warnings),
  };
  report.summary = {
    sessions: report.sessions.length,
    losses: report.losses.length,
    conflicts: report.conflicts.length,
    warnings: report.warnings.length,
  };
  return report;
}
