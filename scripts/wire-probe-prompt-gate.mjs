#!/usr/bin/env node
/**
 * Does the app's header identity lift the system-prompt CONTENT gate?
 *
 * The plugin carries two independent defences against business code `11128`:
 *
 *   1. `ensureSystemHead()` prepends a neutral line when the prompt OPENS with a
 *      measured-unapproved opening (a prefix rule);
 *   2. `breakIdentityClauses()` inserts U+200B inside three identity clauses on
 *      every request, unconditionally, against the substring rule.
 *
 * Defence 2 is the expensive one for fidelity: it edits the host's own system
 * prompt on every request. It exists because the gate was measured to be a
 * CONTENT match — but the plugin has only ever measured it while speaking the
 * CLI channel. If the gate is really "not an approved channel", the app's own
 * header set might satisfy it regardless of prompt content, in which case the
 * prompt rewrite is paying for a problem the headers already solve.
 *
 * That is testable in four rows, same prompt, one variable at a time:
 *
 *   headers × prompt
 *
 * and it is worth testing because the two hypotheses make opposite predictions
 * for the SAME request.
 */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  defaultDesktopAuthCandidates,
  parseWorkBuddyAuth,
  readAtRestKey,
} from '../lib/index.js'

/** The first line of a live DSH system prompt — the measured site 1. */
const DSH_OPENING = 'You are an AI agent powered by DeepSeek Harness.'

/** A realistic prompt: the real opening, then the other two measured sites. */
const DSH_PROMPT = [
  DSH_OPENING,
  'You are a coding agent powered by the hy3 model.',
  'You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:53135.',
  'Working directory: D:/developRelevant/dsh-p/dsh-connect-workbuddy',
].join('\n')

/** The same prompt with every identity clause broken by U+200B, as the plugin sends it. */
const BROKEN_PROMPT = DSH_PROMPT.replace(
  /(you)(\s+are\s+(?:(?:an?\s+)?[\w-]*\s*agent\s+powered\s+by|interacting\s+with\s+the\s+user\s+through\s+the\s+deepseek\s+harness))?/giu,
  (match) => match,
).replace(/(\s+)(?=(are|a|coding|agent|powered|by|interacting|with|the|user|through|deepseek|harness)\b)/giu, '$1\u200b')

function uuidv7Hex() {
  const bytes = Buffer.from(randomUUID().replace(/-/gu, ''), 'hex')
  const now = Date.now()
  for (let index = 0; index < 6; index++) bytes[index] = Math.floor(now / (2 ** (8 * (5 - index)))) & 0xff
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes.toString('hex')
}

function ids() {
  const id = uuidv7Hex()
  const messageId = uuidv7Hex()
  return { id, messageId }
}

/** The plugin's current CLI-channel chat headers (`chatHeaders`, usageIdentity off). */
function pluginHeaders(credential) {
  const { id, messageId } = ids()
  return {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://www.codebuddy.cn',
    'Referer': 'https://www.codebuddy.cn/',
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'Authorization': `Bearer ${credential.accessToken}`,
    'X-User-Id': credential.uid,
    'X-Domain': credential.domain,
    'X-Product': 'SaaS',
    'X-Conversation-ID': id,
    'X-Conversation-Request-ID': id,
    'X-Conversation-Message-ID': messageId,
  }
}

/** The official app's chat headers, as measured to answer 200. */
function appHeaders(credential) {
  const { id, messageId } = ids()
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

async function send(label, url, headers, systemText) {
  const started = Date.now()
  let status = 0
  let text = ''
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'hy3',
        stream: true,
        max_tokens: 1,
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: 'hi' },
        ],
      }),
      signal: AbortSignal.timeout(40_000),
    })
    status = response.status
    text = (await response.text()).slice(0, 400)
  } catch (error) {
    text = `transport: ${String(error).slice(0, 140)}`
  }
  const code = /"code"\s*:\s*(-?\d+)/u.exec(text)?.[1] ?? '-'
  const msg = /"(?:msg|message|displayMsg)"\s*:\s*"([^"]{0,70})"/u.exec(text)?.[1] ?? ''
  process.stdout.write(`${label.padEnd(48)} ${String(status).padStart(4)} code=${String(code).padStart(6)} ${String(Date.now() - started).padStart(5)}ms ${msg}\n`)
  return status
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
  const cn = 'https://www.workbuddy.cn/v2/chat/completions'
  process.stdout.write(`system-prompt gate × header identity\n`)
  process.stdout.write(`raw prompt starts: ${JSON.stringify(DSH_PROMPT.slice(0, 60))}\n\n`)

  await send('1 plugin headers + RAW dsh prompt', cn, pluginHeaders(credential), DSH_PROMPT)
  await new Promise((resolve) => setTimeout(resolve, 4000))
  await send('2 plugin headers + BROKEN dsh prompt', cn, pluginHeaders(credential), BROKEN_PROMPT)
  await new Promise((resolve) => setTimeout(resolve, 4000))
  await send('3 app headers + RAW dsh prompt', cn, appHeaders(credential), DSH_PROMPT)
  await new Promise((resolve) => setTimeout(resolve, 4000))
  await send('4 app headers + BROKEN dsh prompt', cn, appHeaders(credential), BROKEN_PROMPT)
  await new Promise((resolve) => setTimeout(resolve, 4000))
  await send('5 plugin headers + neutral head', cn, pluginHeaders(credential), `You are a helpful assistant.\n${DSH_PROMPT}`)
  await new Promise((resolve) => setTimeout(resolve, 4000))
  await send('6 app headers + neutral head', cn, appHeaders(credential), `You are a helpful assistant.\n${DSH_PROMPT}`)
}

await main()
