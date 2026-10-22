// @vitest-environment jsdom
/**
 * The load badge in the HOST's model picker.
 *
 * The host renders a provider's model name as a plain string, so the only
 * thing a provider can put there is a character — and a character's colour is
 * the emoji font's business, not ours. The host therefore offers exactly one
 * seam for this: the `conversation.input.model.label` slot, whose contract is
 * "render non-interactive inline content such as a coloured name or badge"
 * while the picker keeps owning clicks, focus and check marks.
 *
 * Three things are worth pinning here, and all three are about not overstating
 * what the upstream said:
 *
 * 1. The badge is drawn NEXT TO the catalog name, never instead of it. The
 *    contract says to retain `model.name` as the text, and a picker row that
 *    lost its model name would be useless.
 * 2. Another provider's model gets the PLAIN name — no badge, no fetch.
 * 3. A model the probe did not answer for gets NO badge, even once other
 *    models have one. A badge that guesses is worse than no badge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyModelLabel, resetBusyLevelCache } from '../src/client/WorkBuddyModelLabel.tsx'
import { renderToStaticMarkup } from 'react-dom/server'

afterEach(() => {
  vi.unstubAllGlobals()
  resetBusyLevelCache()
})

/** A signed-in usage body carrying the given load levels. */
function usageWithLevels(busyLevels: Record<string, string> | undefined): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'cn-1', accountName: 'cn One' }],
    models: [{ id: 'model-a', name: 'Model A' }],
    enabledModelIds: ['model-a'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 20, expiringSoon: 0, packages: [] },
    ...busyLevels === undefined ? {} : { busyLevels },
  }
}

const props = {
  provider: { id: 'workbuddy', name: 'WorkBuddy' },
  model: { id: 'model-a', name: 'Model A' },
  placement: 'menu' as const,
  selected: false,
}

describe('the model label in the host picker', () => {
  it('keeps the catalog name, and adds the badge beside it', () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => usageWithLevels({ 'model-a': 'congested' }),
    }))
    const markup = renderToStaticMarkup(<WorkBuddyModelLabel {...props} />)
    // The NAME is still there — the contract says to retain it.
    expect(markup).toContain('Model A')
  })

  it('renders another provider\'s model as the plain name, with no fetch', () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: unknown) => {
      calls.push(String(url))
      return { ok: true, status: 200, json: async () => usageWithLevels({}) }
    })
    const markup = renderToStaticMarkup(
      <WorkBuddyModelLabel {...props} provider={{ id: 'other', name: 'Other' }} />,
    )
    expect(markup).toContain('Model A')
    expect(markup).not.toContain('dsm-workbuddy-busy')
    // No fetch for a provider that is not ours.
    expect(calls).toHaveLength(0)
  })

  it('draws NO badge for a model the probe did not answer for', () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => usageWithLevels({ 'model-a': 'congested' }),
    }))
    // A model id the probe never mentioned: the badge must not appear.
    const markup = renderToStaticMarkup(
      <WorkBuddyModelLabel {...props} model={{ id: 'model-z', name: 'Model Z' }} />,
    )
    expect(markup).toContain('Model Z')
    expect(markup).not.toContain('dsm-workbuddy-busy')
  })

  it('does not fetch at all when the Host has no levels to report', () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => usageWithLevels(undefined),
    }))
    const markup = renderToStaticMarkup(<WorkBuddyModelLabel {...props} />)
    expect(markup).toContain('Model A')
    expect(markup).not.toContain('dsm-workbuddy-busy')
  })
})
