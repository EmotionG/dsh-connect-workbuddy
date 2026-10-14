import { describe, expect, it } from 'vitest'
import { mergePoolProbe } from '../src/account-pool-store.ts'
import { probeUpdatesOf, testAllAccounts } from '../src/account-pool-run.ts'
import { resolveTargetModel, targetModelPreference } from '../src/account-pool.ts'
import type { WorkBuddyPoolTarget } from '../src/account-pool-run.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

/**
 * Issue #61: the pool's test button probes ONE model — the region's
 * `targetModelId` — and the row it produces reads as account-level
 * availability. But `6004` is an ACCOUNT × MODEL condition: the reporter
 * measured two accounts where `hy4-preview-f` answered while `step-5-preview`
 * returned `429 / 6004` in the same second, with the panel showing both as
 * 可用. "The panel says available, then the chat hits a wall."
 *
 * Three fixes, all pinned here:
 *   1. a probe record now carries the MODEL it measured, so a verdict can state
 *      its own scope;
 *   2. a test model can be chosen PER ACCOUNT, and both the row test and the
 *      batch honour it;
 *   3. an override naming a model this region no longer offers is reported, and
 *      never silently swapped for one the user did not choose.
 */

const CATALOG = [
  { id: 'hy4-preview-f', name: 'hy4', contextWindow: 1_000_000, maxTokens: 8_192 },
  { id: 'step-5-preview', name: 'step5', contextWindow: 1_000_000, maxTokens: 8_192 },
] as unknown as readonly WorkBuddyModelInfo[]

describe('which model one account is tested on', () => {
  it('prefers the account override, and falls back to the region target', () => {
    const preferences = { targetModelId: 'hy4-preview-f', targetModelIdByAccount: { b: 'step-5-preview' } }
    expect(targetModelPreference(preferences, 'b')).toBe('step-5-preview')
    expect(targetModelPreference(preferences, 'a')).toBe('hy4-preview-f')
    // No override at all is the pre-#61 behaviour, for every account.
    expect(targetModelPreference({ targetModelId: 'hy4-preview-f' }, 'a')).toBe('hy4-preview-f')
  })

  it('treats an EMPTY override as "follow the region target", not as "no model"', () => {
    // The card stores `''` when the user picks "region target"; reading that as
    // an explicit choice would resolve to nothing and disable the row's test.
    expect(targetModelPreference({ targetModelId: 'hy4-preview-f', targetModelIdByAccount: { a: '' } }, 'a'))
      .toBe('hy4-preview-f')
  })

  it('still validates the override against the catalog', () => {
    // The refusal that matters: an override pointing at a model this region no
    // longer offers must NOT become "test some other model instead" — that
    // spends credits on a model nobody chose and reports it as this account's
    // verdict.
    const target = resolveTargetModel(CATALOG, targetModelPreference(
      { targetModelId: '', targetModelIdByAccount: { a: 'ghost-model' } },
      'a',
    ))
    expect(target).toEqual({ staleModelId: 'ghost-model', source: 'stale' })
    expect(target.modelId).toBeUndefined()
  })
})

describe('the batch honours a per-account model', () => {
  /** A runner whose probe RECORDS the model it was handed. */
  function runner(probed: string[]) {
    return {
      credentialFor: async (accountId: string) => ({ accountId }) as never,
      fetchCheckinStatus: async () => ({}) as never,
      claimDailyCheckin: async () => ({ credit: 0, streakDays: 0 }),
      probe: async (_credential: unknown, modelId: string) => {
        probed.push(modelId)
        return { modelId, outcome: 'ok' as const }
      },
      wait: async () => {},
    }
  }

  const targets: WorkBuddyPoolTarget[] = [
    { accountId: 'a', accountName: 'Alpha' },
    { accountId: 'b', accountName: 'Beta' },
  ]

  it('probes each account on ITS OWN model rather than one model for the table', async () => {
    const probed: string[] = []
    const rows = await testAllAccounts(
      targets,
      accountId => ({ modelId: accountId === 'b' ? 'step-5-preview' : 'hy4-preview-f' }),
      runner(probed) as never,
    )
    expect(rows.map(row => row.result.modelId)).toEqual(['hy4-preview-f', 'step-5-preview'])
    expect(probed).toEqual(['hy4-preview-f', 'step-5-preview'])
  })

  it('still accepts ONE model for the whole batch, unchanged', async () => {
    // Every existing caller passes a string; that shape must keep working.
    const rows = await testAllAccounts(targets, 'hy4-preview-f', runner([]) as never)
    expect(rows.map(row => row.result.modelId)).toEqual(['hy4-preview-f', 'hy4-preview-f'])
  })

  it('reports an unresolvable per-account target instead of substituting another', async () => {
    const probed: string[] = []
    const rows = await testAllAccounts(
      targets,
      accountId => accountId === 'b' ? { staleModelId: 'ghost-model' } : { modelId: 'hy4-preview-f' },
      runner(probed) as never,
    )
    // b produced a row WITHOUT a probe, and the row names the model that could
    // not be tested — so the account is neither silently retargeted nor left
    // looking untested.
    expect(probed).toEqual(['hy4-preview-f'])
    expect(rows[1]?.result.outcome).toBe('unavailable')
    expect(rows[1]?.result.modelId).toBe('ghost-model')
    expect(rows[1]?.result.message).toContain('ghost-model')
  })
})

describe('the record says WHICH model it measured', () => {
  it('is written by the batch from the probe that produced it', () => {
    const updates = probeUpdatesOf([{
      accountId: 'a',
      accountName: 'Alpha',
      result: { modelId: 'step-5-preview', outcome: 'rate-limited' },
    }])
    expect(updates['a']?.modelId).toBe('step-5-preview')
  })

  it('is NOT inherited when a later write does not know it', () => {
    // The deliberate contrast with `accountName`/`retryAtMs`. Those describe the
    // ACCOUNT — a name a later writer could not see is still true, and a future
    // refresh time is still future — while the model describes THIS
    // measurement. Carrying an older id forward would relabel a fresh
    // measurement with a model it was not taken on, which is the exact
    // confusion the field exists to end.
    const merged = mergePoolProbe(
      { outcome: 'ok', atMs: 1_000, modelId: 'hy4-preview-f', accountName: 'Alpha' },
      { outcome: 'rate-limited', atMs: 2_000, message: 'quota' },
    )
    expect(merged.modelId).toBeUndefined()
    // The neighbouring inherits still work, so this is not "merge stopped
    // merging".
    expect(merged.accountName).toBe('Alpha')
  })

  it('is overwritten by a newer measurement on a different model', () => {
    const merged = mergePoolProbe(
      { outcome: 'ok', atMs: 1_000, modelId: 'hy4-preview-f' },
      { outcome: 'rate-limited', atMs: 2_000, modelId: 'step-5-preview' },
    )
    expect(merged.modelId).toBe('step-5-preview')
  })
})
