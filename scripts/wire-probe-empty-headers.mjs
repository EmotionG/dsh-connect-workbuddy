#!/usr/bin/env node
/**
 * Can the plugin replace its `X-No-*` markers with the app's own empty-value
 * headers?
 *
 * The plugin marks an absent value by SENDING A FLAG:
 *
 *     X-No-User-Id: 1     instead of   X-User-Id: <nothing>
 *
 * The app's `applyGatewayHeaders` instead sends the field with whatever it has,
 * which for a personal account is an empty string — its own log shows
 * `"X-User-Id":"985094ac-…"` for a real account but the bundle's literal is
 * `L?.account?.uid ?? N?.uid || ""`, i.e. the empty string is a real value it
 * sends. So the two implementations disagree on the SPELLING of "no value".
 *
 * Empty-valued headers are the kind of thing HTTP clients and gateways silently
 * drop, so this cannot be reasoned about — it has to be measured. Three rows:
 * the plugin's flag form (baseline), the app's empty-value form, and the app's
 * form with the header omitted entirely.
 *
 * Cost: max_tokens 1 per row.
 */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  defaultDesktopAuthCandidates,
  parseWorkBuddyAuth,
  readAtRestKey,
} from '../lib/index.js'

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
  process.exit(1)
}

function uuidv7Hex() {
  const bytes = Buffer.from(randomUUID().replace(/-/gu, ''), 'hex')
  const now = Date.now()
  for (let index = 0; index < 6; index++) bytes[index] = Math.floor(now / 2 ** (8 * (5 - index))) & 0xff
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes.toString('hex')
}

function base(credential) {
  const id = uuidv7Hex()
  const messageId = uuidv7Hex()
  const trace = randomUUID().replace(/-/gu, '')
  const span = randomUUID().replace(/-/gu, '').slice(0, 16)
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'User-Agent': 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0',
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
  process.stdout.write(`${label.padEnd(52)} ${String(status).padStart(4)} code=${String(code).padStart(6)} ${String(Date.now() - started).padStart(5)}ms ${msg}\n`)
}

// This account is personal: `enterpriseId` is null, which is exactly the case
// the flag form exists for.
process.stdout.write(`enterpriseId : ${JSON.stringify(credential.enterpriseId ?? null)}\n\n`)

await send('1 X-No-Enterprise-Id: 1 (plugin form)', base(credential))
await new Promise(r => setTimeout(r, 5000))

const emptyForm = base(credential)
emptyForm['X-Enterprise-Id'] = ''
await send('2 X-Enterprise-Id: "" (app form)', emptyForm)
await new Promise(r => setTimeout(r, 5000))

const omitted = base(credential)
await send('3 X-Enterprise-Id omitted entirely', omitted)
await new Promise(r => setTimeout(r, 5000))

const dept = base(credential)
dept['X-Department-Info'] = ''
await send('4 + X-Department-Info: ""', dept)
