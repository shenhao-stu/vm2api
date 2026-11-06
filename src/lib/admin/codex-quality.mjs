import { createHash } from 'node:crypto'
import { readCodexAccounts } from '../vm/codex-slot.mjs'
import { getVm } from '../vm/vm-registry.mjs'
import { checkQualityExit, qualityExitBinding } from '../pool/codex-quality-exit.mjs'

// Read the previous release's evidence only for the same credential owner.
export function legacyQualityState(project, vmId, stored) {
  const [a] = readCodexAccounts(project, vmId)
  if (!a || !stored) return null
  const identity = [a.chatgpt_account_id || '', a.email || '', a.chatgpt_account_id || a.email ? '' : a.access_token]
  if (stored.account !== createHash('sha256').update(JSON.stringify(identity)).digest('hex')) return null
  if (!Number.isFinite(stored.last_at)) return null
  const at = new Date(stored.last_at).toISOString()
  return {
    last_result: stored.result || null,
    last_test_at: at,
    last_dispatched_at: at,
    last_request_id: stored.request_id || null,
    pending_request_id: stored.result === 'pending' ? stored.request_id : null,
    consecutive_wrong: stored.wrong || 0,
    recovery_phase: stored.quality_paused ? (stored.first_pass ? 'confirming' : 'cooldown') : null,
    recovery_first_pass_at: stored.first_pass ? new Date(stored.first_pass).toISOString() : null,
    recovery_next_at: stored.due ? new Date(stored.due).toISOString() : null,
  }
}

// A bare answer can vote only after the gateway attributed a single completed attempt.
export function attributedAnswer(body, receipt, vmId, model) {
  const verified =
    receipt?.vm_id === vmId &&
    receipt.model === model &&
    receipt.attempt_count === 1 &&
    receipt.final_state === 'verified' &&
    !receipt.model_mismatch &&
    (!receipt.upstream_model || receipt.upstream_model === model) &&
    body?.status === 'completed' &&
    (!body.model || body.model === model)
  if (!verified) return { ok: false, status: 502 }
  const text = (Array.isArray(body.output) ? body.output : [])
    .filter((item) => item?.type === 'message' && item.role === 'assistant')
    .flatMap((item) => item.content || [])
    .filter((part) => part?.type === 'output_text')
    .map((part) => part.text)
    .join('')
  return {
    ok: true,
    status: 200,
    vm_id: vmId,
    stop_reason: body.status,
    text,
    debug: {
      hit_vm: vmId,
      upstream_model: receipt.upstream_model,
      safety_buffering: typeof body.safety_buffering === 'boolean' ? body.safety_buffering : null,
    },
  }
}

async function boundedJson(response) {
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 128 * 1024) throw new Error('quality_response_too_large')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export function loopbackMeasurement({ project, port, apiKey, receipt }) {
  return async (vmId, { model, prompt, reasoning_effort, timeoutMs, requestId }) => {
    const binding = qualityExitBinding(project, getVm(project, vmId))
    if (!(await checkQualityExit(binding))) return { ok: false, status: 503 }
    const current = qualityExitBinding(project, getVm(project, vmId))
    if (current?.url !== binding.url || current.ip !== binding.ip) return { ok: false, status: 503 }
    const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: 'Bearer ' + apiKey,
        'content-type': 'application/json',
        'x-kin-vm': vmId,
        'x-kin-quality-probe': '1',
        'x-request-id': requestId,
        'session-id': requestId,
      },
      body: JSON.stringify({
        model,
        stream: false,
        store: false,
        max_output_tokens: 512,
        reasoning: { effort: reasoning_effort },
        input: [{ role: 'user', content: prompt }],
      }),
    })
    if (!r.ok) {
      await r.body?.cancel()
      return { ok: false, status: r.status }
    }
    const body = await boundedJson(r)
    return attributedAnswer(body, receipt(requestId), vmId, model)
  }
}
