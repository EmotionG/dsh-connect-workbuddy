/**
 * The load-level ICONS, drawn as inline SVG.
 *
 * WHY ICONS HERE AND A CHARACTER IN THE PICKER. The DSH model picker renders
 * the model name verbatim, as a string, with no image slot and no markup
 * support — so a level shown THERE has to be a character (`busySymbol`). This
 * module is the other half: the places the plugin renders itself, where a real
 * picture is possible and therefore better.
 *
 * ONE SHAPE, AND THE COUNT CARRIES THE MEANING. The icon set is a single
 * person, repeated: one for an idle model, one for a healthy one, two when a
 * queue has formed, three when the model is congested. A crossed-out person for
 * "unavailable" is the one exception, because "nobody can use this" is not a
 * matter of degree: there is no "one and a half unavailable".
 *
 * THE COLOUR IS A RAMP. Green (idle) → yellow (normal) → orange (busy) → red
 * (congested) is an order the eye already knows, so the severity of one row can
 * be compared with another at a glance, without reading a word.
 *
 * WHY PEOPLE. Load is a fact about how many people are ahead of you, so the
 * shape is people. The upstream app already uses an icon for its most severe
 * level and words for the rest, so the set here is deliberately SMALL — the
 * healthy default is not drawn at all, because a badge on every healthy row is
 * decoration rather than a warning.
 *
 * The shapes are drawn on a 16-unit grid and scaled by CSS, so one source
 * serves the 12px model row and any larger size without a second asset.
 */
import type { ReactElement } from 'react'
import type { WorkBuddyBusyIcon, WorkBuddyBusyLevel } from '../busy.ts'

/** The word for a level, in the card's language, for the tooltip. */
const TITLES_ZH: Readonly<Partial<Record<WorkBuddyBusyIcon, string>>> = {
  idle: '空闲',
  normal: '正常',
  busy: '轻微拥堵',
  congested: '极度拥堵',
  unavailable: '不可用',
}

const TITLES_EN: Readonly<Partial<Record<WorkBuddyBusyIcon, string>>> = {
  idle: 'Idle',
  normal: 'Normal',
  busy: 'Slightly congested',
  congested: 'Extremely congested',
  unavailable: 'Unavailable',
}

/** The color per level, as a CSS custom property so the theme can override it. */
const COLORS: Readonly<Record<WorkBuddyBusyIcon, string>> = {
  // Green = free right now, yellow = healthy, orange = a queue, red = jammed.
  // The colour is a RAMP, not a set of unrelated hues: the eye reads the
  // order green → yellow → orange → red without being taught it, so the
  // severity of a row can be compared across rows at a glance.
  idle: 'var(--dsm-workbuddy-busy-idle, #3aa76d)',
  normal: 'var(--dsm-workbuddy-busy-normal, #d9b300)',
  busy: 'var(--dsm-workbuddy-busy-busy, #e08a1e)',
  congested: 'var(--dsm-workbuddy-busy-congested, #d93a2b)',
  unavailable: 'var(--dsm-workbuddy-busy-unavailable, #8a8f98)',
}

/**
 * How many people each level draws.
 *
 * `undefined` means the level is not drawn at all. `unavailable` is not a
 * number: it is the one level where a count would lie, so it gets its own mark
 * (a crossed-out person) instead of a crowd.
 */
const PEOPLE: Readonly<Partial<Record<WorkBuddyBusyIcon, number>>> = {
  idle: 1,
  normal: 1,
  busy: 2,
  congested: 3,
}

/** The icon for a level, or `undefined` when the level is not drawn. */
export function busyIconOf(level: WorkBuddyBusyLevel | undefined): WorkBuddyBusyIcon | undefined {
  if (level === undefined) return undefined
  // Only `unknown` is left out: it is the plugin's own "the probe did not
  // answer", and a badge that guesses is worse than no badge. Every level the
  // upstream DID report is drawn — `idle` included, in green, because "the
  // model is free right now" is useful information.
  if (level === 'unknown') return undefined
  return level as WorkBuddyBusyIcon
}

/**
 * One person, full body.
 *
 * The head is a circle of radius 1.7 centred at (2.2, 2.2) and the shoulders
 * start at y = 5.2: a GAP of 1.3 units between them. An earlier version put
 * them too close and the whole thing read as a smudge at the 12px the model row
 * actually uses — a person has to look like a person at 12px.
 */
function person(x: number, key: string): ReactElement {
  return (
    <g key={key} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" transform={`translate(${x} 0)`}>
      <circle cx="2.2" cy="2.2" r="1.7" />
      <path d="M0 7.6c.2-1.5 1-2.4 2.2-2.4s2 .9 2.2 2.4" />
    </g>
  )
}

/**
 * The load-level icon for one model row.
 *
 * Returns `null` for a level that is not drawn — including `undefined`, which
 * means "not measured", and `normal` / `unknown`, which must never be turned
 * into a claim the upstream did not make.
 */
export function busyIcon(
  level: WorkBuddyBusyLevel | undefined,
  language: string = 'zh',
): ReactElement | null {
  const icon = busyIconOf(level)
  if (icon === undefined) return null
  const color = COLORS[icon]
  const isEnglish = language.toLowerCase().startsWith('en')
  const title = (isEnglish ? TITLES_EN : TITLES_ZH)[icon]

  if (icon === 'unavailable') {
    // The one level that is not a matter of degree: nobody can use this model,
    // so a crowd of any size would be a lie. A crossed-out person says it.
    return (
      <span
        className="dsm-workbuddy-busy dsm-workbuddy-busy-unavailable"
        title={title}
        style={{ '--dsm-workbuddy-busy-color': color } as Record<string, string>}
      >
        <svg viewBox="0 0 7.8 7.8" width="12" height="12" aria-hidden="true" focusable="false">
          <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none">
            <circle cx="3" cy="2.4" r="1.8" />
            <path d="M0.6 8c.2-1.5 1.1-2.4 2.4-2.4s2.2.9 2.4 2.4" />
            <path d="M0 8.6 6.2 2" strokeWidth="1.3" />
          </g>
        </svg>
      </span>
    )
  }

  const count = PEOPLE[icon] ?? 1
  // The people are laid out side by side, each 3.6 units apart — TIGHT, so the
  // crowd reads as ONE group rather than as separate figures. (The picker
  // cannot do this: its name is a plain string and the gap between emoji is the
  // FONT's business. Here the gap is ours to choose.)
  const width = (count - 1) * 3.6 + 4.4
  return (
    <span
      className={`dsm-workbuddy-busy dsm-workbuddy-busy-${icon}`}
      title={title}
      style={{ '--dsm-workbuddy-busy-color': color } as Record<string, string>}
    >
      <svg viewBox={`0 0 ${width} 7.8`} width={12} height={12} aria-hidden="true" focusable="false">
        {Array.from({ length: count }, (_, index) => person(index * 3.6, `p${index}`))}
      </svg>
    </span>
  )
}
