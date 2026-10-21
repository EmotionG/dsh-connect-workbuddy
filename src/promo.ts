/**
 * WorkBuddy promotion & tier badges — the upstream's own "this model is on
 * offer" annotation, parsed and resolved against the wall clock.
 *
 * WHY A SEPARATE MODULE, AND WHY IT COSTS NO REQUEST. The upstream ships the
 * badges inside the SAME `/v3/config` document that already carries the model
 * roster: `data.modelPromotions` and `data.modelTiers` sit beside
 * `data.models` (observed on the global feed, 2026-10-21). The plugin already
 * reads that document for the roster, so drawing a promotion badge adds ZERO
 * upstream traffic — it only adds a parser, because the document is not a
 * clean list of promotions: the same `modelPromotions` array also carries
 * NON-promotion entries (`hy-image-3.5`, `kling-video-v3` — entries with
 * `tags` / `videoGeneration` and no `modelIds` and no `badge`). Those must be
 * dropped, not rendered.
 *
 * WHY THE RESOLUTION LIVES HERE AND NOT IN THE FETCHER. A badge is a function
 * of the clock, not of the fetch: the upstream's windows are wall-clock
 * windows in a named zone (`schedule.daily`, e.g. `23:00`–`7:50` in
 * `Asia/Shanghai`) and absolute windows (`schedule.validFrom` /
 * `schedule.validUntil`). Picking the badge once, at parse time, FREEZES it —
 * a badge read at 22:59 would still claim "night discount" at 08:00 the next
 * morning. So the parser keeps EVERY candidate and the RENDERER asks for the
 * one that holds at the moment it draws. The card re-renders at least once a
 * minute while it is open (it polls the usage route), so a window edge is
 * picked up within a minute without a second timer.
 *
 * THE SHAPES THIS PARSER ACCEPTS (all observed on the global feed's
 * `/v3/config`, 2026-10-21 — the CN feed publishes the same two arrays, with
 * Chinese labels and the extra fields listed at the end of this header):
 *
 *   {
 *     id: 'hy3-free-trial-202608',
 *     kind: 'discount',
 *     enabled: true,
 *     priority: 200,
 *     modelIds: ['hy3'],
 *     badge: { label: 'Free now', color: '#FF0000', display: 'activeOnly' },
 *     discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
 *     hover: { textZh: 'Aug 6 – Oct 31: Free daily use with unlimited credits.' },
 *     schedule: {
 *       timezone: 'Asia/Shanghai',
 *       validFrom: '2026-07-06T00:00:00+08:00',
 *       validUntil: '2026-11-01T00:00:00+08:00',
 *     },
 *   }
 *
 * and the tier shape (`data.modelTiers`), which has the same `badge` /
 * `modelIds` / `priority` core, no `schedule`, and a `requiredUserType`:
 *
 *   {
 *     id: 'gpt-pro-only',
 *     badge: { label: 'Pro Only', labelEn: 'Pro Only', color: '#009273' },
 *     hover: { textEn: 'Exclusive to Pro subscribers.', textZh: '模型仅面向 Pro 用户开放。' },
 *     modelIds: ['gpt-6-astra', …],
 *     priority: 200,
 *     requiredUserType: 'standard',
 *     tier: 'standard',
 *   }
 *
 * THE CN FEED IS THE SAME FEED, READ AS THE APP READS IT. The CN gateway
 * publishes `modelPromotions` (8 entries, measured 2026-10-21) and
 * `modelTiers` (1 entry) in the SAME `/v3/config` document — with Chinese
 * labels (`夜间折扣` / `限时免费` / `夜间免费` / `独家限免` / `限时折扣` /
 * `订阅优先`), a `schedule.daily` night window, a base64 `badge.icon` and an
 * optional `badge.display: 'activeOnly'`. Those richer shapes are exactly what
 * this parser accepts below.
 *
 * They are visible only to the APP's product identity: the CLI channel's
 * answer to the same URL publishes neither array, because it is a strict
 * subset of the app channel's document. The plugin therefore reads the
 * product configuration as the app does (`PRODUCT_UA` in `src/upstream.ts`) —
 * which is why a CN account sees the same badges here as in the WorkBuddy
 * app, without a second upstream request.
 *
 * @module dsh-connect-workbuddy/promo
 */

/** How the upstream wants the badge to appear. */
export interface WorkBuddyPromoBadge {
  /**
   * The badge's own wording, region-localized ("限时免费" on the CN feed,
   * "Free now" on the global one).
   */
  label: string
  /** The English wording, when the upstream publishes one. */
  labelEn?: string
  /** A compact wording, when the upstream publishes one. */
  shortLabel?: string
  /** The English compact wording, when the upstream publishes one. */
  shortLabelEn?: string
  /**
   * The badge's colour, as a hex string ("#009273").
   *
   * The upstream publishes it for most promotions and omits it for others
   * (the CN tier entry has none), so the renderer treats it as optional.
   */
  color?: string
  /**
   * `'activeOnly'` — the badge belongs to the promotion's RUNNING period and
   * must disappear when the promotion is over.
   *
   * Absent — the badge is STANDING: it describes the model for as long as the
   * promotion itself lasts, while the promotion's daily window governs only
   * the discount. The upstream uses this for its night-discount pairs, where
   * one entry carries the badge plus the night hours and a second, separate
   * entry carries the same badge plus the daytime hours.
   */
  display?: 'activeOnly'
}

/** One daily window, as wall-clock times in `schedule.timezone`. */
export interface WorkBuddyPromoWindow {
  /** `'HH:mm'`, inclusive. */
  start: string
  /**
   * `'HH:mm'`, exclusive.
   *
   * `end` at or before `start` means the window CROSSES MIDNIGHT: `23:00` to
   * `7:50` is the observed CN night window.
   */
  end: string
}

/** When a promotion runs. */
export interface WorkBuddyPromoSchedule {
  /** The IANA zone the daily windows are written in ("Asia/Shanghai"). */
  timezone?: string
  /** Epoch milliseconds; the promotion has not started before it. */
  validFrom?: number
  /** Epoch milliseconds; the promotion is over AT it. */
  validUntil?: number
  /** The daily windows, when the upstream publishes them. */
  daily?: readonly WorkBuddyPromoWindow[]
}

/** The upstream's explanatory copy for the badge. */
export interface WorkBuddyPromoHover {
  /** The Chinese wording. */
  textZh?: string
  /** The English wording. */
  textEn?: string
}

/** One upstream promotion or tier, resolved into the shape this plugin uses. */
export interface WorkBuddyPromo {
  /** The upstream's id ("hy3-free-trial-202608"). */
  id: string
  /** Which upstream list the entry came from. */
  source: 'promotion' | 'tier'
  /** The models the badge applies to. */
  modelIds: readonly string[]
  /** What the badge says and how it looks. */
  badge: WorkBuddyPromoBadge
  /** The upstream's explanatory copy, when it publishes one. */
  hover?: WorkBuddyPromoHover
  /** When the promotion runs, when it publishes that. */
  schedule?: WorkBuddyPromoSchedule
  /**
   * The upstream's ordering weight: the higher the number, the more the
   * badge matters. Used to pick ONE badge per model when several apply.
   */
  priority: number
}

/** A record-ish value, or undefined for anything else. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A trimmed non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * `'HH:mm'` → minutes since midnight, or undefined for anything else.
 *
 * Hours above 23 are refused: the upstream writes wall-clock times, and
 * `24:00` would mean "midnight of the next day", which is a different
 * statement than the one the upstream would be making. A malformed window is
 * dropped rather than guessed at — a wrong window would hide a live promotion.
 */
function minutesOfClock(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return undefined
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/** An ISO-8601 instant → epoch milliseconds. Numbers are refused on purpose. */
function parseInstant(value: unknown): number | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? undefined : ms
}

/** The upstream's `modelIds` → the model's ids, de-duplicated. */
function parseModelIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  for (const entry of value) {
    const id = text(entry)
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids.length === 0 ? undefined : ids
}

/** The upstream's `badge` → this plugin's badge shape. */
function parseBadge(value: unknown): WorkBuddyPromoBadge | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  // The label is REQUIRED: an entry without one has nothing to draw, and the
  // upstream's `modelPromotions` array contains entries (image and video
  // models) that are not promotions at all. Dropping them here is what keeps
  // them out of the card.
  const label = text(raw['label']) ?? text(raw['labelEn']) ?? text(raw['shortLabel']) ?? text(raw['shortLabelEn'])
  if (label === undefined) return undefined
  const labelEn = text(raw['labelEn'])
  const shortLabel = text(raw['shortLabel'])
  const shortLabelEn = text(raw['shortLabelEn'])
  const color = text(raw['color'])
  const display = raw['display'] === 'activeOnly' ? 'activeOnly' as const : undefined
  return {
    label,
    ...labelEn === undefined ? {} : { labelEn },
    ...shortLabel === undefined ? {} : { shortLabel },
    ...shortLabelEn === undefined ? {} : { shortLabelEn },
    ...color === undefined ? {} : { color },
    ...display === undefined ? {} : { display },
  }
}

/** The upstream's `hover` → this plugin's copy shape. */
function parseHover(value: unknown): WorkBuddyPromoHover | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const textZh = text(raw['textZh'])
  const textEn = text(raw['textEn'])
  if (textZh === undefined && textEn === undefined) return undefined
  return {
    ...textZh === undefined ? {} : { textZh },
    ...textEn === undefined ? {} : { textEn },
  }
}

/** The upstream's `schedule.daily` → the windows this plugin can evaluate. */
function parseDaily(value: unknown): WorkBuddyPromoWindow[] | undefined {
  if (!Array.isArray(value)) return undefined
  const windows: WorkBuddyPromoWindow[] = []
  for (const entry of value) {
    const raw = record(entry)
    if (raw === undefined) continue
    const start = text(raw['start'])
    const end = text(raw['end'])
    if (start === undefined || end === undefined) continue
    // A window whose endpoints are not clock times cannot be evaluated; it is
    // dropped rather than treated as "always" — see `minutesOfClock`.
    if (minutesOfClock(start) === undefined || minutesOfClock(end) === undefined) continue
    windows.push({ start, end })
  }
  return windows.length === 0 ? undefined : windows
}

/** The upstream's `schedule` → this plugin's schedule shape. */
function parseSchedule(value: unknown): WorkBuddyPromoSchedule | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const timezone = text(raw['timezone'])
  const validFrom = parseInstant(raw['validFrom'])
  const validUntil = parseInstant(raw['validUntil'])
  const daily = parseDaily(raw['daily'])
  if (timezone === undefined && validFrom === undefined && validUntil === undefined && daily === undefined) return undefined
  return {
    ...timezone === undefined ? {} : { timezone },
    ...validFrom === undefined ? {} : { validFrom },
    ...validUntil === undefined ? {} : { validUntil },
    ...daily === undefined ? {} : { daily },
  }
}

/** One upstream entry → this plugin's promo shape, or undefined if it is not one. */
function parsePromo(value: unknown, source: 'promotion' | 'tier'): WorkBuddyPromo | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  // An explicitly disabled entry is not a promotion. Absent `enabled` means
  // enabled — the upstream only writes the field when it turns one off.
  if (raw['enabled'] === false) return undefined
  const modelIds = parseModelIds(raw['modelIds'])
  if (modelIds === undefined) return undefined
  const badge = parseBadge(raw['badge'])
  if (badge === undefined) return undefined
  const hover = parseHover(raw['hover'])
  const schedule = parseSchedule(raw['schedule'])
  const priority = typeof raw['priority'] === 'number' && Number.isFinite(raw['priority']) ? raw['priority'] : 0
  const id = text(raw['id']) ?? `${source}:${modelIds.join(',')}`
  return {
    id,
    source,
    modelIds,
    badge,
    ...hover === undefined ? {} : { hover },
    ...schedule === undefined ? {} : { schedule },
    priority,
  }
}

/**
 * Parse the upstream's promotion and tier lists.
 *
 * Both lists are read from the SAME document the roster comes from, so this
 * never costs a request. Entries that are not promotions — no `modelIds`, no
 * `badge`, or `enabled: false` — are dropped here rather than downstream, so
 * that everything downstream can assume a promo is drawable.
 *
 * The promotions come first, so that a TIE on `priority` is broken in the
 * promotions' favour: a price badge ("Free now") is more actionable to a user
 * than an access-tier badge ("Pro Only"), and the upstream numbers them
 * equally (both 200 on the observed feed).
 */
export function parseWorkBuddyPromos(rawPromotions: unknown, rawTiers: unknown): WorkBuddyPromo[] {
  const promos: WorkBuddyPromo[] = []
  for (const entry of Array.isArray(rawPromotions) ? rawPromotions : []) {
    const promo = parsePromo(entry, 'promotion')
    if (promo !== undefined) promos.push(promo)
  }
  for (const entry of Array.isArray(rawTiers) ? rawTiers : []) {
    const tier = parsePromo(entry, 'tier')
    if (tier !== undefined) promos.push(tier)
  }
  return promos
}

/**
 * Attach the promotions that name each model.
 *
 * The result is UNRESOLVED on purpose: every candidate that names the model
 * rides along, so the badge can be chosen at render time against the clock
 * (see {@link selectPromoBadge}). Resolving here would freeze the answer at
 * fetch time — the defect that makes a "night discount" badge keep claiming
 * the night after the night is over.
 */
export function attachPromos<T extends { id: string }>(
  models: readonly T[],
  promos: readonly WorkBuddyPromo[],
): (T & { promos?: readonly WorkBuddyPromo[] })[] {
  if (promos.length === 0) return [...models]
  const byModel = new Map<string, WorkBuddyPromo[]>()
  for (const promo of promos) {
    for (const modelId of promo.modelIds) {
      const list = byModel.get(modelId)
      if (list === undefined) byModel.set(modelId, [promo])
      else list.push(promo)
    }
  }
  return models.map(model => {
    const list = byModel.get(model.id)
    if (list === undefined) return model
    // Highest priority first, so the renderer can take the first match.
    return { ...model, promos: [...list].sort((a, b) => b.priority - a.priority) }
  })
}

/**
 * Minutes since local midnight in `timeZone` at `nowMs`.
 *
 * `Intl` does the zone maths, because the upstream's windows are written in
 * the zone IT names (Asia/Shanghai for the CN feed) and the user's own clock
 * is not necessarily in that zone. An unusable zone falls back to UTC rather
 * than throwing: a badge that cannot be placed is a missing badge, not a
 * broken card.
 */
function zonedMinutes(nowMs: number, timeZone: string | undefined): number {
  const zone = timeZone ?? 'UTC'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(nowMs))
    const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0')
    const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0')
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0
    return hour * 60 + minute
  } catch {
    return 0
  }
}

/** Whether `nowMinutes` falls inside one of the daily windows. */
function withinDailyWindows(windows: readonly WorkBuddyPromoWindow[], nowMinutes: number): boolean {
  return windows.some(window => {
    const start = minutesOfClock(window.start)
    const end = minutesOfClock(window.end)
    if (start === undefined || end === undefined) return false
    // Equal endpoints: a 24-hour window. The upstream never writes one, and
    // reading it as "never" would hide a promotion that is actually running.
    if (start === end) return true
    if (end > start) return nowMinutes >= start && nowMinutes < end
    // Crossing midnight: `23:00`–`7:50` is the observed CN night window.
    return nowMinutes >= start || nowMinutes < end
  })
}

/**
 * Whether the promotion's ABSOLUTE window holds now.
 *
 * The absolute window (`validFrom` / `validUntil`) is the promotion's own
 * lifetime. It gates the badge on its own: a promotion whose lifetime has
 * ended must not keep advertising itself, whatever its daily hours say.
 */
export function promoWithinAbsoluteWindow(promo: WorkBuddyPromo, nowMs: number): boolean {
  const schedule = promo.schedule
  if (schedule === undefined) return true
  if (schedule.validFrom !== undefined && nowMs < schedule.validFrom) return false
  if (schedule.validUntil !== undefined && nowMs >= schedule.validUntil) return false
  return true
}

/**
 * Whether the promotion's DAILY window holds now.
 *
 * The daily window is the discount's own hours — it is what makes a
 * promotion a "night discount" — and a promotion without one is running
 * whenever its absolute window holds.
 */
export function promoWithinDailyWindow(promo: WorkBuddyPromo, nowMs: number): boolean {
  const schedule = promo.schedule
  if (schedule?.daily === undefined || schedule.daily.length === 0) return true
  return withinDailyWindows(schedule.daily, zonedMinutes(nowMs, schedule.timezone))
}

/**
 * Whether the promotion is running right now: its absolute window AND its
 * daily hours both hold.
 */
export function promoActiveAt(promo: WorkBuddyPromo, nowMs: number): boolean {
  return promoWithinAbsoluteWindow(promo, nowMs) && promoWithinDailyWindow(promo, nowMs)
}

/**
 * The badge to draw for a model right now, or undefined when there is none.
 *
 * The order of the two answers is the whole point:
 *
 * 1. A promotion that is RUNNING wins — highest `priority` first.
 * 2. Otherwise a STANDING badge (one the upstream did not mark `activeOnly`)
 *    describes the model for as long as the promotion itself lasts. It is
 *    offered only inside the promotion's absolute window, so an expired
 *    promotion stops advertising itself even though its badge was standing.
 *
 * Only ONE badge is drawn per model. The upstream's own `priority` field is
 * an ordering over the entries that name a model, and a model row is one
 * line wide: two badges would push the model name and the image/think
 * checkboxes out of the row.
 */
export function selectPromoBadge(
  promos: readonly WorkBuddyPromo[] | undefined,
  nowMs: number,
): WorkBuddyPromo | undefined {
  if (promos === undefined || promos.length === 0) return undefined
  const sorted = [...promos].sort((a, b) => b.priority - a.priority)
  const running = sorted.find(promo => promoActiveAt(promo, nowMs))
  if (running !== undefined) return running
  return sorted.find(promo => promo.badge.display !== 'activeOnly' && promoWithinAbsoluteWindow(promo, nowMs))
}
