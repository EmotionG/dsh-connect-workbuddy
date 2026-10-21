/**
 * `/codebuddy` — one CodeBuddy turn started from the composer, without going
 * through the model.
 *
 * WHY A COMMAND AND NOT JUST THE TOOL. `codebuddy_ask` only runs when the model
 * decides to call it, which costs a DSH turn and a decision. A slash command is
 * the one host channel that executes against the receiving agent WITHOUT
 * sending the line to the model: zero DSH turns, the work happens in the Host,
 * and the human reads the result directly.
 *
 * IT ALSO FIXES THE WORKING DIRECTORY GAP. A tool call has no session on its
 * context, which is why `codebuddy_ask` cannot default to the session's
 * workspace. A command invocation carries `invocation.agent.session.header.cwd`,
 * so `/codebuddy` always runs in the workspace the human is actually looking at,
 * with no argument needed.
 *
 * WHAT AN EMPTY LINE MEANS. `/codebuddy` alone is a review: the built-in brief
 * asks CodeBuddy to read the uncommitted changes and report problems. Anything
 * the human types is sent verbatim instead.
 *
 * @module dsh-connect-workbuddy/cli-bridge/command
 */
import { formatInjection, injectOutcome } from './inject.ts'
import type { InjectionOutcome } from './inject.ts'
import type { BridgeCommandInvocation, BridgeCommandsService, BridgeLog } from './services.ts'
import { runAsk } from './tool.ts'
import type { AskDeps, AskResult } from './tool.ts'

/** The command name as registered (no leading slash). */
export const COMMAND_NAME = 'codebuddy'

/**
 * The brief an empty `/codebuddy` line expands to.
 *
 * It names the scope AND the failure mode it wants avoided ("只报你确实看见的
 * 问题"): a review that guesses is worse than one that says less, because the
 * human cannot tell the two apart in the output.
 */
const REVIEW_BRIEF =
  '评审当前工作区里未提交的改动（git 未提交改动；没有未提交改动时看最近一次提交）。' +
  '自己运行 git 命令确认范围，必要时读相关文件理解上下文，然后给出评审结论：' +
  '哪些地方有问题、为什么、怎么改。只报你确实看见的问题，不要猜。'

/**
 * What the composer line becomes.
 *
 * Empty → the review brief. Non-empty → the text verbatim, because a human who
 * typed something meant it, and silently prepending a review brief to "改一下
 * 这个 bug" is how a command does something other than what it was asked.
 */
export function composeCommandPrompt(raw: string): string {
  const note = raw.trim()
  return note === '' ? REVIEW_BRIEF : note
}

/** A one-line label saying how the human's words were used. */
export function commandScopeLabel(raw: string): string {
  const note = raw.trim()
  return note === '' ? '（未提交改动）' : `（指令：${note}）`
}

/** Whether this invocation is the built-in review (empty line). */
export function isReviewInvocation(raw: string): boolean {
  return raw.trim() === ''
}

/**
 * Render one turn outcome as the plain text a command result carries.
 *
 * The footer is the same shape the tool renders, because a human reading a
 * command result wants the same facts: which session, how many turns, what it
 * cost, and where it ran. The one thing added here is the working directory —
 * a command result is the only place the human learns WHICH tree was reviewed.
 *
 * `injection` is the delivery outcome of handing the result to the session's
 * model. It is rendered on its own line because "the command ran" and "the model
 * was told" are different facts and the human is entitled to both; omitting it
 * means no delivery was attempted (failed turn, or disabled).
 */
export function formatCommandOutcome(
  value: AskResult,
  extra: { raw?: string; injection?: InjectionOutcome } = {},
): string {
  const scope = commandScopeLabel(extra.raw ?? '')
  if (!value.ok) {
    return `CodeBuddy 失败${scope}：${value.error === '' ? '未知错误' : value.error}`
  }
  const body = value.reply.trim()
  const head = body === '' ? `CodeBuddy 完成${scope}：没有输出任何结论。` : `CodeBuddy 完成${scope}：\n\n${body}`
  const toolList =
    value.tools.length > 0
      ? value.tools.map(tool => (tool.count > 1 ? `${tool.name}×${String(tool.count)}` : tool.name)).join(', ')
      : '无'
  const footer =
    `\n\n[session_id=${value.session_id === '' ? '?' : value.session_id} turns=${String(value.num_turns)} ` +
    `tool_calls=${String(value.tool_calls)} tools=${toolList} ` +
    `tokens=${String(value.tokens_in)}in/${String(value.tokens_out)}out ` +
    `(cache_read=${String(value.cache_read_tokens)}) elapsed_ms=${String(value.elapsed_ms)} cred=${value.credential_region}` +
    (value.working_dir !== '' ? ` dir=${value.working_dir}` : '') +
    ']'
  const truncated = value.truncated
    ? '\n\n[注意：输出已截断。让 CodeBuddy 把完整内容写到文件里再读，别只靠这一份摘要]'
    : ''
  const delivery = extra.injection === undefined ? '' : `\n\n${formatInjection(extra.injection)}`
  return head + footer + truncated + delivery
}

/** What `mountCodebuddyCommand` needs from the host half. */
export interface CommandDeps extends AskDeps {
  /**
   * Session ids with a turn already running.
   *
   * A command invocation has no tool-call context, so nothing else would stop a
   * human from firing two full agent turns at the same workspace by pressing
   * enter twice; the guard makes the second one fail fast and visibly.
   */
  inFlight: Set<string>
}

/**
 * Register `/codebuddy`, returning the disposer.
 *
 * `commands` is passed in rather than looked up so a Host without the service
 * degrades to "no command" instead of failing the mount — the command is an
 * addition, not a load-bearing part of the plugin.
 */
export function mountCodebuddyCommand(commands: BridgeCommandsService | undefined, deps: CommandDeps): () => void {
  if (commands === undefined || typeof commands.register !== 'function') return () => {}
  const { options, log, inFlight } = deps

  try {
    return commands.register({
      name: COMMAND_NAME,
      description:
        '用 CodeBuddy 在当前工作区跑一轮（不经过模型，不消耗 DSH 额度）；留空 = 评审未提交改动',
      input: {
        hint: '可留空：直接评审当前工作区未提交的改动；或写你的要求（如"修一下这个空指针"）',
      },
      handler: async (invocation: BridgeCommandInvocation) => {
        const sessionId = typeof invocation.agent?.id === 'string' ? invocation.agent.id : ''
        const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput : ''

        if (sessionId !== '' && inFlight.has(sessionId)) {
          return { kind: 'error', text: '这个会话已有一个 CodeBuddy 回合在跑，等它结束再发一次。' }
        }

        // The command has no tool-call context, so the workspace comes from the
        // session header. This is the whole reason the command can promise a
        // working directory when the tool cannot.
        const cwd = invocation.agent?.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd.trim() === '') {
          return {
            kind: 'error',
            text: '这个会话没有工作区路径（session.header.cwd 为空），无法确定 CodeBuddy 该在哪里跑。请在一个打开过目录的会话里再试。',
          }
        }

        const message = composeCommandPrompt(raw)
        // An empty line is a review, and a review must not edit: `plan` is
        // read-only. A line the human actually typed uses the configured mode,
        // because "改一下这个 bug" is a request to change code.
        const review = isReviewInvocation(raw)

        if (sessionId !== '') inFlight.add(sessionId)
        const startedAt = Date.now()
        try {
          const value = await runAsk(
            {
              message,
              working_dir: cwd,
              ...(review ? { permission_mode: 'plan' } : {}),
            },
            invocation.signal === undefined ? undefined : { signal: invocation.signal },
            deps,
          )
          log(`command /${COMMAND_NAME} finished in ${String(Date.now() - startedAt)}ms (ok=${String(value.ok)})`)

          // Hand a SUCCESSFUL result to the session's model. This is the one
          // place the command touches the model, and it does so with a single
          // attributed message — the command's own zero-DSH-turn property is
          // about the WORK, not about never telling the model what happened.
          // A failed turn is not injected: the human reads the error, and
          // waking a model to say "it failed" spends a turn on nothing.
          const injection =
            value.ok && options.injectResult
              ? injectOutcome(invocation.agent, {
                  reply: value.reply,
                  dir: cwd,
                  scope: commandScopeLabel(raw),
                  toolCalls: value.tool_calls,
                  tools: value.tools,
                })
              : undefined

          return {
            kind: value.ok ? ('success' as const) : ('error' as const),
            text: formatCommandOutcome(value, {
              raw,
              ...(injection !== undefined ? { injection } : {}),
            }),
          }
        } catch (error) {
          // `runAsk` reports failures as `ok: false` rather than throwing, but a
          // plugin must not rest its no-crash guarantee on that contract.
          const text = error instanceof Error ? error.message : String(error)
          log(`command /${COMMAND_NAME} threw: ${text}`)
          return { kind: 'error' as const, text: `CodeBuddy 异常终止：${text}` }
        } finally {
          if (sessionId !== '') inFlight.delete(sessionId)
        }
      },
    })
  } catch (error) {
    log(`command registration failed: ${error instanceof Error ? error.message : String(error)}`)
    return () => {}
  }
}

/** Re-exported so the mount half does not need a second import site. */
export type { BridgeLog }
