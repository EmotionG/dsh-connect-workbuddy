/**
 * The load-level ICONS, drawn as inline SVG.
 *
 * WHY ICONS HERE AND A CHARACTER IN THE PICKER. The DSH model picker renders
 * the model name verbatim, as a string, with no image slot and no markup
 * support — so a level shown THERE has to be a character (`busySymbol`). This
 * module is the other half: the places the plugin renders itself, where a real
 * picture is possible and therefore better.
 *
 * WHY PEOPLE. Load is a fact about how many people are ahead of you, so the
 * shapes are people: one, one with someone behind, two pressed together, and a
 * crossed-out one. The upstream app already uses an icon for its most severe
 * level and words for the rest, so the icon set here is deliberately SMALL —
 * the healthy default is not drawn at all, because a badge on every healthy row
 * is decoration rather than a warning.
 *
 * The shapes are drawn on a 16-unit grid and scaled by CSS, so one source
 * serves the 16px row and any larger size without a second asset.
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

/** The icon for a level, or `undefined` when the level is not drawn. */
export function busyIconOf(level: WorkBuddyBusyLevel | undefined): WorkBuddyBusyIcon | undefined {
  if (level === undefined) return undefined
  if (level === 'normal' || level === 'unknown') return undefined
  return level as WorkBuddyBusyIcon
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
  return (
    <span
      className={`dsm-workbuddy-busy dsm-workbuddy-busy-${icon}`}
      title={title}
      style={{ '--dsm-workbuddy-busy-color': color } as Record<string, string>}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
        {icon === 'idle' ? (
          <g stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" fill="none">
            <circle cx="8" cy="5.2" r="2.3" />
            <path d="M3.6 13.4c.4-2.5 2-3.8 4.4-3.8s4 1.3 4.4 3.8" />
          </g>
        ) : icon === 'busy' ? (
          <g stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" fill="none">
            <circle cx="9.6" cy="5.6" r="2.3" />
            <path d="M5.6 13.4c.4-2.4 1.9-3.6 4-3.6s3.6 1.2 4 3.6" />
            <g opacity=".42">
              <circle cx="4" cy="6.6" r="2" />
              <path d="M1.2 13.4c.3-2 1.5-3 3.1-3 .5 0 1 .1 1.4.3" />
            </g>
          </g>
        ) : icon === 'congested' ? (
          <g stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" fill="none">
            <circle cx="5.8" cy="5.4" r="2.4" />
            <path d="M2 13.4c.4-2.5 1.8-3.8 3.8-3.8 1.1 0 2 .4 2.7 1" />
            <circle cx="10.6" cy="6" r="2.2" />
            <path d="M6.9 13.4c.4-2.4 1.7-3.6 3.7-3.6 2 0 3.5 1.2 3.9 3.6" />
          </g>
        ) : (
          <g stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" fill="none">
            <circle cx="8" cy="5.2" r="2.3" />
            <path d="M3.6 13.4c.4-2.5 2-3.8 4.4-3.8s4 1.3 4.4 3.8" />
            <path d="M1.8 14 14.2 1.6" strokeWidth="1.5" />
          </g>
        )}
      </svg>
    </span>
  )
}
