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

function legacyImportResult(previous, view, id) {
  const profile = view.profiles.find((item) => item.id === id)
  const before = (previous.nodes || []).filter((node) => node.profile_id === id)
  const after = (view.nodes || []).filter((node) => node.profile_id === id)
  const active = after.filter((node) => !node.retained)
  const added = active.filter((node) => !before.some((old) => old.id === node.id)).length
  const stable = (nodes) => JSON.stringify([...nodes].sort((a, b) => a.id.localeCompare(b.id)))
  return {
    added,
    updated: active.length - added,
    unchanged: !!previous.profiles.find((item) => item.id === id) && stable(before) === stable(after),
    // Legacy field name; retained bound routes remain active under the fixed-route policy.
    retained_disabled: profile?.retained_count || 0,
    skipped: [],
    source: profile ? { id: profile.id, name: profile.name, nodes: profile.node_count } : null,
  }
}

export async function dispatchClashSubscription(manager, input = {}) {
  const previous = manager.view()
  let selectedId = input.source_id
  const action = input.action ?? 'import'
  let view
  if (action === 'refresh') view = await manager.refresh(input.source_id)
  else if (action === 'configure') view = manager.configure(input.source_id, input)
  else if (action === 'import') {
    if (input.yaml !== undefined && input.content !== undefined) throw new SubscriptionError()
    const matches = previous.profiles.filter((profile) => profile.name === input.name)
    if (!input.source_id && matches.length > 1) throw new SubscriptionError()
    selectedId = input.source_id ?? matches[0]?.id
    view = await manager.import({
      ...input,
      id: selectedId,
      content: input.yaml ?? input.content,
    })
  } else throw new SubscriptionError()
  selectedId ??= view.profiles.find((profile) => !previous.profiles.some((old) => old.id === profile.id))?.id
  const status = clashSubscriptionStatus(view)
  return {
    ...status,
    ...(action === 'configure'
      ? { source: status.sources.find((source) => source.id === selectedId) }
      : legacyImportResult(previous, view, selectedId)),
    data: view,
  }
}
