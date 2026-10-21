/**
 * Wiring the CLI route into the plugin, and normalizing its settings.
 *
 * THE ROUTE IS OPT-IN AND NON-BREAKING. It is `enabled: false` by default, and
 * both host services it needs (`tools`, `commands`) are looked up optionally
 * rather than declared in `inject`. That combination is deliberate: this plugin
 * is installed by people whose only interest is the provider, and a new hard
 * dependency would either fail their mount or silently remove their models. A
 * Host without the services simply gets no tool and no command.
 *
 * WHY THE ROUTE EXISTS AT ALL. The provider route has to look like a CodeBuddy
 * client to get past the gateway's channel check, and that is an arms race the
 * upstream is currently fighting with zero-width-space perturbation (see
 * `perturbChannelFingerprints`). It is also no longer cost-free: issue #98
 * reports account-level restrictions (code 11140). The CLI route has none of
 * that exposure — the process talking to the gateway really is the signed-in
 * CodeBuddy CLI — so it keeps working when the disguised route does not.
 *
 * @module dsh-connect-workbuddy/cli-bridge/mount
 */
import { mountCodebuddyCommand } from './command.ts'
import type { BridgeCredentialRegion } from './credentials.ts'
import type { BridgeCommandsService, BridgeLog, BridgeToolsService } from './services.ts'
import { EFFORT_LEVELS, MAX_REPLY_CHARS_CAP, MAX_TURNS_CAP, PERMISSION_MODES, TIMEOUT_SECS_CAP, mountAskTool } from './tool.ts'
import type { BridgeOptions } from './tool.ts'

/**
 * The `cliBridge` settings as they arrive from the config schema.
 *
 * Every field is optional because the schema may hand over a partial object, and
 * a user who edits only one key must not have to restate the rest.
 */
export interface CliBridgeSettings {
  enabled?: boolean
  binary?: string
  model?: string
  permissionMode?: string
  effort?: string
  maxTurns?: number
  timeoutSecs?: number
  regionOrder?: string
  workingDir?: string
  appendSystemPrompt?: string
  allowUnattended?: boolean
  maxReplyChars?: number
  injectResult?: boolean
}

/** Defaults, mirroring the schema so a missing key behaves the same either way. */
export const CLI_BRIDGE_DEFAULTS = {
  enabled: false,
  binary: '',
  model: '',
  permissionMode: 'acceptEdits',
  effort: '',
  maxTurns: 10,
  timeoutSecs: 900,
  regionOrder: 'cn,global',
  workingDir: '',
  appendSystemPrompt: '',
  allowUnattended: false,
  maxReplyChars: 60_000,
  injectResult: true,
} as const

/** Clamp an optional number to a default and a hard ceiling. */
function clampInt(value: unknown, fallback: number, cap: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(1, Math.min(cap, number))
}

/** Read a string setting, trimmed, falling back when it is not a string. */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/**
 * Turn raw settings into the normalized options one turn runs on.
 *
 * An out-of-range enum is REPORTED and then replaced by the default rather than
 * rejected: a typo in `permissionMode` should not take the whole plugin down,
 * but it must not silently run under a permission level the user did not pick
 * either. `onRejected` is how the caller turns that into a log line.
 */
export function normalizeCliBridgeOptions(
  settings: CliBridgeSettings | undefined,
  onRejected?: (message: string) => void,
): BridgeOptions {
  const raw = settings ?? {}
  const reject = onRejected ?? (() => {})

  const permissionMode = text(raw.permissionMode, CLI_BRIDGE_DEFAULTS.permissionMode)
  const safePermissionMode = (PERMISSION_MODES as readonly string[]).includes(permissionMode)
    ? permissionMode
    : CLI_BRIDGE_DEFAULTS.permissionMode
  if (safePermissionMode !== permissionMode) {
    reject(`permissionMode "${permissionMode}" 不是合法值，已回退到 ${safePermissionMode}；合法值：${PERMISSION_MODES.join(', ')}`)
  }

  const effort = text(raw.effort, CLI_BRIDGE_DEFAULTS.effort)
  const safeEffort = effort === '' || (EFFORT_LEVELS as readonly string[]).includes(effort) ? effort : ''
  if (safeEffort !== effort) {
    reject(`effort "${effort}" 不是合法值，已回退到 CLI 默认；合法值：${EFFORT_LEVELS.join(', ')}`)
  }

  const regionOrder = text(raw.regionOrder, CLI_BRIDGE_DEFAULTS.regionOrder)
  return {
    enabled: raw.enabled === true,
    binary: text(raw.binary, CLI_BRIDGE_DEFAULTS.binary),
    model: text(raw.model, CLI_BRIDGE_DEFAULTS.model),
    permissionMode: safePermissionMode,
    effort: safeEffort,
    maxTurns: clampInt(raw.maxTurns, CLI_BRIDGE_DEFAULTS.maxTurns, MAX_TURNS_CAP),
    timeoutSecs: clampInt(raw.timeoutSecs, CLI_BRIDGE_DEFAULTS.timeoutSecs, TIMEOUT_SECS_CAP),
    regionOrder: regionOrder
      .split(',')
      .map(part => part.trim())
      .filter(part => part !== ''),
    workingDir: text(raw.workingDir, CLI_BRIDGE_DEFAULTS.workingDir),
    appendSystemPrompt: text(raw.appendSystemPrompt, CLI_BRIDGE_DEFAULTS.appendSystemPrompt),
    allowUnattended: raw.allowUnattended === true,
    maxReplyChars: clampInt(raw.maxReplyChars, CLI_BRIDGE_DEFAULTS.maxReplyChars, MAX_REPLY_CHARS_CAP),
    injectResult: raw.injectResult !== false,
  }
}

/** Everything the mount needs, resolved by the caller. */
export interface CliBridgeMountInput {
  settings: CliBridgeSettings | undefined
  /** Region-scoped credential stores, in the order the plugin built them. */
  regions: readonly BridgeCredentialRegion[]
  log: BridgeLog
  /** Optional host services; absent means "this Host has no such surface". */
  tools: BridgeToolsService | undefined
  commands: BridgeCommandsService | undefined
}

/**
 * Mount the CLI route, returning one disposer for everything it registered.
 *
 * The bridge deliberately mounts AFTER the provider stacks exist: the credential
 * walk reads those stores, and mounting first would leave the route pointing at
 * a vault that is not there yet.
 */
export function mountCliBridge(input: CliBridgeMountInput): () => void {
  const options = normalizeCliBridgeOptions(input.settings, message => input.log(message))
  if (!options.enabled) return () => {}

  const deps = { options, regions: input.regions, log: input.log }
  const inFlight = new Set<string>()

  const disposeTool = mountAskTool(input.tools, deps)
  const disposeCommand = mountCodebuddyCommand(input.commands, { ...deps, inFlight })

  const surfaces = [input.tools === undefined ? '' : 'codebuddy_ask', input.commands === undefined ? '' : '/codebuddy']
    .filter(part => part !== '')
    .join(' + ')
  input.log(
    surfaces === ''
      ? 'CLI 路线已开启，但这个宿主既没有 tools 也没有 commands 服务，两个入口都没挂上'
      : `CLI 路线已开启：${surfaces}（权限模式 ${options.permissionMode}，模型 ${options.model === '' ? 'CLI 默认' : options.model}）`,
  )

  return () => {
    disposeCommand()
    disposeTool()
    inFlight.clear()
  }
}
