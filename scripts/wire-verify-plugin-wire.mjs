#!/usr/bin/env node
/**
 * End-to-end confirmation that the PLUGIN's own code path now speaks the app's
 * header shape — not a re-implementation of it.
 *
 * The earlier probes built headers by hand. That proves the gateway accepts a
 * shape; it does not prove the plugin SENDS that shape. This one imports the
 * built client and captures the headers it actually produces, then sends the
 * request for real.
 */
import { readFile } from 'node:fs/promises'
import {
  WorkBuddyUpstreamClient,
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
  process.exitCode = 1
  process.exit()
}

/** Capture what the client produces, then let the real request through. */
const realFetch = globalThis.fetch
const captured = []
globalThis.fetch = (url, init) => {
  captured.push({ url: String(url), headers: { ...init?.headers } })
  return realFetch(url, init)
}

const client = new WorkBuddyUpstreamClient(undefined, { wireIdentity: true })

// A body the gateway has already accepted: system head + tiny prompt. The
// plugin's real body is the DSH prompt, which needs the identity-clause rewrite
// to pass the content gate — that is a body concern, not a header one, and it
// was measured separately.
const body = JSON.stringify({
  model: 'hy3',
  stream: true,
  max_tokens: 1,
  messages: [
    { role: 'system', content: 'You are a connectivity check. Reply with a single word.' },
    { role: 'user', content: 'hi' },
  ],
})

const result = await client.chatStream(credential, body)
const seen = captured.at(-1)
process.stdout.write(`url    : ${seen?.url}\n`)
process.stdout.write(`ok     : ${result.ok}${result.ok ? '' : ` status=${result.status} kind=${result.kind} msg=${String(result.message).slice(0, 120)}`}\n`)
process.stdout.write('headers the plugin actually sent:\n')
for (const [name, value] of Object.entries(seen?.headers ?? {})) {
  const shown = /authorization/i.test(name) ? '<redacted>' : String(value).length > 70 ? `${String(value).slice(0, 70)}…` : String(value)
  process.stdout.write(`  ${name}: ${shown}\n`)
}
if (result.ok) await result.response.text().catch(() => undefined)
