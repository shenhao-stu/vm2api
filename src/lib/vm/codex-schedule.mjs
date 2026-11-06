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
      schedule_disabled_reason: vm.schedule_off ? vm.schedule_off_reason : reason,
      unschedulable: { reason, detail, at },
      updated_at: at,
    },
    { mode: 0o600 },
  )
  return vmId
}

// Only a Codex record can own a quality pause. Write both the legacy scheduler
// fields and the pause reason so reopening it cannot clear independent auth/maintenance holds.
export function setCodexScheduleOff(project, id, off, { reason = 'disabled', preserveUnschedulable = false } = {}) {
  const file = path.join(project, 'vms', id + '.json')
  const vm = readJsonCached(file)
  if (!vm || !isCodexVm(vm)) return null
  const next = { ...vm, updated_at: new Date().toISOString() }
  next.schedule_updated_at = next.updated_at
  if (off) {
    next.schedule_off = next.schedule_manual = true
    next.schedule_off_reason = next.schedule_disabled_reason = reason || 'disabled'
    next.schedulable = false
  } else {
    delete next.schedule_off
    delete next.schedule_off_reason
    if (!preserveUnschedulable) delete next.unschedulable
    next.schedule_disabled_reason = next.unschedulable?.reason || next.schedule_hold?.reason || null
    next.schedulable = !next.schedule_disabled_reason
    next.schedule_manual = false
    if (next.schedulable && next.status === 'paused') next.status = 'running'
  }
  atomicWriteJson(file, next, { mode: 0o600 })
  return next
}
