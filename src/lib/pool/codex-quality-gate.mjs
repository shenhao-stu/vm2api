import { summarizeVm } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { orderCodexSessionSlots } from './codex-slot-pool.mjs'
import { openAIRuntimeSignals } from './openai-account-runtime.mjs'

export const qualityOff = (vm) => vm?.schedule_off === true && vm.schedule_off_reason === 'quality_probe_failed'

export function eligibleQualitySlot(vm, project, model, quotaPolicy, now) {
  if (
    !vm ||
    !isCodexVm(vm) ||
    !vm.proxy?.id ||
    (!vm.proxy.host && !vm.proxy.url) ||
    vm.proxy.scheme === 'local' ||
    vm.proxy.host === 'local' ||
    vm.unschedulable ||
    vm.schedule_hold ||
    openAIRuntimeSignals(vm.id).inFlight > 0
  )
    return false
  const summary = { ...vm, ...summarizeVm(vm, project) }
  if (qualityOff(vm))
    Object.assign(summary, {
      schedule_off: false,
      schedule_manual: false,
      schedulable: true,
      schedule_disabled_reason: null,
    })
  const candidates = orderCodexSessionSlots([summary], { model, quotaPolicy, now, roundRobinCursor: 0 })
  return candidates.ids.includes(vm.id) && candidates.ready?.includes(vm.id) === true
}
