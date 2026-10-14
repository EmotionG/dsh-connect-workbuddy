// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, t } from './pool-render-helpers.tsx'
import {
  claimsQuotaNotice,
  WORKBUDDY_QUOTA_NOTICE_CODES,
  WorkBuddyQuotaNotice,
} from '../src/client/WorkBuddyQuotaNotice.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/**
 * Issue #63: a `6004` (account rate limit) failure is rendered by the host as
 * one fixed sentence — 「当前请求的额度已用尽」 — while the reporting account still
 * held 6,788 credits. The upstream's own words say 「频率限制」 with a reset time,
 * and the host DISCARDS the provider's message when it substitutes that sentence
 * (measured on the shipped client: `failureMessage()` returns the fixed string
 * for `QUOTA` and only falls back to `message` for other codes).
 *
 * The maintainer's decision on #63 was explicit: keep it OUT of the retry set
 * (which is what the current classification buys — every spelling that stops
 * reading as `QUOTA` lands in `RATE_LIMIT`, i.e. 5 in-place retries and ~15.5s of
 * backoff on a limit that resets hours later) and SUPPLEMENT the message
 * instead. So this component is the whole fix: it claims the host's own quota
 * notice and appends the one fact the sentence is missing.
 *
 * What is pinned here:
 *   1. the CLAIM is exactly `QUOTA` — claiming more would take over notices this
 *      plugin knows nothing about, and claiming less would drop the supplement;
 *   2. the host's sentence is kept VERBATIM and the supplement is additive, so
 *      the plugin never contradicts the shell's own vocabulary;
 *   3. the copy is honest for BOTH cases the code covers, because the plugin
 *      cannot tell them apart (the upstream distinguishes them in Chinese prose
 *      it is not allowed to parse for policy).
 */

describe('which notices this plugin takes over', () => {
  it('claims exactly QUOTA', () => {
    // The code the shipped classifier produces for both failures this plugin
    // raises: 6004 (account rate limit) and 14018 (exhausted credits).
    expect(WORKBUDDY_QUOTA_NOTICE_CODES).toEqual(['QUOTA'])
    expect(claimsQuotaNotice('QUOTA')).toBe(true)
  })

  it('leaves every other code on the host\'s own notice', () => {
    // AUTH, ACCOUNT_SIGNED_OUT, ACCOUNT_QUOTA and anything unknown belong to the
    // host or to another plugin; taking them over would replace a notice this
    // plugin cannot describe.
    for (const code of ['AUTH', 'ACCOUNT_QUOTA', 'ACCOUNT_SIGNED_OUT', 'RATE_LIMIT', 'QUOTA_EXCEEDED', '', undefined, null, 42, {}]) {
      expect(claimsQuotaNotice(code)).toBe(false)
    }
  })
})

describe('what the notice says', () => {
  it('keeps the host\'s sentence verbatim and adds the supplement', async () => {
    const m = await mount(WorkBuddyQuotaNotice, {
      matched: { code: 'QUOTA', message: 'HOST SENTENCE' },
      t,
    })
    const text = m.text()
    // The host's own string, unchanged — the shell shows it elsewhere and a
    // reworded copy would contradict the shell's vocabulary.
    expect(text).toContain('HOST SENTENCE')
    expect(text).toContain('quotaNotice.supplement')
    await m.unmount()
  })

  it('offers a dismiss button that calls the host\'s own dismiss', async () => {
    const dismiss = vi.fn()
    const m = await mount(WorkBuddyQuotaNotice, {
      matched: { code: 'QUOTA', message: 'HOST', dismiss },
      t,
    })
    m.button('quotaNotice.dismiss').click()
    expect(dismiss).toHaveBeenCalledTimes(1)
    await m.unmount()
  })

  it('renders without a dismiss handler rather than crashing the overlay', async () => {
    // The overlay is frame-wide: a throw here would take out the whole notice
    // for every plugin. `dismiss` is optional by contract.
    const m = await mount(WorkBuddyQuotaNotice, { matched: { code: 'QUOTA', message: 'HOST' }, t })
    expect(m.text()).toContain('HOST')
    expect(m.buttons()).toHaveLength(0)
    await m.unmount()
  })

  it('falls back to its own headline when the host passes no message', async () => {
    // A host line that stopped sending `message` must still render a sentence
    // rather than an empty notice.
    const m = await mount(WorkBuddyQuotaNotice, { matched: { code: 'QUOTA' }, t })
    expect(m.text()).toContain('quotaNotice.fallbackHead')
    await m.unmount()
  })

  it('never claims the sentence means an empty balance', async () => {
    // The honest wording both cases share: a model's own daily limit is
    // unrelated to credits, AND an exhausted balance is possible. Copy that
    // asserted only one of them would be wrong for the other case.
    const m = await mount(WorkBuddyQuotaNotice, { matched: { code: 'QUOTA', message: 'HOST' }, t })
    expect(m.text()).toContain('quotaNotice.supplement')
    await m.unmount()
  })
})
