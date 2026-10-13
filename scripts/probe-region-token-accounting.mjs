#!/usr/bin/env node
/**
 * Measure how a region's gateway COUNTS a prompt (issue #59).
 *
 * Issue #59 reports a long session whose prompt the CN gateway called ~708K
 * tokens and the international gateway called ~1.374M — the same history,
 * ≈1.94× apart, which turns a switch to international into an instant
 * `code 11115 prompt is too long`. Two worlds explain that, and they have
 * opposite owners:
 *
 *   - the gateways count identical bytes differently (upstream's business); or
 *   - the gateways count identically and the gap came from what was SENT, or
 *     from which part of the prompt each one reports (ours to fix).
 *
 * This probe separates them with two measurements on ONE byte-identical English
 * filler, so neither language nor content differences can produce the answer:
 *
 *   1. `tokens_per_1k_chars` — a cheap cross-region comparability figure. Run
 *      the same `--chars` in both regions and compare; a ratio near 1.0 means
 *      the counters agree on identical bytes.
 *   2. the CACHE CONVENTION — whether `prompt_tokens` INCLUDES the cached
 *      portion. Turn 1 sends the prefix to warm the cache; turns 2..N send the
 *      byte-identical prefix again, and the upstream's own `prompt_cache_hit_tokens`
 *      / `prompt_cache_miss_tokens` say which accounting it uses:
 *        - hit + miss === prompt_tokens  → OpenAI convention (cached is a SUBSET;
 *          pi-ai's `input = prompt - cacheRead` is arithmetically right);
 *        - prompt_tokens === miss alone  → Anthropic convention (cached sits
 *          OUTSIDE prompt_tokens; anything anchoring on prompt_tokens sees only
 *          the uncached remainder and therefore UNDERSTATES the real context).
 *      The second case is a live candidate for #59: a warm long session would
 *      report a prompt far smaller than the bytes actually sent, so a host that
 *      anchors compaction on it never compacts — and the other region, counting
 *      the whole thing, answers 11115.
 *
 * It walks the region's accounts and reports every failure per account, because
 * the first credential a region resolves is often the one that is rate-limited
 * or out of credits (measured 2026-10-14: the CN default answered 6004, all
 * three international accounts answered 14018).
 *
 * READ-ONLY w.r.t. account state, but it DOES spend credits: `--turns`
 * completions of a few tokens over an ~2.6K-token prompt. Account names are
 * masked to their first 8 characters; no token material is printed.
 *
 * Usage:
 *   node scripts/probe-region-token-accounting.mjs --region cn --model deepseek-v4.1-flash
 *   node scripts/probe-region-token-accounting.mjs --region global --model deepseek-v4.1-flash-sg
 *   node scripts/probe-region-token-accounting.mjs --region cn --model glm-5.2 --turns 4
 */

import { WorkBuddyCredentialStore, WorkBuddyUpstreamClient, prepareChatBody } from '../lib/index.js'

const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 || index + 1 >= argv.length ? fallback : argv[index + 1]
}

const REGION = value('--region', 'cn')
const MODEL = value('--model', undefined)
const CHARS = Number.parseInt(value('--chars', '12000'), 10)
const TURNS = Number.parseInt(value('--turns', '2'), 10)
const MAX_TOKENS = Number.parseInt(value('--max-tokens', '8'), 10)
const MAX_ACCOUNTS = Number.parseInt(value('--max-accounts', '10'), 10)

/**
 * Deterministic English filler, byte-identical between regions and turns. The
 * sameness is what makes the numbers comparable at all.
 */
const FILLER = 'The quick brown fox jumps over the lazy dog. Prometheus bound the cache key to the prefix. '
const PREFIX = FILLER.repeat(Math.ceil(CHARS / FILLER.length)).slice(0, CHARS)
const SUFFIX = ' Reply with exactly: OK'

/** Split an SSE body into decoded `data:` payloads. */
function decodeSse(text) {
  const payloads = []
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (raw === '' || raw === '[DONE]') continue
      try {
        payloads.push(JSON.parse(raw))
      } catch {
        // Keepalive/comment lines are never usage events.
      }
    }
  }
  return payloads
}

/** The terminal usage object: the one carrying `prompt_tokens`. */
function findUsage(text) {
  for (const payload of decodeSse(text).reverse()) {
    const usage = payload?.['usage']
    if (typeof usage === 'object' && usage !== null && typeof usage['prompt_tokens'] === 'number') return usage
  }
  return undefined
}

/** Mask a display name: enough to tell accounts apart, not enough to leak one. */
function mask(name) {
  if (typeof name !== 'string' || name === '') return '(unnamed)'
  return name.length <= 8 ? name : `${name.slice(0, 8)}…`
}

/** Send one turn and return either its usage object or the upstream failure. */
async function send(client, credential, modelId, content) {
  const body = prepareChatBody(JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: MAX_TOKENS,
  }))
  let result
  try {
    result = await client.chatStream(credential, body, AbortSignal.timeout(120_000))
  } catch (error) {
    return { failure: `transport error ${String(error)}` }
  }
  if (!result.ok) {
    return { failure: `kind=${result.kind} status=${result.status} ${result.message.slice(0, 160)}` }
  }
  const usage = findUsage(await result.response.text())
  return usage === undefined ? { failure: 'ok but no usage block' } : { usage }
}

const client = new WorkBuddyUpstreamClient()
const store = new WorkBuddyCredentialStore({ refresh: c => client.refreshToken(c), region: REGION })

process.stdout.write(`region  : ${REGION}\n`)
process.stdout.write(`prompt  : prefix ${PREFIX.length} chars, byte-identical across regions and turns\n`)
process.stdout.write(`turns   : ${TURNS} (turn 1 warms the cache, 2..N re-send the same prefix + suffix)\n`)
process.stdout.write(`tokens  : max_tokens=${MAX_TOKENS}\n\n`)

const accounts = await store.accounts()
process.stdout.write(`accounts: ${accounts.length} signed in for this region\n\n`)

if (accounts.length === 0) {
  process.stdout.write('no account for this region; nothing to measure\n')
  process.exitCode = 1
} else {
  const firstCredential = await store.credentialFor(accounts[0].id)
  const models = firstCredential === undefined ? [] : await client.fetchModels(firstCredential)
  const modelId = MODEL ?? models[0]?.id
  if (modelId === undefined) {
    process.stdout.write('model catalog is empty; cannot probe\n')
    process.exitCode = 1
  } else {
    process.stdout.write(`model   : ${modelId}\n\n`)

    /** The first account that completes turn 1 owns the rest of the run. */
    let chosen
    for (const account of accounts.slice(0, MAX_ACCOUNTS)) {
      const credential = await store.credentialFor(account.id)
      if (credential === undefined) {
        process.stdout.write(`- ${mask(account.accountName)}: no readable credential\n`)
        continue
      }
      const answer = await send(client, credential, modelId, PREFIX)
      if (answer.usage === undefined) {
        process.stdout.write(`- ${mask(account.accountName)}: ${answer.failure}\n`)
        continue
      }
      process.stdout.write(`- ${mask(account.accountName)}: answered turn 1\n\n`)
      chosen = { account, credential, first: answer.usage }
      break
    }

    if (chosen === undefined) {
      process.stdout.write('\nno account in this region answered; nothing measurable from here\n')
      process.exitCode = 1
    } else {
      const rows = [{ turn: 1, warming: true, usage: chosen.first }]
      const probePrompt = `${PREFIX}${SUFFIX}`
      for (let turn = 2; turn <= TURNS; turn += 1) {
        const answer = await send(client, chosen.credential, modelId, probePrompt)
        if (answer.usage === undefined) {
          process.stdout.write(`turn ${turn}: ${answer.failure}\n`)
          break
        }
        rows.push({ turn, warming: false, usage: answer.usage })
      }

      process.stdout.write(`account : ${mask(chosen.account.accountName)}\n`)
      process.stdout.write(`model   : ${modelId}\n\n`)
      for (const row of rows) {
        const usage = row.usage
        const prompt = usage['prompt_tokens']
        const hit = usage['prompt_cache_hit_tokens']
        const miss = usage['prompt_cache_miss_tokens']
        const cached = usage['prompt_tokens_details']?.['cached_tokens'] ?? usage['cached_tokens']
        process.stdout.write(`turn ${row.turn}${row.warming ? ' (warm only)' : ''}: prompt_tokens=${prompt}`)
        if (typeof hit === 'number') process.stdout.write(` hit=${hit}`)
        if (typeof miss === 'number') process.stdout.write(` miss=${miss}`)
        if (typeof cached === 'number' && cached !== 0) process.stdout.write(` cached_tokens=${cached}`)
        process.stdout.write(` credit=${usage['credit'] ?? '(none)'}\n`)
        if (row.warming) process.stdout.write(`  raw: ${JSON.stringify(usage)}\n`)
      }

      const first = rows[0].usage
      const identical = rows.filter(row => !row.warming)
      process.stdout.write('\n===== result =====\n')
      process.stdout.write(`region=${REGION} model=${modelId} chars=${PREFIX.length + SUFFIX.length}`)
      process.stdout.write(` prompt_tokens=${first['prompt_tokens']}`)
      process.stdout.write(` tokens_per_1k_chars=${(first['prompt_tokens'] / (PREFIX.length + SUFFIX.length) * 1000).toFixed(2)}\n`)

      if (identical.length === 0) {
        process.stdout.write('cache convention: not measurable (no identical-prompt turn completed)\n')
      } else {
        const usable = identical.filter(row => typeof row.usage['prompt_cache_hit_tokens'] === 'number'
          && typeof row.usage['prompt_cache_miss_tokens'] === 'number')
        const partitioned = usable.length > 0 && usable.every(row => row.usage['prompt_cache_hit_tokens'] + row.usage['prompt_cache_miss_tokens'] === row.usage['prompt_tokens'])
        const missOnly = usable.length > 0 && usable.every(row => row.usage['prompt_cache_hit_tokens'] > 0
          && row.usage['prompt_cache_miss_tokens'] === row.usage['prompt_tokens'])
        process.stdout.write(`cache convention: ${partitioned ? 'OpenAI (prompt_tokens INCLUDES cached)' : missOnly ? 'ANTHROPIC (prompt_tokens EXCLUDES cached)' : 'inconclusive'}\n`)
        if (missOnly) {
          process.stdout.write('  => a warm long session reports only the UNCACHED remainder, so anything\n')
          process.stdout.write('     anchoring on prompt_tokens understates the real context.\n')
        }
      }
    }
  }
}
