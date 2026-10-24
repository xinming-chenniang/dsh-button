/**
 * dsh-button —— 客户端半部：输入框那一排的动作。
 *
 *   0) 「继续」       —— 默认把「继续」两个字发进当前会话（`conversation.input.left`，最左）
 *                        "嗯，往下走"的通用答复：继续 / 按推荐执行 / 接受 / 好的 —— 都点它
 *   1) 「自定义按钮」 —— 用户自己配的 N 个按钮（标签 + 文字），一格平铺
 *                        配置在宿主侧 JSON 里，末尾「＋」打开编辑器；
 *                        编辑器里每条有 ↑ / ↓，手动调整顺序（顺序 = 配置数组顺序，保存即生效）
 *   2) 「重发上一条」 —— 把最后一条**真人**用户消息原样再发一条
 *                        （`conversation.input.right`，就在主发送/暂停键左侧）
 *
 * **每个动作有两种点法**（v1.3 起，存配置里的 `mode`）：
 *   - `send`   直接发送：填进输入框并立即提交（1.2.x 的原有行为，默认）；
 *   - `insert` 填入输入框：只把文字插到光标处，不提交（用宿主 `insertText`，不碰 DOM）。
 * 编辑器按这两种方式分区，不再按「预设 / 我的」分区。
 *
 * **「收尾」不再是写死的按钮**：需要就加一条 `收尾 = 收尾` 的按钮。
 * **「收口」已删除**（2026-10-22）：它依赖外部 `closeout` CLI，对没装的用户是坏格子。
 *
 * 直接发送恒为排队（`submit()` 默认 queue）；手打 Enter 才受 `busyEnter` 设置影响。
 * 直接发送在输入框有草稿时不发；填入则相反 —— 它就是用来往草稿里加字的。
 *
 * 形态照 `@deepseek-ai/dsh-client-*` 的模块表约定：宿主 Web 端用
 * `window.__ModuleLoader__.load({ id, factory })` 加载，factory 里 `require('react')`
 * （react 是平台种子模块，不是依赖），返回一个 cordis 插件对象 `{ name, inject, apply }`。
 *
 * 重发的数据来源（宿主公开面，不是猜的）：
 *   - `sessions.binding(sessionId).eventSource.getSnapshot().entries`，
 *     元素形如 `{ event: { type, seq, time, data } }`；
 *   - 真人消息 = `event.type === 'user/message'` 且 `event.data.source.kind === 'user'`
 *     （注入、引用、技能调用、压缩检查点都不是）；
 *   - 提交 = `conversation.input.for(scope).setDraft(text)` + `.submit()`；
 *   - 填入 = 同一个门面的 `caretSpan()` + `snapshot.draftRev` → `insertText(text, span)`。
 *
 * 刻意不做的事：不写全局 DOM —— 唯一例外是编辑器浮层 portal 到 `document.body`（只追加自己的节点、
 * 不改宿主节点；否则会被聊天区的「回到底部」箭头盖住）；不注册路由、不碰凭据、不出网。
 * 重发只发**文本**：附件、图片、引用不会随按钮复制。
 */

window.__ModuleLoader__.load({
  id: 'dsh-button',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    /**
     * 编辑器浮层要 portal 到 `document.body`：
     * 宿主聊天区的「回到底部」浮动箭头在聊天的层叠上下文里 `z-index: 8`，而输入框这一格所在容器的
     * 层叠级别更低 —— 留在插槽里时，即使浮层写 z-index 21 亿也会被那个箭头盖住（2026-10-24 截图实测）。
     * 挂到 body 后按根层叠上下文比较，才盖得住它。
     */
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch { /* 老宿主没有这个种子模块：退回原地渲染 */ }

    /** 与包名一致（`cordis.patch.yml` 的 insert id 也是它）。 */
    const NAMESPACE = 'dsh-button'
    /**
     * 「继续」按钮发出去的那两个字 —— "没异议、往下走"的通用答复。
     * 想让按钮改词只改这一个常量。
     */
    const TRIGGER_CONTINUE = '继续'

    /**
     * 落点。想换位置只改这几行：
     *   'sidebar.footer.action'              左侧栏底部（`dsh-plugin-restart` 用它，已装机验证）
     *   'conversation.session.header.actions' 会话标题栏右侧（`dsh-session-manager` 用它）
     *   'conversation.input.left'            输入框左侧工具区（继续 / 自定义）
     *   'conversation.input.right'           主发送/暂停键左侧那一排（composer bar 的 trailing 区）。
     */
    const SLOT_CONTINUE = 'conversation.input.left'
    const SLOT_CUSTOM = 'conversation.input.left'
    const SLOT_RESEND = 'conversation.input.right'
    /** 同插槽里的排序（越小越靠左）：「继续」最前（最常用），自定义再往右。 */
    const ORDER_CONTINUE = 4
    const ORDER_CUSTOM = 5
    const ORDER_RESEND = 5

    /**
     * 插槽里的「格子键」。同一个 list 插槽里放两个按钮＝两个格子，
     * 第二个必须用**自己的键**（复用别人的 id 会顶掉对方那个格子）。
     */
    const ID_CONTINUE = `${NAMESPACE}:continue`
    const ID_CUSTOM = `${NAMESPACE}:custom`
    const ID_RESEND = NAMESPACE

    /** 自定义按钮配置的读写路由（`lib/index.js` 的 BUTTONS_ROUTE）。 */
    const BUTTONS_URL = '/api/dsh-button/buttons'
    /** 自定义按钮上限：与宿主 `lib/buttons.js` 的 MAX_BUTTONS 保持一致。 */
    const MAX_CUSTOM = 8
    const MAX_CUSTOM_LABEL = 12
    const MAX_CUSTOM_TEXT = 500
    /** 悬浮提示里的文字预览上限：原生 tooltip 撑不下 500 字的自定义文字。 */
    const TITLE_PREVIEW = 120

    /** 长文字截断，给悬浮提示用（完整文字仍在配置里）。 */
    function previewText(text) {
      const value = typeof text === 'string' ? text : ''
      return value.length > TITLE_PREVIEW ? `${value.slice(0, TITLE_PREVIEW)}…` : value
    }

    /** 极简 `%s` 替换：`t()` 的回退实现不带参数，这里自己来。 */
    function formatText(template, value) {
      return String(template).replace('%s', String(value))
    }

    function buttonsUrl() {
      try {
        const origin = globalThis.location?.origin
        return origin && origin !== 'null' ? `${origin}${BUTTONS_URL}` : BUTTONS_URL
      } catch {
        return BUTTONS_URL
      }
    }

    /** 预设按钮的 key（与宿主 `lib/buttons.js` 的 PRESET_IDS 一致）。 */
    const PRESET_KEYS = ['continue', 'resend']

    /** 自定义按钮 + 预设隐藏的本地缓存：同一次页面生命周期里只拉一次配置。 */
    let customCache // { buttons: Array<{label,text}>, hidden: string[] }
    let customLoad
    let customLoadError = ''
    /** 被用户删掉的预设（渲染时兜底用；真正移除格子靠 seat 的 disposer）。 */
    let presetHidden = new Set()

    async function requestButtons(init) {
      // 路由挂住时不能让「＋」永远 pending：3s 后 abort，交给 ensureCustomButtons 的 catch。
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), 3000)
      try {
        const res = await fetch(buttonsUrl(), controller === null ? init : { ...init, signal: controller.signal })
        const payload = await res.json().catch(() => null)
        if (!res.ok || payload === null || payload.ok !== true) {
          throw new Error((payload && payload.message) || `HTTP ${res.status}`)
        }
        return payload
      } finally {
        if (timer !== null) { try { clearTimeout(timer) } catch { /* 定时器不可用就算了 */ } }
      }
    }

    /** 预设的默认标签/文字（与宿主 `DEFAULT_PRESETS` 一致）。 */
    const DEFAULT_PRESET_LABELS = { continue: '继续', resend: '重发上一条' }
    const DEFAULT_CONTINUE_TEXT = '继续'
    /** 两种点法（与宿主 `MODES` 一致）：`send` 直接发送，`insert` 只填进输入框。 */
    const MODE_SEND = 'send'
    const MODE_INSERT = 'insert'

    /** 把路由返回的 payload 收成 `{ buttons, hidden, presets }`；未知的 hidden / mode 值按默认处理。 */
    function normalizeConfig(payload) {
      const buttons = Array.isArray(payload?.buttons)
        ? payload.buttons
          .filter((item) => item !== null && typeof item === 'object')
          .map((item) => ({
            label: typeof item.label === 'string' ? item.label : '',
            text: typeof item.text === 'string' ? item.text : '',
            mode: item.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND,
          }))
        : []
      const hidden = Array.isArray(payload?.hidden)
        ? payload.hidden.filter((id) => PRESET_KEYS.includes(id))
        : []
      const rawPresets = payload?.presets !== null && typeof payload?.presets === 'object' ? payload.presets : {}
      const modeOf = (key) => (rawPresets?.[key]?.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND)
      const presets = {
        continue: {
          label: typeof rawPresets?.continue?.label === 'string' && rawPresets.continue.label.trim() !== ''
            ? rawPresets.continue.label.trim()
            : DEFAULT_PRESET_LABELS.continue,
          text: typeof rawPresets?.continue?.text === 'string' && rawPresets.continue.text.trim() !== ''
            ? rawPresets.continue.text.trim()
            : DEFAULT_CONTINUE_TEXT,
          mode: modeOf('continue'),
        },
        resend: {
          label: typeof rawPresets?.resend?.label === 'string' && rawPresets.resend.label.trim() !== ''
            ? rawPresets.resend.label.trim()
            : DEFAULT_PRESET_LABELS.resend,
          mode: modeOf('resend'),
        },
      }
      return { buttons, hidden, presets }
    }

    /** 预设的当前标签（配置没到之前用默认值）。 */
    function presetLabel(key) {
      return customCache?.presets?.[key]?.label ?? DEFAULT_PRESET_LABELS[key]
    }

    /** 「继续」当前要发送的文字。 */
    function presetText(key) {
      return customCache?.presets?.[key]?.text ?? DEFAULT_CONTINUE_TEXT
    }

    /** 预设当前的点法：`send`（默认）或 `insert`。 */
    function presetMode(key) {
      return customCache?.presets?.[key]?.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND
    }

    /** 读一次配置；失败记下原因并按空配置继续（「＋」入口仍然可用）。 */
    function ensureCustomButtons() {
      if (customCache !== undefined) return Promise.resolve(customCache)
      if (customLoad === undefined) {
        customLoad = requestButtons({ method: 'GET', headers: { accept: 'application/json' } })
          .then((payload) => {
            customCache = normalizeConfig(payload)
            presetHidden = new Set(customCache.hidden)
            customLoadError = ''
            return customCache
          })
          .catch((e) => {
            customCache = normalizeConfig({ buttons: [], hidden: [] })
            customLoadError = String((e && e.message) || e)
            return customCache
          })
          .finally(() => {
            customLoad = undefined
          })
      }
      return customLoad
    }

    /** 保存配置；宿主校验通过后返回它落盘的那份。 */
    async function saveCustomButtons(list, hidden, presets) {
      const payload = await requestButtons({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ buttons: list, hidden, presets }),
      })
      customCache = normalizeConfig(payload)
      presetHidden = new Set(customCache.hidden)
      return customCache
    }

    /** 编辑器里的一条空行。`mode` 决定它默认落在哪一区。 */
    function blankCustomRow(mode = MODE_SEND) {
      return { label: '', text: '', mode: mode === MODE_INSERT ? MODE_INSERT : MODE_SEND }
    }

    /**
     * 把第 from 条挪到 to（编辑器 ↑ / ↓ 用）。
     * 越界或原地不动就返回原数组；真的搬了返回**新数组**（不改入参，交给 setState 走函数式更新）。
     * @param {Array<{label: string, text: string, mode?: string}>} list
     * @param {number} from
     * @param {number} to
     */
    function moveRow(list, from, to) {
      if (!Array.isArray(list)) return list
      if (!Number.isInteger(from) || !Number.isInteger(to)) return list
      if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
      const next = list.slice()
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    }

    /** 同区相邻的下一行下标（跳过另一区的行）；没有就 -1。 */
    function sectionNeighbor(list, index, direction) {
      if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length) return -1
      const mode = list[index]?.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND
      for (let i = index + direction; i >= 0 && i < list.length; i += direction) {
        const other = list[i]?.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND
        if (other === mode) return i
      }
      return -1
    }

    /**
     * 在**本区**内上移/下移一行（编辑器分区后，↑↓ 只跟同一区的邻居换位）。
     * 另一区的行不参与排序：跳过它们、交换两条同区行的数组位置。
     * @param {Array<{label: string, text: string, mode?: string}>} list
     * @param {number} index
     * @param {number} direction -1 上移 / +1 下移
     */
    function moveInSection(list, index, direction) {
      const target = sectionNeighbor(list, index, direction)
      if (target < 0) return list
      return moveRow(list, index, target)
    }

    /**
     * 编辑器行 → 配置。规则尽量松：
     *   - 标签和文字都空的行走掉（不报错，方便边加边删）；
     *   - 只填了一半的行才报错，并指出是第几条；
     *   - 其余按 host 同样的上限校验；`mode` 原样带上（默认 send）。
     * @param {Array<{label: string, text: string, mode?: string}>} rows
     * @returns {{ok: true, buttons: Array<{label: string, text: string, mode: string}>} | {ok: false, message: string}}
     */
    function validateCustomRows(rows) {
      const list = Array.isArray(rows) ? rows : []
      const buttons = []
      for (let i = 0; i < list.length; i++) {
        const label = typeof list[i]?.label === 'string' ? list[i].label.trim() : ''
        const value = typeof list[i]?.text === 'string' ? list[i].text.trim() : ''
        if (label === '' && value === '') continue
        if (label === '') return { ok: false, message: `第 ${i + 1} 条：标签不能为空` }
        if (value === '') return { ok: false, message: `第 ${i + 1} 条：文字不能为空` }
        if (label.length > MAX_CUSTOM_LABEL) return { ok: false, message: `第 ${i + 1} 条：标签超过 ${MAX_CUSTOM_LABEL} 字` }
        if (value.length > MAX_CUSTOM_TEXT) return { ok: false, message: `第 ${i + 1} 条：文字超过 ${MAX_CUSTOM_TEXT} 字` }
        buttons.push({ label, text: value, mode: list[i]?.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND })
      }
      if (buttons.length > MAX_CUSTOM) return { ok: false, message: `最多 ${MAX_CUSTOM} 条（当前 ${buttons.length} 条）` }
      return { ok: true, buttons }
    }

    /** 复制一份预设配置（避免直接改缓存对象）。 */
    function clonePresets(presets) {
      const p = presets ?? {}
      const modeOf = (key) => (p?.[key]?.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND)
      return {
        continue: {
          label: typeof p?.continue?.label === 'string' ? p.continue.label : DEFAULT_PRESET_LABELS.continue,
          text: typeof p?.continue?.text === 'string' ? p.continue.text : DEFAULT_CONTINUE_TEXT,
          mode: modeOf('continue'),
        },
        resend: {
          label: typeof p?.resend?.label === 'string' ? p.resend.label : DEFAULT_PRESET_LABELS.resend,
          mode: modeOf('resend'),
        },
      }
    }

    /**
     * 校验编辑器里的预设草稿。规则与宿主一致：
     * 标签非空、≤12 字、不换行；「继续」的文字非空、≤500 字、不换行。
     */
    function validatePresetDraft(draft) {
      const presets = clonePresets(draft)
      for (const key of PRESET_KEYS) {
        const name = key === 'continue' ? '继续' : '重发'
        const label = presets[key].label.trim()
        if (label === '') return { ok: false, message: `${name}：标签不能为空` }
        if (label.length > MAX_CUSTOM_LABEL) return { ok: false, message: `${name}：标签超过 ${MAX_CUSTOM_LABEL} 字` }
        if (/[\r\n]/.test(label)) return { ok: false, message: `${name}：标签不能换行` }
        if (presets[key].text !== undefined) {
          const text = presets[key].text.trim()
          if (text === '') return { ok: false, message: `${name}：文字不能为空` }
          if (text.length > MAX_CUSTOM_TEXT) return { ok: false, message: `${name}：文字超过 ${MAX_CUSTOM_TEXT} 字` }
          if (/[\r\n]/.test(text)) return { ok: false, message: `${name}：文字不能换行` }
        }
      }
      return { ok: true, presets }
    }

    const zh = {
      'continue.label': '继续',
      'continue.queued': '已排队 · 本轮结束后发送',
      'continue.sent': '已发送',
      'continue.submitted': '已提交',
      'continue.draft': '有草稿，未发送',
      'continue.drafted': '已填入，按回车',
      'continue.nosession': '没有打开的会话',
      'custom.manage': '＋',
      'custom.manageTitle': '编辑动作按钮（可改方式、排序、删除）',
      'custom.editorTitle': '动作按钮',
      'custom.hint': '一条一个动作：左边标签、右边文字；「直接发送」点一下就发出去，「填入输入框」只填到光标处。↑↓ 调整顺序。',
      'custom.labelPlaceholder': '标签',
      'custom.textPlaceholder': '要发送的文字',
      'custom.add': '＋ 添加一条',
      'custom.remove': '删除',
      'custom.moveUp': '上移',
      'custom.moveDown': '下移',
      'custom.restore': '恢复',
      'custom.sectionSend': '直接发送',
      'custom.sectionSendHint': '点一下就把文字发出去（有草稿时不发送）',
      'custom.sectionInsert': '填入输入框',
      'custom.sectionInsertHint': '只把文字填到光标处，不发送',
      'custom.modeSend': '直接发送',
      'custom.modeInsert': '填入',
      'custom.modeTitle': '点一下做什么',
      'custom.removeRow': '删除这条',
      'custom.presetRemove': '从按钮条移除「%s」',
      'custom.presetRestore': '恢复「%s」',
      'custom.addSend': '添加一条（发送）',
      'custom.addInsert': '添加一条（填入）',
      'custom.saveTitle': '保存到配置文件',
      'custom.cancelTitle': '放弃修改',
      'custom.closeTitle': '关闭编辑器',
      'custom.empty': '还没有按钮，点下面添加一条。',
      'custom.atLimit': '最多 8 条',
      'preset.continue.label': '继续',
      'preset.resend.label': '重发上一条',
      'preset.resend.dynamic': '最后一条我发的消息（动态）',
      'custom.save': '保存',
      'custom.cancel': '取消',
      'custom.saved': '已保存',
      'custom.sending': '已排队 · 本轮结束后发送',
      'custom.queued': '已排队 · 本轮结束后发送',
      'custom.sent': '已发送',
      'custom.submitted': '已提交',
      'custom.draft': '有草稿，未发送',
      'custom.drafted': '已填入，按回车',
      'custom.nosession': '没有打开的会话',
      'custom.inserted': '已填入',
      'custom.insertedEnd': '已填入末尾',
      'custom.insertFailed': '没填进去',
      'custom.loadFailed': '自定义按钮配置没读到',
      'resend.label': '重发上一条',
      'resend.title': '重发上一条：把最后一条我发的消息原样再发一次（只发文本）',
      'resend.sent': '已重发',
      'resend.queued': '已排队 · 本轮结束后发送',
      'resend.submitted': '已提交',
      'resend.drafted': '已填入，按回车',
      'resend.draft': '有草稿，未发送',
      'resend.none': '没有可重发的消息',
      'resend.nosession': '没有打开的会话',
      'insert.inserted': '已填入',
      'insert.insertedEnd': '已填入末尾',
      'insert.failed': '没填进去',
      'resend.insertTitle': '把最后一条我发的消息填到光标处，不发送',
    }
    const en = {
      'continue.label': 'Continue',
      'continue.queued': 'Queued — sends after this turn',
      'continue.sent': 'Sent',
      'continue.submitted': 'Submitted',
      'continue.draft': 'Draft present — not sent',
      'continue.drafted': 'Drafted — press Enter',
      'continue.nosession': 'No open session',
      'custom.manage': '+',
      'custom.manageTitle': 'Edit action buttons (change mode, reorder, remove)',
      'custom.editorTitle': 'Action buttons',
      'custom.hint': 'One action per row: label on the left, text on the right. "Send now" submits it; "Insert into composer" only puts it at the caret. Use ↑ ↓ to reorder.',
      'custom.labelPlaceholder': 'Label',
      'custom.textPlaceholder': 'Text to send',
      'custom.add': '+ Add one',
      'custom.remove': 'Remove',
      'custom.moveUp': 'Move up',
      'custom.moveDown': 'Move down',
      'custom.restore': 'Restore',
      'custom.sectionSend': 'Send now',
      'custom.sectionSendHint': 'One click sends the text (skipped while a draft exists)',
      'custom.sectionInsert': 'Insert into composer',
      'custom.sectionInsertHint': 'Puts the text at the caret only — nothing is sent',
      'custom.modeSend': 'Send now',
      'custom.modeInsert': 'Insert',
      'custom.modeTitle': 'What a click does',
      'custom.removeRow': 'Remove this row',
      'custom.presetRemove': 'Remove "%s" from the button bar',
      'custom.presetRestore': 'Restore "%s"',
      'custom.addSend': 'Add one (send)',
      'custom.addInsert': 'Add one (insert)',
      'custom.saveTitle': 'Save to the config file',
      'custom.cancelTitle': 'Discard changes',
      'custom.closeTitle': 'Close the editor',
      'custom.empty': 'No buttons yet — add one below.',
      'custom.atLimit': 'Up to 8',
      'preset.continue.label': 'Continue',
      'preset.resend.label': 'Resend last',
      'preset.resend.dynamic': 'Your last message (dynamic)',
      'custom.save': 'Save',
      'custom.cancel': 'Cancel',
      'custom.saved': 'Saved',
      'custom.sending': 'Queued — sends after this turn',
      'custom.queued': 'Queued — sends after this turn',
      'custom.sent': 'Sent',
      'custom.submitted': 'Submitted',
      'custom.draft': 'Draft present — not sent',
      'custom.drafted': 'Drafted — press Enter',
      'custom.nosession': 'No open session',
      'custom.inserted': 'Inserted',
      'custom.insertedEnd': 'Inserted at the end',
      'custom.insertFailed': 'Not inserted',
      'custom.loadFailed': 'Could not load custom buttons',
      'resend.label': 'Resend last',
      'resend.title': 'Resend the last message you sent (text only)',
      'resend.sent': 'Resent',
      'resend.queued': 'Queued — sends after this turn',
      'resend.submitted': 'Submitted',
      'resend.drafted': 'Drafted — press Enter',
      'resend.draft': 'Draft present — not sent',
      'resend.none': 'No message to resend',
      'resend.nosession': 'No open session',
      'insert.inserted': 'Inserted',
      'insert.insertedEnd': 'Inserted at the end',
      'insert.failed': 'Not inserted',
      'resend.insertTitle': 'Put your last message at the caret without sending',
    }

    /** 取 sessions 服务（旧宿主可能只有 `ctx.sessions` 代理）。 */
    function sessionsOf(ctx) {
      return ctx.get?.('sessions') ?? ctx.sessions
    }

    /**
     * 当前主视图里的会话 id。取不到就返回 undefined（按钮据此禁用，而不是抛错）。
     * @param {object} ctx cordis 上下文
     */
    function currentSessionId(ctx) {
      try {
        const sessions = sessionsOf(ctx)
        const state = sessions?.list?.getSnapshot?.()
        if (state === undefined) return undefined
        if (typeof state.current === 'string' && state.current !== '') return state.current
        for (const [sid, row] of Object.entries(state.byId ?? {})) {
          if ((row?.retainedBy?.mainView ?? 0) > 0) return sid
        }
        return undefined
      } catch {
        // 试探式读取：宿主快照形状不认识时按钮禁用即可，不把整条输入框带崩。
        return undefined
      }
    }

    /** 取当前会话的输入框门面（这些按钮共用）。 */
    function inputOf(ctx, sessionId) {
      const sessions = sessionsOf(ctx)
      const scope = sessions?.scope?.(sessionId)
      if (scope === undefined) return undefined
      const conversation = ctx.get?.('conversation') ?? ctx.conversation
      if (conversation === undefined) return undefined
      return conversation.input.for(scope)
    }

    /** 当前草稿文本；读不到就返回 ''（不因为宿主门面差异阻塞按钮）。 */
    function currentDraftOf(input) {
      try {
        const snapshot = input?.draftSnapshot
        if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.text === 'string') return snapshot.text
        if (typeof input?.snapshot?.draft === 'string') return input.snapshot.draft
      } catch { /* 试探式读取：旧宿主没有 draftSnapshot 时按空草稿处理 */ }
      return ''
    }

    /** 当前会话是否在跑；未知返回 undefined（提示只说“已提交”）。 */
    function runningOf(ctx, sessionId) {
      try {
        const sessions = sessionsOf(ctx)
        const running = sessions?.binding?.(sessionId)?.session?.getSnapshot?.()?.running
        return typeof running === 'boolean' ? running : undefined
      } catch { return undefined }
    }

    /**
     * 把一句话填进当前会话并提交（继续 / 自定义 / 重发共用这一半）。
     * 有草稿时直接返回 `draft-present`，不覆盖、不提交。
     * `running` 只是点击前的快照，供提示说“已发送/将排队/已提交”，不是事后观测。
     * @param {object} ctx cordis 上下文
     * @param {string} text 要发出去的字
     * @returns {{ok: boolean, submitted?: boolean, running?: boolean, why?: string}}
     */
    function sendText(ctx, text) {
      const sessionId = currentSessionId(ctx)
      if (sessionId === undefined) return { ok: false, why: 'no-session' }
      try {
        const input = inputOf(ctx, sessionId)
        if (input === undefined) return { ok: false, why: 'no-scope' }
        // 有草稿时绝不整段覆盖；按钮让位给用户先处理草稿（状态里会说“有草稿，未发送”）。
        if (currentDraftOf(input).trim() !== '') return { ok: false, why: 'draft-present' }
        // 只作提示用：宿主 submit() 不返回落点，忙态是点击前的快照，不是事后观测。
        const running = runningOf(ctx, sessionId)
        input.setDraft(text)
        // `submit()` 在有些版本上没有：那就只填草稿，用户按回车 —— 比"点了没反应"好。
        if (typeof input.submit === 'function') {
          input.submit()
          return { ok: true, submitted: true, running }
        }
        return { ok: true, submitted: false, running }
      } catch (e) {
        try { console.warn(`[${NAMESPACE}] 发送「${text}」失败：`, e) } catch { /* 控制台不可用就算了 */ }
        return { ok: false, why: 'threw' }
      }
    }

    /** 把发送结果折成提示状态；忙态未知时只说“已提交”，不猜去向。 */
    function sendStateOf(result) {
      if (result?.running === true) return 'queued'
      if (result?.running === false) return 'sent'
      return 'submitted'
    }

    /**
     * 把一段文字插入当前会话输入框的**光标处**，不提交。
     *
     * 用宿主公开的输入门面（`conversation.input.for(scope)`，与 `setDraft` 同一个对象）：
     *   - `caretSpan()`：当前选区（detect 坐标 `{ start, end }`；没有选区就是文档末尾）；
     *   - `snapshot.draftRev`：输入框内容版本号，`insertText` 拿它做 CAS；
     *   - `insertText(text, span)`：宿主自己的插入实现（`/` 斜杠菜单插入走同一条路径）。
     * 这样不用碰 DOM、不需要输入框有焦点也能知道光标在哪，撤销栈也留在宿主手里。
     *
     * 宿主太旧、没有这套 API 时退回「追加到草稿末尾」，并返回 `fallback: true`
     * （状态里会说「已填入末尾」，不假装插在光标处）。
     * @param {object} ctx cordis 上下文
     * @param {string} text 要填入的文字
     * @returns {{ok: true, fallback?: boolean} | {ok: false, why: string}}
     */
    function insertAtCaret(ctx, text) {
      const sessionId = currentSessionId(ctx)
      if (sessionId === undefined) return { ok: false, why: 'no-session' }
      try {
        const input = inputOf(ctx, sessionId)
        if (input === undefined) return { ok: false, why: 'no-scope' }
        const phase = input.snapshot?.phase
        if (phase === 'adjudicating' || phase === 'submitting') return { ok: false, why: 'busy' }
        const caret = typeof input.caretSpan === 'function' ? input.caretSpan() : null
        const draftRev = input.snapshot?.draftRev
        if (
          caret !== null && typeof caret === 'object'
          && Number.isInteger(caret.start) && Number.isInteger(caret.end)
          && Number.isInteger(draftRev) && typeof input.insertText === 'function'
        ) {
          const applied = input.insertText(text, { start: caret.start, end: caret.end, draftRev })
          if (applied === true) {
            // 焦点交回输入框：光标由宿主恢复在插入的文字之后，接着打字就行。
            // 给不回焦点不算插入失败（文字已经进去了）。
            if (typeof input.focus === 'function') {
              try { input.focus() } catch { /* 焦点还原失败不影响已插入的文字 */ }
            }
            return { ok: true }
          }
          return { ok: false, why: 'rejected' }
        }
        // 旧宿主：没有光标级插入 API —— 追加到草稿末尾（状态里会说明是末尾）。
        const draft = currentDraftOf(input)
        input.setDraft(draft === '' ? text : `${draft}\n${text}`)
        return { ok: true, fallback: true }
      } catch (e) {
        try { console.warn(`[${NAMESPACE}] 填入「${text}」失败：`, e) } catch { /* 控制台不可用就算了 */ }
        return { ok: false, why: 'threw' }
      }
    }

    /**
     * 「直接发送 / 填入」两种结果的统一提示后缀。
     * 发送的结果按前缀取各自文案（重新发送说“已重发”）；填入的三种结果大家共用。
     */
    function statusSuffix(t, prefix, state) {
      switch (state) {
        case 'queued': return t(`${prefix}.queued`)
        case 'sent': return t(`${prefix}.sent`)
        case 'submitted': return t(`${prefix}.submitted`)
        case 'draft': return t(`${prefix}.draft`)
        case 'drafted': return t(`${prefix}.drafted`)
        case 'none': return t(`${prefix}.none`)
        case 'nosession': return t(`${prefix}.nosession`)
        case 'inserted': return t('insert.inserted')
        case 'insertedEnd': return t('insert.insertedEnd')
        case 'failed': return t('insert.failed')
        default: return ''
      }
    }

    /** 填入结果 → 状态词；失败按原因归成「没会话 / 没填进去」。 */
    function insertStateOf(result) {
      if (result?.ok !== true) return result?.why === 'no-session' ? 'nosession' : 'failed'
      return result?.fallback === true ? 'insertedEnd' : 'inserted'
    }

    /**
     * 把一条 `user/message` 的 content 收成纯文本。
     * content 可能是裸字符串，也可能是块数组（只有 text 块是消息正文）。
     * @param {unknown} content
     * @returns {string}
     */
    function textOfContent(content) {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join('\n')
    }

    /**
     * 最后一条真人用户消息的文本；没有就返回 undefined。
     * @param {object} ctx cordis 上下文
     */
    function lastUserMessageText(ctx) {
      const sessionId = currentSessionId(ctx)
      if (sessionId === undefined) return undefined
      try {
        const sessions = sessionsOf(ctx)
        const binding = sessions?.binding?.(sessionId)
        const entries = binding?.eventSource?.getSnapshot?.()?.entries
        if (!Array.isArray(entries)) return undefined
        let latest
        for (const entry of entries) {
          const event = entry?.event
          if (event === undefined || event.type !== 'user/message') continue
          // 注入、引用、技能调用、压缩检查点都不是"我发的消息"。
          if (event.data?.source?.kind !== 'user') continue
          if (latest === undefined || (event.seq ?? 0) > (latest.seq ?? 0)) latest = event
        }
        if (latest === undefined) return undefined
        const text = textOfContent(latest.data?.content).trim()
        return text === '' ? undefined : text
      } catch {
        // 试探式读取：旧宿主没有 binding/eventSource 时按钮禁用，不影响输入框。
        return undefined
      }
    }

    /**
     * 把最后一条真人用户消息原样再发一条。有草稿时同样不覆盖。
     * @returns {{ok: boolean, submitted?: boolean, running?: boolean, why?: string}}
     */
    function resendLast(ctx) {
      if (currentSessionId(ctx) === undefined) return { ok: false, why: 'no-session' }
      const text = lastUserMessageText(ctx)
      if (text === undefined) return { ok: false, why: 'no-previous' }
      return sendText(ctx, text)
    }

    /** 浮层外观（自定义按钮编辑器用）：CSS 系统色，跟着宿主主题变。 */
    function editorStyle() {
      return {
        position: 'fixed',
        right: '18px',
        bottom: '92px',
        // border-box + 视口上限：不然 padding 会把 520px 撑成 548px，右侧"×"被窗口裁掉。
        // 520 是加了「方式下拉框 + ↑↓」之后的宽度；小屏仍按视口收缩。
        width: 'min(520px, calc(100vw - 36px))',
        maxHeight: '62vh',
        overflow: 'auto',
        boxSizing: 'border-box',
        borderRadius: '10px',
        padding: '12px 14px',
        background: 'Canvas',
        color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 22%, transparent)',
        boxShadow: '0 10px 30px rgba(0,0,0,.3)',
        // 根层叠上下文里的最大值：portal 到 body 之后用这个数才压得住宿主的浮动控件。
        zIndex: 2147483647,
        fontSize: '12px',
        lineHeight: '1.6',
        wordBreak: 'break-word',
      }
    }

    /**
     * 把浮层送到 `document.body`（React portal）。
     * 没有 react-dom、或不在浏览器里（离线单测）时原样返回，功能不受影响。
     */
    function editorLayer(node) {
      if (node === null || node === undefined) return null
      if (
        typeof ReactDOM?.createPortal === 'function'
        && typeof document !== 'undefined' && document.body !== undefined && document.body !== null
      ) {
        return ReactDOM.createPortal(node, document.body)
      }
      return node
    }

    /** 组件炸了就安静地不渲染，别把整条输入框带崩。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(error) {
        try { console.warn(`[${NAMESPACE}] 组件出错：`, error) } catch { /* 控制台不可用就算了 */ }
      }
      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    /** 两个按钮共用的外观（与宿主输入区的控件同高、透明底）。 */
    function actionStyle(canUse) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '26px',
        padding: '0 8px',
        marginRight: '4px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '1',
        cursor: canUse ? 'pointer' : 'not-allowed',
        opacity: canUse ? 1 : 0.5,
        whiteSpace: 'nowrap',
      }
    }

    return {
      name: NAMESPACE,
      // 只注入 slots（注册按钮必需）；locale 是可选的，代码里有中文回落 ——
      // 放进 inject 会让缺 locale 的 profile 整个插件 pending，三个按钮都消失。
      // sessions / conversation 在点击时按需取，同样不放进 inject。
      inject: ['slots'],
      apply(ctx) {
        // 两套文案：拿不到 locale 服务时回落中文（不影响功能）。
        let t = (key) => zh[key] ?? key
        try {
          if (typeof ctx.locale?.register === 'function') {
            ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), `${NAMESPACE}: dictionaries`)
          }
          if (typeof ctx.locale?.bind === 'function') t = ctx.locale.bind(NAMESPACE)
        } catch { /* 回落中文 */ }

        /**
         * 条上自定义动作的悬浮提示：只给文字预览（长文字截断），不再加「直接发送 / 填入输入框」前缀。
         * 点法看按钮边框（填入=虚线）和编辑器里的方式下拉，悬停只回答“会发什么字”。
         * 以后加第三类动作（脚本）时，如果要区分提示，在这里按 mode 加一行短后缀即可。
         */
        function customActionTitle(text) {
          return previewText(text)
        }

        /**
         * 造一个「点一下就做事」的按钮组件（目前只有「继续」用；自定义按钮直接复用同一套结果映射）。
         * 标签从配置读（`presetLabel`），点法从配置读（`presetMode`）：
         *   - `send`：发出去（`sendText`）；
         *   - `insert`：只填到光标处（`insertAtCaret`）。
         * @param {{className: string, prefix: string, preset?: string}} spec
         */
        function makeTriggerAction({ className, prefix, preset }) {
          return function TriggerAction() {
            // 被删掉的预设兜底不渲染（正常路径是由 syncPresets 注销整个格子）。
            if (preset !== undefined && presetHidden.has(preset)) return null
            const [state, setState] = React.useState('idle')
            // 这类按钮只要求"有当前会话"。
            const canUse = currentSessionId(ctx) !== undefined
            const label = preset !== undefined ? presetLabel(preset) : t(`${prefix}.label`)
            // 悬浮提示与自定义按钮同一条规则：只显示“会发出去的文字”（长文字截断）。
            const value = preset !== undefined ? presetText(preset) : t(`${prefix}.label`)
            const title = previewText(value)
            const insert = presetMode(preset) === MODE_INSERT
            const onClick = () => {
              if (insert) {
                setState(insertStateOf(insertAtCaret(ctx, value)))
              } else {
                const r = sendText(ctx, value)
                setState(r.ok
                  ? (r.submitted ? sendStateOf(r) : 'drafted')
                  : (r.why === 'draft-present' ? 'draft' : 'nosession'))
              }
              // 2.4s 够读完“已排队/已发送/已填入”；仍不占常驻位置
              try { setTimeout(() => setState('idle'), 2400) } catch { /* 定时器不可用就算了 */ }
            }
            const suffix = statusSuffix(t, prefix, state)
            const extra = suffix === '' ? '' : ` · ${suffix}`
            return h(
              'button',
              {
                type: 'button',
                className,
                title,
                'aria-label': title,
                disabled: !canUse,
                onClick,
                style: { ...actionStyle(canUse), borderStyle: insert ? 'dashed' : 'solid' },
              },
              `${label}${extra}`,
            )
          }
        }

        /**
         * 「自定义按钮」一格：平铺用户配置的按钮，末尾一个「＋」打开编辑器。
         * 多个按钮放在**同一个插槽格**里（一个组件渲染多个 button），所以配几个都不占额外 order。
         * 配置读写走宿主路由；读失败时仍然只显示「＋」（入口不能丢）。
         */
        function makeCustomActions(ctx) {
          function CustomActions() {
            const [buttons, setButtons] = React.useState(() => (customCache?.buttons ?? []))
            const [hiddenList, setHiddenList] = React.useState(() => [...(customCache?.hidden ?? [])])
            const [presetDraft, setPresetDraft] = React.useState(() => clonePresets(customCache?.presets))
            const [open, setOpen] = React.useState(false)
            const [rows, setRows] = React.useState(() => (customCache?.buttons ?? []).map((b) => ({
              label: b.label,
              text: b.text,
              mode: b.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND,
            })))
            const [error, setError] = React.useState('')
            const [note, setNote] = React.useState('')
            const canUse = currentSessionId(ctx) !== undefined

            // 首次渲染时拉一次配置；拿到后同步进 state（同一份缓存，之后的渲染不再请求）。
            ensureCustomButtons().then((cfg) => {
              if (JSON.stringify(cfg.buttons) !== JSON.stringify(buttons)) setButtons(cfg.buttons)
            })

            const send = (item) => {
              const key = item.mode === MODE_INSERT
                ? (() => {
                    const r = insertAtCaret(ctx, item.text)
                    return r.ok
                      ? (r.fallback ? 'custom.insertedEnd' : 'custom.inserted')
                      : (r.why === 'no-session' ? 'custom.nosession' : 'custom.insertFailed')
                  })()
                : (() => {
                    const r = sendText(ctx, item.text)
                    return r.ok
                      ? (r.submitted ? `custom.${sendStateOf(r)}` : 'custom.drafted')
                      : (r.why === 'draft-present' ? 'custom.draft' : 'custom.nosession')
                  })()
              setNote(t(key))
              try { setTimeout(() => setNote(''), 2400) } catch { /* 定时器不可用就算了 */ }
            }

            const openEditor = () => {
              // 行序 = 配置数组顺序；两区各自「添加一条」，所以空配置就真的空着。
              setRows(buttons.map((b) => ({ label: b.label, text: b.text, mode: b.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND })))
              setHiddenList([...(customCache?.hidden ?? presetHidden)])
              setPresetDraft(clonePresets(customCache?.presets))
              setError(customLoadError !== '' && buttons.length === 0
                ? `${t('custom.loadFailed')}：${customLoadError}`
                : '')
              setOpen(true)
            }

            const togglePreset = (key) => {
              setHiddenList(hiddenList.includes(key)
                ? hiddenList.filter((id) => id !== key)
                : [...hiddenList, key])
            }

            const updatePreset = (key, patch) => {
              setPresetDraft({ ...presetDraft, [key]: { ...presetDraft[key], ...patch } })
            }

            const updateRow = (index, patch) => {
              setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
            }

            const addRow = (mode) => {
              if (rows.length < MAX_CUSTOM) setRows([...rows, blankCustomRow(mode)])
            }

            const removeRow = (index) => {
              setRows(rows.filter((_, i) => i !== index))
            }

            /** ↑ / ↓：在本区里跟同区的邻居换位。函数式更新，连点几次也不会读到旧快照。 */
            const moveRowTo = (index, offset) => {
              setRows((current) => moveInSection(current, index, offset))
            }

            const save = () => {
              const parsed = validateCustomRows(rows)
              if (!parsed.ok) {
                setError(parsed.message)
                return
              }
              const presetsCheck = validatePresetDraft(presetDraft)
              if (!presetsCheck.ok) {
                setError(presetsCheck.message)
                return
              }
              saveCustomButtons(parsed.buttons, hiddenList, presetsCheck.presets)
                .then((cfg) => {
                  setButtons(cfg.buttons)
                  setHiddenList(cfg.hidden)
                  setPresetDraft(clonePresets(cfg.presets))
                  syncPresets(cfg.hidden)
                  remountPresets()
                  setOpen(false)
                  setNote(t('custom.saved'))
                })
                .catch((e) => setError(String((e && e.message) || e)))
            }

            const items = buttons.map((item, i) => {
              const insertItem = item.mode === MODE_INSERT
              const title = customActionTitle(item.text)
              return h(
                'button',
                {
                  key: `custom-${i}`,
                  type: 'button',
                  className: insertItem ? 'dsh-custom-action dsh-custom-action-insert' : 'dsh-custom-action',
                  title,
                  'aria-label': title,
                  disabled: !canUse,
                  onClick: () => send(item),
                  style: { ...actionStyle(canUse), borderStyle: insertItem ? 'dashed' : 'solid' },
                },
                item.label,
              )
            })

            const manage = h(
              'button',
              {
                type: 'button',
                className: 'dsh-custom-manage',
                title: t('custom.manageTitle'),
                'aria-label': t('custom.manageTitle'),
                onClick: openEditor,
                style: actionStyle(true),
              },
              t('custom.manage'),
            )

            const closeStyle = { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '14px' }
            const inputStyle = {
              font: 'inherit',
              fontSize: '12px',
              background: 'Canvas',
              color: 'CanvasText',
              border: '1px solid color-mix(in srgb, CanvasText 22%, transparent)',
              borderRadius: '6px',
              padding: '5px 7px',
              boxSizing: 'border-box',
              minWidth: 0,
            }
            /** ↑↓ 的小按钮：比 actionStyle 窄，不挤压两个输入框。 */
            const moveStyle = (disabled) => ({
              border: 0,
              background: 'transparent',
              color: 'inherit',
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.3 : 0.85,
              font: 'inherit',
              fontSize: '13px',
              lineHeight: '1',
              padding: '2px 3px',
              width: '20px',
              flex: '0 0 auto',
            })
            /** 方式下拉的两个选项：直接发送 / 填入。 */
            const modeOptions = [
              h('option', { key: 'send', value: MODE_SEND }, t('custom.modeSend')),
              h('option', { key: 'insert', value: MODE_INSERT }, t('custom.modeInsert')),
            ]
            /** 方式下拉框：切换后这一条会出现在另一个区（编辑器按方式分区）。 */
            const modeSelect = (value, onChange, className) => h(
              'select',
              {
                className,
                value: value === MODE_INSERT ? MODE_INSERT : MODE_SEND,
                title: t('custom.modeTitle'),
                'aria-label': t('custom.modeTitle'),
                onChange: (e) => onChange(e?.target?.value === MODE_INSERT ? MODE_INSERT : MODE_SEND),
                style: { ...inputStyle, width: '88px', flex: '0 0 auto', padding: '4px 4px' },
              },
              ...modeOptions,
            )
            const rowStyle = (extra) => ({ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px', ...extra })

            /** 一个预设行（继续 / 重发）；方式下拉决定它出现在哪一区。 */
            const presetRowOf = (key) => {
              const hiddenNow = hiddenList.includes(key)
              const draft = presetDraft[key]
              const mode = draft.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND
              const shownLabel = draft.label === '' ? t(`preset.${key}.label`) : draft.label
              const actionTitle = formatText(t(hiddenNow ? 'custom.presetRestore' : 'custom.presetRemove'), shownLabel)
              return h(
                'div',
                {
                  key: `preset-${key}`,
                  style: rowStyle({ opacity: hiddenNow ? 0.55 : 1 }),
                },
                h('input', {
                  className: `dsh-preset-label-input dsh-preset-${key}-label`,
                  value: draft.label,
                  placeholder: t('custom.labelPlaceholder'),
                  'aria-label': `${t(`preset.${key}.label`)}标签`,
                  disabled: hiddenNow,
                  onChange: (e) => updatePreset(key, { label: e?.target?.value ?? '' }),
                  style: { ...inputStyle, width: '96px', flex: '0 0 auto' },
                }),
                key === 'continue'
                  ? h('input', {
                      className: 'dsh-preset-text-input',
                      value: draft.text,
                      placeholder: t('custom.textPlaceholder'),
                      'aria-label': t('preset.continue.label'),
                      disabled: hiddenNow,
                      onChange: (e) => updatePreset(key, { text: e?.target?.value ?? '' }),
                      style: { ...inputStyle, flex: '1 1 auto' },
                    })
                  : h(
                      'div',
                      { className: 'dsh-preset-dynamic', style: { ...inputStyle, flex: '1 1 auto', opacity: 0.55, display: 'flex', alignItems: 'center' } },
                      t('preset.resend.dynamic'),
                    ),
                modeSelect(mode, (next) => updatePreset(key, { mode: next }), 'dsh-preset-mode'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: hiddenNow ? 'dsh-custom-preset-restore' : 'dsh-custom-preset-remove',
                    title: actionTitle,
                    'aria-label': actionTitle,
                    onClick: () => togglePreset(key),
                    style: { ...actionStyle(true), marginRight: 0 },
                  },
                  hiddenNow ? t('custom.restore') : t('custom.remove'),
                ),
              )
            }

            /** 一条自定义行；↑↓ 只跟本区的邻居换位。 */
            const customRowOf = (row, i) => {
              const upIndex = sectionNeighbor(rows, i, -1)
              const downIndex = sectionNeighbor(rows, i, 1)
              return h(
                'div',
                { key: `custom-row-${i}`, style: rowStyle() },
                h('input', {
                  className: 'dsh-custom-label-input',
                  value: row.label,
                  placeholder: t('custom.labelPlaceholder'),
                  'aria-label': t('custom.labelPlaceholder'),
                  onChange: (e) => updateRow(i, { label: e?.target?.value ?? '' }),
                  style: { ...inputStyle, width: '96px', flex: '0 0 auto' },
                }),
                h('input', {
                  className: 'dsh-custom-text-input',
                  value: row.text,
                  placeholder: t('custom.textPlaceholder'),
                  'aria-label': t('custom.textPlaceholder'),
                  onChange: (e) => updateRow(i, { text: e?.target?.value ?? '' }),
                  style: { ...inputStyle, flex: '1 1 auto' },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-custom-up',
                    title: t('custom.moveUp'),
                    'aria-label': t('custom.moveUp'),
                    disabled: upIndex < 0,
                    onClick: () => moveRowTo(i, -1),
                    style: moveStyle(upIndex < 0),
                  },
                  '↑',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-custom-down',
                    title: t('custom.moveDown'),
                    'aria-label': t('custom.moveDown'),
                    disabled: downIndex < 0,
                    onClick: () => moveRowTo(i, 1),
                    style: moveStyle(downIndex < 0),
                  },
                  '↓',
                ),
                modeSelect(row.mode, (next) => updateRow(i, { mode: next }), 'dsh-custom-mode'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-custom-remove',
                    title: t('custom.removeRow'),
                    'aria-label': t('custom.removeRow'),
                    onClick: () => removeRow(i),
                    style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '14px', padding: '0 4px' },
                  },
                  '×',
                ),
              )
            }

            /** 每区一个「添加一条」：新行的方式跟着这一区走。 */
            const addButtonOf = (mode, className) => {
              const title = t(mode === MODE_INSERT ? 'custom.addInsert' : 'custom.addSend')
              return h(
                'button',
                {
                  type: 'button',
                  className,
                  title,
                  'aria-label': title,
                  disabled: rows.length >= MAX_CUSTOM,
                  onClick: () => addRow(mode),
                  style: { ...actionStyle(rows.length < MAX_CUSTOM), marginTop: '8px' },
                },
                rows.length >= MAX_CUSTOM ? t('custom.atLimit') : t('custom.add'),
              )
            }

            /** 一个分区：标题 + 说明 + 行 + （空提示）+ 添加按钮。 */
            const sectionOf = (className, title, hint, children, addButton) => h(
              'div',
              { className },
              h('div', { style: { fontWeight: 600, opacity: 0.85, marginTop: '10px' } }, title),
              h('div', { style: { opacity: 0.6, marginTop: '2px' } }, hint),
              ...children,
              children.length === 0 ? h('div', { style: { opacity: 0.6, marginTop: '8px' } }, t('custom.empty')) : null,
              addButton,
            )

            const sendRows = []
            const insertRows = []
            for (const key of PRESET_KEYS) {
              const mode = presetDraft[key]?.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND
              const target = mode === MODE_INSERT ? insertRows : sendRows
              target.push(presetRowOf(key))
            }
            rows.forEach((row, i) => {
              const target = row.mode === MODE_INSERT ? insertRows : sendRows
              target.push(customRowOf(row, i))
            })

            const editor = open
              ? editorLayer(h(
                  'div',
                  { style: editorStyle() },
                  h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                    h('strong', null, t('custom.editorTitle')),
                    h('button', {
                      type: 'button',
                      className: 'dsh-custom-close',
                      title: t('custom.closeTitle'),
                      'aria-label': t('custom.closeTitle'),
                      onClick: () => setOpen(false),
                      style: closeStyle,
                    }, '×'),
                  ),
                  h('div', { style: { opacity: 0.65, marginTop: '4px' } }, t('custom.hint')),
                  sectionOf('dsh-section-send', t('custom.sectionSend'), t('custom.sectionSendHint'), sendRows, addButtonOf(MODE_SEND, 'dsh-custom-add-send')),
                  sectionOf('dsh-section-insert', t('custom.sectionInsert'), t('custom.sectionInsertHint'), insertRows, addButtonOf(MODE_INSERT, 'dsh-custom-add-insert')),
                  error !== '' ? h('div', { style: { color: 'crimson', marginTop: '6px' } }, error) : null,
                  h(
                    'div',
                    { style: { marginTop: '8px', display: 'flex', gap: '8px' } },
                    h('button', {
                      type: 'button',
                      className: 'dsh-custom-save',
                      title: t('custom.saveTitle'),
                      'aria-label': t('custom.saveTitle'),
                      onClick: save,
                      style: actionStyle(true),
                    }, t('custom.save')),
                    h('button', {
                      type: 'button',
                      className: 'dsh-custom-cancel',
                      title: t('custom.cancelTitle'),
                      'aria-label': t('custom.cancelTitle'),
                      onClick: () => setOpen(false),
                      style: actionStyle(true),
                    }, t('custom.cancel')),
                  ),
                ))
              : null

            return h(
              React.Fragment,
              null,
              ...items,
              manage,
              note !== '' ? h('span', { style: { opacity: 0.6, fontSize: '11px', marginRight: '4px' } }, note) : null,
              editor,
            )
          }
          return CustomActions
        }

        const ContinueAction = makeTriggerAction({
          className: 'dsh-continue-action',
          prefix: 'continue',
          preset: 'continue',
        })

        /** 自定义按钮要拿到 `ctx`（组件定义在 apply 内，才能按需取会话）。 */
        const CustomActions = makeCustomActions(ctx)

        function ResendAction() {
          // 被删掉的预设兜底不渲染（正常路径是由 syncPresets 注销整个格子）。
          if (presetHidden.has('resend')) return null
          const [state, setState] = React.useState('idle')
          // 渲染时读一次快照：没有可重发的消息就禁用。
          const canUse = lastUserMessageText(ctx) !== undefined
          const insert = presetMode('resend') === MODE_INSERT
          const onClick = () => {
            if (insert) {
              // 填入模式：把最后一条真人消息塞进光标处，编辑完再自己发。
              const text = lastUserMessageText(ctx)
              if (text === undefined) {
                setState('none')
              } else {
                const r = insertAtCaret(ctx, text)
                setState(r.ok
                  ? (r.fallback ? 'insertedEnd' : 'inserted')
                  : (r.why === 'no-session' ? 'nosession' : 'failed'))
              }
            } else {
              const r = resendLast(ctx)
              if (!r.ok) setState(r.why === 'draft-present' ? 'draft' : (r.why === 'no-session' ? 'nosession' : 'none'))
              else setState(r.submitted ? sendStateOf(r) : 'drafted')
            }
            try { setTimeout(() => setState('idle'), 2400) } catch { /* 定时器不可用就算了 */ }
          }
          const suffix = statusSuffix(t, 'resend', state)
          const extra = suffix === '' ? '' : ` · ${suffix}`
          const title = t(insert ? 'resend.insertTitle' : 'resend.title')
          return h(
            'button',
            {
              type: 'button',
              className: 'dsh-resend-action',
              title,
              'aria-label': title,
              disabled: !canUse,
              onClick,
              style: { ...actionStyle(canUse), borderStyle: insert ? 'dashed' : 'solid' },
            },
            `${presetLabel('resend')}${extra}`,
          )
        }

        /** 注册一个组件到指定插槽；返回 disposer。`id` 是这个格子的键（同插槽两格必须不同）。 */
        function seat(slot, id, order, Component) {
          const dispose = ctx.slots.inject(slot, () =>
            ctx.slots.register(
              { name: slot, id, order },
              function Seat() {
                return h(Boundary, null, h(Component, null))
              },
            ),
          )
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => dispose, `${NAMESPACE}: ${id}`)
          }
          return dispose
        }

        /**
         * 预设格子的动态装卸：用户删掉的预设要从插槽里**真的移除**（不只是渲染 null），
         * 恢复时再注册回来。`presetSeats` 记录已挂载的 disposer。
         */
        const presetSeats = new Map()
        const presetSpecs = {
          continue: { slot: SLOT_CONTINUE, id: ID_CONTINUE, order: ORDER_CONTINUE, Component: ContinueAction },
          resend: { slot: SLOT_RESEND, id: ID_RESEND, order: ORDER_RESEND, Component: ResendAction },
        }
        function mountPreset(key) {
          if (presetSeats.has(key)) return
          const spec = presetSpecs[key]
          presetSeats.set(key, seat(spec.slot, spec.id, spec.order, spec.Component))
        }
        function unmountPreset(key) {
          const dispose = presetSeats.get(key)
          if (dispose === undefined) return
          dispose()
          presetSeats.delete(key)
        }
        function syncPresets(hidden) {
          presetHidden = new Set(hidden)
          for (const key of PRESET_KEYS) {
            if (presetHidden.has(key)) unmountPreset(key)
            else mountPreset(key)
          }
        }
        /** 标签/文字改过后重新挂载可见预设，让按钮显示新文案（配置刚落地时也会走一次）。 */
        function remountPresets() {
          for (const key of PRESET_KEYS) {
            if (!presetHidden.has(key)) {
              unmountPreset(key)
              mountPreset(key)
            }
          }
        }

        // 首帧先全注册（不等配置，避免闪动），配置到达后再按 hidden 调整、并刷新文案。
        syncPresets([])
        seat(SLOT_CUSTOM, ID_CUSTOM, ORDER_CUSTOM, CustomActions)
        ensureCustomButtons().then((cfg) => {
          syncPresets(cfg.hidden)
          remountPresets()
        })
      },
      /** 仅供单测的纯函数（不是公开 API，宿主不读）。 */
      __internals: { blankCustomRow, moveRow, moveInSection, sectionNeighbor, validateCustomRows, validatePresetDraft, clonePresets, sendText, insertAtCaret, MAX_CUSTOM },
    }
  },
})
