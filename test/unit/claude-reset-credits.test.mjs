import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canClaudeResetCredits } from '../../src/lib/oauth/credential-mode.mjs'
import test from 'node:test'
import { buildClaudeResetQuery, buildClaudeResetRedeem } from '../../src/lib/admin/panel-api.mjs'
import {
  claudeResetOperationId,
  claudeResetOrgId,
  parseClaudeResetStatus,
  projectClaudeResetCredits,
  queryClaudeResetCredits,
  redeemClaudeResetCredit,
  resetClaudeResetLeasesForTest,
} from '../../src/lib/oauth/claude-reset-credits.mjs'
import { planClaudeFableReset } from '../../src/lib/oauth/claude-reset-policy.mjs'

const ORG = '11111111-1111-4111-8111-111111111111'
const ACCOUNT = '22222222-2222-4222-8222-222222222222'
const OTHER_ACCOUNT = '33333333-3333-4333-8333-333333333333'
const ACCOUNT_FINGERPRINT = createHash('sha256').update(`claude-reset-account:${ACCOUNT}:${ORG}`).digest('hex')
const NOW = Date.parse('2026-09-25T00:00:00Z')
const REDEEMABLE = {
  cedar_ember: {
    eligible: true,
    at_limit: true,
    next_grant_id: 'grant_next',
    grants: [
      {
        id: 'grant_other',
        resets_left: 1,
        usable_now: true,
        use_requires_limit: false,
        clears: ['five_hour'],
      },
      {
        id: 'grant_next',
        resets_left: 2,
        usable_now: true,
        use_requires_limit: true,
        clears: ['five_hour', 'seven_day'],
      },
    ],
  },
}

function rootDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-claude-reset-'))
}

function writeVm(root, id = 'vm-1') {
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      platform: 'anthropic',
      family: 'claude',
      claude: { mode: 'oauth', scope: 'user:profile user:inference', account_uuid: ACCOUNT, org_uuid: ORG },
    }),
  )
  fs.utimesSync(path.join(root, 'vms', `${id}.json`), NOW / 1000, NOW / 1000)
  return id
}

function scripted({
  status = REDEEMABLE,
  claim = { result: 'reset', cleared: ['five_hour', 'seven_day'] },
  claimStatus = 200,
  onRedeem,
} = {}) {
  const posts = []
  const transport = async (_exec, op, opts = {}) => {
    if (op === 'profile')
      return { ok: true, status: 200, body: { account: { uuid: ACCOUNT }, organization: { uuid: ORG } } }
    if (op === 'reset-status') return { ok: true, status: 200, body: status }
    if (op === 'reset-redeem') {
      posts.push(opts.body)
      if (onRedeem) await onRedeem()
      if (claimStatus === 0) return { ok: false, status: 0, transportError: true, body: null }
      const body = typeof claim === 'string' ? claim : claim
      return { ok: claimStatus >= 200 && claimStatus < 300, status: claimStatus, body }
    }
    throw new Error(`unexpected ${op}`)
  }
  return { transport, posts }
}

test.beforeEach(() => {
  resetClaudeResetLeasesForTest()
})

test('query projects the next grant and hides grant ids', async () => {
  const root = rootDir()
  writeVm(root)
  const status = {
    cedar_ember: {
      eligible: true,
      at_limit: false,
      next_grant_id: 'launch',
      grants: [
        {
          id: 'launch',
          resets_left: 2,
          usable_now: true,
          use_requires_limit: false,
          ends_at: '2026-10-22T00:00:00Z',
          clears: ['five_hour'],
          percent_used: { five_hour: 65 },
          blocking: [],
        },
        { id: 'later', clears: ['five_hour'], resets_left: 1, usable_now: true, use_requires_limit: false },
      ],
    },
  }
  let calls = 0
  const result = await queryClaudeResetCredits({
    projectRoot: root,
    vmId: 'vm-1',
    now: () => NOW,
    transport: async () => {
      calls += 1
      return { ok: true, status: 200, body: status }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 1)
  assert.equal(result.claude_reset_credits.available_count, 2)
  assert.equal(result.claude_reset_credits.credits[0].redeemable, true)
  assert.equal(result.claude_reset_credits.credits[1].redeemable, false)
  const raw = JSON.stringify(result)
  for (const secret of ['"id"', 'launch', 'later', 'synthetic-token']) assert.equal(raw.includes(secret), false)
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-1.json'), 'utf8'))
  assert.equal(JSON.stringify(saved.claude_reset_credits).includes('launch'), false)
})

test('past cooldown is cleared and a future cooldown blocks', () => {
  const now = Date.now()
  const past = new Date(now - 60_000).toISOString()
  const future = new Date(now + 3_600_000).toISOString()
  const grant = { id: 'grant', resets_left: 1, usable_now: true, use_requires_limit: false, clears: ['five_hour'] }
  let view = projectClaudeResetCredits(
    { eligible: true, next_grant_id: 'grant', cooldown_until: past, grants: [grant] },
    now,
  )
  assert.equal(view.cooldown_until, undefined)
  assert.equal(view.available_count, 1)
  view = projectClaudeResetCredits(
    { eligible: true, next_grant_id: 'grant', cooldown_until: future, grants: [grant] },
    now,
  )
  assert.equal(view.available_count, 0)
  assert.ok(view.cooldown_until)
})

test('eligibility fails closed', () => {
  const now = Date.now()
  const past = new Date(now - 60_000).toISOString()
  const future = new Date(now + 3_600_000).toISOString()
  const base = { id: 'grant', resets_left: 1, usable_now: true, use_requires_limit: false, clears: ['five_hour'] }
  const cases = {
    paused: { grant: { paused: true } },
    expired: { grant: { ends_at: past } },
    future: { grant: { starts_at: future } },
    cooldown: { block: { cooldown_until: future } },
    'requires-limit': { grant: { use_requires_limit: undefined } },
    blocking: { grant: { blocking: ['seven_day'] } },
    ineligible: { block: { eligible: false } },
    spent: { grant: { resets_left: 0 } },
    'not-next': { block: { next_grant_id: 'other' } },
  }
  for (const [name, patch] of Object.entries(cases)) {
    const grant = { ...base, ...patch.grant }
    if (name === 'requires-limit') delete grant.use_requires_limit
    const block = { eligible: true, next_grant_id: grant.id, grants: [grant], ...patch.block }
    assert.equal(projectClaudeResetCredits(block, now).available_count, 0, name)
  }
})

test('missing profile scope does not call the worker', async () => {
  const root = rootDir()
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-1.json'),
    JSON.stringify({ id: 'vm-1', platform: 'anthropic', claude: { mode: 'oauth', scope: 'user:inference' } }),
  )
  const result = await queryClaudeResetCredits({
    projectRoot: root,
    vmId: 'vm-1',
    transport: async () => {
      throw new Error('network')
    },
  })
  assert.equal(result.error, 'CLAUDE_RESET_PROFILE_SCOPE_REQUIRED')
})

test('setup-token label with user:profile still queries', async () => {
  const root = rootDir()
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-03.json'),
    JSON.stringify({
      id: 'vm-03',
      platform: 'anthropic',
      claude: { mode: 'setup-token', has_access: true, scope: 'user:profile user:inference' },
    }),
  )
  let calls = 0
  const result = await queryClaudeResetCredits({
    projectRoot: root,
    vmId: 'vm-03',
    transport: async () => {
      calls += 1
      return { ok: true, status: 200, body: { cedar_ember: null } }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 1)
  assert.equal(result.claude_reset_credits.available_count, 0)
  assert.equal(
    canClaudeResetCredits({
      platform: 'anthropic',
      claude: { mode: 'setup-token', has_access: true, scope: 'user:profile user:inference' },
    }),
    true,
  )
  assert.equal(
    canClaudeResetCredits({
      platform: 'anthropic',
      claude: { mode: 'setup-token', has_access: true, scope: 'user:inference' },
    }),
    false,
  )
})

test('malformed or absent cedar blocks', () => {
  for (const body of [{}, { five_hour: {}, cedar_ember: null }]) {
    const parsed = parseClaudeResetStatus(body)
    assert.equal(parsed.block, null)
    assert.equal(parsed.error, undefined)
  }
  for (const body of [{ cedar_ember: { eligible: true } }, { error: { message: 'private upstream data' } }, null]) {
    const parsed = parseClaudeResetStatus(body)
    assert.equal(parsed.error, 'invalid')
    assert.equal(JSON.stringify(parsed).includes('private upstream data'), false)
  }
})

test('redeem lets the server pick the next grant and hides ids', async () => {
  const root = rootDir()
  writeVm(root)
  const { transport, posts } = scripted()
  const result = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    idempotencyKey: 'op-1',
    now: () => NOW,
    transport,
  })
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'reset')
  assert.equal(result.replayed, false)
  assert.deepEqual(result.cleared, ['five_hour', 'seven_day'])
  assert.equal(posts.length, 1)
  assert.equal(posts[0].grant_id, 'grant_next')
  assert.equal(posts[0].organization_uuid, ORG)
  const raw = JSON.stringify(result)
  for (const secret of ['grant_next', 'grant_other', ORG, posts[0].request_id, '"id"']) {
    assert.equal(raw.includes(secret), false, secret)
  }
})

test('a non-redeemable status sends no claim', async () => {
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const cases = [
    ['not at limit', { ...REDEEMABLE, cedar_ember: { ...REDEEMABLE.cedar_ember, at_limit: false } }],
    ['ineligible', { ...REDEEMABLE, cedar_ember: { ...REDEEMABLE.cedar_ember, eligible: false } }],
    ['cooldown', { ...REDEEMABLE, cedar_ember: { ...REDEEMABLE.cedar_ember, cooldown_until: future } }],
    ['no next grant', { ...REDEEMABLE, cedar_ember: { ...REDEEMABLE.cedar_ember, next_grant_id: 'missing' } }],
    ['absent', { cedar_ember: null }],
  ]
  for (const [name, status] of cases) {
    resetClaudeResetLeasesForTest()
    const root = rootDir()
    writeVm(root)
    const { transport, posts } = scripted({ status })
    const result = await redeemClaudeResetCredit({
      projectRoot: root,
      vmId: 'vm-1',
      idempotencyKey: 'op-1',
      transport,
    })
    assert.equal(result.error, 'CLAUDE_RESET_NOT_AVAILABLE', name)
    assert.equal(posts.length, 0, name)
  }
})

test('redeem requires an idempotency key', async () => {
  const root = rootDir()
  writeVm(root)
  const { transport, posts } = scripted()
  const missing = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', transport })
  assert.equal(missing.error, 'IDEMPOTENCY_KEY_REQUIRED')
  const blank = await buildClaudeResetRedeem({
    cfg: { paths: { project: root } },
    id: 'vm-1',
    idempotencyKey: '   ',
    transport,
  })
  assert.equal(blank.status, 400)
  assert.equal(posts.length, 0)
})

test('the same key replays and a new key gets a new request id', async () => {
  const root = rootDir()
  writeVm(root)
  const { transport, posts } = scripted()
  const first = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
  const again = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
  assert.equal(again.replayed, true)
  assert.equal(again.outcome, first.outcome)
  assert.equal(posts.length, 1)
  const second = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-2', transport })
  assert.equal(second.ok, true)
  assert.equal(posts.length, 2)
  assert.notEqual(posts[0].request_id, posts[1].request_id)
})

test('two accounts of one organization cannot claim together', async () => {
  const root = rootDir()
  writeVm(root, 'vm-1')
  writeVm(root, 'vm-2')
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let entered = 0
  const { transport, posts } = scripted({
    onRedeem: () => {
      entered += 1
      return gate
    },
  })
  const first = redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'account-one', transport })
  while (entered < 1) await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-2',
    idempotencyKey: 'account-two',
    transport,
  })
  assert.equal(second.error, 'CLAUDE_RESET_BUSY')
  release()
  const done = await first
  assert.equal(done.outcome, 'reset')
  assert.equal(posts.length, 1)
})

test('an unknown claim fences the organization', async () => {
  const claims = [
    { claimStatus: 0, claim: null },
    { claim: 'not-json', claimStatus: 200 },
    { claim: { result: 'weird' } },
    { claim: { result: 'unavailable', reason: 'stamp_indeterminate' } },
    { claim: { result: 'reset', reason: 'reset_unconfirmed' } },
    { claim: { result: 'reset' }, claimStatus: 500 },
  ]
  for (const spec of claims) {
    resetClaudeResetLeasesForTest()
    const root = rootDir()
    writeVm(root, 'vm-1')
    writeVm(root, 'vm-2')
    const { transport, posts } = scripted(spec)
    const out = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
    assert.equal(out.outcome, 'unknown')
    assert.equal(out.claude_reset_credits, undefined)
    assert.equal(String(out.reason || '').includes('private'), false)
    const again = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
    assert.equal(again.replayed, true)
    resetClaudeResetLeasesForTest()
    for (const id of ['vm-1', 'vm-2']) {
      const blocked = await redeemClaudeResetCredit({
        projectRoot: root,
        vmId: id,
        idempotencyKey: 'op-new',
        transport,
      })
      assert.equal(blocked.error, 'CLAUDE_RESET_UNRESOLVED')
    }
    assert.equal(posts.length, 1)
    const laterNow = () => Date.now() + 24 * 60 * 60 * 1000 + 60_000
    const later = await redeemClaudeResetCredit({
      projectRoot: root,
      vmId: 'vm-1',
      idempotencyKey: 'op-later',
      now: laterNow,
      transport: scripted().transport,
    })
    assert.equal(later.outcome, 'reset')
  }
})

test('a crashed claim never resends the same confirmation', async () => {
  const root = rootDir()
  writeVm(root)
  const operation = claudeResetOperationId('vm-1', 'op-1')
  const orgKey = claudeResetOrgId(ORG)
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'data', 'claude-reset-state.json'),
    JSON.stringify({
      operations: {},
      fences: {
        [orgKey]: { operation, outcome: 'unknown', reason: 'claim_unconfirmed', at: new Date().toISOString() },
      },
    }),
  )
  const { transport, posts } = scripted()
  const out = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
  assert.equal(out.outcome, 'unknown')
  assert.equal(out.replayed, true)
  assert.equal(posts.length, 0)
})

test('upstream results map and definite outcomes do not fence', async () => {
  const cases = [
    [{ result: 'reset' }, 'reset', 200],
    [{ result: 'already_used' }, 'already_used', 200],
    [{ result: 'not_limited' }, 'not_limited', 200],
    [{ result: 'cooldown', cooldown_until: '2099-01-01T00:00:00Z' }, 'cooldown', 200],
    [{ result: 'ineligible', reason: 'tenure' }, 'ineligible', 200],
    [{ result: 'reset' }, 'ineligible', 403],
  ]
  for (const [claim, outcome, claimStatus] of cases) {
    resetClaudeResetLeasesForTest()
    const root = rootDir()
    writeVm(root)
    const { transport, posts } = scripted({ claim, claimStatus })
    const out = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
    assert.equal(out.outcome, outcome)
    if (outcome === 'cooldown') assert.ok(out.cooldown_until)
    if (outcome === 'ineligible' && claimStatus === 200) assert.equal(out.reason, 'tenure')
    const again = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-2', transport })
    assert.equal(again.ok, true, outcome)
    assert.equal(posts.length, 2, outcome)
  }
})

test('unknown upstream reasons and windows are dropped', async () => {
  const root = rootDir()
  writeVm(root)
  const { transport } = scripted({
    claim: {
      result: 'ineligible',
      reason: 'Bearer synthetic-token leaked <script>',
      cleared: ['five_hour', '<bad>'],
    },
  })
  const out = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
  assert.equal(out.reason, undefined)
  assert.deepEqual(out.cleared, ['five_hour'])
})

test('explicit unavailable fences briefly', async () => {
  const root = rootDir()
  writeVm(root, 'vm-1')
  writeVm(root, 'vm-2')
  let clock = Date.now()
  const { transport, posts } = scripted({ claim: { result: 'unavailable', reason: 'grant_next' } })
  const out = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    idempotencyKey: 'op-1',
    now: () => clock,
    transport,
  })
  assert.equal(out.outcome, 'unknown')
  assert.equal(out.reason, 'upstream_unavailable')
  resetClaudeResetLeasesForTest()
  const blocked = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-2',
    idempotencyKey: 'op-new',
    now: () => clock,
    transport,
  })
  assert.equal(blocked.error, 'CLAUDE_RESET_UPSTREAM_UNAVAILABLE')
  assert.equal(posts.length, 1)
  clock += 15 * 60 * 1000 + 60_000
  const later = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    idempotencyKey: 'op-later',
    now: () => clock,
    transport: scripted().transport,
  })
  assert.equal(later.outcome, 'reset')
})

test('panel query route returns the public snapshot', async () => {
  const root = rootDir()
  writeVm(root)
  const result = await buildClaudeResetQuery({
    cfg: { paths: { project: root } },
    id: 'vm-1',
    now: () => NOW,
    transport: scripted().transport,
  })
  assert.equal(result.ok, true)
  assert.equal(result.data.claude_reset_credits.available_count, 2)
  assert.equal(JSON.stringify(result).includes('grant_next'), false)
})

function autoStatus() {
  return {
    cedar_ember: {
      eligible: true,
      at_limit: true,
      next_grant_id: 'fable_card',
      grants: [
        {
          id: 'fable_card',
          resets_left: 2,
          usable_now: true,
          use_requires_limit: false,
          clears: ['five_hour', 'seven_day_overage_included'],
          percent_used: { seven_day_overage_included: 100 },
          ends_at: new Date(NOW + 3 * 86400000).toISOString(),
        },
      ],
    },
  }
}

function autoRequest(status = autoStatus(), now = NOW) {
  const plan = planClaudeFableReset({
    vmId: 'vm-1',
    enabled: true,
    accountReady: true,
    exitReady: true,
    credits: { ...projectClaudeResetCredits(status.cedar_ember, now), account_fingerprint: ACCOUNT_FINGERPRINT },
    now,
  })
  assert.equal(plan.action, 'redeem')
  return {
    idempotencyKey: plan.idempotency_key,
    autoReset: {
      fingerprint: plan.fingerprint,
      resets_left: plan.resets_left,
      account_fingerprint: ACCOUNT_FINGERPRINT,
    },
  }
}

test('automatic reset verifies fresh card, redeems once and reuses the recorded result', async (t) => {
  const root = rootDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeVm(root)
  const status = autoStatus()
  const { transport, posts } = scripted({ status })
  const args = { projectRoot: root, vmId: 'vm-1', ...autoRequest(status), transport, now: () => NOW }
  const first = await redeemClaudeResetCredit(args)
  const second = await redeemClaudeResetCredit(args)
  assert.equal(first.outcome, 'reset')
  assert.equal(second.replayed, true)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].grant_id, 'fable_card')
})

test('a changed official next grant cannot redeem using the earlier query proof', async (t) => {
  const root = rootDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeVm(root)
  const oldStatus = autoStatus()
  const changed = autoStatus()
  changed.cedar_ember.next_grant_id = 'replacement_card'
  changed.cedar_ember.grants[0].id = 'replacement_card'
  const { transport, posts } = scripted({ status: changed })
  const out = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    ...autoRequest(oldStatus),
    transport,
    now: () => NOW,
  })
  assert.equal(out.error, 'CLAUDE_RESET_AUTO_CREDIT_CHANGED')
  assert.equal(posts.length, 0)
})

test('query fingerprints distinguish identical public cards without exposing internal grant ids', () => {
  const status = autoStatus().cedar_ember
  const first = projectClaudeResetCredits(status, NOW)
  const credit = first.credits[0]
  assert.equal(credit.fingerprint.length, 64)
  status.grants[0].percent_used.seven_day_overage_included = 23
  status.grants[0].label = 'translated display label'
  assert.equal(projectClaudeResetCredits(status, NOW + 1).credits[0].fingerprint, credit.fingerprint)
  status.grants[0].id = 'different-internal-grant'
  const second = projectClaudeResetCredits(status, NOW)
  assert.notEqual(second.credits[0].fingerprint, credit.fingerprint)
  assert.equal(JSON.stringify(second).includes('different-internal-grant'), false)
})

test('official quota resetting after query makes automatic redemption unnecessary', async (t) => {
  const root = rootDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeVm(root)
  const oldStatus = autoStatus()
  const fresh = autoStatus()
  fresh.cedar_ember.grants[0].percent_used.seven_day_overage_included = 0
  const { transport, posts } = scripted({ status: fresh })
  const out = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    ...autoRequest(oldStatus),
    transport,
    now: () => NOW,
  })
  assert.equal(out.error, 'CLAUDE_RESET_AUTO_NOT_NEEDED')
  assert.equal(posts.length, 0)
  fresh.cedar_ember.grants[0].percent_used.seven_day_overage_included = 100
  const later = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    ...autoRequest(oldStatus),
    transport,
    now: () => NOW,
  })
  assert.equal(later.outcome, 'reset')
  assert.equal(posts.length, 1)
})

test('a consumed remaining use or another ordinary next card prevents automatic redemption', async (t) => {
  for (const mutate of [
    (block) => {
      block.grants[0].resets_left = 1
    },
    (block) => {
      block.grants[0].clears = ['five_hour', 'seven_day']
    },
  ]) {
    const root = rootDir()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    writeVm(root)
    const fresh = autoStatus()
    mutate(fresh.cedar_ember)
    const { transport, posts } = scripted({ status: fresh })
    const out = await redeemClaudeResetCredit({
      projectRoot: root,
      vmId: 'vm-1',
      ...autoRequest(),
      transport,
      now: () => NOW,
    })
    assert.equal(out.ok, false)
    assert.equal(posts.length, 0)
  }
})

test('automatic redemption preserves a manual scheduling stop made after query', async (t) => {
  const root = rootDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeVm(root)
  const file = path.join(root, 'vms', 'vm-1.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), schedulable: false }))
  const { transport, posts } = scripted({ status: autoStatus() })
  const out = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    ...autoRequest(),
    transport,
    now: () => NOW,
  })
  assert.equal(out.error, 'CLAUDE_RESET_AUTO_NOT_NEEDED')
  assert.equal(posts.length, 0)
})

test('automatic reset requires a stable key and rejects malformed proof without a claim', async (t) => {
  const root = rootDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeVm(root)
  const { transport, posts } = scripted({ status: autoStatus() })
  for (const patch of [
    { autoReset: {} },
    { autoReset: { fingerprint: 'wrong', resets_left: 2 } },
    { idempotencyKey: 'fresh-key-every-minute' },
  ]) {
    const out = await redeemClaudeResetCredit({
      projectRoot: root,
      vmId: 'vm-1',
      ...autoRequest(),
      ...patch,
      transport,
      now: () => NOW,
    })
    assert.equal(out.status, 400)
  }
  assert.equal(posts.length, 0)
})

test('unconfirmed old redemption permanently blocks new automatic claims across restarts', async (t) => {
  const root = rootDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeVm(root)
  const previous = scripted({ status: autoStatus(), claimStatus: 0 })
  const first = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    idempotencyKey: 'old-manual-attempt',
    transport: previous.transport,
    now: () => NOW,
  })
  assert.equal(first.outcome, 'unknown')
  resetClaudeResetLeasesForTest()
  const later = NOW + 25 * 60 * 60 * 1000
  const next = scripted({ status: autoStatus() })
  const out = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    ...autoRequest(autoStatus(), later),
    transport: next.transport,
    now: () => later,
  })
  assert.equal(out.error, 'CLAUDE_RESET_UNRESOLVED')
  assert.equal(next.posts.length, 0)
})

function replaceAccount(root, accountUuid = OTHER_ACCOUNT) {
  const file = path.join(root, 'vms', 'vm-1.json')
  const before = fs.statSync(file)
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.claude.account_uuid = accountUuid
  fs.writeFileSync(file, JSON.stringify(vm))
  // Reproduce same-size, same-inode, same-timestamp replacement on every OS.
  // A file-metadata cache is not authoritative evidence of account identity.
  fs.utimesSync(file, before.atime, before.mtime)
}

test('query binds the public credit snapshot to account and organization without exposing identifiers', async (t) => {
  const root = rootDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeVm(root)
  const result = await queryClaudeResetCredits({ projectRoot: root, vmId: 'vm-1', transport: scripted().transport })
  assert.equal(result.claude_reset_credits.account_fingerprint, ACCOUNT_FINGERPRINT)
  assert.equal(JSON.stringify(result).includes(ACCOUNT), false)
  assert.equal(JSON.stringify(result).includes(ORG), false)
})

test('query does not attach a previous account credit snapshot after credential replacement', async (t) => {
  const root = rootDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeVm(root)
  const result = await queryClaudeResetCredits({
    projectRoot: root,
    vmId: 'vm-1',
    transport: async () => {
      replaceAccount(root)
      return { ok: true, status: 200, body: autoStatus() }
    },
  })
  assert.equal(result.error, 'CLAUDE_RESET_ACCOUNT_CHANGED')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-1.json'))).claude_reset_credits, undefined)
})

test('automatic reset rejects a previous account query proof before reaching its worker', async (t) => {
  const root = rootDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeVm(root)
  replaceAccount(root)
  let calls = 0
  const result = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    ...autoRequest(),
    now: () => NOW,
    transport: async () => {
      calls += 1
      throw new Error('must not call worker')
    },
  })
  assert.equal(result.error, 'CLAUDE_RESET_ACCOUNT_CHANGED')
  assert.equal(calls, 0)
})

test('manual and automatic resets reject profile identity drift and credential replacement before claim', async (t) => {
  for (const automatic of [false, true]) {
    for (const phase of [
      'profile',
      'reset-status',
      'profile-drift',
      'final-profile-drift',
      'missing-profile-account',
    ]) {
      const root = rootDir()
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      writeVm(root)
      const base = scripted({ status: autoStatus() })
      let profileCalls = 0
      const result = await redeemClaudeResetCredit({
        projectRoot: root,
        vmId: 'vm-1',
        ...(automatic ? autoRequest() : { idempotencyKey: 'manual-identity-check' }),
        now: () => NOW,
        transport: async (exec, op, opts) => {
          if (op === 'profile') profileCalls += 1
          if (op === phase) replaceAccount(root)
          if (
            op === 'profile' &&
            (phase === 'profile-drift' || (phase === 'final-profile-drift' && profileCalls === 2))
          ) {
            return { ok: true, status: 200, body: { account: { uuid: OTHER_ACCOUNT }, organization: { uuid: ORG } } }
          }
          if (op === 'profile' && phase === 'missing-profile-account') {
            return { ok: true, status: 200, body: { organization: { uuid: ORG } } }
          }
          return base.transport(exec, op, opts)
        },
      })
      assert.equal(result.error, 'CLAUDE_RESET_ACCOUNT_CHANGED', `${automatic}/${phase}`)
      assert.equal(base.posts.length, 0, `${automatic}/${phase}`)
    }
  }
})

test('a completed reset remains recorded but never overwrites replacement account metadata', async (t) => {
  const root = rootDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeVm(root)
  const { transport, posts } = scripted({ status: autoStatus(), onRedeem: () => replaceAccount(root) })
  const result = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    ...autoRequest(),
    now: () => NOW,
    transport,
  })
  assert.equal(result.outcome, 'reset')
  assert.equal(result.claude_reset_credits, undefined)
  assert.equal(posts.length, 1)
  const replacement = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-1.json')))
  assert.equal(replacement.claude.account_uuid, OTHER_ACCOUNT)
  assert.equal(replacement.claude_reset_credits, undefined)
  const recorded = JSON.parse(fs.readFileSync(path.join(root, 'data', 'claude-reset-state.json')))
  assert.equal(Object.values(recorded.operations)[0].outcome, 'reset')
})
