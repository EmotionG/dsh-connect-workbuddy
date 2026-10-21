/**
 * Issues #87 / #88 / #89 / #90, second half: the gateway's CHANNEL gate is its
 * own failure, and the reply must name the line that tripped it.
 *
 * THE REPORT. Both gateways match the OPENING of every `system` message against
 * a list of known third-party-agent prompts and answer `400` + business code
 * `11128` on a hit. The upstream's own `displayTips` describes that as "this
 * call failed channel verification, possibly because it was not sent from an
 * official client" — which sent four separate reporters through account swaps,
 * region swaps and even a reinstall of the official client. None of it could
 * work: every account sends the same prompt.
 *
 * WHAT WAS WRONG IN THE PLUGIN, and each item is a test below.
 *
 *   1. `11128` classified as `client` — the generic bucket. The reader got
 *      "refused on its parameters, another account will not help", which is true
 *      and useless: it does not say WHAT was refused, so the prompt was never a
 *      suspect.
 *   2. The body's `displayTips` was not even echoed — the misleading sentence
 *      was, because the generic path prefers it for `client` failures.
 *   3. `client` was not failover-worthy, so behaviour happened to be right — but
 *      only by accident of bucket membership, not because the code knew a
 *      second account cannot change a byte of the prompt.
 *   4. The probe classified the same refusal as `failed`, so the one card that
 *      could explain "test passes, chat fails" printed "✗ Test failed" instead.
 *
 * THE HARD PART IS NOT RECOGNISING THE GATE, IT IS NOT OVER-RECOGNISING IT.
 * Code `11128` is shared with at least two other gates — `conversation id
 * missing` (the header rule issue #66 fixed) and `first message is not system
 * prompt`. Both must keep their existing classification, because telling a user
 * to rewrite their system prompt when the real fault is a header would be a
 * confidently wrong diagnosis. The bodies below are byte-exact captures from the
 * live CN gateway and from the issue threads.
 *
 * @module dsh-connect-workbuddy/tests/issue90-channel-reject
 */
import { afterEach, describe, expect, it } from 'vitest'
import { stream } from '@earendil-works/pi-ai/api/openai-completions'
import { isQuotaExceededError } from '@deepseek-ai/dsh-llm'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  classifyUpstreamError,
  isChannelRejectBody,
  parseUpstreamErrorDetail,
  systemOpeningsOfBody,
  WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
} from '../src/upstream.ts'
import type { WorkBuddyChatResult, WorkBuddyUpstreamClient } from '../src/upstream.ts'
import { outcomeOfFailure } from '../src/probe.ts'
import { exclusionOf } from '../src/account-pool.ts'

/**
 * The live CN gateway's reply to a `system` opening it fingerprints.
 *
 * Captured byte-exact (request id redacted to a fixed UUID so assertions are
 * stable). The `msg` is the diagnostic half this fix matches on; `displayTips`
 * is the misleading half it must never match on.
 */
const CHANNEL_REJECT_BODY = JSON.stringify({
  code: 11128,
  msg: 'Illegal API invocation from an unapproved channel',
  requestId: '26d17b97-c53b-461a-bd21-34c61c86f15b',
  displayMsg: {
    en: 'Request blocked. Please send it again',
    zh: '请求被拦截，请重新发送',
    'zh-hant': '請求已被攔截，請重新傳送',
  },
  displayTips: {
    en: 'This call failed channel verification, possibly because it was not sent from an official client. Please resend from the official client.',
    zh: '这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。',
    'zh-hant': '本次呼叫未通過通路驗證，可能不是官方用戶端發出。請使用官方版本重新傳送。',
  },
  actions: ['EDIT_INPUT', 'SUBMIT_FEEDBACK'],
})

/** The OTHER `11128`: the header gate issue #66 fixed. Same code, different cause. */
const CONVERSATION_ID_BODY = '{"code":11128,"msg":"conversation id missing","requestId":"3605a27b-0000-4000-8000-000000000066","displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"}}'

/** The OTHER `11128` again: the global gateway's first-message rule. */
const FIRST_MESSAGE_BODY = '{"code":11128,"msg":"first message is not system prompt","requestId":"5c9a2946-0000-4000-8000-000000000090","displayMsg":{"zh":"请求被安全策略拦截，请稍后重试或联系支持。"}}'

describe('classifying the channel gate', () => {
  it('files the live CN body as its own kind, not as `client`', () => {
    // The regression: `client` was the bucket that produced the generic
    // "refused on its parameters" sentence and made the prompt un-suspect.
    expect(classifyUpstreamError(400, CHANNEL_REJECT_BODY)).toBe('channel_reject')
  })

  it('matches on `msg`, never on `displayTips`', () => {
    // Independent of parsing order: the predicate itself must not fire on a body
    // whose only channel-ish wording is the tips sentence, because that sentence
    // is IDENTICAL for every member of the 11128 family.
    expect(isChannelRejectBody(CHANNEL_REJECT_BODY)).toBe(true)
    expect(isChannelRejectBody(CONVERSATION_ID_BODY)).toBe(false)
    expect(isChannelRejectBody(FIRST_MESSAGE_BODY)).toBe(false)
    // And a body carrying the misleading tips with NO diagnostic message is not
    // enough to claim the prompt rule.
    const tipsOnly = '{"code":11128,"msg":"something else","displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。"}}'
    expect(isChannelRejectBody(tipsOnly)).toBe(false)
  })

  it('leaves the OTHER 11128 gates with their existing classification', () => {
    // A wrongly-claimed header failure would tell the reader to rewrite a system
    // prompt that is not at fault — worse than the generic reply.
    for (const body of [CONVERSATION_ID_BODY, FIRST_MESSAGE_BODY]) {
      expect(classifyUpstreamError(400, body)).toBe('client')
    }
  })

  it('requires the code as well as the wording', () => {
    // Another business code quoting the same English phrase is not this gate.
    const otherCode = CHANNEL_REJECT_BODY.replace('"code":11128', '"code":11140')
    expect(isChannelRejectBody(otherCode)).toBe(false)
    expect(classifyUpstreamError(400, otherCode)).toBe('policy_reject')
  })

  it('still lets a real content refusal keep its more specific reply', () => {
    // The gate is checked AFTER the policy markers on purpose. A body that
    // really is a 11140 content refusal must not be re-filed as the prompt rule.
    expect(classifyUpstreamError(400, '{"code":11140,"msg":"request illegal"}')).toBe('policy_reject')
  })

  it('is not swallowed by the quoted-key guard on a request id', () => {
    // Request ids are hexadecimal and can contain `11128` by coincidence; the
    // quoted-key form is what keeps that from classifying a healthy body.
    expect(classifyUpstreamError(400, '{"requestId":"11128abc","msg":"ok"}')).toBe('client')
  })
})

describe('the probe reports the channel gate as itself', () => {
  it('maps the gate to `channel-rejected` instead of `failed`', () => {
    // `failed` is what the card renders as a bare "✗ Test failed" — the one label
    // that invites an account fix, which cannot work here.
    expect(outcomeOfFailure(400, CHANNEL_REJECT_BODY)).toBe('channel-rejected')
    expect(outcomeOfFailure(400, CONVERSATION_ID_BODY)).toBe('failed')
  })

  it('does not bench the account for it', () => {
    // Every account sends the same prompt, so removing this one hides the real
    // remedy and idles a healthy credential.
    expect(exclusionOf({ outcome: 'channel-rejected', atMs: Date.now() }, Date.now())).toBeUndefined()
  })
})

describe('systemOpeningsOfBody: what the gate actually looked at', () => {
  it('returns the first lines of every system message', () => {
    const body = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.\n\nLong body follows.' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'Second system message.' },
      ],
    })
    expect(systemOpeningsOfBody(body)).toEqual([
      'You are an AI agent powered by DeepSeek Harness.',
      'Second system message.',
    ])
  })

  it('prefers the neutralised opening the plugin actually sent', () => {
    // In production this is the point: after `prepareChatBody`, a KNOWN
    // fingerprint no longer leads, so what gets echoed is the placeholder line —
    // the truth about the bytes on the wire, not the host's original prompt.
    const body = JSON.stringify({
      messages: [{ role: 'system', content: `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\nYou are an AI agent powered by DeepSeek Harness.` }],
    })
    expect(systemOpeningsOfBody(body)[0]).toBe(WORKBUDDY_FALLBACK_SYSTEM_PROMPT)
  })

  it('clips a pathological opening instead of dumping a prompt', () => {
    const body = JSON.stringify({ messages: [{ role: 'system', content: `${'x'.repeat(5000)}\nrest` }] })
    const [opening] = systemOpeningsOfBody(body)
    expect(opening).toHaveLength(120)
    expect(opening?.endsWith('…')).toBe(true)
  })

  it('caps how many openings it reports', () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({ role: 'system', content: `opening ${i}` }))
    expect(systemOpeningsOfBody(JSON.stringify({ messages }))).toHaveLength(3)
  })

  it('never throws on a body it cannot read', () => {
    // Losing the failure measurement is not an acceptable price for an excerpt.
    for (const body of ['', 'not json', 'null', '[]', '"str"', '{"messages":"nope"}', '{"messages":[null,3,{"role":1}]}']) {
      expect(systemOpeningsOfBody(body)).toEqual([])
    }
  })

  it('ignores a message whose content is an array, not a string', () => {
    const body = JSON.stringify({ messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }] }, { role: 'system', content: 'kept' }] })
    expect(systemOpeningsOfBody(body)).toEqual(['kept'])
  })
})

// ---------------------------------------------------------------------------
// The rendered sentence. These mount the REAL shim (so the real body-prep and
// real failure renderer run) and replace only the upstream client's answer.
// ---------------------------------------------------------------------------

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid',
  uin: 'selected',
  source: 'desktop',
  filePath: '/tmp/auth.info',
}

const store = {
  resolve: async () => CREDENTIAL,
  credentialFor: async () => CREDENTIAL,
} as unknown as import('../src/auth.ts').WorkBuddyCredentialStore

let shim: WorkBuddyShim | undefined
afterEach(async () => { await shim?.close(); shim = undefined })

function failure(status: number, body: string): WorkBuddyChatResult {
  return {
    ok: false,
    status,
    kind: classifyUpstreamError(status, body),
    message: body,
    detail: parseUpstreamErrorDetail(body),
  }
}

function mount(result: WorkBuddyChatResult, failover?: (tried: readonly string[]) => Promise<WorkBuddyCredential | undefined>): WorkBuddyShim {
  const client = { chatStream: async () => result } as unknown as WorkBuddyUpstreamClient
  return createWorkBuddyShim({
    store,
    client,
    catalog: new WorkBuddyCatalog(),
    ...failover === undefined ? {} : { failoverAccount: failover },
  })
}

/** One chat through the shim, returning the host-facing error plus the sent body. */
async function chat(instance: WorkBuddyShim, systemOpening: string): Promise<{
  status: number
  message: string
  type: string
  bodies: Record<string, unknown>[]
}> {
  const sent: Record<string, unknown>[] = []
  const instance2 = instance
  // The shim's upstream client is the canned one, so capture the body from the
  // REQUEST side instead: `prepareChatBody` runs inside the shim, and the token
  // route is the only way in.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).includes('chat/completions') && typeof init?.body === 'string') {
      sent.push(JSON.parse(init.body) as Record<string, unknown>)
    }
    return originalFetch(String(url), init as never)
  }) as typeof fetch
  try {
    const response = await originalFetch(`${instance2.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${instance2.token()}` },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [
          { role: 'system', content: systemOpening },
          { role: 'user', content: 'hi' },
        ],
      }),
    })
    const parsed = JSON.parse(await response.text()) as { error: { message: string, type: string } }
    return { status: response.status, message: parsed.error.message, type: parsed.error.type, bodies: sent }
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe('the rendered reply names the line the gate refused', () => {
  it('echoes the system opening and refutes the client-identity story', async () => {
    shim = mount(failure(400, CHANNEL_REJECT_BODY), async () => undefined)
    await shim.ready

    // A NOVEL fingerprint — not in `UNAPPROVED_CHANNEL_OPENINGS`, so the plugin
    // has nothing to neutralise and this is exactly what reaches the gateway.
    // (The known ones are covered by the next case, where the echo is the
    // placeholder line instead.)
    const NOVEL = 'You are Cursor Agent, an AI pair programmer from Anysphere.'
    const { status, message, type } = await chat(shim, NOVEL)
    expect(status).toBe(400)
    expect(type).toBe('channel_reject')
    // 1. The evidence, quoted — this is the whole fix. The reader can now see
    //    WHICH line was refused instead of cycling accounts.
    expect(message).toContain(`命中的 system 提示开头：「${NOVEL}」`)
    // 2. Support's handles, compact.
    expect(message).toContain('code 11128')
    expect(message).toContain('requestId 26d17b97-c53b-461a-bd21-34c61c86f15b')
    // 3. The remedy, and the explicit rejection of the misleading story.
    expect(message).toContain('换账号或换区域也不会改变结果')
    expect(message).toContain('误导性文案')
    // 4. None of the account-fix language the old generic path produced.
    expect(message).not.toContain('换账号也不会改变结果，请按上面的提示调整后重试')
  })

  it('quotes the bytes actually sent, after normalisation', async () => {
    // `prepareChatBody` prepends the placeholder to a KNOWN fingerprint, so the
    // echo must be that placeholder — proof the excerpt comes from the wire body
    // and not from a re-read of the host's original prompt.
    shim = mount(failure(400, CHANNEL_REJECT_BODY), async () => undefined)
    await shim.ready
    const { message } = await chat(shim, 'You are an AI agent powered by DeepSeek Harness.')
    expect(message).toContain(`「${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}」`)
    expect(message).not.toContain('「You are an AI agent powered by DeepSeek Harness.」')
  })

  it('echoes the injected fallback head when the host sent no system message', async () => {
    // `ensureSystemHead` guarantees a head exists, so this is the closest the
    // shim ever gets to "nothing to quote" — and the honest answer is still to
    // quote what went on the wire, not to claim the request had no prompt.
    shim = mount(failure(400, CHANNEL_REJECT_BODY), async () => undefined)
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const parsed = JSON.parse(await response.text()) as { error: { message: string } }
    expect(parsed.error.message).toContain(`「${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}」`)
    expect(parsed.error.message).toContain('code 11128')
    expect(parsed.error.message).toContain('换账号或换区域也不会改变结果')
  })

  it('does not spend a failover round trip on a second account', async () => {
    // The gate reads the PROMPT. Every account sends that prompt, so a retry
    // buys the same 11128 while billing a credential that was never at fault.
    let asked = 0
    shim = mount(failure(400, CHANNEL_REJECT_BODY), async () => { asked += 1; return undefined })
    await shim.ready
    const { message } = await chat(shim, 'You are an AI agent powered by DeepSeek Harness.')
    expect(asked, 'the pool was searched for a replacement account').toBe(0)
    // And it must not claim a search it never ran (the issue #78 defect, again).
    expect(message).not.toContain('已尝试')
    expect(message).not.toContain('池中其余账号')
  })

  it('renders the host-facing code and status the host needs', async () => {
    // 400 + `channel_reject` keeps it outside the host's retry set; the `code`
    // is the kind itself (no `quota_exceeded` translation, which would let the
    // host swap out this copy for its own quota wording).
    shim = mount(failure(400, CHANNEL_REJECT_BODY), async () => undefined)
    await shim.ready
    const { status, type } = await chat(shim, 'You are an AI agent powered by DeepSeek Harness.')
    expect(status).toBe(400)
    expect(type).toBe('channel_reject')
  })

  it('labels the failure as the gateway gate, not as a generic upstream refusal', async () => {
    shim = mount(failure(400, CHANNEL_REJECT_BODY), async () => undefined)
    await shim.ready
    const { message } = await chat(shim, 'You are an AI agent powered by DeepSeek Harness.')
    expect(message).toContain('被网关的渠道校验拦截（不是账号、额度或网络问题）')
    // 2. Same outer frame as every other failure, so the sentence users paste
    //    into issues keeps its shape.
    expect(message).toContain('workbuddy 上游失败：')
    expect(message).toContain('（http 400）')
  })
})

describe('the card copy for a channel rejection', () => {
  it('is distinct from the policy and generic failure copy in both locales', async () => {
    // A shared string would make "test passes, chat refused" read as a content
    // refusal, which has a completely different (and wrong) next step.
    const { en, zh } = await import('../src/client/locales.ts')
    const key = 'row.probeChannelRejected' as const
    expect(en[key].length).toBeGreaterThan(0)
    expect(zh[key].length).toBeGreaterThan(0)
    expect(zh[key]).not.toBe(en[key])
    expect(en[key]).not.toBe(en['row.probePolicyRejected'])
    expect(zh[key]).not.toBe(zh['row.probePolicyRejected'])
    expect(en[key]).not.toBe(en['row.probeFailed'])
    expect(zh[key]).not.toBe(zh['row.probeFailed'])
  })

  it('carries no markdown emphasis, because it renders as plain text', async () => {
    // The probe verdict is rendered as a JSX text child
    // (`probeResultView` → `<p>{view.text}</p>`), NOT through a rich-text
    // renderer. So a `**bold**` marker in this string reaches the screen as
    // literal asterisks — a cosmetic defect a user would read as noise on the
    // one line that is supposed to explain the failure.
    //
    // The `**` style IS used in this file, but only in strings that go into a
    // `title=` tooltip, where the host renders markdown. The distinction is not
    // obvious from the dictionary alone, so it is pinned here: every label in
    // the `row.probe*` family is plain text.
    const { en, zh } = await import('../src/client/locales.ts')
    const probeLabels = Object.keys(en).filter(key => key.startsWith('row.probe'))
    expect(probeLabels.length).toBeGreaterThan(0)
    for (const key of probeLabels) {
      const enText = (en as Record<string, string>)[key]
      const zhText = (zh as Record<string, string>)[key]
      expect(enText, key).not.toContain('**')
      expect(zhText, key).not.toContain('**')
    }
  })
})

/**
 * The HOST's own view of the failure.
 *
 * WHY THIS BLOCK EXISTS. Everything above asserts on what the PLUGIN writes. But
 * the plugin's sentence only reaches the user if the host keeps it — and the
 * host does not always keep it: `failureMessage()` in
 * `@deepseek-ai/dsh-client-ui-chat` hard-codes its own wording for `QUOTA` /
 * `ACCOUNT_QUOTA` and DISCARDS the plugin's message (that is the whole of issue
 * #84). The host also picks the failure CLASS by regexing English text out of
 * `type + " " + code + " " + message` (`classifyPiAiError()` in
 * `@deepseek-ai/dsh-llm-pi-ai`), and that class decides whether the request is
 * retried in place.
 *
 * So the decisive claim is not "the shim wrote a good message" but "the host
 * classifies this as a terminal 400 and shows the plugin's sentence". This block
 * drives the REAL pi-ai client — the same `stream()` the host uses — against
 * the REAL shim over a real socket, and then asks the host's OWN predicate.
 *
 * The risk this guards is specific and real: our message says 「不是账号、额度
 * 或网络问题」, and the upstream's `displayTips` says 「不是官方客户端发出的」.
 * Both are Chinese prose about limits, and a classifier that matched Chinese
 * quota wording would file this as an account limit and show the wrong remedy.
 */
describe('the host keeps the plugin\'s sentence and does not retry the gate', () => {
  /** One chat through the REAL pi-ai client, returning the text the host reads. */
  async function hostErrorText(instance: WorkBuddyShim): Promise<string> {
    const model = {
      id: 'deepseek-v4.1-flash',
      name: 'Deepseek-V4.1-Flash',
      api: 'openai-completions' as const,
      provider: 'workbuddy',
      baseUrl: `${instance.baseUrl()}/v1`,
      input: ['text' as const],
      cost: { input: 0, output: 0 },
      contextWindow: 300_000,
      maxTokens: 8_000,
      reasoning: true,
      compat: {},
    }
    const context = {
      messages: [{
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'hi' }],
        timestamp: Date.now(),
      }],
    }
    const events = stream(
      model as unknown as Parameters<typeof stream>[0],
      context as unknown as Parameters<typeof stream>[1],
      { apiKey: instance.token(), maxRetries: 0 },
    )
    for await (const event of events) void event
    const message = await events.result()
    expect(message.stopReason).toBe('error')
    return message.errorMessage ?? ''
  }

  it('is not read as a quota failure, so the plugin wording survives', async () => {
    shim = mount(failure(400, CHANNEL_REJECT_BODY), async () => undefined)
    await shim.ready

    const text = await hostErrorText(shim)

    // The host's OWN predicate. If this were true, `failureMessage()` would
    // replace the plugin's sentence with 「当前请求的额度已用尽」 — the exact
    // misdirection issue #84 was about, reintroduced for this failure.
    expect(isQuotaExceededError(text)).toBe(false)

    // And the sentence that must reach the reader is in the text the host reads.
    expect(text).toContain('命中的 system 提示开头')
    expect(text).toContain('换账号或换区域也不会改变结果')
    // The upstream's misleading half must NOT be what the reader is left with.
    expect(text).not.toContain('请用官方版本重新发送')
  })

  it('is classified as a terminal 400, which the host does not retry in place', async () => {
    // The host's retryable set is `RATE_LIMIT` / `SERVER` / `TIMEOUT` /
    // `TRANSPORT` / `EMPTY_RESPONSE` (see `DEFAULT_RETRYABLE_CODES`). A 400 is
    // none of them, and that is CORRECT here: the gate reads the PROMPT, so a
    // retry sends the same prompt again and buys exactly the same refusal —
    // five times over, if the retry budget were spent.
    //
    // What the host sees is the plugin's own `code` (untranslated — see
    // `KIND_HOST_CODE`), and the status the gateway actually answered.
    shim = mount(failure(400, CHANNEL_REJECT_BODY), async () => undefined)
    await shim.ready

    const { status, type } = await chat(shim, 'You are Cursor Agent, an AI pair programmer from Anysphere.')
    expect(status).toBe(400)
    // `channel_reject`, NOT `quota_exceeded` and NOT `client`: the first would
    // be substituted by the host, the second would be indistinguishable from
    // every other 400 the gateway can produce.
    expect(type).toBe('channel_reject')
  })
})
