/**
 * Issue #120: the badge and the price must agree.
 *
 * The upstream's night-discount pairs carry TWO entries per model: one with the
 * discount and the night hours, and a second, daytime entry with the same badge
 * and no discount. The plugin drew the badge against the clock but took the
 * price from the static catalog `credits` string — so a model could wear
 * 「夜间折扣」 next to its full `x0.11`, and the user had to open the WorkBuddy
 * client to find out what it actually cost.
 *
 * The discount has always been in the same `/v3/config` document
 * (`discount.discountedCredits`), so this costs no request. Two rules are
 * pinned here:
 *
 *   1. Only a RUNNING promotion discounts. The daytime half of the pair is a
 *      STANDING badge — it may be drawn outside its hours, but it must not
 *      change the price then, or the card would show the night price all day.
 *   2. `discountedCredits` is a STRING with the unit glued on ("0x", "0.06x").
 *      `Number("0.06x")` is `NaN`; a value that does not parse leaves the
 *      catalog price alone rather than inventing a cheaper one.
 */
import { describe, expect, it } from 'vitest'
import { parseWorkBuddyPromos, selectPromoMultiplier } from '../src/promo.ts'

/** A night-discount pair, shaped like the CN feed observed on 2026-10-21. */
const nightWithDiscount = {
  id: 'ds-discount-night-202610',
  kind: 'discount',
  enabled: true,
  priority: 300,
  modelIds: ['deepseek-v4.1-flash'],
  badge: { label: '夜间折扣', color: '#009273' },
  discount: { discountedCredits: '0.06x', displayMode: 'replace', factor: 0.545 },
  hover: { textZh: '夜间时段按折后价计费。' },
  schedule: {
    timezone: 'Asia/Shanghai',
    daily: [{ start: '23:00', end: '07:50' }],
  },
}

/** The daytime half: same badge, no discount, complementary hours. */
const daytimeStanding = {
  id: 'ds-discount-daytime-badge-202610',
  kind: 'discount',
  enabled: true,
  priority: 100,
  modelIds: ['deepseek-v4.1-flash'],
  badge: { label: '夜间折扣', color: '#009273' },
  hover: { textZh: '夜间时段按折后价计费。' },
  schedule: {
    timezone: 'Asia/Shanghai',
    daily: [{ start: '07:50', end: '23:00' }],
  },
}

/** 2026-10-23 00:30 in Asia/Shanghai — inside the night window. */
const atNight = Date.parse('2026-10-22T16:30:00Z')
/** 2026-10-23 12:00 in Asia/Shanghai — inside the daytime window. */
const atNoon = Date.parse('2026-10-23T04:00:00Z')

describe('the discount is parsed off the same document as the badge (issue #120)', () => {
  it('reads "0.06x" out of discountedCredits instead of coercing it', () => {
    const [promo] = parseWorkBuddyPromos([nightWithDiscount], [])
    expect(promo?.discount?.multiplier).toBe(0.06)
    expect(promo?.discount?.displayMode).toBe('replace')
  })

  it('reads a bare number and a zero ("0x" is free, not missing)', () => {
    const [bare] = parseWorkBuddyPromos([{ ...nightWithDiscount, id: 'a', discount: { discountedCredits: '0.29', displayMode: 'replace' } }], [])
    const [free] = parseWorkBuddyPromos([{ ...nightWithDiscount, id: 'b', discount: { discountedCredits: '0x', displayMode: 'replace' } }], [])
    expect(bare?.discount?.multiplier).toBe(0.29)
    expect(free?.discount?.multiplier).toBe(0)
  })

  it('falls back to factor only when the string cannot be read', () => {
    const [broken] = parseWorkBuddyPromos([{ ...nightWithDiscount, id: 'c', discount: { discountedCredits: 'free!', factor: 0.5, displayMode: 'replace' } }], [])
    expect(broken?.discount?.multiplier).toBe(0.5)
  })

  it('refuses a value that is not a finite non-negative number', () => {
    for (const discountedCredits of ['', '-1x', 'abc', 'NaNx']) {
      const [promo] = parseWorkBuddyPromos([{ ...nightWithDiscount, id: 'd', discount: { discountedCredits, displayMode: 'replace' } }], [])
      expect(promo?.discount?.multiplier).toBeUndefined()
    }
  })

  it('ignores a displayMode it does not know', () => {
    const [promo] = parseWorkBuddyPromos([{ ...nightWithDiscount, id: 'e', discount: { discountedCredits: '0.06x', displayMode: 'strikethrough' } }], [])
    expect(promo?.discount?.multiplier).toBe(0.06)
    expect(promo?.discount?.displayMode).toBeUndefined()
  })
})

describe('when the discounted price applies (issue #120)', () => {
  const promos = parseWorkBuddyPromos([nightWithDiscount, daytimeStanding], [])

  it('uses the discount while the discount entry is running', () => {
    expect(selectPromoMultiplier(promos, atNight)).toBe(0.06)
  })

  it('does NOT discount during the daytime standing entry', () => {
    // The standing half carries the same badge and the complementary hours, so
    // the badge is still drawn at noon — the price must not move with it.
    expect(selectPromoMultiplier(promos, atNoon)).toBeUndefined()
  })

  it('returns undefined (keep the catalog figure) when no entry has a discount', () => {
    const noDiscount = parseWorkBuddyPromos([{ ...nightWithDiscount, discount: undefined }], [])
    expect(selectPromoMultiplier(noDiscount, atNight)).toBeUndefined()
  })

  it('respects the absolute lifetime: an expired discount stops applying', () => {
    const expired = parseWorkBuddyPromos([{
      ...nightWithDiscount,
      schedule: { ...nightWithDiscount.schedule, validFrom: '2026-01-01T00:00:00+08:00', validUntil: '2026-02-01T00:00:00+08:00' },
    }], [])
    expect(selectPromoMultiplier(expired, atNight)).toBeUndefined()
  })

  it('takes the highest-priority running entry when several discount', () => {
    const two = parseWorkBuddyPromos([
      { ...nightWithDiscount, id: 'low', priority: 10, discount: { discountedCredits: '0.50x', displayMode: 'replace' } },
      { ...nightWithDiscount, id: 'high', priority: 900, discount: { discountedCredits: '0.06x', displayMode: 'replace' } },
    ], [])
    expect(selectPromoMultiplier(two, atNight)).toBe(0.06)
  })
})
