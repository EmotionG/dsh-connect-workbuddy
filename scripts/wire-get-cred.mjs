#!/usr/bin/env node
/**
 * Print the SHAPE of the live WorkBuddy credential (never the secret values).
 *
 * Purpose: confirm this machine can open the desktop app's encrypted auth
 * document, so a wire probe can use the same token the plugin and the app use.
 */
import { readAtRestKey } from '../lib/index.js'
import { defaultDesktopAuthCandidates, parseWorkBuddyAuth, hasEncryptedCredentialFields } from '../lib/index.js'
import { readFile } from 'node:fs/promises'

const candidates = defaultDesktopAuthCandidates()
process.stdout.write(`auth candidates (${candidates.length}):\n`)
for (const path of candidates) process.stdout.write(`  ${path}\n`)

let key
try {
  key = await readAtRestKey()
  process.stdout.write(`at-rest key: ${key === undefined ? 'NOT AVAILABLE' : `obtained (${key.length} bytes)`}\n`)
} catch (error) {
  process.stdout.write(`at-rest key: ERROR ${String(error).slice(0, 200)}\n`)
}

for (const path of candidates) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    continue
  }
  const encrypted = hasEncryptedCredentialFields(text)
  const credential = parseWorkBuddyAuth(text, path, key)
  process.stdout.write(`\n${path}\n  encrypted fields: ${encrypted}\n`)
  if (credential === undefined) {
    process.stdout.write('  credential: UNREADABLE\n')
    continue
  }
  process.stdout.write(
    `  credential: uid=${credential.uid} enterpriseId=${JSON.stringify(credential.enterpriseId ?? null)} `
    + `domain=${credential.domain} accessToken.len=${credential.accessToken.length} `
    + `refreshToken.len=${credential.refreshToken?.length ?? 0}\n`,
  )
}
