#!/usr/bin/env node
/**
 * Two header details the app's own bundle contradicts the plugin on.
 *
 * 1. USER-AGENT. The plugin sends `CLI/2.63.2 CodeBuddy/2.63.2` on chat and calls
 *    that the channel identity. The app's own ModelProvider does the opposite:
 *    after merging its custom headers it runs
 *
 *        delete M.authorization, delete M["user-agent"]
 *
 *    so the chat request leaves the app with NO explicit User-Agent at all
 *    (the transport supplies its own), and only re-adds `authorization` later.
 *    If the gateway answers 200 without one, then a UA the app does not send is
 *    a divergence the plugin is inventing.
 *
 * 2. ORIGIN / REFERER. The plugin sends both. They are browser headers; the app's
 *    main process sends neither on chat.
 *
 * Both are cheap to measure and both only ever ADD restrictions if wrong, so
 * measure before deciding.
 */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  defaultDesktopAuthCandidates,
  parseWorkBuddyAuth,
  readAtRestKey,
} from '../lib/index.js'

function uuidv7Hex() {
  const bytes = Buffer.from(randomUUID().replace(/-/gu, ''), 'hex')
  const now = Date.now()
  for (let index = 0; index < 6; index++) bytes[index] = Math.floor(now / (2 ** (8 * (5 - index)))) & 0xff
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes.toString('hex')
}

/** The app's chat headers, with an explicit knob for the two details above. */
function appChatHeaders(credential, { userAgent = 'triple', origin = false } = {}) {
  const id = uuidv7Hex()
  const messageId = uuidv7Hex()
  const trace = randomUUID().replace(/-/gu, '')
  const span = randomUUID().replace(/-/gu, '').slice(0, 16)
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'Authorization': `Bearer ${credential.accessToken}`,
    'X-Conversation-ID': id,
    'X-Conversation-Request-ID': id,
    'X-Conversation-Message-ID': messageId,
    'X-Request-ID': messageId,
    'X-Product': 'SaaS',
    'X-Domain': credential.domain,
    'X-User-Id': credential.uid,
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '5.8.3',
    'X-Private-Data': 'false',
    'x-codebuddy-request': '1',
    'traceparent': `00-${trace}-${span}-01`,
    'b3': `${trace}-${span}-1-${randomUUID().replace(/-/gu, '').slice(0, 16)}`,
    'X-B3-TraceId': trace,
    'X-B3-ParentSpanId': span,
    'X-B3-SpanId': span,
    'X-B3-Sampled': '1',
    'X-Trace-ID': trace,
  }
  if (userAgent === 'triple') headers['User-Agent'] = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'
  if (userAgent === 'cli') headers['User-Agent'] = 'CLI/2.63.2 CodeBuddy/2.63.2'
  if (origin) {
    headers['Origin'] = 'https://www.codebuddy.cn'
    headers['Referer'] = 'https://www.codebuddy.cn/'
  }
  return headers
}

async function send(label, headers) {
  const started = Date.now()
  let status = 0
  let text = ''
  try {
    const response = await fetch('https://www.workbuddy.cn/v2/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'hy3',
        stream: true,
        max_tokens: 1,
        messages: [
          { role: 'system', content: 'You are a connectivity check. Reply with a single word.' },
          { role: 'user', content: 'hi' },
        ],
      }),
      signal: AbortSignal.timeout(40_000),
    })
    status = response.status
    text = (await response.text()).slice(0, 300)
  } catch (error) {
    text = `transport: ${String(error).slice(0, 140)}`
  }
  const code = /"code"\s*:\s*(-?\d+)/u.exec(text)?.[1] ?? '-'
  const msg = /"(?:msg|message|displayMsg)"\s*:\s*"([^"]{0,60})"/u.exec(text)?.[1] ?? ''
  process.stdout.write(`${label.padEnd(44)} ${String(status).padStart(4)} code=${String(code).padStart(6)} ${String(Date.now() - started).padStart(5)}ms ${msg}\n`)
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
  process.stdout.write('UA / Origin probe\n\n')
  await send('1 app headers, UA=triple', appChatHeaders(credential))
  await new Promise((resolve) => setTimeout(resolve, 5000))
  await send('2 app headers, NO User-Agent (as app does)', appChatHeaders(credential, { userAgent: 'none' }))
  await new Promise((resolve) => setTimeout(resolve, 5000))
  await send('3 app headers, UA=CLI-shaped', appChatHeaders(credential, { userAgent: 'cli' }))
  await new Promise((resolve) => setTimeout(resolve, 5000))
  await send('4 app headers + Origin/Referer', appChatHeaders(credential, { origin: true }))
}

await main()
