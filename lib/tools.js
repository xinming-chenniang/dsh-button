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

/** 一条按钮的人话预览（文字长了截断，避免把会话刷满）。 */
function describeButton(item, index) {
  const options = Array.isArray(item?.items) ? item.items : []
  const text = String(item?.text ?? '').replace(/\n/g, '\\n')
  const raw = options.length > 0
    ? `[${options.map((option) => option?.label ?? '').join(' / ')}]`
    : (text.length > 60 ? `${text.slice(0, 60)}…` : text)
  const mode = item?.mode === 'insert' || item?.mode === 'quote' ? 'insert' : 'send'
  const bits = [mode]
  // 2026-11-10 晚起引用并入变量（`{{引用选中}}`）；`quote` 只是读旧配置时的遗留字段。
  if (item?.quote === true || item?.mode === 'quote') bits.push('legacy-quote')
  if (options.length > 0) bits.push(`menu ${options.length}`)
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
        ? `Updated: ${describeButton(result.updated, result.target)}`
        : `Saved ${result.buttons.length} button(s).`
  lines.push(head)
  lines.push(`Now in ${result.path}:`)
  result.buttons.forEach((item, i) => lines.push(describeButton(item, i)))
  lines.push('An already-open composer keeps the old buttons until the page is refreshed (or the session is reopened).')
  return lines.join('\n')
}

export function apply(ctx) {
  const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools
  if (tools === null || typeof tools?.register !== 'function' || typeof ctx?.effect !== 'function') return

  ctx.effect(
    () => tools.register({
      name: 'dsh_button',
      description: 'Manage the DSH composer quick-action buttons (the row of one-click prompts above the input box); same JSON file and validation as the ⋮ settings panel. action: list (default) | add | remove | set_options | save (replaces the whole table). Buttons are text-only — this tool never runs commands. A button with `items` (1–8) is a menu: it opens with the same-styled buttons and sends the chosen item; use it for several next-step options in one slot. Rewrite an existing menu with set_options — never with save. An open composer keeps old buttons until the page is refreshed.',
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
            description: 'For set_options: the new option list of one menu button (1–8). Pass [] to drop the menu and turn it back into a plain button. Only this one button changes — the rest of the table is untouched.',
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
      async execute(args) {
        return runButtonsAction(args ?? {})
      },
      presentCall(args) {
        return { card: 'generic', title: `dsh-button: ${args?.action ?? 'list'}`, kind: args?.action === 'list' ? 'read' : 'edit', rawInput: args?.label ?? args?.button?.label }
      },
    }),
    'dsh-button: tool dsh_button',
  )
}

export default { name, inject, apply }
