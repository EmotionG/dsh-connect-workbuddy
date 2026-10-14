/**
 * The supplement this plugin adds to the host's quota notice (issue #63).
 *
 * WHY THIS EXISTS. When an upstream failure is classified `QUOTA`, the host
 * renders ONE fixed sentence — 「当前请求的额度已用尽」 — and (measured on the
 * shipped client) it DISCARDS the provider's own message to do so:
 *
 *   function failureMessage(message, code, t) {
 *     if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return t('message.failure.quota')
 *     return code === 'AUTH' ? t('message.failure.auth') : message
 *   }
 *
 * That sentence is right for a genuinely exhausted account (14018), and wrong
 * for `6004` — the upstream's own words are 「您的使用量已超出频率限制，将在
 * <时刻> 重置」, and the reporter's account still held 6,788 credits. The
 * plugin cannot fix that by re-classifying: measured against the shipped
 * classifier, every spelling that stops reading as `QUOTA` falls into
 * `RATE_LIMIT`, which IS in `DEFAULT_RETRYABLE_CODES` — so it would buy an
 * honest sentence with 5 in-place retries and ~15.5s of backoff on a limit that
 * resets hours later. Staying out of the retry set is the behaviour we keep
 * (the maintainer's call on issue #63); the sentence is what we supplement.
 *
 * HOW. The host ships a CHAIN seat for exactly this: `shell.quota-notice`, a
 * frame-wide overlay whose own comment says "a `shell.quota-notice` entry may
 * replace the generic Toast for codes it claims". The chain hands a claiming
 * entry the host's own owner object — `{ code, message, dismiss, keepOpen }` —
 * so this component can keep the host's sentence VERBATIM and append the one
 * fact the sentence is missing. Claiming only `QUOTA` leaves every other code on
 * the host's fallback Toast.
 *
 * WHY THE HOST'S SENTENCE IS KEPT, not rewritten: it is the string the shell
 * shows everywhere else for this code, and a plugin that reworded it would
 * contradict the shell's own vocabulary. The supplement is additive, and it is
 * written to be TRUE FOR BOTH CASES the code covers — a model's own daily quota
 * (not credits) and a genuinely empty balance — because the plugin cannot always
 * tell which one it is: the upstream states it in Chinese prose the plugin is
 * not allowed to parse for policy.
 *
 * Rendered as plain DOM with this plugin's own classes: the client half
 * deliberately does not depend on `@deepseek-ai/dsh-client-ui-primitives` (see
 * the note in `src/client/index.tsx` — a stale inject entry there once made the
 * whole card's arrival depend on the churn-heaviest host package), so the
 * notice is built from the same primitives every other component here uses.
 */
import { createElement as h } from 'react'
import type { Translate } from './searched-paths.ts'

/**
 * The host's owner object for a claimed quota notice.
 *
 * Only the fields this component uses are named, and all but `message` are
 * optional: `dismiss`/`keepOpen` exist on the host's object today, and a
 * deployment that stopped passing them must render a notice the user can at
 * least read rather than crash the overlay.
 */
export interface WorkBuddyQuotaNoticeMatched {
  code?: string
  /** The host's own sentence for this code, rendered verbatim. */
  message?: string
  /** Dismiss the notice; absent means no button is offered. */
  dismiss?: () => void
}

export interface WorkBuddyQuotaNoticeProps {
  /** The owner object the chain handed to the entry that claimed it. */
  matched: WorkBuddyQuotaNoticeMatched
  t: (key: Parameters<Translate>[0], params?: Record<string, unknown>) => string
}

/**
 * Which notice codes this plugin claims.
 *
 * `QUOTA` only — it is what the shipped classifier produces for BOTH failures
 * this plugin raises (`6004` account rate limit and `14018` exhausted credits),
 * and claiming anything else would take over a notice this plugin knows nothing
 * about. Exported so the claim is unit-testable without a host.
 */
export const WORKBUDDY_QUOTA_NOTICE_CODES: readonly string[] = ['QUOTA']

/** Whether this plugin should take over the notice for one owner object. */
export function claimsQuotaNotice(code: unknown): boolean {
  return typeof code === 'string' && WORKBUDDY_QUOTA_NOTICE_CODES.includes(code)
}

/** The frame-wide supplement shown under the host's sentence. */
export function WorkBuddyQuotaNotice(props: WorkBuddyQuotaNoticeProps) {
  const { matched, t } = props
  return h('div', { className: 'dsm-workbuddy-quota-notice', role: 'status' },
    h('span', { className: 'dsm-workbuddy-quota-notice-head' },
      // The host's sentence VERBATIM; the supplement is a second line rather
      // than a longer first one so the sentence every other surface shows stays
      // recognisable.
      matched.message ?? t('quotaNotice.fallbackHead'),
    ),
    h('span', { className: 'dsm-workbuddy-quota-notice-body' }, t('quotaNotice.supplement')),
    matched.dismiss === undefined
      ? null
      : h('button', {
          type: 'button',
          className: 'dsm-btn dsm-btn-outline dsm-workbuddy-quota-notice-dismiss',
          onClick: () => matched.dismiss?.(),
        }, t('quotaNotice.dismiss')),
  )
}
