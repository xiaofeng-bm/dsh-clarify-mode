/**
 * dsh-clarify-mode — a user-chosen interview mode for DeepSeek Harness.
 *
 * Inside the mode the agent may only ask: the file-writing tools disappear from
 * its visible catalog, a policy section teaches it how to interview a
 * non-expert, and `exit_clarify` closes the session by writing the spec and
 * restoring the tools.
 *
 * The mode is per-session state folded from the session log, so it survives
 * resume and fork. There are no runtime imports on purpose: the profile links
 * this directory into its node_modules, and the plugin resolves nothing of its
 * own, so a symlinked source tree works as-is.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

const POLICY_FILE = new URL('./policy.md', import.meta.url)
const DIMENSIONS_FILE = new URL('./dimensions.md', import.meta.url)

/** Model-facing name of the tool that closes the interview. */
const EXIT_TOOL = 'exit_clarify'
/** Session event carrying the collaboration state. */
const MODE_EVENT = 'clarify/mode'
/** Projection key folding {@link MODE_EVENT} and the question counter. */
const PROJECTION_KEY = 'clarify'
/** The tool whose calls advance the round counter. */
const QUESTION_TOOL = 'ask_user_question'
/** Section placement, right after plan policy (500) and before team policy (600). */
const POLICY_ORDER = 550
const STANDBY_ORDER = 551

/** Registered tools removed while the mode is active. */
const DEFAULT_HIDDEN_TOOLS = ['write', 'edit', 'bash', 'subagent', 'subagent_fork', 'workflow']

const DEFAULTS = {
  softRounds: 5,
  maxRounds: 12,
  domain: 'auto',
  specPath: '.dsh/clarify/spec.md',
  hiddenTools: DEFAULT_HIDDEN_TOOLS,
  customDimensions: [],
  customRules: '',
  standbyHint: true,
}

/** Keys accepted on top of {@link DEFAULTS}, including the deprecated `rounds` alias. */
const KNOWN_KEYS = [...Object.keys(DEFAULTS), 'rounds']

const INACTIVE = Object.freeze({ active: false, asked: 0 })

/** A stable empty state; callers compare by reference. */
const EMPTY_QUESTIONS = Object.freeze([])

/**
 * Validate plugin config at load time: unknown keys and wrong types fail here
 * rather than at the first question.
 *
 * @param raw Raw plugin config from the profile layer.
 * @returns A detached, fully defaulted config.
 */
function resolveConfig(raw) {
  if (raw === null || typeof raw !== 'object') throw new Error('clarify-mode config must be an object')
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(`clarify-mode config has unknown key(s) ${unknown.join(', ')} — known keys: ${KNOWN_KEYS.join(', ')}`)
  }
  // `rounds` was the only budget before the coverage gate; keep it working as the
  // soft pace line rather than failing every existing profile on upgrade.
  const config = { ...DEFAULTS, ...raw }
  if (raw.rounds !== undefined && raw.softRounds === undefined) {
    if (!Number.isInteger(raw.rounds) || raw.rounds < 1) throw new Error('clarify-mode: `rounds` must be a positive integer')
    config.softRounds = raw.rounds
  }
  if (!Number.isInteger(config.softRounds) || config.softRounds < 1 || config.softRounds > 20) {
    throw new Error('clarify-mode: `softRounds` must be an integer between 1 and 20')
  }
  if (!Number.isInteger(config.maxRounds) || config.maxRounds < config.softRounds || config.maxRounds > 50) {
    throw new Error('clarify-mode: `maxRounds` must be an integer between `softRounds` and 50')
  }
  if (typeof config.domain !== 'string' || config.domain.trim() === '') {
    throw new Error('clarify-mode: `domain` must be a non-empty string')
  }
  if (typeof config.specPath !== 'string' || config.specPath.trim() === '') {
    throw new Error('clarify-mode: `specPath` must be a non-empty string')
  }
  if (!Array.isArray(config.hiddenTools) || config.hiddenTools.some((name) => typeof name !== 'string')) {
    throw new Error('clarify-mode: `hiddenTools` must be an array of tool names')
  }
  if (!Array.isArray(config.customDimensions) || config.customDimensions.some((line) => typeof line !== 'string')) {
    throw new Error('clarify-mode: `customDimensions` must be an array of strings')
  }
  if (typeof config.customRules !== 'string') throw new Error('clarify-mode: `customRules` must be a string')
  if (typeof config.standbyHint !== 'boolean') throw new Error('clarify-mode: `standbyHint` must be a boolean')
  return config
}

/**
 * Split the dimensions file into named sections.
 *
 * @param source Raw `dimensions.md` contents.
 * @returns Section name → bullet lines, in file order.
 */
function parseDimensions(source) {
  const sections = new Map()
  let current = null
  for (const rawLine of source.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(rawLine)
    if (heading !== null) {
      current = heading[1]
      sections.set(current, [])
      continue
    }
    if (current !== null && rawLine.trim().startsWith('- ')) sections.get(current).push(rawLine.trim())
  }
  return sections
}

/** Round budget mirrored into the client view so the chip can show `n/total`. */
let roundBudget = 5

/** Rule files are re-read when they change, so editing them never needs a restart. */
let sourceCache = { stamp: '', policy: '', dimensions: new Map() }

/**
 * Load the policy and dimension files, re-reading them only when either changed.
 *
 * @returns The current policy template and dimension sections.
 */
function sources() {
  const stamp = `${statSync(POLICY_FILE).mtimeMs}:${statSync(DIMENSIONS_FILE).mtimeMs}`
  if (stamp !== sourceCache.stamp) {
    sourceCache = {
      stamp,
      policy: readFileSync(POLICY_FILE, 'utf8'),
      dimensions: parseDimensions(readFileSync(DIMENSIONS_FILE, 'utf8')),
    }
  }
  return sourceCache
}

/**
 * Replace `{{name}}` placeholders in one pass. Values are inserted literally, so
 * a value containing `{{…}}` is never re-expanded.
 *
 * @param template Source text.
 * @param values Placeholder values.
 * @returns Rendered text.
 */
function render(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) => (Object.hasOwn(values, name) ? String(values[name]) : match))
}

/**
 * A one-off account of a mode change, injected so the switch is visible in the
 * conversation instead of happening silently. Same shape as any user message:
 * only the source tells consumers this is a notice rather than something the
 * user typed.
 *
 * @param text The one-line account, also shown as the row summary.
 * @returns A user-role message carrying a `notice` source.
 */
function noticeMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'clarify-mode', form: 'notice', summary: text.slice(0, 120) },
  }
}

/**
 * The highest `qN` question index in one `ask_user_question` call, or 0 when the
 * call carries no numbered question. Re-asking the same question reuses its id,
 * which is what keeps side-quests and follow-ups from spending rounds.
 *
 * @param argsJson Serialized tool arguments.
 * @returns Highest index seen.
 */
function highestQuestionIndex(argsJson) {
  if (typeof argsJson !== 'string') return 0
  let parsed
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return 0
  }
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
  let highest = 0
  for (const question of questions) {
    const match = typeof question?.id === 'string' ? /^q(\d+)$/.exec(question.id) : null
    if (match === null) continue
    const index = Number(match[1])
    if (Number.isFinite(index) && index > highest) highest = index
  }
  return highest
}

/** Per-session collaboration state, folded from the log by the projection. */
const clarifyProjection = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  // Plain-JSON duck schema: the store only calls `parse` when restoring a cache row.
  stateSchema: { parse: (value) => value },
  init: () => INACTIVE,
  apply: (state, event) => {
    if (event.type === MODE_EVENT) {
      const active = event.data.active === true
      return state.active === active && state.asked === 0 ? state : { active, asked: 0 }
    }
    if (event.type === 'tool/call' && event.data.name === QUESTION_TOOL && state.active) {
      const index = highestQuestionIndex(event.data.arguments)
      return index > state.asked ? { active: true, asked: index } : state
    }
    return state
  },
  // Exposed so a client can render a mode badge (a client plugin is required to
  // consume it; the host value alone renders nothing).
  wire: {
    viewSchema: { parse: (value) => value },
    view: (state) => ({ active: state.active, asked: state.asked, rounds: roundBudget }),
  },
}

export const name = 'clarify-mode'
export const inject = ['systemPrompt', 'tools', 'sessionProjections']

/**
 * Mount the clarify mode: one command, two prompt sections, one exit tool, and
 * a tool-catalog filter that only fires while the mode is active.
 *
 * A plugin that fails to start is invisible to the user — the loader logs it
 * where nobody looks — so both outcomes are recorded for post-restart checks.
 *
 * @param ctx The Cordis context of this plugin.
 * @param rawConfig Profile configuration.
 */
export function apply(ctx, rawConfig = {}) {
  try {
    mount(ctx, rawConfig)
    note('mounted')
  } catch (error) {
    note(`FAILED ${error?.stack ?? error}`)
    throw error
  }
}

/** Record one mount outcome next to the OS temp directory. */
function note(message) {
  try {
    appendFileSync(join(tmpdir(), 'dsh-clarify.log'), `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // Diagnostics must never break the mount.
  }
}

/**
 * Register the mode's command, sections, tool, and catalog filter.
 *
 * @param ctx The Cordis context of this plugin.
 * @param rawConfig Profile configuration.
 */
function mount(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  roundBudget = config.maxRounds
  const hidden = new Set(config.hiddenTools)
  sources()

  ctx.sessionProjections.register(clarifyProjection)

  /** Read the folded state, tolerating a session that has not started projecting yet. */
  const stateOf = (session) => {
    if (session === undefined) return INACTIVE
    const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY)
    return state ?? INACTIVE
  }

  /** Render the candidate list for the configured domain. */
  const dimensionList = () => {
    const { dimensions } = sources()
    const lines = [...(dimensions.get('通用') ?? []), ...config.customDimensions]
    const domain = config.domain.trim()
    if (domain !== 'auto' && dimensions.has(domain)) lines.push(...dimensions.get(domain))
    return lines.length > 0 ? lines.map((line) => `${line}`).join('\n') : '（清单为空，用你的判断）'
  }

  /** Render the policy text for one session, including the live round counter. */
  const policyText = (session) => {
    const { asked } = stateOf(session)
    const { policy, dimensions } = sources()
    const others = [...dimensions.keys()].filter((key) => key !== '通用' && key !== config.domain.trim())
    // The soft line is a pace check, not a budget: past it the policy asks the
    // model to re-examine its own to-do list instead of forcing a wrap-up.
    const softHint =
      asked >= config.softRounds
        ? `已经问了 ${asked} 轮。回到待办表看一眼：剩下没划掉的是不是 P0？如果只剩 P1，现在就收尾；如果 P0 还没问到，那就是前面几轮问偏了，别靠加轮次补救。`
        : ''
    return render(policy, {
      softRounds: config.softRounds,
      maxRounds: config.maxRounds,
      round: asked + 1,
      asked,
      softHint,
      hardHint: asked + 1 >= config.maxRounds ? `这是第 ${asked + 1} 轮，已到硬顶（${config.maxRounds} 轮）。问完这一题必须收尾，并在需求卡里注明还有哪几项没问到。` : '',
      dimensions: dimensionList(),
      domains: others.length === 0 ? '' : `其他可用的领域清单（当用户的需求属于它们时，按同样的方式使用）：${others.join('、')}。`,
      specPath: config.specPath,
      customRules: config.customRules.trim() === '' ? '' : `## 附加规则\n\n${config.customRules}`,
    })
  }

  // Policy while active, one-line hint while inactive — both interpolation-free
  // because the text is already rendered and may contain arbitrary braces.
  ctx.systemPrompt.section({
    name: 'clarify:policy',
    order: POLICY_ORDER,
    interpolate: false,
    text: (context) => (context.agent !== undefined && stateOf(context.agent.session).active ? policyText(context.agent.session) : ''),
  })
  ctx.systemPrompt.section({
    name: 'clarify:standby',
    order: STANDBY_ORDER,
    interpolate: false,
    text: (context) => {
      if (!config.standbyHint || context.agent === undefined) return ''
      if (stateOf(context.agent.session).active) return ''
      return '用户可以用 /clarify 进入需求澄清模式：先问清楚要做什么，再动手写。'
    },
  })

  // Hard half of the mode: drop the writing tools from the model-facing catalog.
  // A prompt alone cannot stop the model; an absent tool can.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    const agent = context?.agent
    if (agent === undefined || !stateOf(agent.session).active) return result
    const tools = result.tools.filter((tool) => !hidden.has(tool.name))
    return tools.length === result.tools.length ? result : { ...result, tools }
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'dsh-clarify-mode',
      name: 'clarify',
      description: 'Enter or leave requirement-clarification mode',
      input: { hint: '[off | 你的需求描述]' },
      handler: ({ agent, rawInput }) => {
        const argument = rawInput.trim()
        const active = argument !== 'off'
        const state = stateOf(agent.session)
        if (state.active === active) {
          return { kind: 'success', text: active ? '已经在澄清模式里了。' : '当前不在澄清模式。' }
        }
        agent.session.append(MODE_EVENT, { active })
        // The event alone is invisible to the user, so the switch also lands in
        // the conversation as a notice whose summary the client can render.
        const summary = active
          ? `已进入需求澄清模式：只问不写，问清为止（上限 ${config.maxRounds} 轮）。随时 /clarify off 退出。`
          : '已退出澄清模式，写文件的能力已恢复。'
        try {
          agent.inject(noticeMessage(summary))
        } catch (error) {
          note(`notice inject failed: ${error?.message ?? error}`)
        }
        // `/clarify 我想做个骰子` submits that text as the user's own message, so
        // the agent opens the interview in the same step instead of waiting for
        // a second turn.
        if (active && argument !== '') {
          try {
            agent.steer({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: argument }],
              source: { kind: 'user' },
            })
          } catch (error) {
            note(`steer failed: ${error?.message ?? error}`)
            return { kind: 'success', text: `${summary}\n需求请作为下一条消息发送。` }
          }
        }
        return { kind: 'success', text: summary }
      },
    })
  })

  ctx.tools.register({
    name: EXIT_TOOL,
    description: 'Only available in clarify mode. Call it after the user confirms the requirement card: it saves the spec and leaves the mode, restoring your tools.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        spec: {
          type: 'string',
          description: 'The complete spec in markdown: goal, out of scope, acceptance criteria, clarified terms, key decisions.',
        },
      },
      required: ['spec'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['path', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${EXIT_TOOL} requires a calling agent`)
      if (!stateOf(agent.session).active) throw new Error(`${EXIT_TOOL} is only available in clarify mode`)
      if (typeof args?.spec !== 'string' || args.spec.trim() === '') {
        throw new Error(`${EXIT_TOOL} requires a non-empty markdown \`spec\``)
      }
      const cwd = agent.session.header.cwd ?? process.cwd()
      const target = isAbsolute(config.specPath) ? config.specPath : join(cwd, config.specPath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, args.spec.endsWith('\n') ? args.spec : `${args.spec}\n`, 'utf8')
      agent.session.append(MODE_EVENT, { active: false })
      return {
        path: target,
        message: `Spec saved to ${target}. Clarify mode is off and your writing tools are back — implement the spec now, without asking again.`,
      }
    },
  })
}
