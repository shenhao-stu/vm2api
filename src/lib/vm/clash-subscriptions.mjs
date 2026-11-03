// Legacy Clash request shapes use the sole encrypted subscription manager.
// This adapter has no storage, listener, controller or background scheduler.
import { SubscriptionError } from './subscription-network.mjs'

export function clashSubscriptionStatus(view) {
  return {
    configured: view.runtime.available,
    sources: view.profiles.map((profile) => ({
      ...profile,
      nodes: profile.node_count,
      retired: profile.retained_count,
      has_url: profile.source === 'url',
    })),
  }
}

export async function dispatchClashSubscription(manager, input = {}) {
  const action = input.action ?? 'import'
  let view
  if (action === 'refresh') view = await manager.refresh(input.source_id)
  else if (action === 'configure') view = manager.configure(input.source_id, input)
  else if (action === 'import') {
    if (input.yaml !== undefined && input.content !== undefined) throw new SubscriptionError()
    const matches = manager.view().profiles.filter((profile) => profile.name === input.name)
    if (!input.source_id && matches.length > 1) throw new SubscriptionError()
    view = await manager.import({
      ...input,
      id: input.source_id ?? matches[0]?.id,
      content: input.yaml ?? input.content,
    })
  } else throw new SubscriptionError()
  return { ...clashSubscriptionStatus(view), data: view }
}
