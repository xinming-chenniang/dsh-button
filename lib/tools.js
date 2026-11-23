/**
 * dsh-button —— 工具半部（宿主侧，独立 entry）。
 *
 * 为什么单独一个 entry：cordis 的 `inject` 是"必需服务"，缺了它整个 entry 保持 pending、`apply()` 不执行。
 * 路由那半要 `webServer`，工具这半只要 `tools`。写在一起的后果（dsh-outcomes 第 14 轮实测）是：
 * 没有 Web 服务的 profile（headless）里，工具一个都注册不上。两条 entry 由 `cordis.patch.yml` 分别插入。
 *
 * 这个工具和「⋮ 设置」读写**同一份文件、同一套校验**（`lib/buttons.js`）：
 *   - 界面 → HTTP 路由 → saveConfig；
 *   - agent → `dsh_button` 工具 → saveConfig。
 * 所以不存在"两边各一份、改完对不上"的情况。
 *
 * 边界：只碰这一个 JSON 文件，不执行命令、不读其它文件、不出网。
 */
import { runButtonsAction } from './buttons.js'

/** 工具 entry 的名字（与 `cordis.patch.yml` 的 insert id 一致）。 */
export const name = 'dsh-button-tools'
/** 只要工具服务；没有它这半确实没活干。 */
export const inject = ['tools']

/** 工具输出的渲染形状（一个纯文本块）。 */
function renderText(text) {
  return [{ type: 'text', text }]
}

/** 一条按钮上按会话存的选项（`sessions`），只留非空的那几节。 */
function sessionEntriesOf(item) {
  const map = item?.sessions
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return []
  return Object.values(map).filter((entry) => Array.isArray(entry?.items) && entry.items.length > 0)
}

/** 一条按钮的人话预览（文字长了截断，避免把会话刷满）。 */
function describeButton(item, index) {
  const options = Array.isArray(item?.items) ? item.items : []
  const sessions = sessionEntriesOf(item)
  // 共享项优先预览；没有共享项就预览第一个会话那份（选项本身不在这里展开，只给一眼）。
  const preview = options.length > 0 ? options : (sessions[0]?.items ?? [])
  const text = String(item?.text ?? '').replace(/\n/g, '\\n')
  const raw = preview.length > 0
    ? `[${preview.map((option) => option?.label ?? '').join(' / ')}]`
    : (text.length > 60 ? `${text.slice(0, 60)}…` : text)
  const mode = item?.mode === 'insert' || item?.mode === 'quote' ? 'insert' : 'send'
  const bits = [mode]
  // 2026-11-10 晚起引用并入变量（`{{引用选中}}`）；`quote` 只是读旧配置时的遗留字段。
  if (item?.quote === true || item?.mode === 'quote') bits.push('legacy-quote')
  if (options.length > 0 || sessions.length > 0) {
    const total = options.length + sessions.reduce((sum, entry) => sum + entry.items.length, 0)
    bits.push(`menu ${total}`)
    if (sessions.length > 0) bits.push(`per-session ×${sessions.length}`)
  }
  if (item?.source && item.source !== 'static') bits.push(item.source)
  if (item?.side) bits.push(item.side)
  const prefix = Number.isInteger(index) && index >= 0 ? `${index + 1}. ` : ''
  return `${prefix}${item?.label ?? ''} [${bits.join(' · ')}] — ${raw}`
}

/** 把 `runButtonsAction` 的结果写成给模型看的文本。 */
function summarize(result) {
  if (result?.ok === false) return `dsh_button failed (${result.error}): ${result.message}`
  const lines = []
  if (result.action === 'list') {
    lines.push(`${result.buttons.length} button(s)${result.defaults ? ' (built-in defaults — the config file does not exist yet)' : ''} in ${result.path}`)
    result.buttons.forEach((item, i) => lines.push(describeButton(item, i)))
    if (result.buttons.length === 0) lines.push('(none)')
    return lines.join('\n')
  }
  const head = result.action === 'add'
    ? `Added: ${describeButton(result.added, result.buttons.length - 1)}`
    : result.action === 'remove'
      ? `Removed: ${describeButton(result.removed, 0)}`
      : result.action === 'set_options'
        ? `Updated: ${describeButton(result.updated, result.target)}${result.session ? ` (options for ${result.session})` : ' (shared options)'}`
        : `Saved ${result.buttons.length} button(s).`
  lines.push(head)
  lines.push(`Now in ${result.path}:`)
  result.buttons.forEach((item, i) => lines.push(describeButton(item, i)))
  lines.push('Open composers pick the new table up on their own within ~2s (menu options included) — no page refresh needed.')
  return lines.join('\n')
}

/**
 * 兜底的当前会话 id：只看宿主的 `sessions` 快照的 `current`（界面聚焦的那个）。
 * **正常路径不用它** —— `execute()` 优先取这次工具调用所属会话（`exec.agent.id`）；
 * 这里只在拿不到调用上下文（老宿主 / 直接调 `runButtonsAction`）时兜底。
 * **刻意不做 byId 兜底**（2026-11-16 实测教训）：兜底会挑到任意一个会话 ——
 * 另一个会话的 agent 写方案时，被盖上了我这边的会话 id，于是它自己反而看不到。
 * 拿不到就返回空串（= 不盖章），宁可退化成共享，也不要盖错章。
 */
function currentSessionIdOf(ctx) {
  try {
    const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined
    const snapshot = sessions?.list?.getSnapshot?.()
    if (typeof snapshot?.current === 'string' && snapshot.current !== '') return snapshot.current
  } catch { /* 读不到就当没有会话 id */ }
  return ''
}

export function apply(ctx) {
  const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools
  if (tools === null || typeof tools?.register !== 'function' || typeof ctx?.effect !== 'function') return

  ctx.effect(
    () => tools.register({
      name: 'dsh_button',
      description: 'Manage the DSH composer quick-action buttons (the row of one-click prompts above the input box); same JSON file and validation as the ⋮ settings panel. action: list (default) | add | remove | set_options | save (replaces the whole table). Buttons are text-only — this tool never runs commands. A button with `items` (1–8) is a menu: hovering opens it with the same-styled buttons, clicking it sends "继续" (Continue), and it sends the chosen item. Menu options are stored **per session**: several sessions can each keep their own set at the same time, and set_options only replaces the set for the calling session (other sessions keep their options untouched). CONVENTION: when a turn ends with several next steps the user may pick from, write them into the existing menu button with set_options instead of adding buttons — the calling session id is filled in automatically. Rewrite an existing menu with set_options — never with save. An open composer picks changes up automatically within ~2s; no page refresh needed.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add', 'remove', 'set_options', 'save'],
            description: 'list (default) | add | remove | set_options | save',
          },
          button: {
            type: 'object',
            description: 'For add: the button to append.',
            properties: {
              label: { type: 'string', description: 'Button text, max 12 chars, single line.' },
              text: { type: 'string', description: 'Text to send / insert, max 500 chars. Variables read at click time: {{selection}} {{last-user}} {{last-answer}} {{draft}} {{title}} {{model}} {{time}}. Quote-block variables: {{quote-selection}} {{quote-last-user}} {{quote-last-answer}} (the read text becomes a "> " Markdown quote block). {{name}} prompts for a value on click. \\n = newline.' },
              mode: { type: 'string', enum: ['send', 'insert'], description: 'send = submit now (default); insert = fill the draft.' },
              source: { type: 'string', enum: ['static', 'last-user', 'last-assistant', 'draft', 'selection', 'session-title', 'model', 'time'], description: 'Text source read at click time (kept for old configs). static (default) uses text as-is; others read the session then; {{value}} = what was read.' },
              style: { type: 'string', enum: ['secondary', 'primary', 'ghost', 'danger'], description: 'Ignored (kept for old configs): look is fixed by mode.' },
              side: { type: 'string', enum: ['left', 'right'], description: 'Row end. Defaults: left for insert, right for send.' },
              items: {
                type: 'array',
                description: 'Menu button (tier 6): 1–8 options. With items the button opens a menu instead of sending, and its own `text` may be empty. Use it to offer several next steps in one slot instead of adding several buttons.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Option label, max 12 chars.' },
                    text: { type: 'string', description: 'Text sent / inserted when this option is chosen, max 500 chars.' },
                    mode: { type: 'string', enum: ['send', 'insert'] },
                  },
                  required: ['label', 'text'],
                  additionalProperties: false,
                },
              },
              at: { type: 'string', description: 'When items were written (ISO time, e.g. 2026-11-15T18:16:00+08:00). Options older than 24h show a stale hint.' },
            },
            required: ['label', 'text'],
            additionalProperties: false,
          },
          label: { type: 'string', description: 'For remove / set_options: exact label of the target button.' },
          index: { type: 'number', description: 'For remove / set_options: 0-based index (required when several buttons share the label).' },
          items: {
            type: 'array',
            description: 'For set_options: the new option list of one menu button (1–8) for the calling session — other sessions keep their own lists untouched. Pass [] to drop the calling session list; the button becomes plain only when no session and no shared list is left. Only this one button changes — the rest of the table is untouched.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Option label, max 12 chars.' },
                text: { type: 'string', description: 'Text sent / inserted when this option is chosen, max 500 chars.' },
                mode: { type: 'string', enum: ['send', 'insert'] },
              },
              required: ['label', 'text'],
              additionalProperties: false,
            },
          },
          at: { type: 'string', description: 'For set_options: when these options were written (ISO time). Defaults to now; options older than 24h show a stale hint.' },
          session: { type: 'string', description: 'For set_options: normally omit — the calling session id is filled in automatically from the tool context. Pass it only when writing options for a different session (e.g. the UI is focused on another window).' },
          buttons: {
            type: 'array',
            description: 'For save: the complete replacement list. Every entry takes the same fields as `button`.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                text: { type: 'string' },
                mode: { type: 'string', enum: ['send', 'insert'] },
                source: { type: 'string', enum: ['static', 'last-user', 'last-assistant', 'draft', 'selection', 'session-title', 'model', 'time'] },
                style: { type: 'string', enum: ['secondary', 'primary', 'ghost', 'danger'] },
                side: { type: 'string', enum: ['left', 'right'] },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      text: { type: 'string' },
                      mode: { type: 'string', enum: ['send', 'insert'] },
                    },
                    required: ['label', 'text'],
                    additionalProperties: false,
                  },
                },
                at: { type: 'string' },
              },
              required: ['label', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => renderText(summarize(value)),
      },
      async execute(args, exec) {
        const input = args ?? {}
        // 谁写的菜单：调用方显式给了 `session` 就用；否则用**这次工具调用所属的会话**
        // （`ToolRunContext.agent.id`，宿主 dsh-tools 的契约）。
        // 不能退回「界面聚焦的那个会话」当第一选择：两者可以不同 —— 2026-11-22 实测，
        // 聚焦在另一个会话时写进去的是错的 id，客户端判定「菜单是别人的」只显示一行
        // 「生成本轮选项」，用户点它又让 agent 写回同一个错 id，形成死循环。
        const callingSession = typeof exec?.agent?.id === 'string' && exec.agent.id !== '' ? exec.agent.id : ''
        const session = typeof input.session === 'string' && input.session !== ''
          ? input.session
          : (callingSession !== '' ? callingSession : currentSessionIdOf(ctx))
        return runButtonsAction(session === '' ? input : { ...input, session })
      },
      presentCall(args) {
        return { card: 'generic', title: `dsh-button: ${args?.action ?? 'list'}`, kind: args?.action === 'list' ? 'read' : 'edit', rawInput: args?.label ?? args?.button?.label }
      },
    }),
    'dsh-button: tool dsh_button',
  )
}

export default { name, inject, apply }
