/**
 * `codebuddy_ask` — the model-side entrance to the CLI route.
 *
 * WHY THIS IS A TOOL AND NOT A PROVIDER. A provider sits in the completion
 * socket and must therefore look like a CodeBuddy client to the gateway — that
 * is the shape this plugin already has, and it is the shape the gateway keeps
 * fingerprinting (http 400 code 11128) and, since issue #98, restricting
 * accounts over (code 11140, 「账号存在异常行为，已被限制使用」). A tool has none of
 * that exposure: the process that talks to the gateway IS the CodeBuddy CLI
 * that is signed in here, so there is no system prompt to disguise.
 *
 * THE PRICE, stated plainly: a bridged turn is a SEPARATE agent. It does not
 * see this session's conversation, so it re-explores the workspace from
 * scratch. That is fine for "review this module" and wrong for "continue what
 * we were doing" — which is why the tool takes a self-contained `message`.
 *
 * @module dsh-connect-workbuddy/cli-bridge/tool
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCredentials, type BridgeCredentialRegion } from './credentials.ts'
import { runAgent } from './runner.ts'
import type { BridgeLog, BridgeToolExecution, BridgeToolsService } from './services.ts'

/** Permission modes the CLI accepts for `--permission-mode`. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const

/** Reasoning levels the CLI accepts for `--effort`. */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Hard ceiling on one turn's agent budget, whatever the config says. */
export const MAX_TURNS_CAP = 100

/** Hard ceiling on one turn's wall clock, in seconds. */
export const TIMEOUT_SECS_CAP = 1800

/** How many distinct tools the result reports before the array is cut. */
export const TOOLS_CAP = 12

/** Hard ceiling on the reply length, in characters. */
export const MAX_REPLY_CHARS_CAP = 400_000

/** The normalized bridge settings, derived from the plugin config. */
export interface BridgeOptions {
  /** Whether the route is mounted at all. Off by default. */
  enabled: boolean
  binary: string
  model: string
  permissionMode: string
  effort: string
  maxTurns: number
  timeoutSecs: number
  regionOrder: readonly string[]
  workingDir: string
  appendSystemPrompt: string
  allowUnattended: boolean
  maxReplyChars: number
  injectResult: boolean
}

/** One tool tally in the result shape. */
export interface AskToolTally {
  name: string
  count: number
}

/** The complete result of one bridged turn — every field always present. */
export interface AskResult {
  ok: boolean
  reply: string
  session_id: string
  tools: AskToolTally[]
  tool_calls: number
  num_turns: number
  tokens_in: number
  tokens_out: number
  cache_read_tokens: number
  credential_region: string
  working_dir: string
  unattended: boolean
  elapsed_ms: number
  truncated: boolean
  error: string
}

/** Every field defaulted, so the Host's closed schema always validates. */
function result(partial: Partial<AskResult>): AskResult {
  return {
    ok: partial.ok === true,
    reply: partial.reply ?? '',
    session_id: partial.session_id ?? '',
    tools: partial.tools ?? [],
    tool_calls: partial.tool_calls ?? 0,
    num_turns: partial.num_turns ?? 0,
    tokens_in: partial.tokens_in ?? 0,
    tokens_out: partial.tokens_out ?? 0,
    cache_read_tokens: partial.cache_read_tokens ?? 0,
    credential_region: partial.credential_region ?? '',
    working_dir: partial.working_dir ?? '',
    unattended: partial.unattended === true,
    elapsed_ms: partial.elapsed_ms ?? 0,
    truncated: partial.truncated === true,
    error: partial.error ?? '',
  }
}

/** Clamp an optional numeric argument to a config default and a hard ceiling. */
function clampInt(value: unknown, fallback: number, cap: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(1, Math.min(cap, number))
}

/** The throwaway directory used when the caller explicitly allows no workspace. */
export function scratchDir(): string {
  const dir = join(tmpdir(), 'dsh-codebuddy-scratch')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Where a turn will run, or why it cannot run at all. */
export interface WorkingDirChoice {
  ok: boolean
  dir: string
  unattended: boolean
  reason: string
}

/**
 * Decide the directory one turn runs in.
 *
 * THE ORDER IS A LADDER, and the last rung is a refusal rather than a guess. The
 * Host does not pass the session's cwd to plugin tools (see
 * `BridgeToolExecution.cwd`), so a tool call genuinely has no idea where the
 * human is looking; picking a directory on its behalf would point an agent that
 * can edit files at a tree nobody chose. Hence: explicit argument → the Host's
 * (currently unpopulated) cwd → the configured default → an explicitly allowed
 * scratch dir → refuse, naming all four ways out.
 */
export function resolveWorkingDir(
  args: Record<string, unknown>,
  options: BridgeOptions,
  execution: BridgeToolExecution | undefined,
): WorkingDirChoice {
  const explicit = typeof args['working_dir'] === 'string' ? args['working_dir'].trim() : ''
  if (explicit !== '') return { ok: true, dir: explicit, unattended: false, reason: '' }

  const fromHost = typeof execution?.cwd === 'string' ? execution.cwd.trim() : ''
  if (fromHost !== '') return { ok: true, dir: fromHost, unattended: false, reason: '' }

  if (options.workingDir !== '') return { ok: true, dir: options.workingDir, unattended: false, reason: '' }

  if (args['allow_unattended'] === true || options.allowUnattended) {
    return { ok: true, dir: scratchDir(), unattended: true, reason: '' }
  }

  return {
    ok: false,
    dir: '',
    unattended: false,
    reason:
      'no working directory。宿主目前不把会话 cwd 传给插件工具，所以这个值必须由调用方给：' +
      '① 传 working_dir 指定一个已存在的目录；② 在插件配置里设 working_dir；' +
      '③ 若本回合只是通用问答、不需要任何目录，传 allow_unattended: true' +
      '（会在一个临时目录里跑，该目录是它的读写边界，不碰你的 home 或会话工作区）。',
  }
}

/** The closed output schema the Host validates every result against. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '本回合是否正常完成' },
    reply: { type: 'string', description: 'CodeBuddy 的最终回复文本' },
    session_id: { type: 'string', description: '本回合的 CLI 会话 id；空字符串表示未报' },
    tools: {
      type: 'array',
      description: `本回合用过的工具及次数，最多 ${String(TOOLS_CAP)} 条（超出见 tool_calls，它是真实总数）`,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name', 'count'],
        additionalProperties: false,
      },
    },
    tool_calls: { type: 'number', description: '本回合工具调用总次数（tools 数组可能被截断，这个数是真实的）' },
    num_turns: { type: 'number', description: 'CLI 自报的 agent 轮数' },
    tokens_in: { type: 'number', description: '本回合输入 token 数（含缓存命中部分）' },
    tokens_out: { type: 'number', description: '本回合输出 token 数' },
    cache_read_tokens: {
      type: 'number',
      description: '输入里命中提示缓存的部分。它通常占 tokens_in 的绝大部分——名义输入看着很大，新增计费其实很小',
    },
    credential_region: { type: 'string', description: '本次实际用的凭据区域（cn / global / env）' },
    working_dir: { type: 'string', description: '本回合实际使用的工作目录（它的读写边界）；空字符串表示本回合在拒绝前就结束了' },
    unattended: {
      type: 'boolean',
      description: '本回合是否因为调用方传了 allow_unattended 而在临时目录里跑（工具可能在那里写文件）',
    },
    elapsed_ms: { type: 'number', description: '本回合墙钟毫秒数' },
    truncated: { type: 'boolean', description: 'reply 超过上限被截断（截断处有标记）；长内容应让它落盘再读' },
    error: { type: 'string', description: '失败原因；空字符串表示没有错误' },
  },
  required: [
    'ok',
    'reply',
    'session_id',
    'tools',
    'tool_calls',
    'num_turns',
    'tokens_in',
    'tokens_out',
    'cache_read_tokens',
    'credential_region',
    'working_dir',
    'unattended',
    'elapsed_ms',
    'truncated',
    'error',
  ],
  additionalProperties: false,
} as const

/** What `mountAskTool` needs from the host half. */
export interface AskDeps {
  options: BridgeOptions
  regions: readonly BridgeCredentialRegion[]
  log: BridgeLog
}

/**
 * Run one bridged turn and return the complete result object.
 *
 * Exported because the `/codebuddy` slash command needs the same turn with the
 * same validation — a command that re-implemented this would drift from the
 * tool the first time either side gained a knob. The command supplies
 * `working_dir` from the session header and calls this directly; the tool's
 * `execute` is a one-line forward.
 */
export async function runAsk(
  args: Record<string, unknown>,
  execution: BridgeToolExecution | undefined,
  deps: AskDeps,
): Promise<AskResult> {
  const startedAt = Date.now()
  const { options, regions, log } = deps

  const mode = typeof args['permission_mode'] === 'string' ? args['permission_mode'].trim() : ''
  if (mode !== '' && !(PERMISSION_MODES as readonly string[]).includes(mode)) {
    return result({ ok: false, error: `permission_mode "${mode}" 不是合法值；合法值：${PERMISSION_MODES.join(', ')}` })
  }

  const effort = typeof args['effort'] === 'string' ? args['effort'].trim() : ''
  if (effort !== '' && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    return result({ ok: false, error: `effort "${effort}" 不是合法值；合法值：${EFFORT_LEVELS.join(', ')}` })
  }

  const message = typeof args['message'] === 'string' ? args['message'] : ''
  if (message.trim() === '') {
    return result({ ok: false, error: 'message 不能为空：要说清楚这一轮让 CodeBuddy 做什么。' })
  }

  const dir = resolveWorkingDir(args, options, execution)
  if (!dir.ok) return result({ ok: false, error: dir.reason })

  let credentials
  try {
    credentials = await resolveCredentials(regions, options.regionOrder, log)
  } catch (error) {
    return result({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }

  try {
    const modelArg = typeof args['model'] === 'string' ? args['model'].trim() : ''
    const sessionIdArg = typeof args['session_id'] === 'string' ? args['session_id'].trim() : ''
    const signal = execution?.signal

    const outcome = await runAgent(
      {
        prompt: message,
        cwd: dir.dir,
        binary: options.binary,
        model: modelArg !== '' ? modelArg : options.model,
        permissionMode: mode !== '' ? mode : options.permissionMode,
        effort: effort !== '' ? effort : options.effort,
        appendSystemPrompt: options.appendSystemPrompt,
        maxTurns: clampInt(args['max_turns'], options.maxTurns, MAX_TURNS_CAP),
        timeoutMs: clampInt(args['timeout_secs'], options.timeoutSecs, TIMEOUT_SECS_CAP) * 1000,
        ...(sessionIdArg !== '' ? { sessionId: sessionIdArg } : {}),
        ...(signal !== undefined ? { signal } : {}),
      },
      credentials,
      log,
    )

    let reply = outcome.text
    let truncated = false
    if (reply.length > options.maxReplyChars) {
      const omitted = reply.length - options.maxReplyChars
      reply =
        `${reply.slice(0, options.maxReplyChars)}\n\n` +
        `[truncated by dsh-connect-workbuddy: ${String(omitted)} more characters. ` +
        'Have CodeBuddy write the full text to a file and read it back.]'
      truncated = true
    }

    const tools = [...outcome.toolCounts.entries()]
      .slice(0, TOOLS_CAP)
      .map(([name, count]) => ({ name, count }))

    return result({
      ok: outcome.ok,
      reply,
      session_id: outcome.sessionId ?? '',
      tools,
      tool_calls: [...outcome.toolCounts.values()].reduce((sum, count) => sum + count, 0),
      num_turns: outcome.numTurns ?? 0,
      tokens_in: outcome.usage?.input_tokens ?? 0,
      tokens_out: outcome.usage?.output_tokens ?? 0,
      cache_read_tokens: outcome.usage?.cache_read_input_tokens ?? 0,
      credential_region: outcome.credential.region,
      working_dir: dir.dir,
      unattended: dir.unattended,
      elapsed_ms: Date.now() - startedAt,
      truncated,
      error: outcome.error ?? '',
    })
  } catch (error) {
    return result({ ok: false, error: error instanceof Error ? error.message : String(error), elapsed_ms: Date.now() - startedAt })
  }
}

/**
 * Register `codebuddy_ask`, returning the disposer.
 *
 * `tools` is passed in rather than looked up so a Host without the service
 * degrades to "no tool" instead of failing the mount.
 */
export function mountAskTool(tools: BridgeToolsService | undefined, deps: AskDeps): () => void {
  if (tools === undefined || typeof tools.register !== 'function') return () => {}

  try {
    return tools.register({
      name: 'codebuddy_ask',
      description:
        '把一个独立的任务交给本机的 CodeBuddy CLI 跑一轮完整 agent（它自己读文件、改文件、跑命令），返回它的结论。' +
        '适合"独立审一块代码 / 跑一轮调查 / 让另一个 agent 复核"，不适合"接着我们刚才的思路改"——它看不到本会话的对话，会重新探索工作区。' +
        '必须给 working_dir（宿主的工具调用不携带会话 cwd）。',
      timeoutMs: (deps.options.timeoutSecs + 30) * 1000,
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: '交给 CodeBuddy 的完整任务描述。它看不到本会话，所以要自包含：目标、范围、验收标准。',
          },
          working_dir: {
            type: 'string',
            description:
              '本回合的工作目录（它的读写边界）。宿主不把会话 cwd 传给插件工具，所以不传这个（且配置里没有默认值）会被拒绝。',
          },
          model: {
            type: 'string',
            description: `可选：本回合模型 id，默认取插件配置（当前 ${deps.options.model === '' ? 'CLI 自己的设置' : deps.options.model}）。`,
          },
          permission_mode: {
            type: 'string',
            description:
              '可选：本回合权限模式。plan = 只读，纯审查用这个；acceptEdits = 可改文件（默认）；bypassPermissions = 全部放行，无人值守；default / dontAsk / auto 也接受。传其它值会被拒绝并列出合法值。',
          },
          effort: {
            type: 'string',
            description: `可选：本回合推理力度。合法值：${EFFORT_LEVELS.join(', ')}。不传取插件配置。`,
          },
          max_turns: {
            type: 'number',
            description: `可选：本回合 agent 轮数上限，默认取插件配置（当前 ${String(deps.options.maxTurns)}），上限 ${String(MAX_TURNS_CAP)}。用尽会标记为截断，不当作成功。`,
          },
          timeout_secs: {
            type: 'number',
            description: `可选：本回合墙钟超时秒数，默认取插件配置（当前 ${String(deps.options.timeoutSecs)}），上限 ${String(TIMEOUT_SECS_CAP)}；超时会被杀掉并报错。`,
          },
          session_id: {
            type: 'string',
            description: '可选：指定 CLI 会话 id，让后续调用接着同一个会话。不传则每次开新会话。',
          },
          allow_unattended: {
            type: 'boolean',
            description:
              '可选：本回合不需要任何目录时设为 true，会在一个临时目录里跑（该目录是它的读写边界）。默认 false：一个能改文件的 agent 不该被指向没人选过的目录。',
          },
        },
        required: ['message'],
      },
      output: {
        schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        render(_args: unknown, value: unknown) {
          const typed = value as AskResult
          if (!typed.ok) {
            return [{ type: 'text', text: `CodeBuddy 调用失败: ${typed.error === '' ? '(未给出原因)' : typed.error}` }]
          }
          const lines = ['CodeBuddy 回复:', typed.reply === '' ? '(空回复)' : typed.reply, '']
          if (typed.truncated) {
            lines.push('[注意：reply 已截断。让 CodeBuddy 把完整内容写到文件里再读，别只靠这一份摘要]', '')
          }
          if (typed.unattended) {
            lines.push(
              `[注意：本回合未指定 working_dir，按调用方的 allow_unattended 在临时目录里执行（${typed.working_dir}）。` +
                '它读不到你的仓库；要针对某个仓库请显式传 working_dir]',
              '',
            )
          }
          const toolList =
            typed.tools.length > 0
              ? typed.tools.map(tool => (tool.count > 1 ? `${tool.name}×${String(tool.count)}` : tool.name)).join(', ')
              : '无'
          lines.push(
            `[session_id=${typed.session_id === '' ? '?' : typed.session_id} turns=${String(typed.num_turns)} tool_calls=${String(typed.tool_calls)} ` +
              `tools=${toolList} tokens=${String(typed.tokens_in)}in/${String(typed.tokens_out)}out ` +
              `(cache_read=${String(typed.cache_read_tokens)}) elapsed_ms=${String(typed.elapsed_ms)} cred=${typed.credential_region}` +
              (typed.working_dir !== '' ? ` dir=${typed.working_dir}` : '') +
              ']',
          )
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args: unknown, execution: BridgeToolExecution) {
        const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
        return runAsk(record, execution, deps)
      },
    })
  } catch (error) {
    deps.log(`tool registration failed: ${error instanceof Error ? error.message : String(error)}`)
    return () => {}
  }
}
