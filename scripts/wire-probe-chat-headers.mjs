#!/usr/bin/env node
/**
 * Measure which chat request shape the real gateway ACCEPTS.
 *
 * Question this answers: the plugin's `chatHeaders()` sends the CLI channel's
 * minimal set. The official WorkBuddy app sends a much wider set (X-Agent-Intent,
 * X-Agent-Purpose, X-IDE-*, X-Private-Data, x-codebuddy-request, trace headers).
 * The plugin's own comments record that those extras are NOT REQUIRED (a request
 * without them answered 200) — but "not required" is not "permitted": nobody has
 * measured whether sending them changes the answer.
 *
 * So this probe goes the other way: start from the FULL official set and remove
 * one group at a time. A row that answers 200 proves that shape is permitted.
 * A row that fails names the group that was load-bearing.
 *
 * Cost: max_tokens 1, one tiny message pair per row.
 *
 * Usage: node scripts/wire-probe-chat-headers.mjs
 */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  defaultDesktopAuthCandidates,
  parseWorkBuddyAuth,
  readAtRestKey,
} from '../lib/index.js'

const APP_VERSION = '5.8.3'
const CLI_VERSION = '2.161.0'
const UA_CLI = 'CLI/2.63.2 CodeBuddy/2.63.2'
const UA_APP = `WorkBuddy/${APP_VERSION}`
const UA_TRIPLE = `WorkBuddy/${APP_VERSION} WorkBuddy/${APP_VERSION} CLI/${CLI_VERSION}`

/** 32-hex UUIDv7, the shape the official client's ids take. */
function uuidv7Hex() {
  const bytes = Buffer.from(randomUUID().replace(/-/gu, ''), 'hex')
  const now = Date.now()
  for (let index = 0; index < 6; index++) {
    bytes[index] = Math.floor(now / 2 ** (8 * (5 - index))) & 0xff
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes.toString('hex')
}

function traceHeaders() {
  const trace = randomUUID().replace(/-/gu, '')
  const span = randomUUID().replace(/-/gu, '').slice(0, 16)
  return {
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1-${randomUUID().replace(/-/gu, '').slice(0, 16)}`,
    'X-B3-TraceId': trace,
    'X-B3-ParentSpanId': span,
    'X-B3-SpanId': span,
    'X-B3-Sampled': '1',
    'X-Trace-ID': trace,
  }
}

/**
 * The official app's chat header set, as extracted from the app bundle
 * (`cli/dist/codebuddy-lite-wb.mjs` — `applyGatewayHeaders` + the CLI's
 * `getCustomHeaders`) and from the app's own logs.
 */
function officialHeaders(credential, { withIde = true, withAgent = true, withTrace = true, withSecurity = true, ua = UA_TRIPLE } = {}) {
  const id = uuidv7Hex()
  const messageId = uuidv7Hex()
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'User-Agent': ua,
    'Authorization': `Bearer ${credential.accessToken}`,
    'X-Conversation-ID': id,
    'X-Conversation-Request-ID': id,
    'X-Conversation-Message-ID': messageId,
    'X-Request-ID': messageId,
    'X-Product': 'SaaS',
    'X-Domain': credential.domain,
    'X-User-Id': credential.uid,
  }
  if (withAgent) {
    headers['X-Agent-Intent'] = 'craft'
    headers['X-Agent-Purpose'] = 'conversation'
  }
  if (withIde) {
    headers['X-IDE-Type'] = 'WorkBuddy'
    headers['X-IDE-Name'] = 'WorkBuddy'
    headers['X-IDE-Version'] = APP_VERSION
    // Derived from `enableModelOptimization.enabled !== false` → true on a
    // default install → the header value is the string "false".
    headers['X-Private-Data'] = 'false'
  }
  if (withSecurity) headers['x-codebuddy-request'] = '1'
  if (withTrace) Object.assign(headers, traceHeaders())
  return headers
}

/** The plugin's current shape, for the baseline row. */
function pluginHeaders(credential) {
  const id = uuidv7Hex()
  const messageId = uuidv7Hex()
  return {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://www.codebuddy.cn',
    'Referer': 'https://www.codebuddy.cn/',
    'User-Agent': UA_CLI,
    'Authorization': `Bearer ${credential.accessToken}`,
    'X-User-Id': credential.uid,
    'X-Domain': credential.domain,
    'X-Product': 'SaaS',
    'X-Conversation-ID': id,
    'X-Conversation-Request-ID': id,
    'X-Conversation-Message-ID': messageId,
  }
}

function body(model) {
  return JSON.stringify({
    model,
    stream: true,
    max_tokens: 1,
    messages: [
      { role: 'system', content: 'You are a connectivity check. Reply with a single word.' },
      { role: 'user', content: 'hi' },
    ],
  })
}

async function send(label, url, headers, model) {
  const started = Date.now()
  let status = 0
  let text = ''
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: body(model),
      signal: AbortSignal.timeout(30_000),
    })
    status = response.status
    text = (await response.text()).slice(0, 300)
  } catch (error) {
    text = `transport: ${String(error).slice(0, 160)}`
  }
  const elapsed = Date.now() - started
  // The SSE answer is a success; an envelope body carries the business code.
  const code = /"code"\s*:\s*(-?\d+)/u.exec(text)?.[1] ?? '-'
  const oneLine = text.replace(/\s+/gu, ' ').slice(0, 160)
  process.stdout.write(`${label.padEnd(46)} ${String(status).padStart(4)}  code=${String(code).padStart(6)}  ${elapsed}ms  ${oneLine}\n`)
  return { label, status, code }
}

async function main() {
  const key = await readAtRestKey()
  let credential
  for (const path of defaultDesktopAuthCandidates()) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    credential = parseWorkBuddyAuth(text, path, key)
    if (credential !== undefined) break
  }
  if (credential === undefined) {
    process.stdout.write('no credential\n')
    process.exitCode = 1
    return
  }

  const model = process.env.PROBE_MODEL ?? 'hy3'
  const cnApp = 'https://www.workbuddy.cn/v2/chat/completions'
  const cnCli = 'https://copilot.tencent.com/v2/chat/completions'
  process.stdout.write(`account  : ${credential.uid}\nmodel    : ${model}\n\n`)

  await send('1 plugin baseline (copilot)', cnCli, pluginHeaders(credential), model)
  await send('2 plugin baseline (workbuddy.cn)', cnApp, pluginHeaders(credential), model)
  await send('3 official full (workbuddy.cn)', cnApp, officialHeaders(credential), model)
  await send('4 official full (copilot)', cnCli, officialHeaders(credential), model)
  await send('5 official UA=WorkBuddy/5.8.3 only', cnApp, officialHeaders(credential, { ua: UA_APP }), model)
  await send('6 official minus IDE/Private', cnApp, officialHeaders(credential, { withIde: false }), model)
  await send('7 official minus Agent-Intent/Purpose', cnApp, officialHeaders(credential, { withAgent: false }), model)
  await send('8 official minus trace', cnApp, officialHeaders(credential, { withTrace: false }), model)
  await send('9 official minus x-codebuddy-request', cnApp, officialHeaders(credential, { withSecurity: false }), model)
  await send('10 official, UA=CLI-shaped', cnApp, officialHeaders(credential, { ua: UA_CLI }), model)
}

await main()
