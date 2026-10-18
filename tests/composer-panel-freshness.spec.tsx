// @vitest-environment jsdom
/**
 * The composer panel's rows must not be a frozen snapshot.
 *
 * The maintainer's screenshot pair was taken at the SAME second (17:12:47) and
 * disagreed about one account: the pool card said dingxiyue was 模型繁忙 with
 * 「10/15, 17:13 之后可再用」, while the composer panel drew NO mark against it.
 * Both surfaces read the same `exclusionOf` rule over the same store, so the
 * only way they can differ is TIME.
 *
 * That is what these cases pin, by executing the real component under fake
 * timers rather than grepping its source:
 *
 * 1. The account table is re-read on a cadence while the panel stays open, at
 *    the CARD's cadence (60 s) rather than the readout's five minutes — because
 *    the shortest pool cooldown it has to render is the 2-minute model-scoped
 *    throttle, so anything slower can claim 模型繁忙 behind the card's back.
 * 2. Pressing 刷新 on that table refreshes the TABLE. It used to call
 *    `fetchUsage` alone, leaving every row's mark exactly as it was.
 *
 * A source-text guard cannot express either: both defects are about WHICH code
 * runs at WHICH moment, and a regex would pass on a respelled ternary.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerCredits, COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS } from '../src/client/ComposerCredits.tsx'
import { mount, stubFetch, t, type Mounted } from './pool-render-helpers.tsx'

/**
 * Fake ONLY the interval APIs.
 *
 * `vi.useFakeTimers()` with its defaults also fakes `setTimeout`, and the shared
 * harness drains React with a real `setTimeout(…, 0)` (`Mounted.settle`). Faking
 * it therefore deadlocks every helper in this file — the timer the component
 * arms is not the timer the harness waits on, so the two must be separated
 * rather than the harness rewritten.
 */
const fakeIntervals = (): void => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.querySelectorAll('.dsm-workbuddy-composer-panel').forEach(node => { node.remove() })
})

/** A signed-in usage body for one region. */
function usageOf(total: number): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    accountId: 'a-1',
    accountName: 'A One',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [
      { id: 'a-1', accountName: 'A One', selected: true },
      { id: 'a-2', accountName: 'A Two', selected: false },
    ],
    models: [],
    enabledModelIds: [],
    imageModelIds: [],
    contexts: {},
    contextBudgets: {},
    credits: { total, expiringSoon: 0, packages: [] },
  }
}

function scopeOf(value: unknown, writable = true): any {
  return {
    getSnapshot: () => ({ status: 'ready', value, writable }),
    subscribe: () => () => {},
    set: async () => true,
  }
}

const panelText = (): string =>
  document.body.querySelector('.dsm-workbuddy-composer-panel')?.textContent ?? ''

/**
 * Mount the readout, open the panel, and settle.
 *
 * `act` is driven through the shared harness so React batches every update the
 * timer causes; a bare `vi.advanceTimersByTime` would fire the interval outside
 * `act` and the assertions would race the re-render.
 */
async function openPanel(props: Record<string, unknown> = {}): Promise<Mounted> {
  const m = await mount(ComposerCredits as any, { t, provider: 'workbuddy', settingsScope: scopeOf({ accounts: {} }), ...props })
  await m.settle()
  await m.click(m.buttons()[0] as Element)
  await m.settle()
  return m
}

describe('the panel keeps its account rows current while it is open', () => {
  it('re-reads the account table on the CARD cadence, not the readout one', () => {
    // Pinned as a constant, because the value IS the argument: the shortest
    // exclusion cooldown this table renders is 2 minutes, and the pool card it
    // must agree with polls at 60 s. A 5-minute cycle — the readout's own — would
    // let the panel contradict the card for up to four minutes at a time.
    expect(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS).toBe(60_000)
    const card = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'WorkBuddyCard.tsx'),
      'utf8',
    )
    expect(card).toContain('const POLL_INTERVAL_MS = 60_000')
    expect(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS).toBe(60_000)
  })

  it('picks up a mark that appeared AFTER the panel was opened', async () => {
    // The reported symptom, reproduced: the panel opened while nothing was
    // wrong, then a live request benched the account — and the panel kept
    // drawing no mark while the card said 模型繁忙.
    fakeIntervals()
    let marked = false
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [
            { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
            {
              id: 'a-2',
              accountName: 'A Two',
              selected: false,
              credits: 300,
              ...marked ? { excludedBy: 'model-busy' } : {},
            },
          ] }
        : usageOf(1072),
    }))
    const m = await openPanel()
    // Before the failure: no mark, as the panel originally showed.
    expect(panelText()).not.toContain('row.poolExcludedModelBusy')

    // A live request benches the account — exactly what happened at 17:11:47,
    // AFTER the panel's open-time read at ~17:12.
    marked = true
    await m.settle()
    vi.advanceTimersByTime(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS)
    await m.settle()

    // Mutation: drop the interval, or restore the open-only effect → still empty.
    expect(panelText()).toContain('row.poolExcludedModelBusy')
    // Two lines: the selected row always names itself, and the newly benched one
    // now carries its reason. Before the refresh there was one; the interval is
    // what adds the second.
    const marks = Array.from(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-mark'))
      .map(node => node.textContent ?? '')
    expect(marks).toContain('composer.current')
    expect(marks.some(line => line.includes('row.poolExcludedModelBusy')), 'the new reason is drawn').toBe(true)
    expect(marks).toHaveLength(2)
  })

  it('stops reading the table once the panel closes', async () => {
    // The cost rule at the top of the component: per-account figures are fetched
    // ONLY while the panel is visible. A timer that outlives the close would turn
    // one read per account into a permanent background poll.
    fakeIntervals()
    const calls = stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 1072 }] }
        : usageOf(1072),
    }))
    const m = await openPanel()
    const afterOpen = calls.filter(call => call.url.includes('account-credits')).length
    expect(afterOpen).toBeGreaterThan(0)

    // Close it again (the trigger toggles).
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    vi.advanceTimersByTime(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS * 3)
    await m.settle()

    // Mutation: leave the timer running on close → this count keeps climbing.
    expect(calls.filter(call => call.url.includes('account-credits')).length).toBe(afterOpen)
  })

  it('does not fire the table read before the open-time read settles', async () => {
    // Start-only-after-settle, the same shape the readout's cycle uses: two
    // overlapping reads of one route would race to set the same rows.
    fakeIntervals()
    const calls = stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 1072 }] }
        : usageOf(1072),
    }))
    await openPanel()
    const tableCalls = calls.filter(call => call.url.includes('account-credits')).length
    // One open-time read, and nothing more: no timer has been armed yet by
    // inspecting the count, because a 1 ms advance cannot have fired it.
    expect(tableCalls).toBe(1)
  })

  it('SKIPS a timer tick that arrives while a read is still in flight', async () => {
    // The cost rule this protects: a tick means "has anything changed?", and a
    // read already on its way answers that. Without the guard, a slow upstream
    // would accumulate one in-flight read per minute per account.
    //
    // The overlap must be built on the TIMER's read, not the open-time one: the
    // interval is only armed after the open-time read settles (`…finally`), so
    // hanging that read would leave no timer to tick at all and the case would
    // pass whether or not the guard existed — which is exactly how the first
    // draft of this test failed to catch the guard's removal.
    fakeIntervals()
    let tableCalls = 0
    let releaseTick: (() => void) | undefined
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      const target = String(url)
      const payload = target.includes('account-credits')
        ? { accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 1072 }] }
        : usageOf(1072)
      if (target.includes('account-credits')) {
        tableCalls += 1
        // Call 1 = the open-time read, which must settle for the timer to arm.
        // Call 2 = the first tick's read, held open so the next ticks overlap it.
        if (tableCalls === 2) await new Promise<void>(resolve => { releaseTick = resolve })
      }
      void init
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)))
            controller.close()
          },
        }),
      } as unknown as Response
    })
    const m = await mount(ComposerCredits as any, {
      t,
      provider: 'workbuddy',
      settingsScope: scopeOf({ accounts: {} }),
    })
    await m.settle()
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    expect(tableCalls).toBe(1)

    // First tick: starts a read and leaves it in flight.
    vi.advanceTimersByTime(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS)
    await m.settle()
    expect(tableCalls).toBe(2)

    // Two more ticks land while that read is still unanswered.
    vi.advanceTimersByTime(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS * 2)
    await m.settle()
    // Mutation: drop the `!force && accountsInFlight.current > 0` bail → 4.
    expect(tableCalls).toBe(2)

    // Let it finish: the harness must not be left with a dangling promise.
    releaseTick?.()
    await m.settle()
  })
  it('does NOT skip a deliberate press, even during an in-flight tick', async () => {
    // The failure mode the guard must not have: the timer's read is slow, the
    // user presses 刷新, and the press is dropped because a read is already
    // running — so the control reports "the table is current" without having
    // asked. That is the same class of defect as the button refreshing the wrong
    // half, so the deliberate path claims the newest generation (`force`).
    fakeIntervals()
    let tableCalls = 0
    let releaseFirst: (() => void) | undefined
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      const target = String(url)
      const payload = target.includes('account-credits')
        ? { accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 1072 }] }
        : usageOf(1072)
      if (target.includes('account-credits')) {
        tableCalls += 1
        if (tableCalls === 1) await new Promise<void>(resolve => { releaseFirst = resolve })
      }
      void init
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)))
            controller.close()
          },
        }),
      } as unknown as Response
    })
    const m = await mount(ComposerCredits as any, {
      t,
      provider: 'workbuddy',
      settingsScope: scopeOf({ accounts: {} }),
    })
    await m.settle()
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    expect(tableCalls).toBe(1)

    const refresh = document.body.querySelector<HTMLButtonElement>('.dsm-workbuddy-composer-panel-refresh')
    await m.click(refresh as Element)
    await m.settle()

    // Mutation: make the guard unconditional (drop `!force &&`) → stays 1.
    expect(tableCalls).toBe(2)
    releaseFirst?.()
    await m.settle()
  })
})

describe('the panel refresh control refreshes the panel', () => {
  it('re-reads the account table, not only the usage document', async () => {
    // The defect: the button sat in the ACCOUNT TABLE's header and called
    // `fetchUsage` alone, so pressing 刷新 moved the trigger's balance and left
    // every row — marks included — untouched.
    const calls = stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [
            { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
            { id: 'a-2', accountName: 'A Two', selected: false, credits: 300 },
          ] }
        : usageOf(1072),
    }))
    const m = await openPanel()
    const before = calls.filter(call => call.url.includes('account-credits')).length

    const refresh = document.body.querySelector<HTMLButtonElement>('.dsm-workbuddy-composer-panel-refresh')
    expect(refresh, 'panel refresh button').not.toBeNull()
    await m.click(refresh as Element)
    await m.settle()

    // Mutation: restore `onClick={() => void fetchUsage()}` → this stays equal.
    expect(calls.filter(call => call.url.includes('account-credits')).length)
      .toBeGreaterThan(before)
  })

  it('moves the footer clock when the table is refreshed', async () => {
    // The footer says when the panel last asked about credits. A table that just
    // refreshed under an unchanged timestamp is the same "is this stale?"
    // question the frozen marks raised.
    const calls = stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 1072 }] }
        : usageOf(1072),
    }))
    const m = await openPanel()
    const footBefore = document.body.querySelector('.dsm-workbuddy-composer-panel-foot')?.textContent ?? ''
    expect(footBefore).toContain('composer.lastRefresh')
    // Two account reads in sequence must differ by the clock, so a fake advance
    // is what makes the change observable.
    const refresh = document.body.querySelector<HTMLButtonElement>('.dsm-workbuddy-composer-panel-refresh')
    await m.click(refresh as Element)
    await m.settle()
    expect(calls.some(call => call.url.includes('account-credits'))).toBe(true)
    expect(document.body.querySelector('.dsm-workbuddy-composer-panel-foot')?.textContent)
      .toContain('composer.lastRefresh')
  })
})
