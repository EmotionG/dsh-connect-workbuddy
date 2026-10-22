/**
 * The composer pill that says what the CodeBuddy CLI route is doing RIGHT NOW.
 *
 * WHY THIS EXISTS. A bridged turn is a spawned agent: minutes of reading files
 * and running commands, then one answer. The Host tool contract has no progress
 * channel — `execute()` returns when it returns — so without this pill the user
 * watches a spinner with no way to tell "still working" from "hung". The pill is
 * fed by the plugin's own read-only route (`WORKBUDDY_CLI_LIVE_PATH`), which
 * serializes the host-side live board (see `../cli-bridge/live.ts`).
 *
 * WHY IT RENDERS NOTHING WHEN IDLE. This is the ambient dock under the composer,
 * a row the shell already fills with round/token pills. A permanent "no turn
 * running" line would be a claim about a feature most users never switch on
 * (`cliBridge.enabled` defaults to false), so the empty state is `null`: the row
 * is untouched until there is something true to say.
 *
 * WHY POLLING, AND WHY THE INTERVAL IS 5s. The Host has no push channel to a
 * session component, so a poll is the only option. Five seconds is the slowest
 * cadence at which a turn that just started still feels immediate; the elapsed
 * counter between polls is advanced locally from `startedAt` (a 1s tick that
 * costs no request), so the number moves every second without the network
 * traffic moving with it. Concurrent sessions share ONE in-flight request per
 * interval (see {@link readLive}), which is what keeps N open tabs from becoming
 * N polls per tick.
 *
 * WHY THE CLOCK OFFSET IS APPLIED. `startedAt` is the HOST's clock. A browser
 * whose clock is a minute behind would compute a negative age and the pill would
 * print nonsense. The document ships `serverTime`, so the offset is measured at
 * each successful read and applied to the local clock instead of trusting the
 * two machines to agree.
 *
 * @module dsh-connect-workbuddy/client/CodebuddyLive
 */
import { useEffect, useRef, useState } from 'react'
import { WORKBUDDY_CLI_LIVE_PATH } from '../status-paths.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/** How often the route is asked. See the module comment for why 5s. */
export const CLI_LIVE_POLL_MS = 5000

/** How often the elapsed counter is advanced locally between polls. */
export const CLI_LIVE_TICK_MS = 1000

/**
 * One live turn, as the route ships it.
 *
 * Declared here rather than imported from `../cli-bridge/live.ts` on purpose:
 * the client entry must not pull host code into the browser bundle, and this is
 * the wire shape — the same reason `status-paths.ts` declares its own types
 * instead of importing the host modules that produce them.
 */
export interface LiveTurnView {
  id: string
  startedAt: number
  elapsedMs: number
  entrance: 'tool' | 'command'
  workingDir: string
  unattended: boolean
  permissionMode: string
  model: string
  sessionId: string
  phase: 'starting' | 'running' | 'finishing'
  toolCalls: number
  lastTool: string
  chars: number
}

export interface LiveSnapshot {
  turns: LiveTurnView[]
  serverTime: number
}

/**
 * The last document any component in this page saw, shared across sessions.
 *
 * A module-level cache is safe here because the document is host state, not
 * component state: every session polls the same board, so one request serves
 * them all. `inflight` collapses the case where several components mount in the
 * same tick — without it, opening three sessions at once would fire three
 * requests and each would overwrite the others' result.
 */
let cached: { at: number; document: LiveSnapshot } | undefined
let inflight: Promise<LiveSnapshot | undefined> | undefined

/** Test seam: forget the cache so a test starts from a known state. */
export function resetLiveCache(): void {
  cached = undefined
  inflight = undefined
}

/** Read the board, reusing a recent document or a request already in flight. */
export async function readLive(fetchImpl: typeof fetch, now: number = Date.now()): Promise<LiveSnapshot | undefined> {
  if (cached !== undefined && now - cached.at < CLI_LIVE_POLL_MS) return cached.document
  if (inflight !== undefined) return inflight
  inflight = (async (): Promise<LiveSnapshot | undefined> => {
    try {
      const response = await fetchImpl(WORKBUDDY_CLI_LIVE_PATH, { headers: { accept: 'application/json' } })
      if (!response.ok) return undefined
      const document = (await response.json()) as LiveSnapshot
      if (!Array.isArray(document.turns)) return undefined
      cached = { at: Date.now(), document }
      return document
    } catch {
      // A failed poll is not an error worth surfacing: the route is local, and
      // the pill simply keeps showing the last document until the next tick.
      return undefined
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

/**
 * The text of one pill.
 *
 * Split out so the format is testable without a DOM, and so the same function
 * produces the visible label and the accessible one.
 */
export function liveLabel(
  turn: LiveTurnView,
  elapsedMs: number,
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string,
): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  const parts = [t('cliLive.running'), t('cliLive.toolCalls', { count: turn.toolCalls })]
  if (turn.phase === 'starting') parts.push(t('cliLive.starting'))
  else if (turn.phase === 'finishing') parts.push(t('cliLive.finishing'))
  else parts.push(t('cliLive.elapsed', { seconds }))
  if (turn.lastTool !== '') parts.push(t('cliLive.lastTool', { tool: turn.lastTool }))
  return parts.join(' · ')
}

export interface CodebuddyLiveProps {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
  /** Test seams; the slot injects neither. */
  fetchImpl?: typeof fetch
  pollMs?: number
  tickMs?: number
}

/**
 * The pill itself.
 *
 * Shows the NEWEST turn (the one the last click started) and appends `+N` when
 * several are live, because the dock is a single line and a queue listing would
 * wrap. The count is the whole point of the `+N`: it tells the user there is
 * more work running than the line describes.
 */
export function CodebuddyLive(props: CodebuddyLiveProps) {
  const { t } = props
  const fetchImpl = props.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  const pollMs = props.pollMs ?? CLI_LIVE_POLL_MS
  const tickMs = props.tickMs ?? CLI_LIVE_TICK_MS
  const [document, setDocument] = useState<LiveSnapshot | undefined>(undefined)
  // Bumped by the local tick so the elapsed counter re-renders without a fetch.
  const [, setTick] = useState(0)
  // Host clock minus local clock. Measured only when a FRESH document arrives:
  // `readLive` serves a cached one for up to a poll interval, and that document
  // still carries the old `serverTime`. Re-measuring on every cached return
  // would subtract the elapsed time from the offset on each poll and pin the
  // counter at whatever age the document had when it was fetched.
  const offsetRef = useRef(0)
  const offsetForRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (fetchImpl === undefined) return undefined
    let live = true
    const read = (): void => {
      void readLive(fetchImpl).then(next => {
        if (!live || next === undefined) return
        if (next.serverTime !== offsetForRef.current) {
          offsetForRef.current = next.serverTime
          offsetRef.current = next.serverTime - Date.now()
        }
        setDocument(next)
      })
    }
    read()
    const timer = setInterval(read, pollMs)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [fetchImpl, pollMs])

  const turns = document?.turns ?? []
  const active = turns.length > 0

  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => { setTick(value => value + 1) }, tickMs)
    return () => { clearInterval(timer) }
  }, [active, tickMs])

  if (!active) return null

  // Newest last in the document (the board appends), so the newest is the tail.
  const turn = turns[turns.length - 1] as LiveTurnView
  const elapsedMs = Math.max(0, Date.now() + offsetRef.current - turn.startedAt)
  const label = liveLabel(turn, elapsedMs, t)
  const extra = turns.length > 1 ? ` +${String(turns.length - 1)}` : ''

  return (
    <span
      // `status` and not `alert`: a running turn is ambient information, and an
      // assertive announcement every time a tool is called would interrupt a
      // screen-reader user mid-sentence.
      role="status"
      aria-label={t('cliLive.aria', { detail: label })}
      title={`${label}${extra}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35em',
        fontSize: '0.85em',
        opacity: 0.85,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true" style={{ width: '0.5em', height: '0.5em', borderRadius: '50%', background: 'currentColor' }} />
      {label}{extra}
    </span>
  )
}
