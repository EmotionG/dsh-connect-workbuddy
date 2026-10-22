/**
 * The load-level badge in the HOST's model picker.
 *
 * WHY A SLOT. The host renders the model name as a plain string, so the only
 * thing a provider can put there is a character — and a character's colour is
 * the emoji font's business, not ours. The host therefore offers exactly one
 * seam for this: the `conversation.input.model.label` slot, whose contract is
 * "render non-interactive inline content such as a coloured name or badge"
 * while the picker keeps owning clicks, focus, check marks and the rest. The
 * shipped example is the official DeepSeek "1017" release badge — a coloured
 * marker next to a model name — which is the same job.
 *
 * WHY A SEPARATE FETCH. The slot is rendered by the host, outside the plugin's
 * card, so it cannot read the card's React state. It therefore asks the Host
 * for the load levels itself. The levels are a fact about this minute, so the
 * answer is cached briefly: a picker that re-fetches on every re-render would
 * be wasteful, and a level that is a few seconds old is still true.
 *
 * WHY THE HOST STILL OWNS THE NAME. The contract says to keep `model.name` as
 * the text and render the addition beside it, so this component returns the
 * name followed by the badge — it never replaces the name, and it renders
 * nothing at all for a provider that is not ours.
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { busyIcon } from './busy-icon.tsx'
import type { WorkBuddyBusyLevel } from '../busy.ts'
import { WORKBUDDY_USAGE_PATH } from '../status-paths.ts'

/** The provider ids this plugin registers. */
const OWNED_PROVIDER_IDS: ReadonlySet<string> = new Set(['workbuddy', 'workbuddy-global'])

/** How long a fetched level set is trusted, in milliseconds. */
const CACHE_MS = 60_000

/** The levels, by model id, plus when they were read. */
let cache: { levels: Record<string, WorkBuddyBusyLevel>, at: number } | undefined

/**
 * The levels, read from the Host once and reused briefly.
 *
 * `undefined` means "not known" — the caller renders nothing rather than
 * guessing, because a badge that claims a level the upstream never stated is
 * worse than no badge.
 */
async function levelsNow(): Promise<Record<string, WorkBuddyBusyLevel> | undefined> {
  if (cache !== undefined && Date.now() - cache.at < CACHE_MS) return cache.levels
  try {
    const response = await fetch(WORKBUDDY_USAGE_PATH, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!response.ok) return undefined
    const body = await response.json() as { busyLevels?: Record<string, WorkBuddyBusyLevel> }
    const levels = body.busyLevels
    if (levels === undefined || levels === null) return undefined
    cache = { levels, at: Date.now() }
    return levels
  } catch {
    // The Host is unreachable or refused: no badge. Never a made-up one.
    return undefined
  }
}

/** Forget the cached levels; used by the tests. */
export function resetBusyLevelCache(): void {
  cache = undefined
}

/**
 * The label for one model row in the host's picker.
 *
 * @param props - The host's model identity and the placement of this label.
 * @returns The catalog name, followed by the load badge when there is one.
 */
export function WorkBuddyModelLabel(props: {
  provider: { id: string, name: string }
  model: { id: string, name: string }
  placement: 'trigger' | 'menu' | 'option'
  selected: boolean
}): ReactElement {
  const { provider, model } = props
  if (!OWNED_PROVIDER_IDS.has(provider.id)) {
    // Another provider's model: the host renders the plain name.
    return <span>{model.name}</span>
  }
  return <WorkBuddyModelLabelInner modelId={model.id} name={model.name} />
}

/** The stateful half: fetches the levels, then renders the badge. */
function WorkBuddyModelLabelInner(props: { modelId: string, name: string }): ReactElement {
  const { modelId, name } = props
  const [level, setLevel] = useState<WorkBuddyBusyLevel | undefined>(undefined)

  useEffect(() => {
    let live = true
    void levelsNow().then(levels => {
      // Superseded while in flight: a newer answer must not be overwritten by
      // an older one.
      if (!live || levels === undefined) return
      setLevel(levels[modelId])
    })
    return () => { live = false }
  }, [modelId])

  return (
    <span className="dsm-workbuddy-model-label">
      <span>{name}</span>
      {level === undefined ? null : busyIcon(level, 'zh')}
    </span>
  )
}
