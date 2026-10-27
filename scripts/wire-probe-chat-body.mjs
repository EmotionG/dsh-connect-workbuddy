#!/usr/bin/env node
/**
 * Measure which BODY fields the gateway accepts on the chat endpoint.
 *
 * The plugin rewrites the body before sending: `stream` is forced to true,
 * `developer` becomes `system`, `tool_choice` is flattened from the object form
 * to a bare string, `reasoning_effort: "off"` is dropped. Each of those was
 * forced by an observed 400 — but at the CLI channel's request shape. Now that
 * the app-shaped header set is measured to answer 200, the question is whether
 * the rewrites are still necessary: a rewrite that is NOT needed is a real
 * divergence from the app's own parameters, which is exactly what this task is
 * about.
 *
 * Method: send the SAME app-shaped headers (measured 200) and vary ONE body
 * field per row. A row that answers 200 means the plugin's rewrite of that field
 * can be dropped and the caller's own value forwarded verbatim.
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

const UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'

function uuidv7Hex() {
  const bytes = Buffer.from(randomUUID().replace(/-/gu, ''), 'hex')
  const now = Date.now()
  for (let index = 0; index < 6; index++) bytes[index] = Math.floor(now / 2 ** (8 * (5 - index))) & 0xff
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes.toString('hex')
}

function headersFor(credential) {
  const id = uuidv7Hex()
  const messageId = uuidv7Hex()
  const trace = randomUUID().replace(/-/gu, '')
  const span = randomUUID().replace(/-/gu, '').slice(0, 16)
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'User-Agent': UA,
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

const TOOL = {
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Return the current time.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}

const baseMessages = [
  { role: 'system', content: 'You are a connectivity check. Reply with a single word.' },
  { role: 'user', content: 'hi' },
]

const ROWS = [
  { label: 'a stream:true (plugin shape)', body: { model: 'hy3', stream: true, messages: baseMessages } },
  { label: 'b stream:true + temperature:0', body: { model: 'hy3', stream: true, temperature: 0, messages: baseMessages } },
  { label: 'c + max_tokens:64', body: { model: 'hy3', stream: true, max_tokens: 64, messages: baseMessages } },
  { label: 'd + stream_options.include_usage', body: { model: 'hy3', stream: true, stream_options: { include_usage: true }, messages: baseMessages } },
  { label: 'e developer role instead of system', body: { model: 'hy3', stream: true, messages: [{ role: 'developer', content: 'You are a connectivity check. Reply with a single word.' }, { role: 'user', content: 'hi' }] } },
  { label: 'f tool_choice:"auto" + tools', body: { model: 'hy3', stream: true, messages: baseMessages, tools: [TOOL], tool_choice: 'auto' } },
  { label: 'g tool_choice OBJECT form', body: { model: 'hy3', stream: true, messages: baseMessages, tools: [TOOL], tool_choice: { type: 'function', function: { name: 'get_time' } } } },
  { label: 'h tool_choice:"none" + tools', body: { model: 'hy3', stream: true, messages: baseMessages, tools: [TOOL], tool_choice: 'none' } },
  { label: 'i reasoning_effort:"off"', body: { model: 'hy3', stream: true, reasoning_effort: 'off', messages: baseMessages } },
  { label: 'j top_p / presence / frequency', body: { model: 'hy3', stream: true, top_p: 1, presence_penalty: 0, frequency_penalty: 0, messages: baseMessages } },
  { label: 'k no system head (user first)', body: { model: 'hy3', stream: true, messages: [{ role: 'user', content: 'hi' }] } },
  { label: 'l stream:false', body: { model: 'hy3', stream: false, messages: baseMessages } },
]

async function send(credential, label, body) {
  const started = Date.now()
  let status = 0
  let text = ''
  try {
    const response = await fetch('https://www.workbuddy.cn/v2/chat/completions', {
      method: 'POST',
      headers: headersFor(credential),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    status = response.status
    text = (await response.text()).slice(0, 400)
  } catch (error) {
    text = `transport: ${String(error).slice(0, 160)}`
  }
  const code = /"code"\s*:\s*(-?\d+)/u.exec(text)?.[1] ?? '-'
  const msg = /"(?:msg|message|displayMsg)"\s*:\s*"([^"]{0,90})"/u.exec(text)?.[1] ?? ''
  process.stdout.write(`${label.padEnd(40)} ${String(status).padStart(4)} code=${String(code).padStart(6)} ${String(Date.now() - started).padStart(5)}ms ${msg}\n`)
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
  process.stdout.write(`body shape probe — model hy3, app-shaped headers\n\n`)
  for (const row of ROWS) await send(credential, row.label, row.body)
}

await main()
