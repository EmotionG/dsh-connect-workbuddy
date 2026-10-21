/**
 * The card copy has FOUR homes, and the host reads three of them:
 *
 * 1. `locale/en.json` + `locale/zh.json` — what the DSH plugin manager shows on
 *    the Plugins page. `readPluginMeta()` (`@deepseek-ai/dsh-app-boot`) resolves
 *    `<pkg>/locale/en.json` through the Node resolver, then scans THAT file's
 *    directory for the other language files, and reads `meta.title` /
 *    `meta.description` out of each.
 * 2. `package.json` `description` — the English fallback used when the locale
 *    dictionary could not be read at all.
 * 3. `awesome-dsh-plugin-submission/<owner>__<repo>.yml` — the marketplace
 *    listing's own copy of the same sentence.
 *
 * None of the three fails loudly when it drifts. A missing locale resource is
 * swallowed by the host as "no localized metadata": the title then falls back to
 * the bare package name (`displayName` is never read) and the description to
 * `package.json`. A card can therefore read "dsh-connect-workbuddy" with a
 * Chinese description inside an English UI and still look like a working
 * plugin — which is exactly what this repository looked like before this
 * directory existed.
 *
 * The cases below pin the contract that makes the card correct:
 *
 *   1. `locale/en.json` is the ANCHOR. The host scans the directory of the
 *      resolved English file, so without it `zh.json` is never read at all.
 *   2. The exports wildcard `"./locale/*.json"` is what lets the host RESOLVE
 *      that file; without it the resolution throws
 *      `ERR_PACKAGE_PATH_NOT_EXPORTED`, which the host also swallows.
 *   3. `files` must carry the bare `locale` directory, or the published
 *      tarball ships the package without its own copy.
 *   4. The three copies of the sentence must say the same thing: the English
 *      fallback, the card dictionary and the marketplace draft.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../', import.meta.url)

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, repoRoot)), 'utf8')
}

interface Manifest {
  name: string
  description?: string
  exports?: Record<string, unknown>
  files?: string[]
  repository?: { url?: string }
}

function manifest(): Manifest {
  return JSON.parse(read('package.json')) as Manifest
}

interface Meta {
  title?: string
  description?: string
}

/** The `meta` object of one locale file, as the host reads it. */
function metaOf(language: string): Meta {
  const parsed = JSON.parse(read(`locale/${language}.json`)) as { meta?: Meta }
  return parsed.meta ?? {}
}

/**
 * A locale file's name is its language id — the host takes the basename minus
 * `.json` and rejects anything that is not a language id.
 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/

/** Strips one layer of YAML quoting; a plain scalar is returned as it is. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"')
  }
  return value
}

/**
 * The two descriptions of the marketplace draft.
 *
 * Read line by line rather than with a YAML parser: the draft is a flat
 * top-level mapping plus a two-line `description` block, and the repository
 * deliberately carries no YAML dependency. A regex over the whole file would
 * also match the `en:`/`zh:` inside a quoted value.
 */
function draftDescriptions(text: string): { en?: string; zh?: string } {
  const result: { en?: string; zh?: string } = {}
  let insideDescription = false
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    if (!/^\s/.test(raw)) {
      // A top-level key ends the description block.
      insideDescription = /^description:\s*$/.test(raw.trim())
      continue
    }
    if (!insideDescription) continue
    const match = /^\s+(en|zh):\s*(.*)$/.exec(raw)
    if (match === null) continue
    const [, language, value] = match
    if (language === undefined || value === undefined) continue
    result[language as 'en' | 'zh'] = unquote(value.trim())
  }
  return result
}

describe('locale metadata', () => {
  it('ships an English locale file, which is the anchor the host scans', () => {
    // The host resolves `<pkg>/locale/en.json` and then scans ITS directory.
    // Without this file there is no directory to scan, so `zh.json` would be
    // dead weight no matter how correct it is.
    expect(read('locale/en.json')).toBeTruthy()
    const files = readdirSync(fileURLToPath(new URL('locale', repoRoot)))
    expect(files).toContain('en.json')
  })

  it('gives every locale file a language id as its filename', () => {
    // The host throws on a file whose basename is not a language id, and that
    // error takes the whole card down — one stray `locale/notes.json` is
    // enough.
    const files = readdirSync(fileURLToPath(new URL('locale', repoRoot)))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(file.endsWith('.json')).toBe(true)
      const language = file.slice(0, -'.json'.length)
      expect(language).toMatch(LANGUAGE_ID)
    }
  })

  it('carries a non-empty title and description in every locale', () => {
    for (const language of ['en', 'zh']) {
      const meta = metaOf(language)
      expect(typeof meta.title).toBe('string')
      expect(meta.title?.trim()).not.toBe('')
      expect(typeof meta.description).toBe('string')
      expect(meta.description?.trim()).not.toBe('')
    }
  })

  it('titles the card instead of letting it fall back to the package name', () => {
    // `displayName` is not part of the read chain: without `meta.title` the
    // card shows the bare package name.
    const { name } = manifest()
    expect(metaOf('en').title).not.toBe(name)
    expect(metaOf('zh').title).not.toBe(name)
    // Two languages, two titles — one shared string would mean one of them is
    // showing the other language's name.
    expect(metaOf('en').title).not.toBe(metaOf('zh').title)
  })

  it('keeps the Chinese copy Chinese and the English copy English', () => {
    const han = /\p{Script=Han}/u
    expect(han.test(metaOf('zh').description ?? '')).toBe(true)
    expect(han.test(metaOf('en').description ?? '')).toBe(false)
  })

  it('exports the locale directory so the host can resolve it', () => {
    // Without this wildcard the resolution throws
    // `ERR_PACKAGE_PATH_NOT_EXPORTED` — and the host treats that as "no
    // localized metadata", so the card silently stays untranslated.
    const { exports: exported } = manifest()
    expect(exported?.['./locale/*.json']).toBe('./locale/*.json')
  })

  it('publishes the locale directory with the package', () => {
    // The bare directory name, not a glob: `files` entries are read as paths,
    // and a pattern is not a path.
    const { files } = manifest()
    expect(files).toContain('locale')
  })

  it('keeps the English fallback and the card dictionary in step', () => {
    // `package.json.description` is what an English UI falls back to when the
    // dictionary could not be read; it must not say something different.
    expect(manifest().description).toBe(metaOf('en').description)
  })

  it('keeps the marketplace draft and the card in step', () => {
    const { repository } = manifest()
    const url = (repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
    const slug = url.replace(/^https:\/\/github\.com\//, '')
    const draft = read(`awesome-dsh-plugin-submission/${slug.replace('/', '__')}.yml`)
    const descriptions = draftDescriptions(draft)
    expect(descriptions.en).toBe(metaOf('en').description)
    expect(descriptions.zh).toBe(metaOf('zh').description)
  })
})
