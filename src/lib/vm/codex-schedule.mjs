import path from 'node:path'
import { atomicWriteJson, readJsonCached } from './vm-file.mjs'
import { isCodexVm } from './vm-kind.mjs'

/** Persist a Codex auth verdict using this branch's legacy scheduling fields. */
export function markCodexUnschedulable(projectRoot, vmId, reason, detail) {
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  const vm = readJsonCached(file)
  if (!vm || !isCodexVm(vm)) return null
  const at = new Date().toISOString()
  atomicWriteJson(
    file,
    {
      ...vm,
      schedulable: false,
      schedule_disabled_reason: reason,
      unschedulable: { reason, detail, at },
      updated_at: at,
    },
    { mode: 0o600 },
  )
  return vmId
}
