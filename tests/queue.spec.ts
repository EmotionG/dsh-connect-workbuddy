/**
 * The model queue: which upstream answers are a queue at all, and what the
 * plugin says about them.
 *
 * The three codes and the polling tiers are the WorkBuddy client's own
 * (`QueuePollingManager`, 5.8.3): `6020` waiting, `6021` full, `6022` this user
 * already holds the maximum, polled every 2/5/10/15 s by position tier. The
 * `<status>` shape is the live answer measured 2026-10-21 on `/v2/chat/queue/status`
 * — including its `message`, which is an i18n KEY (`queue.expired.title`), not a
 * sentence. The plugin therefore never renders that field, and one test below
 * pins exactly that.
 */
import { describe, expect, it } from 'vitest'
import {
  isQueueCode,
  parseQueueAnswer,
  queueNoticeText,
  queuePollIntervalMs,
  WORKBUDDY_QUEUE_DEFAULT_RETRY_SEC,
  WORKBUDDY_QUEUE_FULL,
  WORKBUDDY_QUEUE_MAX_WAIT_MS,
  WORKBUDDY_QUEUE_USER_LIMIT,
  WORKBUDDY_QUEUE_WAITING,
} from '../src/queue.ts'

/** What the app's own bundle answers for one waiting request. */
const waitingEnvelope = JSON.stringify({
  code: WORKBUDDY_QUEUE_WAITING,
  message: 'queue.waiting',
  data: { code: WORKBUDDY_QUEUE_WAITING, queue_position: 8777, queue_size: 9021, retry_after: 7 },
})

/** The live status answer, whose `message` is a key. */
const statusAnswer = JSON.stringify({
  code: 0,
  msg: 'OK',
  requestId: '8b0bd3ee',
  data: { status: 'expired', message: 'queue.expired.title' },
})

describe('the three queue codes', () => {
  it('recognises exactly the app’s enum', () => {
    expect(isQueueCode(WORKBUDDY_QUEUE_WAITING)).toBe(true)
    expect(isQueueCode(WORKBUDDY_QUEUE_FULL)).toBe(true)
    expect(isQueueCode(WORKBUDDY_QUEUE_USER_LIMIT)).toBe(true)
    expect(isQueueCode(14003)).toBe(false)
    expect(isQueueCode('6020')).toBe(false)
    expect(isQueueCode(undefined)).toBe(false)
  })
})

describe('parseQueueAnswer', () => {
  it('reads position, size and retry_after out of a waiting answer', () => {
    expect(parseQueueAnswer(waitingEnvelope)).toEqual({
      code: WORKBUDDY_QUEUE_WAITING,
      position: 8777,
      size: 9021,
      retryAfterSec: 7,
    })
  })

  it('falls back to the app’s 5-second default when no retry_after came', () => {
    const body = JSON.stringify({ code: 6020, data: { queue_position: 3 } })
    expect(parseQueueAnswer(body)?.retryAfterSec).toBe(WORKBUDDY_QUEUE_DEFAULT_RETRY_SEC)
  })

  it('reads a code nested one level down', () => {
    const body = JSON.stringify({ code: 0, data: { code: 6021, queue_size: 500 } })
    expect(parseQueueAnswer(body)).toEqual({ code: WORKBUDDY_QUEUE_FULL, size: 500, retryAfterSec: 5 })
  })

  it('reads the app’s agent-protocol envelope, where the condition is a JSON string', () => {
    const body = JSON.stringify({
      _meta: {
        'codebuddy.ai/errorMessage': JSON.stringify({
          code: 0,
          data: { code: 6020, queue_position: 12, queue_size: 40 },
          message: 'queue.waiting',
        }),
      },
    })
    expect(parseQueueAnswer(body)?.position).toBe(12)
  })

  it('is NOT a queue for a throttle, a quota refusal or a truncated body', () => {
    expect(parseQueueAnswer(JSON.stringify({ code: 14003, msg: 'model busy' }))).toBeUndefined()
    expect(parseQueueAnswer(JSON.stringify({ code: 14018, extError: { code: 14018 } }))).toBeUndefined()
    expect(parseQueueAnswer('{"code":6020,"data":{"queue_pos')).toBeUndefined()
    expect(parseQueueAnswer('')).toBeUndefined()
  })

  it('does not mistake the live status answer for a queue condition', () => {
    // `{status:'expired', message:'queue.expired.title'}` is a STATUS read, not
    // a queue event: nothing to report, and the key must never be printed.
    expect(parseQueueAnswer(statusAnswer)).toBeUndefined()
  })
})

describe('queuePollIntervalMs', () => {
  it('uses the app’s position tiers', () => {
    expect(queuePollIntervalMs(1)).toBe(2_000)
    expect(queuePollIntervalMs(5)).toBe(2_000)
    expect(queuePollIntervalMs(6)).toBe(5_000)
    expect(queuePollIntervalMs(20)).toBe(5_000)
    expect(queuePollIntervalMs(21)).toBe(10_000)
    expect(queuePollIntervalMs(50)).toBe(10_000)
    expect(queuePollIntervalMs(8777)).toBe(15_000)
  })

  it('polls at the slowest tier when the position is unknown', () => {
    expect(queuePollIntervalMs(undefined)).toBe(15_000)
    expect(queuePollIntervalMs(Number.NaN)).toBe(15_000)
  })

  it('bounds the wait at the app’s 12 minutes', () => {
    expect(WORKBUDDY_QUEUE_MAX_WAIT_MS).toBe(12 * 60 * 1000)
  })
})

describe('queueNoticeText', () => {
  it('names the position AND the queue size for a waiting request', () => {
    const text = queueNoticeText({ code: WORKBUDDY_QUEUE_WAITING, position: 8777, size: 9021, retryAfterSec: 7 })
    expect(text).toContain('排队中')
    expect(text).toContain('8777')
    expect(text).toContain('9021')
    expect(text).toContain('7 秒')
  })

  it('says the queue is full, and does not pretend a position exists', () => {
    const text = queueNoticeText({ code: WORKBUDDY_QUEUE_FULL, size: 500, retryAfterSec: 5 })
    expect(text).toContain('队列已满')
    expect(text).not.toContain('第 ')
  })

  it('says the user already holds the maximum, for 6022', () => {
    expect(queueNoticeText({ code: WORKBUDDY_QUEUE_USER_LIMIT, retryAfterSec: 5 })).toContain('排队任务已达上限')
  })

  it('never prints an untranslated upstream message key', () => {
    const text = queueNoticeText({ code: WORKBUDDY_QUEUE_WAITING, position: 2, retryAfterSec: 5 })
    expect(text).not.toContain('queue.')
  })
})
