// @vitest-environment jsdom
/**
 * The load-level ICON, rendered in the card.
 *
 * The card is the one place the plugin renders itself, so it is the one place a
 * level can be drawn as a picture instead of a word. Three properties are worth
 * pinning:
 *
 * 1. It is drawn for a level that changes a decision, and NOT for the healthy
 *    default — a badge on every healthy row is decoration, not a warning.
 * 2. It is NOT drawn for a model the probe did not answer for. "We were told
 *    nothing" must not become a picture.
 * 3. The word is still there, in the tooltip: a picture saves room, it does not
 *    replace the information.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/** A signed-in usage body carrying the given load levels. */
function usageWithLevels(busyLevels: Record<string, string> | undefined): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'real-1', accountName: 'Real One' }],
    models: [
      {
        id: 'model-a',
        name: 'Model A',
        contextWindow: 192_000,
        nativeContextWindow: 192_000,
        maxTokens: 64_000,
      },
      {
        id: 'model-b',
        name: 'Model B',
        contextWindow: 192_000,
        nativeContextWindow: 192_000,
        maxTokens: 64_000,
      },
    ],
    enabledModelIds: ['model-a', 'model-b'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 20, expiringSoon: 0, packages: [] },
    ...busyLevels === undefined ? {} : { busyLevels },
  }
}

const render = async (busyLevels: Record<string, string> | undefined) => {
  stubFetch(() => ({ body: usageWithLevels(busyLevels) }))
  const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
  await m.settle()
  return m
}

/** The load icons in the rendered card, in document order. */
function icons(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.dsm-workbuddy-busy'))
}

describe('the load-level icon in the card', () => {
  it('draws one icon for the model that is congested, and none for the other', async () => {
    const m = await render({ 'model-a': 'congested' })
    const drawn = icons(m.container)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]?.className).toContain('dsm-workbuddy-busy-congested')
  })

  it('draws a different shape per level', async () => {
    const m = await render({ 'model-a': 'congested', 'model-b': 'busy' })
    const classes = icons(m.container).map(icon => icon.className)
    expect(classes.some(name => name.includes('dsm-workbuddy-busy-congested'))).toBe(true)
    expect(classes.some(name => name.includes('dsm-workbuddy-busy-busy'))).toBe(true)
  })

  it('draws NOTHING when no level was measured', async () => {
    // Absent means "not measured right now" — not "normal", and not a badge.
    const m = await render(undefined)
    expect(icons(m.container)).toHaveLength(0)
  })

  it('draws nothing for a model the probe did not answer for', async () => {
    const m = await render({ 'model-a': 'congested' })
    // Model B has no entry in the map, so it must carry no icon.
    const drawn = icons(m.container)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]?.closest('.dsm-workbuddy-model')?.textContent).toContain('Model A')
  })

  it('draws ONE shape, and lets the COUNT say how congested it is', async () => {
    // The whole point of the icon language: a single person, repeated. Two
    // people means a queue has formed; three means it is congested. A second
    // SHAPE per level would have to be learned; a count is read instantly.
    const m = await render({ 'model-a': 'busy', 'model-b': 'congested' })
    const drawn = icons(m.container)
    const peopleIn = (icon: HTMLElement | undefined): number =>
      icon?.querySelectorAll('g').length ?? 0
    const busy = drawn.find(icon => icon.className.includes('dsm-workbuddy-busy-busy'))
    const congested = drawn.find(icon => icon.className.includes('dsm-workbuddy-busy-congested'))
    expect(peopleIn(busy)).toBe(2)
    expect(peopleIn(congested)).toBe(3)
  })

  it('draws ONE person for the healthy case, and NONE for idle', async () => {
    // The healthy case IS drawn — one person says "free" without shouting.
    // `idle` (the upstream's "nobody is here") draws nothing at all.
    const m = await render({ 'model-a': 'normal' })
    const drawn = icons(m.container)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]?.querySelectorAll('g')).toHaveLength(1)
  })

  it('colours the crowd as a RAMP: green, yellow, orange, red', async () => {
    // The colour order is one the eye already knows, so the severity of a row
    // can be compared with another at a glance, without reading a word.
    const m = await render({
      'model-a': 'idle',
      'model-b': 'congested',
    })
    const drawn = icons(m.container)
    const idle = drawn.find(icon => icon.className.includes('dsm-workbuddy-busy-idle'))
    const congested = drawn.find(icon => icon.className.includes('dsm-workbuddy-busy-congested'))
    expect(idle?.getAttribute('style')).toContain('#3aa76d')
    expect(congested?.getAttribute('style')).toContain('#d93a2b')
  })

  it('keeps the word reachable, in the tooltip', async () => {
    const m = await render({ 'model-a': 'congested' })
    // The picture saves room; the title keeps the level readable. The wording
    // follows the browser's language — the upstream's own words, in the
    // upstream's own language.
    const title = icons(m.container)[0]?.getAttribute('title')
    expect(title).toBe('Extremely congested')
  })

  it('uses the Chinese wording for a Chinese browser', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'language')
    Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true })
    try {
      const m = await render({ 'model-a': 'congested' })
      expect(icons(m.container)[0]?.getAttribute('title')).toBe('极度拥堵')
    } finally {
      if (original === undefined) delete (navigator as { language?: string }).language
      else Object.defineProperty(navigator, 'language', original)
    }
  })
})
