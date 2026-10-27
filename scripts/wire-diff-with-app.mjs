#!/usr/bin/env node
/**
 * The one comparison that matters: plugin output vs. the app's own capture.
 *
 * Everything else in this directory measured the GATEWAY's tolerance. This
 * diffs the header set the plugin now sends against the header set the installed
 * WorkBuddy app sends, so a divergence is named instead of assumed away.
 *
 * The app's set comes from its bundle (`cli/dist/codebuddy-lite-wb.mjs`,
 * `applyGatewayHeaders` + the CLI's `getCustomHeaders`) plus its own logs.
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
  process.exit(1)
}

const realFetch = globalThis.fetch
const captured = []
globalThis.fetch = (url, init) => {
  captured.push({ headers: { ...init?.headers } })
  return new Response('data: [DONE]\n\n', { status: 200 })
}
await new WorkBuddyUpstreamClient(undefined, { wireIdentity: true })
  .chatStream(credential, JSON.stringify({ model: 'hy3', messages: [] }))
  .catch(() => undefined)
globalThis.fetch = realFetch

const plugin = new Map(
  Object.entries(captured.at(-1)?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]),
)

/**
 * What the app sends, lower-cased, with volatile values reduced to a shape so
 * the diff is about WHICH headers exist, not about random ids.
 */
const app = {
  'accept': 'application/json',
  'content-type': 'application/json',
  'authorization': '<bearer>',
  'x-requested-with': 'XMLHttpRequest',
  'x-conversation-id': '<uuidv7-32hex>',
  'x-conversation-request-id': '<uuidv7-32hex>',
  'x-conversation-message-id': '<uuidv7-32hex>',
  'x-request-id': '<= message-id>',
  'x-agent-intent': 'craft',
  'x-agent-purpose': '<purpose>',
  'x-ide-type': '<ideType>',
  'x-ide-name': '<ideName>',
  'x-ide-version': '<ideVersion>',
  'x-private-data': '<false|true>',
  'x-codebuddy-request': '1',
  'x-product': '<deploymentType||SaaS>',
  'x-user-id': '<uid>',
  'x-domain': '<domain>',
  'traceparent': '<w3c>',
  'b3': '<b3>',
  'x-b3-traceid': '<hex>',
  'x-b3-parentspanid': '<hex>',
  'x-b3-spanid': '<hex>',
  'x-b3-sampled': '1',
  'x-trace-id': '<hex>',
  'x-department-info': '<dept||empty>',
}

const shapeOf = (name, value) => {
  if (name === 'authorization') return '<bearer>'
  if (/^x-(conversation|request)-/.test(name)) return '<id>'
  if (name === 'traceparent') return '<w3c>'
  if (/^(b3|x-b3-|x-trace)/.test(name)) return '<trace>'
  return value
}

const rows = []
const allNames = new Set([...Object.keys(app), ...plugin.keys()])
for (const name of [...allNames].sort()) {
  const inApp = name in app
  const inPlugin = plugin.has(name)
  const pluginShape = inPlugin ? shapeOf(name, plugin.get(name)) : ''
  const appShape = inApp ? app[name] : ''
  const same = inApp && inPlugin
    ? (appShape.startsWith('<') || pluginShape === appShape)
    : false
  rows.push({ name, inApp, inPlugin, pluginShape, appShape, same })
}

const label = (row) => {
  if (row.inApp && row.inPlugin) return row.same ? 'both     ' : 'both (val)'
  if (row.inApp) return 'app only '
  return 'PLUGIN + '
}
process.stdout.write('header                        where       plugin value\n')
for (const row of rows) {
  process.stdout.write(
    `${row.name.padEnd(28)}  ${label(row)}  ${row.pluginShape.slice(0, 60)}\n`,
  )
}
const onlyPlugin = rows.filter(r => r.inPlugin && !r.inApp)
const onlyApp = rows.filter(r => r.inApp && !r.inPlugin)
process.stdout.write(`\nsent by plugin but not the app (${onlyPlugin.length}): ${onlyPlugin.map(r => r.name).join(', ') || '(none)'}\n`)
process.stdout.write(`sent by the app but not the plugin (${onlyApp.length}): ${onlyApp.map(r => r.name).join(', ') || '(none)'}\n`)
