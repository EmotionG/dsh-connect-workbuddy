// @vitest-environment jsdom
/**
 * The composer pill, rendered.
 *
 * The host side (`cli-bridge-live.spec.ts`) locks what the board SAYS. This file
 * locks what the user SEES and how often the browser asks: that an idle board
 * renders nothing at all, that the pill names the tool count and the elapsed
 * seconds, that the counter moves between polls without another request, and
 * that a hostile or clock-skewed host cannot make the pill print nonsense.
 *
 * ## Why some tests drive the clock by hand
 *
 * The elapsed counter is the point of the pill, and it advances on a 1s tick
 * that costs no request. Asserting that needs ownership of time: with real
 * timers the test would have to sleep a whole second and then race React's
 * commit. `vi.useFakeTimers()` freezes `Date.now()` too, so an
 * `advanceTimersByTimeAsync(1_100)` moves BOTH the tick and the clock the label
 * reads — the assertion is then exact rather than a range.
 *
 * The shared harness's `settle()` drains async work with `setTimeout`, which
 * fake timers freeze (it would hang), so the mount and the first read always
 * happen under real timers; the clock is switched to fake only afterwards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import {
  CLI_LIVE_POLL_MS,
  CodebuddyLive,
  liveLabel,
  readLive,
  resetLiveCache,
} from '../src/client/CodebuddyLive.tsx'
import type { LiveSnapshot, LiveTurnView } from '../src/client/CodebuddyLive.tsx'
import { WORKBUDDY_CLI_LIVE_PATH } from '../src/status-paths.ts'
import { mount, stubFetch } from './pool-render-helpers.tsx'

/**
 * Every view this file mounted, so `afterEach` can retire them.
 *
 * A test that throws before its own `unmount()` would otherwise leave the
 * component's poll running, and its stub — not the next test's — would keep
 * refilling the module cache. That is a real trap: it once made a "the route
 * failed" test pass a stale document.
 */
const views: Awaited<ReturnType<typeof mount>>[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const view of views.splice(0)) {
    try {
      await view.unmount()
    } catch {
      // Already gone; nothing to retire.
    }
  }
  vi.unstubAllGlobals()
  resetLiveCache()
})

/** Mount the pill and remember it for cleanup. */
async function show(props: Record<string, unknown>): Promise<Awaited<ReturnType<typeof mount>>> {
  const view = await mount(CodebuddyLive as any, { t, ...props })
  views.push(view)
  return view
}

/** A translator that actually substitutes, so the assertions read like the UI. */
const TEMPLATES: Record<string, string> = {
  'cliLive.running': 'CodeBuddy',
  'cliLive.toolCalls': '{count} tools',
  'cliLive.elapsed': '{seconds}s',
  'cliLive.starting': 'starting…',
  'cliLive.finishing': 'finishing…',
  'cliLive.lastTool': 'last: {tool}',
  'cliLive.chars': '{count} chars',
  'cliLive.aria': 'A CodeBuddy turn is running: {detail}',
}

const t = ((key: string, params?: Record<string, unknown>): string => {
  const template = TEMPLATES[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (_all, name: string) => String(params[name] ?? `{${name}}`))
}) as any

function turnOf(patch: Partial<LiveTurnView> = {}): LiveTurnView {
  return {
    id: 't-1',
    startedAt: Date.now() - 3000,
    elapsedMs: 3000,
    entrance: 'tool',
    workingDir: 'C:/repo',
    unattended: false,
    permissionMode: 'dontAsk',
    model: 'deepseek-v4-flash',
    sessionId: 's-1',
    phase: 'running',
    toolCalls: 3,
    lastTool: 'Read',
    chars: 1200,
    ...patch,
  }
}

function documentOf(turns: LiveTurnView[], serverTime = Date.now()): LiveSnapshot {
  return { turns, serverTime }
}

/** Poll until the predicate holds, so no test depends on a fixed sleep. */
async function until(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('the pill', () => {
  it('renders nothing when no turn is running', async () => {
    stubFetch(() => ({ body: documentOf([]) }))
    const view = await show({ pollMs: 20, tickMs: 20 })
    await view.settle()
    expect(view.text()).toBe('')
    // Not even a container: an idle dock must stay exactly as the shell left it.
    expect(view.html()).toBe('')
  })

  it('names the tool count, the elapsed seconds and the last tool', async () => {
    stubFetch(() => ({ body: documentOf([turnOf({ startedAt: Date.now() - 3000 })]) }))
    const view = await show({ pollMs: 20, tickMs: 20 })
    await until(() => view.text().includes('CodeBuddy'), 'the pill')
    const text = view.text()
    expect(text).toContain('CodeBuddy')
    expect(text).toContain('3 tools')
    // 3s, give or take the milliseconds the mount took.
    expect(text).toMatch(/\b[34]s\b/u)
    expect(text).toContain('last: Read')
    expect(view.html()).toContain('role="status"')
  })

  it('says "starting" and "finishing" instead of a stale second count', () => {
    const starting = liveLabel(turnOf({ phase: 'starting' }), 1000, t)
    expect(starting).toContain('starting…')
    expect(starting).not.toContain('1s')
    const finishing = liveLabel(turnOf({ phase: 'finishing' }), 1000, t)
    expect(finishing).toContain('finishing…')
    expect(finishing).not.toContain('1s')
  })

  it('appends +N when more than one turn is live', async () => {
    stubFetch(() => ({ body: documentOf([turnOf({ id: 't-1' }), turnOf({ id: 't-2' }), turnOf({ id: 't-3' })]) }))
    const view = await show({ pollMs: 20, tickMs: 20 })
    await until(() => view.text().includes('+2'), 'the +2 badge')
    expect(view.text()).toContain('+2')
  })

  it('advances the elapsed counter between polls without asking again', async () => {
    expect(CLI_LIVE_POLL_MS).toBeGreaterThan(1000)
    const calls = stubFetch(() => ({ body: documentOf([turnOf({ startedAt: Date.now() - 200 })]) }))
    // The fake clock has to be installed BEFORE the mount: switching later does
    // not retroactively capture the interval the effect already armed with the
    // real `setInterval`, and the tick would simply never fire.
    vi.useFakeTimers()
    const view = await show({ pollMs: 20, tickMs: 20 })
    // `settle()` is unavailable here (it drains with `setTimeout`, which is now
    // frozen); a zero-length async advance is what lets the read's promise chain
    // finish and commit the first document.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(view.text()).toContain('0s')
    const before = calls.length

    // Now the tick fires and `Date.now()` moves with it, so the label must read
    // exactly 1s — and the request count must not budge, because the module
    // cache is still inside its 5s window.
    await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
    expect(view.text()).toContain('1s')
    expect(calls.length).toBe(before)
  })

  it('applies the host clock offset instead of trusting the browser clock', async () => {
    // The host thinks it is a minute ahead. A browser that used its own clock
    // would compute a 63s age; the offset makes it 3s.
    const hostNow = Date.now() + 60_000
    stubFetch(() => ({ body: documentOf([turnOf({ startedAt: hostNow - 3000 })], hostNow) }))
    const view = await show({ pollMs: 20, tickMs: 20 })
    await until(() => view.text().includes('CodeBuddy'), 'the pill')
    expect(view.text()).toMatch(/\b[34]s\b/u)
    expect(view.text()).not.toMatch(/\b6[0-9]s\b/u)
  })

  it('renders nothing, and does not throw, when the route fails', async () => {
    stubFetch(() => ({ status: 503, body: { error: 'no' } }))
    const view = await show({ pollMs: 20, tickMs: 20 })
    await view.settle()
    expect(view.text()).toBe('')
  })

  it('ignores a document whose turns field is not an array', async () => {
    stubFetch(() => ({ body: { turns: 'nope', serverTime: Date.now() } }))
    const view = await show({ pollMs: 20, tickMs: 20 })
    await view.settle()
    expect(view.text()).toBe('')
  })

  it('renders nothing when no fetch implementation is available', async () => {
    // A host that strips `fetch` must leave the dock untouched rather than
    // throw from an effect.
    const view = await show({ fetchImpl: undefined, pollMs: 20, tickMs: 20 })
    await view.settle()
    expect(view.text()).toBe('')
  })
})

describe('readLive', () => {
  it('collapses concurrent readers into one request', async () => {
    const calls = stubFetch(() => ({ body: documentOf([turnOf()]) }))
    const [first, second] = await Promise.all([readLive(fetch), readLive(fetch)])
    expect(calls).toHaveLength(1)
    expect(first?.turns).toHaveLength(1)
    expect(second?.turns).toHaveLength(1)
    expect(calls[0]?.url).toBe(WORKBUDDY_CLI_LIVE_PATH)
  })

  it('serves a document from the cache until the poll interval has passed', async () => {
    const calls = stubFetch(() => ({ body: documentOf([turnOf()]) }))
    await readLive(fetch)
    await readLive(fetch)
    expect(calls).toHaveLength(1)
    // Stepping past the interval must ask again.
    await readLive(fetch, Date.now() + CLI_LIVE_POLL_MS + 1)
    expect(calls).toHaveLength(2)
  })
})
