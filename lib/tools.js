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
  const text = String(item?.text ?? '').replace(/\n/g, '\\n')
  const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text
  const bits = [item?.mode === 'insert' ? 'insert' : 'send']
  if (item?.source && item.source !== 'static') bits.push(item.source)
  if (item?.side) bits.push(item.side)
  return `${index + 1}. ${item?.label ?? ''} [${bits.join(' · ')}] — ${preview}`
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
      description: 'Read or edit the quick-action buttons of the DSH composer (the dsh-button plugin): the row of one-click prompts above the input box. Uses the same JSON file and the same validation as the ⋮ settings panel, so edits made here show up in the UI. actions: list (default) returns every button with its label, text preview, mode (send submits / insert fills the draft), source and side; add appends one button; remove deletes by label (add index when several share a label); save replaces the whole table. Text-only buttons: this tool never runs commands. An already-open composer keeps the old buttons until the page is refreshed or the session is reopened.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add', 'remove', 'save'],
            description: 'list (default) | add | remove | save',
          },
          button: {
            type: 'object',
            description: 'For add: the button to append.',
            properties: {
              label: { type: 'string', description: 'Button text, max 12 characters, single line.' },
              text: { type: 'string', description: 'The text to send or insert, max 500 characters. Supports \\n for a newline and {{name}} placeholders (filled in when clicked).' },
              mode: { type: 'string', enum: ['send', 'insert'], description: 'send = submit right away (default); insert = put it at the caret without sending.' },
              source: { type: 'string', enum: ['static', 'last-user', 'last-assistant', 'draft', 'selection', 'session-title', 'model', 'time'], description: 'Where the text comes from when clicked. static (default) uses text as-is; anything else reads the session at click time, and {{value}} in text is replaced by what was read.' },
              style: { type: 'string', enum: ['secondary', 'primary', 'ghost', 'danger'], description: 'Look only. Defaults to secondary for send, ghost for insert.' },
              side: { type: 'string', enum: ['left', 'right'], description: 'Which end of the action row. Defaults to left for insert, right for send.' },
            },
            required: ['label', 'text'],
            additionalProperties: false,
          },
          label: { type: 'string', description: 'For remove: exact label of the button to delete.' },
          index: { type: 'number', description: 'For remove: 0-based index (required when several buttons share the label).' },
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
