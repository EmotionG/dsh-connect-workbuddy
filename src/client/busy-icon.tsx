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
 * person, repeated: one for a free model, two when a queue has formed, three
 * when the model is congested. A crossed-out person for "unavailable" is the
 * one exception, because "nobody can use this" is not a matter of degree: there
 * is no "one and a half unavailable".
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
  busy: '轻微拥堵',
  congested: '极度拥堵',
  unavailable: '不可用',
}

const TITLES_EN: Readonly<Partial<Record<WorkBuddyBusyIcon, string>>> = {
  idle: 'Idle',
  busy: 'Slightly congested',
  congested: 'Extremely congested',
  unavailable: 'Unavailable',
}

/** The color per level, as a CSS custom property so the theme can override it. */
const COLORS: Readonly<Record<WorkBuddyBusyIcon, string>> = {
  idle: 'var(--dsm-workbuddy-busy-idle, #9aa0a6)',
  busy: 'var(--dsm-workbuddy-busy-busy, #d99a00)',
  congested: 'var(--dsm-workbuddy-busy-congested, #e2571f)',
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
  busy: 2,
  congested: 3,
}

/** The icon for a level, or `undefined` when the level is not drawn. */
export function busyIconOf(level: WorkBuddyBusyLevel | undefined): WorkBuddyBusyIcon | undefined {
  if (level === undefined) return undefined
  if (level === 'normal' || level === 'unknown') return undefined
  return level as WorkBuddyBusyIcon
}

/**
 * One person, on the icon's own grid. The same shape for every count.
 *
 * The geometry is deliberately spread out: the head is a circle of radius 1.9
 * centred at (2.6, 2.6), and the shoulders start at y = 6.6 — a GAP of 2.1
 * units between them. An earlier version put the shoulders at y = 6.8 with the
 * head centred at y = 3.4, so head and body touched and the whole thing read as
 * a smudge at the 12px the model row actually uses. A person has to look like a
 * person at 12px, and that means the head has to be a separate mark.
 */
function person(x: number, key: string): ReactElement {
  return (
    <g key={key} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" transform={`translate(${x} 0)`}>
      <circle cx="2.6" cy="2.6" r="1.9" />
      <path d="M0.2 9.9c.2-2.1 1.2-3.3 2.4-3.3s2.2 1.2 2.4 3.3" />
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
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <g stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" fill="none">
            <circle cx="8" cy="5.2" r="2.3" />
            <path d="M3.6 13.4c.4-2.5 2-3.8 4.4-3.8s4 1.3 4.4 3.8" />
            <path d="M1.8 14 14.2 1.6" strokeWidth="1.5" />
          </g>
        </svg>
      </span>
    )
  }

  const count = PEOPLE[icon] ?? 1
  // The people are laid out side by side, each 6.2 units apart, so a bigger
  // crowd is a WIDER icon rather than a smaller person: the count stays legible
  // at the 12px the model row actually uses. The HEIGHT stays fixed at 10 units,
  // so the icon is never squashed — it only grows to the right.
  const width = (count - 1) * 6.2 + 5.2
  return (
    <span
      className={`dsm-workbuddy-busy dsm-workbuddy-busy-${icon}`}
      title={title}
      style={{ '--dsm-workbuddy-busy-color': color } as Record<string, string>}
    >
      <svg viewBox={`0 0 ${width} 10.2`} width={12} height={12} aria-hidden="true" focusable="false">
        {Array.from({ length: count }, (_, index) => person(index * 6.2, `p${index}`))}
      </svg>
    </span>
  )
}
