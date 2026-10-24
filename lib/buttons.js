/**
 * dsh-button —— 自定义按钮 + 预设隐藏的配置读写（宿主半部）。
 *
 * 为什么放在宿主：renderer 没有文件系统权限，而配置要能**手改、备份、跨端共用**，
 * 所以唯一事实源是一个 JSON 文件，客户端只经路由读写它。
 *
 * 文件位置（按优先级）：
 *   1. 环境变量 `DSH_BUTTON_CONFIG`（可直接指向任意 .json）；
 *   2. `$DSH_HOME/dsh-button/buttons.json`，DSH_HOME 默认 `~/.dsh`。
 *
 * 文件格式（`hidden` / `presets` / `mode` 可省略）：
 *   {
 *     "buttons": [
 *       { "label": "收尾", "text": "收尾" },                          // mode 省略 = send
 *       { "label": "模板", "text": "…", "mode": "insert" }
 *     ],
 *     "hidden": ["resend"],          // 隐藏的预设：continue / resend
 *     "presets": { "continue": { "label": "继续", "text": "继续", "mode": "send" } }
 *   }
 *
 * `mode` 只有两种：
 *   - `send`   —— 直接发送：把文字填进输入框并立即提交（原有行为，默认值）；
 *   - `insert` —— 填入输入框：只把文字插入到光标处，不提交。
 *
 * 文件不存在 = 空配置（不建文件、不报错）；内容坏了 = 明确的错误，不静默当空。
 * 写盘用「临时文件 + rename」，避免写到一半把配置弄坏。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 自定义按钮数量上限。再多输入框就摆不下了（也逼着人把语义合并）。 */
export const MAX_BUTTONS = 8
/** 标签长度上限：足够放「收尾」「知识库」这类词。 */
export const MAX_LABEL = 12
/** 发送文本上限：自定义提示词可以长一点，但不该变成第二个输入框。 */
export const MAX_TEXT = 500
/**
 * 每个动作的两种点法：
 *   `send`   —— 直接发送（原有行为，默认）；
 *   `insert` —— 填入输入框：只把文字插到光标处，不提交。
 * 名字不用「插入」：宿主自带的「插话」是真发出去的消息，容易混。
 */
export const MODES = ['send', 'insert']
/** 可以被隐藏的预设按钮（「收口」「按建议执行」已删除，不在其中）。 */
export const PRESET_IDS = ['continue', 'resend']
/**
 * 首次安装（配置文件还不存在）时自带的兜底按钮。
 * 都是"点一下就让 agent 做一件通用事"的只读/低风险动作，不绑定任何人的目录规范；
 * 用户保存过一次配置后就不再出现（文件存在 = 以文件为准，哪怕保存的是空列表）。
 */
export const DEFAULT_BUTTONS = [
  { label: '总结', text: '总结刚才这一轮：做了什么、改了哪些文件、还剩什么', mode: 'send' },
  { label: '审查', text: '审查当前未提交的改动，指出 bug 和风险，先别改', mode: 'send' },
  { label: '测试', text: '跑相关测试，失败就修，最后报告结果', mode: 'send' },
  { label: '提交信息', text: '根据当前改动生成一条 commit message，先别提交', mode: 'send' },
  { label: '解释报错', text: '解释这个报错的原因，给出修复步骤，先别动手', mode: 'send' },
]
/**
 * 预设按钮的默认标签与文字。
 * 「继续」和自定义按钮一样只是"发一句话"，所以它的标签与文字都可改；
 * 「重发」的内容是动态的（最后一条真人消息原文），只能改标签。
 */
export const DEFAULT_PRESETS = {
  continue: { label: '继续', text: '继续', mode: 'send' },
  resend: { label: '重发上一条', mode: 'send' },
}
/** 路由路径（与 `lib/index.js` 注册的一致）。 */
export const ROUTE = '/api/dsh-button/buttons'

/** 配置文件路径。`env` 可注入，便于测试。 */
export function configPath(env = process.env) {
  if (env.DSH_BUTTON_CONFIG && env.DSH_BUTTON_CONFIG.trim() !== '') return resolve(env.DSH_BUTTON_CONFIG)
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'dsh-button', 'buttons.json')
}

/**
 * 一个动作的点法。省略 / null → `send`（向后兼容 1.2.x 写的配置）；
 * 其余只接受 MODES 里的值，返回 null 表示不认识。
 * @param {unknown} raw
 * @returns {'send' | 'insert' | null}
 */
export function normalizeMode(raw) {
  if (raw === undefined || raw === null || raw === '') return 'send'
  return MODES.includes(raw) ? raw : null
}

/** 把一条原始配置收成 `{ label, text, mode }`；不是对象就返回 null。 */
export function normalizeButton(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  return { label, text, mode: normalizeMode(raw.mode) }
}

/** 校验 hidden 列表：只允许已知预设、去重。 */
export function validateHidden(raw) {
  if (raw === undefined || raw === null) return { ok: true, hidden: [] }
  if (!Array.isArray(raw)) return { ok: false, message: 'hidden 必须是数组' }
  const hidden = []
  for (const id of raw) {
    if (typeof id !== 'string' || !PRESET_IDS.includes(id)) {
      return { ok: false, message: `未知的预设按钮：${String(id)}（可选 ${PRESET_IDS.join(' / ')}）` }
    }
    if (!hidden.includes(id)) hidden.push(id)
  }
  return { ok: true, hidden }
}

/** 把预设配置收成完整对象；缺的字段用默认值补上。 */
export function normalizePresets(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const pick = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  const cont = input.continue !== null && typeof input.continue === 'object' ? input.continue : {}
  const resend = input.resend !== null && typeof input.resend === 'object' ? input.resend : {}
  return {
    continue: {
      label: pick(cont.label, DEFAULT_PRESETS.continue.label),
      text: pick(cont.text, DEFAULT_PRESETS.continue.text),
      mode: normalizeMode(cont.mode),
    },
    resend: { label: pick(resend.label, DEFAULT_PRESETS.resend.label), mode: normalizeMode(resend.mode) },
  }
}

/** 校验预设：标签/文字长度、标签不能换行、mode 只能是两种之一。 */
export function validatePresets(raw) {
  const presets = normalizePresets(raw)
  for (const key of PRESET_IDS) {
    const item = presets[key]
    if (item.mode === null) return { ok: false, message: `预设「${key}」的 mode 只能是 send（直接发送）或 insert（填入输入框）` }
    if (item.label.length > MAX_LABEL) return { ok: false, message: `预设「${key}」标签超过 ${MAX_LABEL} 字` }
    if (/[\r\n]/.test(item.label)) return { ok: false, message: `预设「${key}」标签不能换行` }
    if (item.text !== undefined) {
      if (item.text.length > MAX_TEXT) return { ok: false, message: `预设「${key}」文字超过 ${MAX_TEXT} 字` }
      if (/[\r\n]/.test(item.text)) return { ok: false, message: `预设「${key}」文字不能换行` }
    }
  }
  return { ok: true, presets }
}

/**
 * 校验并规范化一份配置。接受两种 JSON 形态：
 *   `[{ label, text, mode? }]` 或 `{ buttons: [{ label, text, mode? }], hidden: [...], presets: {...} }`。
 * @returns {{ok: true, buttons: Array<{label: string, text: string, mode: 'send' | 'insert'}>, hidden: string[], presets: object} | {ok: false, message: string}}
 */
export function validateConfig(raw) {
  const list = Array.isArray(raw) ? raw : raw?.buttons
  if (!Array.isArray(list)) return { ok: false, message: '配置必须是数组，或 { buttons: [...] }' }
  if (list.length > MAX_BUTTONS) return { ok: false, message: `最多 ${MAX_BUTTONS} 个自定义按钮（当前 ${list.length} 个）` }
  const buttons = []
  for (let i = 0; i < list.length; i++) {
    const item = normalizeButton(list[i])
    if (item === null) return { ok: false, message: `第 ${i + 1} 条不是对象` }
    if (item.label === '') return { ok: false, message: `第 ${i + 1} 条缺少标签` }
    if (item.text === '') return { ok: false, message: `第 ${i + 1} 条缺少要发送的文字` }
    if (item.mode === null) return { ok: false, message: `第 ${i + 1} 条：mode 只能是 send（直接发送）或 insert（填入输入框）` }
    if (item.label.length > MAX_LABEL) return { ok: false, message: `第 ${i + 1} 条标签超过 ${MAX_LABEL} 字` }
    if (item.text.length > MAX_TEXT) return { ok: false, message: `第 ${i + 1} 条文字超过 ${MAX_TEXT} 字` }
    // 标签是按钮上的单行文字；文字内容允许换行（多行消息合法），只有标签不行。
    if (/[\r\n]/.test(item.label)) return { ok: false, message: `第 ${i + 1} 条标签不能换行` }
    buttons.push(item)
  }
  const hiddenCheck = validateHidden(Array.isArray(raw) ? undefined : raw?.hidden)
  if (!hiddenCheck.ok) return hiddenCheck
  const presetCheck = validatePresets(Array.isArray(raw) ? undefined : raw?.presets)
  if (!presetCheck.ok) return presetCheck
  return { ok: true, buttons, hidden: hiddenCheck.hidden, presets: presetCheck.presets }
}

/** 读配置。文件不存在 → 自带默认按钮与预设；内容坏了 → `ok:false`（不把坏文件当空配置）。 */
export function loadConfig(file = configPath()) {
  if (!existsSync(file)) return { ok: true, buttons: DEFAULT_BUTTONS, hidden: [], presets: DEFAULT_PRESETS, exists: false, path: file }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    return { ok: false, buttons: [], hidden: [], presets: DEFAULT_PRESETS, exists: true, path: file, message: `读不了配置文件：${String(e?.message ?? e)}` }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, buttons: [], hidden: [], presets: DEFAULT_PRESETS, exists: true, path: file, message: `配置文件不是合法 JSON：${String(e?.message ?? e)}` }
  }
  const checked = validateConfig(raw)
  if (!checked.ok) return { ok: false, buttons: [], hidden: [], presets: DEFAULT_PRESETS, exists: true, path: file, message: checked.message }
  return { ok: true, buttons: checked.buttons, hidden: checked.hidden, presets: checked.presets, exists: true, path: file }
}

/** 原子写配置：先写临时文件，再 rename 覆盖。 */
export function saveConfig(buttons, hidden, presets, file = configPath()) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const payload = `${JSON.stringify({ buttons, hidden, presets }, null, 2)}\n`
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, payload, 'utf8')
    renameSync(tmp, file)
    return { ok: true, path: file }
  } catch (e) {
    return { ok: false, path: file, message: `写不了配置文件：${String(e?.message ?? e)}` }
  }
}
