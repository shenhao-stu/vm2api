const REASONS = new Set([
  'cold',
  'unchanged',
  'restored',
  'history_changed',
  'context_budget',
  'body_budget',
  'entry_budget',
  'memory_budget',
  'scan_budget',
  'concurrent',
  'unscoped',
  'disposed',
])

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)

/** Only bounded categories and counts may enter normal request summaries. */
export function toolPruneMetrics(value) {
  const reason = REASONS.has(value?.reason) ? value.reason : null
  return {
    tool_prune_reason: reason,
    tool_prune_restored: reason ? count(value.restored) : null,
    tool_prune_restored_bytes: reason ? count(value.restoredBytes) : null,
  }
}
