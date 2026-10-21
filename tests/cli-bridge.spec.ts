/**
 * The CLI route: settings, credentials, the working-directory ladder, both
 * host entrances, and the message handed back to the session's model.
 *
 * Why these are tests and not "it works on my machine": the route's whole claim
 * is that it is SAFE TO ADD. Three properties carry that claim and each one is
 * a single line away from being silently false —
 *
 * 1. it is off unless the user turns it on (`enabled`), and it registers
 *    NOTHING when it is off or when the Host publishes no tools/commands;
 * 2. it never picks a directory on the user's behalf (an agent that can edit
 *    files must not be pointed at a tree nobody chose);
 * 3. its tool schema stays inside the Host's CLOSED JSON-Schema subset — a
 *    single array-typed `type` makes `apply()` throw and the WHOLE plugin stop
 *    loading, which is a failure mode with no visible cause.
 *
 * Every one of those is asserted below rather than described.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLI_BRIDGE_DEFAULTS,
  mountCliBridge,
  normalizeCliBridgeOptions,
} from '../src/cli-bridge/mount.ts'
import type { CliBridgeSettings } from '../src/cli-bridge/mount.ts'
import { AUTH_TOKEN_ENV, resolveCredentials } from '../src/cli-bridge/credentials.ts'
import type { BridgeCredentialRegion } from '../src/cli-bridge/credentials.ts'
import {
  COMMAND_NAME,
  commandScopeLabel,
  composeCommandPrompt,
  formatCommandOutcome,
  isReviewInvocation,
  mountCodebuddyCommand,
} from '../src/cli-bridge/command.ts'
import { composeContinuation, formatInjection, injectOutcome, INJECT_TEXT_LIMIT } from '../src/cli-bridge/inject.ts'
import type { BridgeAgent } from '../src/cli-bridge/inject.ts'
import type { BridgeCommandDefinition, BridgeToolDefinition } from '../src/cli-bridge/services.ts'
import {
  EFFORT_LEVELS,
  MAX_REPLY_CHARS_CAP,
  MAX_TURNS_CAP,
  PERMISSION_MODES,
  TIMEOUT_SECS_CAP,
  mountAskTool,
  resolveWorkingDir,
  runAsk,
} from '../src/cli-bridge/tool.ts'
import type { AskResult, BridgeOptions } from '../src/cli-bridge/tool.ts'

/** A fully-defaulted options object, so each test names only what it changes. */
function options(overrides: Partial<BridgeOptions> = {}): BridgeOptions {
  return {
    enabled: true,
    binary: '',
    model: '',
    permissionMode: 'acceptEdits',
    effort: '',
    maxTurns: 10,
    timeoutSecs: 900,
    regionOrder: ['cn', 'global'],
    workingDir: '',
    appendSystemPrompt: '',
    allowUnattended: false,
    maxReplyChars: 60_000,
    injectResult: true,
    ...overrides,
  }
}

/** A store that answers from a literal table, so ordering is observable. */
function region(regionName: string, accounts: ReadonlyArray<{ id: string, expiresAtMs: number }>): BridgeCredentialRegion {
  return {
    region: regionName,
    store: {
      async accounts() {
        return accounts.map(account => ({ id: account.id, tokenExpiresAtMs: account.expiresAtMs }))
      },
      async credentialFor(accountId: string) {
        const found = accounts.find(account => account.id === accountId)
        return found === undefined ? undefined : { accessToken: `token-${accountId}`, expiresAtMs: found.expiresAtMs }
      },
    },
  }
}

/** The smallest live agent the injection path touches. */
function agent(status: string | undefined): BridgeAgent & { calls: string[] } {
  const calls: string[] = []
  return {
    ...status === undefined ? {} : { status },
    calls,
    inject() { calls.push('inject') },
    steer() { calls.push('steer') },
  }
}

describe('normalizeCliBridgeOptions', () => {
  it('is OFF when the settings are absent, so an existing install is unchanged', () => {
    const resolved = normalizeCliBridgeOptions(undefined)
    expect(resolved.enabled).toBe(false)
    expect(resolved.permissionMode).toBe(CLI_BRIDGE_DEFAULTS.permissionMode)
    expect(resolved.maxTurns).toBe(CLI_BRIDGE_DEFAULTS.maxTurns)
  })

  it('is OFF for every value except a literal true', () => {
    // A config file is user-editable text. `"enabled": "true"` must not turn on
    // a route that runs a file-editing agent.
    for (const value of ['true', 1, 'yes', null] as unknown[]) {
      expect(normalizeCliBridgeOptions({ enabled: value as boolean }).enabled).toBe(false)
    }
    expect(normalizeCliBridgeOptions({ enabled: true }).enabled).toBe(true)
  })

  it('clamps the turn budget and the wall clock to their hard ceilings', () => {
    const high = normalizeCliBridgeOptions({ maxTurns: 9_999, timeoutSecs: 99_999 })
    expect(high.maxTurns).toBe(MAX_TURNS_CAP)
    expect(high.timeoutSecs).toBe(TIMEOUT_SECS_CAP)
    // Zero and negatives are floored at 1 rather than disabling the bound.
    const low = normalizeCliBridgeOptions({ maxTurns: 0, timeoutSecs: -5 })
    expect(low.maxTurns).toBe(1)
    expect(low.timeoutSecs).toBe(1)
    const capped = normalizeCliBridgeOptions({ maxReplyChars: 10_000_000 })
    expect(capped.maxReplyChars).toBe(MAX_REPLY_CHARS_CAP)
  })

  it('replaces an out-of-range enum with the default AND says so', () => {
    const rejected: string[] = []
    const resolved = normalizeCliBridgeOptions(
      { permissionMode: 'yolo', effort: 'turbo' },
      message => rejected.push(message),
    )
    expect(resolved.permissionMode).toBe(CLI_BRIDGE_DEFAULTS.permissionMode)
    expect(resolved.effort).toBe('')
    // Silently running under a permission level the user did not choose is the
    // failure this guards: a typo must be visible, not absorbed.
    expect(rejected).toHaveLength(2)
    expect(rejected[0]).toContain('yolo')
    expect(rejected[1]).toContain('turbo')
  })

  it('accepts every documented enum value without complaining', () => {
    for (const mode of PERMISSION_MODES) {
      const rejected: string[] = []
      expect(normalizeCliBridgeOptions({ permissionMode: mode }, m => rejected.push(m)).permissionMode).toBe(mode)
      expect(rejected).toEqual([])
    }
    for (const level of EFFORT_LEVELS) {
      const rejected: string[] = []
      expect(normalizeCliBridgeOptions({ effort: level }, m => rejected.push(m)).effort).toBe(level)
      expect(rejected).toEqual([])
    }
  })

  it('turns the region order into a list, dropping blanks', () => {
    expect(normalizeCliBridgeOptions({ regionOrder: ' global , cn ,,' }).regionOrder).toEqual(['global', 'cn'])
    expect(normalizeCliBridgeOptions({ regionOrder: '   ' }).regionOrder).toEqual([])
  })

  it('keeps injection on unless it was explicitly turned off', () => {
    expect(normalizeCliBridgeOptions({}).injectResult).toBe(true)
    expect(normalizeCliBridgeOptions({ injectResult: false }).injectResult).toBe(false)
  })
})

describe('resolveCredentials', () => {
  const original = process.env[AUTH_TOKEN_ENV]
  afterEach(() => {
    if (original === undefined) delete process.env[AUTH_TOKEN_ENV]
    else process.env[AUTH_TOKEN_ENV] = original
  })

  it('lets the environment variable short-circuit the vault', async () => {
    process.env[AUTH_TOKEN_ENV] = '  env-token  '
    const found = await resolveCredentials([region('cn', [{ id: 'a', expiresAtMs: 1 }])], ['cn'], () => {})
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ token: 'env-token', region: 'env' })
  })

  it('ranks REGION before freshness, because a later expiry is not a live token', async () => {
    // The real machine's shape: the global backup claims a later expiry than the
    // domestic sign-in, and the domestic endpoint 401s the global token. Ranking
    // by expiry alone picks the wrong one on every start.
    const found = await resolveCredentials(
      [
        region('global', [{ id: 'g', expiresAtMs: 9_999_999_999_999 }]),
        region('cn', [{ id: 'c', expiresAtMs: 1_000 }]),
      ],
      ['cn', 'global'],
      () => {},
    )
    expect(found.map(credential => credential.region)).toEqual(['cn', 'global'])
  })

  it('sorts within one region by freshness', async () => {
    const found = await resolveCredentials(
      [region('cn', [{ id: 'old', expiresAtMs: 1 }, { id: 'new', expiresAtMs: 2 }])],
      ['cn'],
      () => {},
    )
    expect(found.map(credential => credential.source)).toEqual(['cn 账号 new', 'cn 账号 old'])
  })

  it('keeps an expired token, last, instead of reporting "not signed in"', async () => {
    const found = await resolveCredentials(
      [region('cn', [{ id: 'dead', expiresAtMs: 1 }])],
      ['cn'],
      () => {},
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.expired).toBe(true)
  })

  it('names the fix when nothing is available', async () => {
    delete process.env[AUTH_TOKEN_ENV]
    await expect(resolveCredentials([], ['cn'], () => {})).rejects.toThrow(AUTH_TOKEN_ENV)
  })
})

describe('resolveWorkingDir', () => {
  it('prefers the explicit argument over everything else', () => {
    const choice = resolveWorkingDir({ working_dir: ' C:/repo ' }, options({ workingDir: 'D:/other' }), { cwd: 'E:/host' })
    expect(choice).toMatchObject({ ok: true, dir: 'C:/repo', unattended: false })
  })

  it('uses the Host cwd when the call did not name one', () => {
    expect(resolveWorkingDir({}, options(), { cwd: 'E:/host' })).toMatchObject({ ok: true, dir: 'E:/host' })
  })

  it('falls back to the configured default', () => {
    expect(resolveWorkingDir({}, options({ workingDir: 'D:/configured' }), undefined)).toMatchObject({
      ok: true,
      dir: 'D:/configured',
      unattended: false,
    })
  })

  it('refuses rather than guessing a directory, and names all three ways out', () => {
    const choice = resolveWorkingDir({}, options(), undefined)
    expect(choice.ok).toBe(false)
    expect(choice.dir).toBe('')
    // The message is the user-facing documentation of this failure; each escape
    // hatch has to be discoverable from it.
    expect(choice.reason).toContain('working_dir')
    expect(choice.reason).toContain('allow_unattended')
    expect(choice.reason).toContain('插件配置')
  })

  it('uses a scratch directory only when the caller explicitly allowed it', () => {
    const viaArg = resolveWorkingDir({ allow_unattended: true }, options(), undefined)
    expect(viaArg).toMatchObject({ ok: true, unattended: true })
    expect(viaArg.dir).not.toBe('')

    const viaConfig = resolveWorkingDir({}, options({ allowUnattended: true }), undefined)
    expect(viaConfig).toMatchObject({ ok: true, unattended: true })
  })
})

describe('runAsk argument validation', () => {
  const deps = { options: options(), regions: [] as BridgeCredentialRegion[], log: () => {} }

  it('refuses an empty message before touching the CLI', async () => {
    const value = await runAsk({ message: '   ' }, undefined, deps)
    expect(value.ok).toBe(false)
    expect(value.error).toContain('message')
  })

  it('refuses an unknown permission mode and lists the legal ones', async () => {
    const value = await runAsk({ message: 'x', working_dir: 'C:/repo', permission_mode: 'yolo' }, undefined, deps)
    expect(value.ok).toBe(false)
    expect(value.error).toContain('yolo')
    expect(value.error).toContain('acceptEdits')
  })

  it('refuses an unknown effort level', async () => {
    const value = await runAsk({ message: 'x', working_dir: 'C:/repo', effort: 'turbo' }, undefined, deps)
    expect(value.ok).toBe(false)
    expect(value.error).toContain('turbo')
  })

  it('reports a missing working directory instead of choosing one', async () => {
    const value = await runAsk({ message: 'x' }, undefined, deps)
    expect(value.ok).toBe(false)
    expect(value.error).toContain('working_dir')
  })
})

/** Walk a JSON Schema and return every violation of the Host's closed subset. */
function closedSubsetViolations(schema: unknown, path = '$'): string[] {
  const problems: string[] = []
  if (schema === null || typeof schema !== 'object') return problems
  const node = schema as Record<string, unknown>
  const type = node['type']
  if (type !== undefined && typeof type !== 'string') {
    problems.push(`${path}.type must be a single string, got ${JSON.stringify(type)}`)
  }
  const properties = node['properties']
  if (properties !== undefined && typeof properties === 'object' && properties !== null) {
    const keys = Object.keys(properties as Record<string, unknown>)
    const required = Array.isArray(node['required']) ? (node['required'] as unknown[]) : []
    for (const key of keys) {
      if (!required.includes(key)) problems.push(`${path}.required is missing "${key}"`)
      problems.push(...closedSubsetViolations((properties as Record<string, unknown>)[key], `${path}.${key}`))
    }
    if (node['additionalProperties'] !== false) problems.push(`${path}.additionalProperties must be false`)
  }
  const items = node['items']
  if (items !== undefined) problems.push(...closedSubsetViolations(items, `${path}[]`))
  return problems
}

describe('codebuddy_ask registration', () => {
  /** A tools service that records what it was handed. */
  function capture() {
    const registered: BridgeToolDefinition[] = []
    const disposers: number[] = []
    let disposed = 0
    return {
      registered,
      disposed: () => disposed,
      disposers,
      service: {
        register(definition: BridgeToolDefinition) {
          registered.push(definition)
          return () => { disposed += 1 }
        },
      },
    }
  }

  it('registers one tool whose schema stays inside the Host closed subset', () => {
    const sink = capture()
    const dispose = mountAskTool(sink.service, { options: options(), regions: [], log: () => {} })
    expect(sink.registered).toHaveLength(1)
    const definition = sink.registered[0]!
    expect(definition.name).toBe('codebuddy_ask')
    expect(definition.parameters['required']).toEqual(['message'])
    expect(closedSubsetViolations(definition.output.schema)).toEqual([])
    // The result object is validated against this schema on every call, so a
    // field missing from `required` is a value the Host may drop.
    expect(definition.output.schema['required']).toEqual(
      expect.arrayContaining([
        'ok', 'reply', 'session_id', 'tools', 'tool_calls', 'num_turns', 'tokens_in',
        'tokens_out', 'cache_read_tokens', 'credential_region', 'working_dir',
        'unattended', 'elapsed_ms', 'truncated', 'error',
      ]),
    )
    dispose()
    expect(sink.disposed()).toBe(1)
  })

  it('degrades to a no-op when the Host has no tools service', () => {
    const dispose = mountAskTool(undefined, { options: options(), regions: [], log: () => {} })
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })

  it('renders a failure as text instead of throwing', () => {
    const sink = capture()
    mountAskTool(sink.service, { options: options(), regions: [], log: () => {} })
    const render = sink.registered[0]!.output.render
    const failed = { ok: false, error: 'boom' } as AskResult
    const blocks = render({}, failed) as Array<{ type: string, text: string }>
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain('boom')
  })

  it('renders a success with the accounting footer and the working directory', () => {
    const sink = capture()
    mountAskTool(sink.service, { options: options(), regions: [], log: () => {} })
    const render = sink.registered[0]!.output.render
    const ok = {
      ok: true,
      reply: 'done',
      session_id: 's1',
      tools: [{ name: 'Read', count: 2 }],
      tool_calls: 2,
      num_turns: 3,
      tokens_in: 10,
      tokens_out: 4,
      cache_read_tokens: 8,
      credential_region: 'cn',
      working_dir: 'C:/repo',
      unattended: false,
      elapsed_ms: 1234,
      truncated: false,
      error: '',
    } as AskResult
    const text = (render({}, ok) as Array<{ text: string }>)[0]!.text
    expect(text).toContain('done')
    expect(text).toContain('Read×2')
    expect(text).toContain('dir=C:/repo')
    expect(text).toContain('cred=cn')
  })

  it('warns the caller when the turn ran unattended', () => {
    const sink = capture()
    mountAskTool(sink.service, { options: options(), regions: [], log: () => {} })
    const render = sink.registered[0]!.output.render
    const value = {
      ok: true, reply: 'x', session_id: '', tools: [], tool_calls: 0, num_turns: 0,
      tokens_in: 0, tokens_out: 0, cache_read_tokens: 0, credential_region: 'cn',
      working_dir: 'C:/temp/scratch', unattended: true, elapsed_ms: 1, truncated: false, error: '',
    } as AskResult
    expect((render({}, value) as Array<{ text: string }>)[0]!.text).toContain('临时目录')
  })
})

describe('composeContinuation and injectOutcome', () => {
  it('names CodeBuddy, the directory and the instruction, and warns files may have changed', () => {
    const text = composeContinuation('评审结论：没问题', {
      dir: 'C:/repo',
      scope: '（未提交改动）',
      toolCalls: 3,
      tools: [{ name: 'Read', count: 3 }],
    })
    expect(text).toContain('CodeBuddy')
    expect(text).toContain('C:/repo')
    expect(text).toContain('（未提交改动）')
    expect(text).toContain('Read×3')
    expect(text).toContain('可能已经改动了工作区里的文件')
    // It must NOT pretend the human asked the model to continue: the command was
    // human-to-CodeBuddy.
    expect(text).not.toContain('继续你原来的任务')
  })

  it('omits the optional lines rather than printing empty labels', () => {
    const text = composeContinuation('ok')
    expect(text).not.toContain('工作目录：')
    expect(text).not.toContain('交给它的指令：')
    expect(text).toContain('无')
  })

  it('wakes an idle session and queues onto a running one', () => {
    const idle = agent('idle')
    expect(injectOutcome(idle, { reply: 'done' })).toMatchObject({ ok: true, delivered: 'new-turn', woke: true })
    expect(idle.calls).toEqual(['steer'])

    const running = agent('running')
    expect(injectOutcome(running, { reply: 'done' })).toMatchObject({ ok: true, delivered: 'next-step', woke: false })
    expect(running.calls).toEqual(['inject'])
  })

  it('treats an ABSENT status as running: a parked message is recoverable, a spare turn is not', () => {
    const unknown = agent(undefined)
    expect(injectOutcome(unknown, { reply: 'done' })).toMatchObject({ ok: true, delivered: 'next-step' })
    expect(unknown.calls).toEqual(['inject'])
  })

  it('refuses by name instead of silently doing nothing', () => {
    expect(injectOutcome(undefined, { reply: 'x' })).toMatchObject({ ok: false, code: 'agent-not-live' })
    expect(injectOutcome(agent('idle'), { reply: '   ' })).toMatchObject({ ok: false, code: 'text-required' })
    expect(injectOutcome(agent('idle'), { reply: 'x'.repeat(INJECT_TEXT_LIMIT + 1) })).toMatchObject({
      ok: false,
      code: 'text-too-large',
    })
  })

  it('reports a delivery failure as a named refusal, not an exception', () => {
    const broken: BridgeAgent = {
      status: 'idle',
      inject() { throw new Error('nope') },
      steer() { throw new Error('nope') },
    }
    expect(injectOutcome(broken, { reply: 'x' })).toMatchObject({ ok: false, code: 'inject-failed' })
  })

  it('renders the two delivery outcomes differently, because they are different facts', () => {
    expect(formatInjection({ ok: true, delivered: 'new-turn', woke: true, messageId: 'm' })).toContain('已唤醒')
    expect(formatInjection({ ok: true, delivered: 'next-step', woke: false, messageId: 'm' })).toContain('已排队')
    expect(formatInjection({ ok: false, code: 'agent-not-live', error: 'x' })).toContain('agent-not-live')
  })
})

describe('/codebuddy', () => {
  function captureCommands() {
    const registered: BridgeCommandDefinition[] = []
    let disposed = 0
    return {
      registered,
      disposed: () => disposed,
      service: {
        register(definition: BridgeCommandDefinition) {
          registered.push(definition)
          return () => { disposed += 1 }
        },
      },
    }
  }

  it('turns an empty line into the review brief and leaves typed text alone', () => {
    expect(composeCommandPrompt('')).toContain('未提交的改动')
    expect(composeCommandPrompt('   ')).toContain('未提交的改动')
    // A human who typed something meant it: no brief may be prepended.
    expect(composeCommandPrompt(' 修一下这个空指针 ')).toBe('修一下这个空指针')
  })

  it('labels the scope so the footer says what was asked', () => {
    expect(commandScopeLabel('')).toBe('（未提交改动）')
    expect(commandScopeLabel(' 修 bug ')).toBe('（指令：修 bug）')
  })

  it('detects the review invocation by an empty line only', () => {
    expect(isReviewInvocation('')).toBe(true)
    expect(isReviewInvocation('  ')).toBe(true)
    expect(isReviewInvocation('review')).toBe(false)
  })

  it('registers under the documented name with a hint', () => {
    const sink = captureCommands()
    const dispose = mountCodebuddyCommand(sink.service, {
      options: options(),
      regions: [],
      log: () => {},
      inFlight: new Set<string>(),
    })
    expect(sink.registered[0]?.name).toBe(COMMAND_NAME)
    expect(sink.registered[0]?.input?.hint).toContain('留空')
    dispose()
    expect(sink.disposed()).toBe(1)
  })

  it('degrades to a no-op when the Host has no commands service', () => {
    const dispose = mountCodebuddyCommand(undefined, {
      options: options(),
      regions: [],
      log: () => {},
      inFlight: new Set<string>(),
    })
    expect(() => dispose()).not.toThrow()
  })

  it('refuses when the session carries no workspace path', async () => {
    const sink = captureCommands()
    mountCodebuddyCommand(sink.service, {
      options: options(),
      regions: [],
      log: () => {},
      inFlight: new Set<string>(),
    })
    const result = await sink.registered[0]!.handler({ agent: { id: 's', inject() {}, steer() {} } })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('工作区')
  })

  it('refuses a second concurrent turn on the same session', async () => {
    const sink = captureCommands()
    const inFlight = new Set<string>(['session-1'])
    mountCodebuddyCommand(sink.service, { options: options(), regions: [], log: () => {}, inFlight })
    const result = await sink.registered[0]!.handler({
      agent: { id: 'session-1', session: { header: { cwd: 'C:/repo' } }, inject() {}, steer() {} },
      rawInput: '',
    })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('回合在跑')
  })

  it('renders a failed turn as an error result without touching the model', async () => {
    const sink = captureCommands()
    mountCodebuddyCommand(sink.service, {
      options: options(),
      regions: [],
      log: () => {},
      inFlight: new Set<string>(),
    })
    // No credentials → runAsk fails before spawning anything.
    const agentStub = { id: 'session-2', session: { header: { cwd: 'C:/repo' } }, inject: vi.fn(), steer: vi.fn() }
    const result = await sink.registered[0]!.handler({ agent: agentStub, rawInput: 'do something' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('CodeBuddy 失败')
    expect(agentStub.inject).not.toHaveBeenCalled()
    expect(agentStub.steer).not.toHaveBeenCalled()
  })
})

describe('formatCommandOutcome', () => {
  const base: AskResult = {
    ok: true,
    reply: '结论',
    session_id: 's1',
    tools: [],
    tool_calls: 0,
    num_turns: 2,
    tokens_in: 5,
    tokens_out: 6,
    cache_read_tokens: 4,
    credential_region: 'cn',
    working_dir: 'C:/repo',
    unattended: false,
    elapsed_ms: 900,
    truncated: false,
    error: '',
  }

  it('carries the same footer the tool renders, plus the directory', () => {
    const text = formatCommandOutcome(base, { raw: '' })
    expect(text).toContain('结论')
    expect(text).toContain('（未提交改动）')
    expect(text).toContain('dir=C:/repo')
    expect(text).toContain('turns=2')
  })

  it('adds the delivery line only when a delivery was attempted', () => {
    expect(formatCommandOutcome(base, { raw: '' })).not.toContain('已唤醒')
    const withDelivery = formatCommandOutcome(base, {
      raw: '',
      injection: { ok: true, delivered: 'new-turn', woke: true, messageId: 'm' },
    })
    expect(withDelivery).toContain('已唤醒')
  })

  it('flags a truncated reply so nobody reads the summary as the whole answer', () => {
    expect(formatCommandOutcome({ ...base, truncated: true }, {})).toContain('已截断')
  })

  it('says a failed turn failed, with its reason', () => {
    const text = formatCommandOutcome({ ...base, ok: false, error: 'boom' }, { raw: 'x' })
    expect(text).toContain('失败')
    expect(text).toContain('boom')
  })
})

describe('runner lookups', () => {
  it('takes an explicit CLI path literally instead of second-guessing it', async () => {
    const { resolveCliEntry } = await import('../src/cli-bridge/runner.ts')
    // A typo answered by a different working executable is a bug nobody can
    // reproduce, so an explicit path is never validated or replaced.
    expect(resolveCliEntry('C:/custom/codebuddy')).toEqual({ entry: 'C:/custom/codebuddy', configured: true })
  })

  it('finds nothing when no install exists, rather than inventing a path', async () => {
    const { resolveCliEntry } = await import('../src/cli-bridge/runner.ts')
    // vitest isolates HOME/APPDATA to an empty temp dir, so the home-derived
    // candidates cannot exist here. The two hard-coded POSIX prefixes below
    // are outside that isolation, though, so this asserts the CONTRACT rather
    // than "nothing was found": an auto-detected entry is only ever reported
    // when the file really exists, and it is never `configured`.
    const found = resolveCliEntry('')
    expect(found.configured).toBe(false)
    if (found.entry !== undefined) expect(found.entry.endsWith('@tencent-ai/codebuddy-code/bin/codebuddy')).toBe(true)
  })

  it('only treats a credential refusal as worth walking to the next account', async () => {
    const { looksLikeAuthFailure } = await import('../src/cli-bridge/runner.ts')
    const outcome = (text: string, isError = true) => ({
      text,
      toolCounts: new Map<string, number>(),
      sessionId: undefined,
      usage: undefined,
      numTurns: undefined,
      isError,
      errors: [] as readonly string[],
      subtype: undefined,
      stderr: '',
    })
    expect(looksLikeAuthFailure(outcome('http 401 Unauthorized'))).toBe(true)
    expect(looksLikeAuthFailure(outcome('Authentication required'))).toBe(true)
    expect(looksLikeAuthFailure(outcome('run the /login command'))).toBe(true)
    // A rate limit or a real model error on the next token just burns a turn.
    expect(looksLikeAuthFailure(outcome('http 429 rate limited'))).toBe(false)
    expect(looksLikeAuthFailure(outcome('http 401', false))).toBe(false)
  })
})

describe('plugin config schema', () => {
  // The schema is what a user's profile is validated against, so "the route is
  // off by default" has to be true HERE too — not only in the mount's fallback.
  it('resolves the CLI section with defaults when the profile omits it', async () => {
    const plugin = await import('../src/index.ts')
    const resolved = (plugin.Config as unknown as (value: unknown) => Record<string, any>)({})
    expect(resolved['cliBridge']).toBeDefined()
    expect(resolved['cliBridge'].enabled).toBe(false)
    expect(resolved['cliBridge'].permissionMode).toBe(CLI_BRIDGE_DEFAULTS.permissionMode)
    expect(resolved['cliBridge'].maxTurns).toBe(CLI_BRIDGE_DEFAULTS.maxTurns)
    expect(resolved['cliBridge'].regionOrder).toBe(CLI_BRIDGE_DEFAULTS.regionOrder)
  })

  it('accepts the documented keys a user would actually write', async () => {
    const plugin = await import('../src/index.ts')
    const resolved = (plugin.Config as unknown as (value: unknown) => Record<string, any>)({
      cliBridge: { enabled: true, maxTurns: 3, permissionMode: 'plan' },
    })
    expect(resolved['cliBridge'].enabled).toBe(true)
    expect(resolved['cliBridge'].maxTurns).toBe(3)
    expect(resolved['cliBridge'].permissionMode).toBe('plan')
  })
})

describe('mountCliBridge', () => {
  function services() {
    const tools: BridgeToolDefinition[] = []
    const commands: BridgeCommandDefinition[] = []
    return {
      tools,
      commands,
      input: {
        regions: [] as BridgeCredentialRegion[],
        tools: { register(definition: BridgeToolDefinition) { tools.push(definition); return () => {} } },
        commands: { register(definition: BridgeCommandDefinition) { commands.push(definition); return () => {} } },
      },
    }
  }

  it('registers nothing at all while the route is off, and does not log', () => {
    const sink = services()
    const log = vi.fn()
    const dispose = mountCliBridge({ settings: { enabled: false } as CliBridgeSettings, log, ...sink.input })
    expect(sink.tools).toHaveLength(0)
    expect(sink.commands).toHaveLength(0)
    expect(log).not.toHaveBeenCalled()
    expect(() => dispose()).not.toThrow()
  })

  it('registers both entrances when it is on', () => {
    const sink = services()
    const log = vi.fn()
    const dispose = mountCliBridge({ settings: { enabled: true }, log, ...sink.input })
    expect(sink.tools).toHaveLength(1)
    expect(sink.commands).toHaveLength(1)
    expect(log.mock.calls[0]?.[0]).toContain('codebuddy_ask')
    expect(log.mock.calls[0]?.[0]).toContain('/codebuddy')
    dispose()
  })

  it('mounts the provider-only case: on, but the Host publishes neither service', () => {
    const log = vi.fn()
    const dispose = mountCliBridge({
      settings: { enabled: true },
      regions: [],
      log,
      tools: undefined,
      commands: undefined,
    })
    // Not a throw and not silence: the user turned it on and is entitled to know
    // it did nothing.
    expect(log.mock.calls[0]?.[0]).toContain('两个入口都没挂上')
    expect(() => dispose()).not.toThrow()
  })
})
