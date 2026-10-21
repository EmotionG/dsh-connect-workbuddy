/**
 * One bridged CodeBuddy turn, and the credential walk around it.
 *
 * This is the escape hatch for the channel gate: the request is made BY the
 * CodeBuddy CLI that is already signed in on this machine, so there is no
 * system prompt to disguise and no identity to forge. When the provider route
 * is refused (`channel_reject` / 11128) or an account is restricted (11140),
 * this route keeps working because nothing about it pretends to be something
 * else.
 *
 * Two decisions in here are load-bearing and easy to undo by accident:
 *
 * 1. **The prompt travels on stdin, never on argv.** It is written as one
 *    `stream-json` user message. Passing it as an argument would put arbitrary
 *    text through a shell on Windows (the `.cmd` shim requires one), where `&`,
 *    `|`, `>` and backticks stop being prose. Nothing a user types should be
 *    able to become a command.
 *
 * 2. **The CLI entry is executed directly, not through its shim.** The shim is
 *    a one-line forwarder to `node <pkg>/bin/codebuddy`, so running the entry
 *    with `process.execPath` removes the shell from the picture entirely. The
 *    shim remains only as a fallback for installs where the package cannot be
 *    located, and that is the only path that sets `shell: true`.
 *
 * @module dsh-connect-workbuddy/cli-bridge/runner
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One credential the bridge may use, already resolved from the vault. */
export interface BridgeCredential {
  token: string
  /** Human-readable origin, used only in log lines. Never the token itself. */
  source: string
  region: string
  /** Past `expiresAtMs`. Tried anyway, last: the field is not trustworthy. */
  expired: boolean
}

/** Everything one turn needs. Built per call, never cached. */
export interface TurnOptions {
  prompt: string
  cwd: string
  /** Explicit CLI entry from config; `''` means auto-detect. */
  binary: string
  model: string
  permissionMode: string
  effort: string
  maxTurns: number
  timeoutMs: number
  appendSystemPrompt: string
  /** Continue this CLI session instead of starting a fresh one. */
  sessionId?: string
  /** Continue the most recent session for this working directory. */
  continueSession?: boolean
  signal?: AbortSignal
}

/** What the CLI actually did, after one successful turn. */
export interface TurnOutcome {
  text: string
  toolCounts: Map<string, number>
  sessionId: string | undefined
  usage: UsageCounts | undefined
  numTurns: number | undefined
  isError: boolean
  errors: readonly string[]
  subtype: string | undefined
  stderr: string
}

/** The CLI's own token accounting for the turn. */
export interface UsageCounts {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** The settled answer of a whole bridged call. */
export interface AgentOutcome {
  ok: boolean
  text: string
  toolCounts: Map<string, number>
  sessionId: string | undefined
  usage: UsageCounts | undefined
  numTurns: number | undefined
  credential: BridgeCredential
  elapsedMs: number
  error: string | undefined
}

/**
 * Paths a global npm install of the CLI can live at, most likely first.
 *
 * `APPDATA` is read before `homedir()` because a redirected profile puts the
 * npm prefix somewhere else entirely, and the AppData path is the one the
 * installer actually used.
 */
function cliEntryCandidates(): readonly string[] {
  const out: string[] = []
  const appData = process.env['APPDATA']
  if (typeof appData === 'string' && appData !== '') {
    out.push(join(appData, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'))
  }
  out.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'))
  out.push('/usr/local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy')
  out.push('/usr/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy')
  return out
}

/**
 * Locate the CLI's JS entry.
 *
 * An explicit `binary` from config wins and is taken literally — never
 * second-guessed with a fallback, because a typo answered by a different
 * working executable is a bug nobody can reproduce.
 */
export function resolveCliEntry(binary: string): { entry: string | undefined; configured: boolean } {
  if (binary !== '') return { entry: binary, configured: true }
  for (const candidate of cliEntryCandidates()) {
    if (existsSync(candidate)) return { entry: candidate, configured: false }
  }
  return { entry: undefined, configured: false }
}

/**
 * Whether a finished-but-failed run failed specifically because the credential
 * was refused.
 *
 * Only then is trying the next credential meaningful; retrying a 429 or a real
 * model error on the next token just burns another turn.
 */
export function looksLikeAuthFailure(out: TurnOutcome): boolean {
  if (!out.isError) return false
  const text = `${out.errors.join('\n')}\n${out.text}`
  return /\b401\b|Authentication required|\/login command/i.test(text)
}

/** Shape of one NDJSON frame, as far as this module cares. */
interface CliFrame {
  type?: string
  message?: { content?: unknown }
  content?: unknown
  session_id?: string
  usage?: UsageCounts
  num_turns?: number
  is_error?: boolean
  errors?: unknown
  errors_info?: unknown
  subtype?: string
}

/** One content block inside an assistant frame. */
interface ContentBlock {
  type?: string
  text?: string
  name?: string
}

function blocksOf(frame: CliFrame): readonly ContentBlock[] {
  const fromMessage = frame.message?.content
  if (Array.isArray(fromMessage)) return fromMessage as readonly ContentBlock[]
  const topLevel = frame.content
  if (Array.isArray(topLevel)) return topLevel as readonly ContentBlock[]
  return []
}

/**
 * Run exactly one CLI turn with exactly one token.
 *
 * Resolves on the terminal `result` frame rather than on process exit, so a slow
 * teardown cannot hang the caller. Rejects only when no turn completed at all.
 */
function runOneTurn(options: TurnOptions, token: string): Promise<TurnOutcome> {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(options.maxTurns),
    '--permission-mode', options.permissionMode,
  ]
  if (options.model !== '') args.push('--model', options.model)
  if (options.effort !== '') args.push('--effort', options.effort)
  if (options.appendSystemPrompt !== '') args.push('--append-system-prompt', options.appendSystemPrompt)
  if (options.sessionId !== undefined && options.sessionId !== '') args.push('--session-id', options.sessionId)
  if (options.continueSession === true) args.push('--continue')

  const env = {
    ...process.env,
    CODEBUDDY_AUTH_TOKEN: token,
    // A single-shot `-p` turn cannot receive background task events, so the
    // background variants are removed from the tool schema entirely.
    CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
  }

  const { entry } = resolveCliEntry(options.binary)
  const useShim = entry === undefined
  const command = useShim ? (process.platform === 'win32' ? 'codebuddy.cmd' : 'codebuddy') : process.execPath
  const commandArgs = useShim ? args : [entry, ...args]

  return new Promise<TurnOutcome>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env,
      shell: useShim && process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let settled = false
    const assistantText: string[] = []
    const toolCounts = new Map<string, number>()
    let stderr = ''
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    const onAbort = (): void => {
      fail(new Error('cancelled by the host'))
    }

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        child.kill()
      } catch {
        // Already gone; the rejection is what matters.
      }
      reject(error)
    }

    const settle = (frame: CliFrame): void => {
      if (settled) return
      settled = true
      cleanup()
      const errors = Array.isArray(frame.errors)
        ? frame.errors.filter((value): value is string => typeof value === 'string')
        : []
      resolve({
        text: assistantText.join('\n').trim(),
        toolCounts,
        sessionId: typeof frame.session_id === 'string' ? frame.session_id : undefined,
        usage: frame.usage,
        numTurns: typeof frame.num_turns === 'number' ? frame.num_turns : undefined,
        isError: frame.is_error === true,
        errors,
        subtype: typeof frame.subtype === 'string' ? frame.subtype : undefined,
        stderr,
      })
    }

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        fail(new Error('cancelled by the host'))
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      fail(new Error(`codebuddy exceeded its ${Math.round(options.timeoutMs / 1000)}s budget`))
    }, options.timeoutMs)

    // The CLI may close stdin before the write drains; the result frame is what
    // matters, so a broken pipe here is noise rather than a failure.
    child.stdin.on('error', () => {})
    child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: options.prompt }] },
      })}\n`,
    )
    child.stdin.end()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      // stream-json is NDJSON; the trailing partial line stays in the buffer.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let frame: CliFrame
        try {
          frame = JSON.parse(trimmed) as CliFrame
        } catch {
          continue // a non-JSON line is noise, not a fatal error
        }
        // An assistant turn arrives as {type:'assistant', message:{content:[…]}};
        // some builds put the blocks at the top level, so accept both.
        if (frame.type === 'assistant') {
          for (const block of blocksOf(frame)) {
            if (block.type === 'text' && typeof block.text === 'string') {
              assistantText.push(block.text)
            } else if (block.type === 'tool_use' && typeof block.name === 'string') {
              toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1)
            }
          }
        }
        if (frame.type === 'result') settle(frame)
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (error: Error) => fail(error))
    child.on('close', (code: number | null) => {
      if (settled) return
      const tail = stderr.trim().split('\n').slice(-6).join('\n')
      fail(
        new Error(
          `codebuddy exited with code ${String(code)} and emitted no result frame` + (tail !== '' ? `\n${tail}` : ''),
        ),
      )
    })
  })
}

/**
 * Run one bridged turn, walking the credential list until a turn completes or
 * the list runs out.
 *
 * A wrong-region token 401s, and the only way to know which region this CLI
 * build targets is to ask it. One wasted turn is cheaper than making the user
 * choose a region they have no way to know.
 */
export async function runAgent(
  options: TurnOptions,
  credentials: readonly BridgeCredential[],
  log: (message: string) => void,
): Promise<AgentOutcome> {
  const startedAt = Date.now()
  let lastError: Error | undefined

  for (let index = 0; index < credentials.length; index += 1) {
    const candidate = credentials[index]
    if (candidate === undefined) continue
    if (candidate.expired) {
      log(`${candidate.source} is past its expiry; trying it anyway`)
    }

    let out: TurnOutcome
    try {
      out = await runOneTurn(options, candidate.token)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      // A cancellation is the caller's decision, not a credential problem:
      // walking the rest of the list would run the turn again after the host
      // asked us to stop.
      if (/cancelled by the host/.test(lastError.message)) throw lastError
      continue
    }

    const isLast = index === credentials.length - 1
    if (looksLikeAuthFailure(out) && !isLast) {
      log(`${candidate.source} was refused (401); trying the next credential`)
      lastError = new Error(out.errors[0] ?? '401')
      continue
    }

    return {
      ok: !out.isError,
      text: out.text,
      toolCounts: out.toolCounts,
      sessionId: out.sessionId,
      usage: out.usage,
      numTurns: out.numTurns,
      credential: candidate,
      elapsedMs: Date.now() - startedAt,
      error: out.isError
        ? (out.errors.join('\n') || out.subtype || 'the turn reported an error')
        : undefined,
    }
  }

  throw lastError ?? new Error('no credential worked')
}
