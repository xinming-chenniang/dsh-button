/**
 * dsh-button —— 客户端半部：输入框上方那一行动作。
 *
 * 所有动作（继续 / 自定义 / 重发）都在 `conversation.input.dock` 里由同一个组件渲染成一行：
 *   左侧 = 「插入文字」类（对着输入框的附件键）
 *   右侧 = 「直接发送」类（对着输入框的发送键），末尾是「＋」编辑器入口。
 * 这样输入框的控件行只留附件、权限、模型和发送键，模型名不再被按钮挤掉。
 *
 * 「继续」默认把「继续」两个字发进当前会话（"没异议、往下走"的通用答复）；
 * 「自定义」是用户自己配的按钮（标签 + 文字），配置在宿主侧 JSON，末尾「＋」打开编辑器；
 * 「重发上一条」把最后一条**真人**用户消息原样再发一条。
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
     * 三种显示方案（编辑器里的「动作行位置」，localStorage 记住）：
     *   below 卡片下方（B1：portal 到 `[data-composer-dock]` 前面，整行）
     *   card  卡片底部（append 进卡片，控制行下面）
     *   bar   控制行（两格：insert 进 input.left，send + ＋ 进 input.right）
     * below/card 是同一格 dock；bar 换成两个公开插槽，所以切换会重新注册格子。
     */
    const SLOT_DOCK = 'conversation.composer.dock'
    const SLOT_INSERT = 'conversation.input.left'
    const SLOT_SEND = 'conversation.input.right'
    const ORDER_DOCK = 10
    const ORDER_INSERT = 4
    const ORDER_SEND = 5
    const ID_ACTIONS = `${NAMESPACE}:actions`
    const ID_INSERT = `${NAMESPACE}:insert`
    const ID_SEND = `${NAMESPACE}:send`
    const LAYOUTS = ['below', 'card', 'bar']
    const DEFAULT_LAYOUT = 'bar'
    const LAYOUT_KEY = 'dsh-button:layout'

    function readActionLayout() {
      try {
        const value = globalThis.localStorage?.getItem(LAYOUT_KEY)
        if (LAYOUTS.includes(value)) return value
      } catch { /* localStorage 不可用就用默认值 */ }
      return DEFAULT_LAYOUT
    }

    function writeActionLayout(layout) {
      try { globalThis.localStorage?.setItem(LAYOUT_KEY, layout) } catch { /* 存不下就不存 */ }
    }

    /** 模型「只显示图标」的实验开关：localStorage 记住，用宿主内部 CSS 变量强制收起。 */
    const MODEL_COMPACT_KEY = 'dsh-button:model-compact'
    function readModelCompact() {
      try {
        const value = globalThis.localStorage?.getItem(MODEL_COMPACT_KEY)
        return value === null || value === undefined ? true : value === '1'
      } catch { return true }
    }
    function writeModelCompact(enabled) {
      try { globalThis.localStorage?.setItem(MODEL_COMPACT_KEY, enabled ? '1' : '0') } catch { /* 存不下就不存 */ }
    }
    let modelCompactStyle = false
    function applyModelCompact(enabled) {
      if (typeof document === 'undefined' || document.documentElement === undefined || document.documentElement === null) return
      if (!modelCompactStyle && typeof document.createElement === 'function' && document.head !== undefined && document.head !== null) {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-button', 'model-compact')
        style.textContent = 'html[data-dsh-button-model-compact]{--dsh-composer-model-text-display:none;--dsh-composer-model-icon-display:block}'
        document.head.appendChild(style)
        modelCompactStyle = true
      }
      if (enabled) document.documentElement.setAttribute('data-dsh-button-model-compact', '')
      else document.documentElement.removeAttribute('data-dsh-button-model-compact')
    }

    /** 动作条按钮大小：只影响动作条，不动设置面板里的控件。 */
    const SIZE_KEY = 'dsh-button:size'
    const SIZES = ['compact', 'standard', 'large']
    function readActionSize() {
      try {
        const value = globalThis.localStorage?.getItem(SIZE_KEY)
        if (SIZES.includes(value)) return value
      } catch { /* localStorage 不可用就用大号 */ }
      return 'large'
    }
    function writeActionSize(size) {
      try { globalThis.localStorage?.setItem(SIZE_KEY, size) } catch { /* 存不下就不存 */ }
    }
    let actionSizeStyle = false
    function applyActionSize(size) {
      const value = SIZES.includes(size) ? size : 'standard'
      if (typeof document === 'undefined' || document.documentElement === undefined || document.documentElement === null) return
      if (!actionSizeStyle && typeof document.createElement === 'function' && document.head !== undefined && document.head !== null) {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-button', 'action-size')
        style.textContent = 'html[data-dsh-button-size="compact"]{--dsh-btn-h:22px;--dsh-btn-px:6px;--dsh-btn-fs:11px;--dsh-btn-radius:5px}html[data-dsh-button-size="large"]{--dsh-btn-h:30px;--dsh-btn-px:10px;--dsh-btn-fs:13px;--dsh-btn-radius:7px}'
        document.head.appendChild(style)
        actionSizeStyle = true
      }
      if (value === 'standard') document.documentElement.removeAttribute('data-dsh-button-size')
      else document.documentElement.setAttribute('data-dsh-button-size', value)
    }

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

    /**
     * B1 落点：卡片和统计行之间的宿主容器。
     * 在 `[data-composer-dock]` 前面插一个自己的 block 容器并复用；行 portal 进去，
     * 就落在卡片下方、统计上方；card 模式则 append 进卡片（控制行下面）。
     * 找不到宿主（单测/旧宿主）返回 null，调用方退回原地渲染。
     */
    function actionRowHost(layout) {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
      const dock = document.querySelector('[data-composer-dock]')
      if (dock === null || dock.parentElement === null) return null
      const mode = layout === 'card' ? 'card' : 'below'
      const parent = mode === 'card' ? dock.previousElementSibling : dock.parentElement
      if (parent === null || parent === undefined) return null
      if (parent.children !== undefined) {
        for (let i = 0; i < parent.children.length; i++) {
          const child = parent.children[i]
          if (child !== null && typeof child.hasAttribute === 'function' && child.getAttribute?.('data-dsh-action-row') === mode) return child
        }
      }
      if (typeof document.createElement !== 'function') return null
      const host = document.createElement('div')
      host.setAttribute('data-dsh-action-row', mode)
      host.style.display = 'flex'
      host.style.flexDirection = 'column'
      if (mode === 'card') {
        if (typeof parent.appendChild !== 'function') return null
        host.style.width = '100%'
        host.style.boxSizing = 'border-box'
        host.style.padding = '0 8px 6px'
        parent.appendChild(host)
      } else {
        if (typeof parent.insertBefore !== 'function') return null
        // composer 根是 flex column + align-items:center；宿主块必须自己撑满，行才能和卡片同宽。
        host.style.width = '100%'
        host.style.maxWidth = 'var(--dsh-composer-card-max-width, 100%)'
        host.style.margin = '0 auto'
        parent.insertBefore(host, dock)
      }
      return host
    }

    /** 切布局/重新注册前清掉旧宿主容器，避免残留空行。 */
    function removeActionHosts() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
      const hosts = document.querySelectorAll('[data-dsh-action-row]')
      for (const host of hosts) host.remove?.()
    }

    function buttonsUrl() {
      try {
        const origin = globalThis.location?.origin
        return origin && origin !== 'null' ? `${origin}${BUTTONS_URL}` : BUTTONS_URL
      } catch {
        return BUTTONS_URL
      }
    }

    /** 所有动作都是普通按钮；旧 `presets.continue` 在读取时并成第一条。 */
    let customCache // { buttons: Array<{label,text,mode}> }
    let customLoad
    let customLoadError = ''

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

    const DEFAULT_CONTINUE_LABEL = '继续'
    const DEFAULT_CONTINUE_TEXT = '继续'
    /** 两种点法（与宿主 `MODES` 一致）：`send` 直接发送，`insert` 只填进输入框。 */
    const MODE_SEND = 'send'
    const MODE_INSERT = 'insert'

    /**
     * 把路由 payload 收成 `{ buttons }`。
     * 旧配置的 `presets.continue` 并成第一条普通按钮；`hidden: ['continue']` 表示已经并过/用户删了，
     * 不再补。`presets.resend` 已废弃，忽略。
     */
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
      const hidden = Array.isArray(payload?.hidden) ? payload.hidden : []
      const preset = payload?.presets?.continue !== null && typeof payload?.presets?.continue === 'object'
        ? payload.presets.continue
        : {}
      const label = typeof preset.label === 'string' && preset.label.trim() !== '' ? preset.label.trim() : DEFAULT_CONTINUE_LABEL
      const text = typeof preset.text === 'string' && preset.text.trim() !== '' ? preset.text.trim() : DEFAULT_CONTINUE_TEXT
      const mode = preset.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND
      if (!hidden.includes('continue') && buttons.length < MAX_CUSTOM && !buttons.some((item) => item.label === label && item.text === text)) {
        buttons.unshift({ label, text, mode })
      }
      return { buttons }
    }

    /** 读一次配置；失败记下原因并按空配置继续（「＋」入口仍然可用）。 */
    function ensureCustomButtons() {
      if (customCache !== undefined) return Promise.resolve(customCache)
      if (customLoad === undefined) {
        customLoad = requestButtons({ method: 'GET', headers: { accept: 'application/json' } })
          .then((payload) => {
            customCache = normalizeConfig(payload)
            customLoadError = ''
            return customCache
          })
          .catch((e) => {
            customCache = normalizeConfig({ buttons: [] })
            customLoadError = String((e && e.message) || e)
            return customCache
          })
          .finally(() => {
            customLoad = undefined
          })
      }
      return customLoad
    }

    /**
     * 保存配置。写盘时把 `hidden: ['continue']` 一起带上：旧宿主保留预设字段，
     * 但下一次读取不会再补一条继续 —— 继续已经作为普通按钮存在数组里。
     */
    async function saveCustomButtons(list) {
      const payload = await requestButtons({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ buttons: list, hidden: ['continue'] }),
      })
      customCache = normalizeConfig(payload)
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

    const zh = {
      'continue.label': '继续',
      'continue.queued': '已排队 · 本轮结束后发送',
      'continue.sent': '已发送',
      'continue.submitted': '已提交',
      'continue.draft': '有草稿，未发送',
      'continue.drafted': '已填入，按回车',
      'continue.nosession': '没有打开的会话',
      'custom.manage': '⋮',
      'custom.manageTitle': '设置',
      'custom.editorTitle': '设置',
      'custom.dragHint': '拖动标题栏移动面板；双击标题栏复位',
      'custom.dragHintShort': '双击标题栏可复位',
      'custom.hint': '一条一个动作：左边标签、右边文字；「直接发送」点一下就发出去，「填入输入框」只填到光标处。↑↓ 调整顺序。',
      'custom.layoutTitle': '位置',
      'custom.layoutHint': '切换会关闭编辑器，未保存的修改会丢失；控制行是两格：插入在左、发送在右。',
      'custom.layoutBelow': '卡片下方',
      'custom.layoutCard': '卡片底部',
      'custom.layoutBar': '控制行（会挤模型）',
      'custom.modelCompact': '模型只显示图标（实验）',
      'custom.modelCompactTitle': '强制模型选择器收起成图标；依赖宿主内部 CSS 变量，DSH 升级后可能失效',
      'custom.sizeTitle': '按钮大小',
      'custom.sizeHint': '只影响动作条按钮；设置面板控件保持标准大小',
      'custom.sizeCompact': '紧凑',
      'custom.sizeStandard': '标准',
      'custom.sizeLarge': '大',
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
      'custom.modeSend': '发送',
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
      'custom.manage': '⋮',
      'custom.manageTitle': 'Settings',
      'custom.editorTitle': 'Settings',
      'custom.dragHint': 'Drag the title bar to move the panel; double-click it to reset',
      'custom.dragHintShort': 'Double-click the title bar to reset',
      'custom.hint': 'One action per row: label on the left, text on the right. "Send now" submits it; "Insert into composer" only puts it at the caret. Use ↑ ↓ to reorder.',
      'custom.layoutTitle': 'Position',
      'custom.layoutHint': 'Switching closes the editor and discards unsaved changes. Control row uses two cells: insert left, send right.',
      'custom.layoutBelow': 'Below card',
      'custom.layoutCard': 'Card bottom',
      'custom.layoutBar': 'Control row (may squeeze model)',
      'custom.modelCompact': 'Model icon only (experimental)',
      'custom.modelCompactTitle': 'Force the model selector to collapse to its icon; depends on host CSS variables and may break after a DSH upgrade',
      'custom.sizeTitle': 'Button size',
      'custom.sizeHint': 'Affects action-bar buttons only; the settings panel stays standard',
      'custom.sizeCompact': 'Compact',
      'custom.sizeStandard': 'Standard',
      'custom.sizeLarge': 'Large',
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
      'custom.modeSend': 'Send',
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
     * 内容框里的转义写法（执行时才解码，编辑框里保持可读的 `\n`）：
     *   \n（或 /n）→ 真换行；\t（或 /t）→ 制表；\\ → 一个反斜杠。
     * 其它反斜杠组合原样保留。
     */
    function decodeActionText(text) {
      return String(typeof text === 'string' ? text : '')
        .replace(/\\(n|t|\\)/g, (_, ch) => {
          if (ch === 'n') return '\n'
          if (ch === 't') return '\t'
          return '\\'
        })
        .replace(/\/(n|t)/g, (_, ch) => (ch === 'n' ? '\n' : '\t'))
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
          // 多行文本走 setDraft：宿主会把 \n 拆成段落，插入后能真正换行；
          // insertText 只往 TextNode 里塞原始 \n，排版不一定生效。
          const draft = currentDraftOf(input)
          if (text.includes('\n') && typeof input.setDraft === 'function') {
            const next = `${draft.slice(0, caret.start)}${text}${draft.slice(caret.end)}`
            input.setDraft(next)
            if (typeof input.focus === 'function') {
              try { input.focus() } catch { /* 焦点还原失败不影响已插入的文字 */ }
            }
            const atEnd = caret.start >= draft.length && caret.end >= draft.length
            return atEnd ? { ok: true } : { ok: true, fallback: true }
          }
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

    /** 设置浮层拖过之后的位置（localStorage）：`{ left, top }`；没拖过就是 null（仍用右下角默认位）。 */
    const EDITOR_POS_KEY = 'dsh-button:editor-pos'
    /** 拖动时四周至少留这么多像素，保证标题栏始终抓得到。 */
    const EDITOR_MARGIN = 8

    function readEditorPos() {
      try {
        const raw = globalThis.localStorage?.getItem(EDITOR_POS_KEY)
        if (typeof raw !== 'string' || raw === '') return null
        const value = JSON.parse(raw)
        if (value === null || typeof value !== 'object') return null
        const left = Number(value.left)
        const top = Number(value.top)
        if (!Number.isFinite(left) || !Number.isFinite(top)) return null
        return { left, top }
      } catch { return null }
    }

    function writeEditorPos(pos) {
      try {
        if (pos === null) {
          globalThis.localStorage?.removeItem?.(EDITOR_POS_KEY)
          return
        }
        globalThis.localStorage?.setItem(EDITOR_POS_KEY, JSON.stringify({ left: Math.round(pos.left), top: Math.round(pos.top) }))
      } catch { /* 存不下就不存 */ }
    }

    /** 视口尺寸；取不到（离线单测）按 1024×768 估。 */
    function viewportSize() {
      const width = Number(globalThis.window?.innerWidth)
      const height = Number(globalThis.window?.innerHeight)
      return {
        width: Number.isFinite(width) && width > 0 ? width : 1024,
        height: Number.isFinite(height) && height > 0 ? height : 768,
      }
    }

    /** 把位置夹回视口：面板整块尽量可见，至少露出标题栏。 */
    function clampEditorPos(pos, size, viewport) {
      const maxLeft = Math.max(EDITOR_MARGIN, viewport.width - Math.min(size.width, viewport.width) - EDITOR_MARGIN)
      const maxTop = Math.max(EDITOR_MARGIN, viewport.height - Math.min(size.height, viewport.height) - EDITOR_MARGIN)
      return {
        left: Math.min(Math.max(pos.left, EDITOR_MARGIN), maxLeft),
        top: Math.min(Math.max(pos.top, EDITOR_MARGIN), maxTop),
      }
    }

    /** 当前拖动（模块级：同一时刻只有一个设置浮层，不需要 ref 也能跨渲染保持）。 */
    let editorDrag = null

    /** 浮层外观（自定义按钮编辑器用）：CSS 系统色，跟着宿主主题变。传了位置就用 left/top，否则仍是右下角。 */
    function editorStyle(pos) {
      if (pos !== null && pos !== undefined) {
        return { ...editorStyleBase(), left: `${Math.round(pos.left)}px`, top: `${Math.round(pos.top)}px`, right: 'auto', bottom: 'auto' }
      }
      return editorStyleBase()
    }

    function editorStyleBase() {
      return {
        position: 'fixed',
        right: '18px',
        bottom: '92px',
        width: 'min(640px, calc(100vw - 36px))',
        maxHeight: 'min(78vh, 720px)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxSizing: 'border-box',
        borderRadius: '12px',
        padding: 0,
        background: 'Canvas',
        color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 22%, transparent)',
        boxShadow: '0 16px 48px rgba(0,0,0,.35)',
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

    /** 动作条按钮：高度/内边距/字号/圆角跟随「按钮大小」设置，面板控件保持标准。 */
    function barActionStyle(canUse) {
      return {
        ...actionStyle(canUse),
        height: 'var(--dsh-btn-h, 26px)',
        padding: '0 var(--dsh-btn-px, 8px)',
        fontSize: 'var(--dsh-btn-fs, 12px)',
        borderRadius: 'var(--dsh-btn-radius, 6px)',
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
         * 输入框上方的动作行：左边放「插入文字」类，右边放「直接发送」类，
         * 末尾「＋」打开编辑器。整行是一个插槽格，所以配几条都不占额外 order。
         * 配置读写走宿主路由；读失败时仍然只显示「＋」（入口不能丢）。
         */
        function makeActionPanel(ctx, kind, layout, setLayout, onSaved) {
          function ActionPanel() {
            const initialButtons = () => (customCache?.buttons ?? normalizeConfig({ buttons: [] }).buttons)
            const [buttons, setButtons] = React.useState(initialButtons)
            const [open, setOpen] = React.useState(false)
            const [rows, setRows] = React.useState(() => initialButtons().map((b) => ({
              label: b.label,
              text: b.text,
              mode: b.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND,
            })))
            const [error, setError] = React.useState('')
            const [statuses, setStatuses] = React.useState({})
            const [modelCompact, setModelCompact] = React.useState(readModelCompact)
            const [actionSize, setActionSize] = React.useState(readActionSize)
            const [editorPos, setEditorPos] = React.useState(readEditorPos)
            /** 每次打开面板后、第一次真的拖动结束时，在标题栏浮一条「双击可复位」的提示。 */
            const [dragHint, setDragHint] = React.useState(false)
            const [dragHintShown, setDragHintShown] = React.useState(false)
            const canUse = currentSessionId(ctx) !== undefined

            /** 从标题栏拖动面板：按下记起点与矩形，移动时夹回视口并立即记住。 */
            const onHeaderPointerDown = (event) => {
              if (event?.button !== undefined && event.button !== 0) return
              const tag = event?.target?.tagName
              if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT') return
              const header = event?.currentTarget
              const panel = header?.parentElement
              if (panel === null || panel === undefined || typeof panel.getBoundingClientRect !== 'function') return
              const rect = panel.getBoundingClientRect()
              editorDrag = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              }
              try { header.setPointerCapture?.(event.pointerId) } catch { /* 不支持指针捕获时，指针离开标题栏就停止拖动 */ }
              event.preventDefault?.()
            }
            const onHeaderPointerMove = (event) => {
              if (editorDrag === null) return
              if (editorDrag.pointerId !== undefined && event?.pointerId !== undefined && event.pointerId !== editorDrag.pointerId) return
              editorDrag.moved = true
              const next = clampEditorPos(
                {
                  left: editorDrag.left + (event.clientX - editorDrag.startX),
                  top: editorDrag.top + (event.clientY - editorDrag.startY),
                },
                { width: editorDrag.width, height: editorDrag.height },
                viewportSize(),
              )
              setEditorPos(next)
              writeEditorPos(next)
            }
            const endHeaderDrag = () => {
              const moved = editorDrag?.moved === true
              editorDrag = null
              // 只提示一次：这次打开面板后的第一次「真的拖动」结束时浮出来，2.6s 后自己消失。
              if (!moved || dragHintShown) return
              setDragHintShown(true)
              setDragHint(true)
              try { setTimeout(() => setDragHint(false), 2600) } catch { /* 定时器不可用就让它一直显示 */ }
            }
            const resetEditorPos = () => {
              setEditorPos(null)
              writeEditorPos(null)
              editorDrag = null
            }

            // 首次渲染时拉一次配置；每个面板各自同步，bar 的左右两格才不会一快一慢。
            ensureCustomButtons().then((cfg) => {
              if (open) return
              if (JSON.stringify(cfg.buttons) !== JSON.stringify(buttons)) setButtons(cfg.buttons)
            })

            /** 点完某个动作后的短提示：只在本按钮上停留 2.4s。 */
            const flashStatus = (id, state) => {
              setStatuses((prev) => ({ ...prev, [id]: state }))
              try {
                setTimeout(() => setStatuses((prev) => {
                  if (prev[id] !== state) return prev
                  const next = { ...prev }
                  delete next[id]
                  return next
                }), 2400)
              } catch { /* 定时器不可用就算了 */ }
            }
            const suffixFor = (prefix, id) => {
              const suffix = statusSuffix(t, prefix, statuses[id] ?? 'idle')
              return suffix === '' ? '' : ` · ${suffix}`
            }


            /** 自定义动作：标签 + 文字，按自己的 mode 发或填。 */
            const buildCustom = (item, i) => {
              const insertItem = item.mode === MODE_INSERT
              const id = `custom-${i}`
              const text = decodeActionText(item.text)
              const title = customActionTitle(text)
              const suffix = suffixFor('custom', id)
              return h(
                'button',
                {
                  key: id,
                  type: 'button',
                  className: insertItem ? 'dsh-custom-action dsh-custom-action-insert' : 'dsh-custom-action',
                  title,
                  'aria-label': title,
                  disabled: !canUse,
                  onClick: () => {
                    const state = insertItem
                      ? insertStateOf(insertAtCaret(ctx, text))
                      : (() => {
                          const r = sendText(ctx, text)
                          return r.ok ? (r.submitted ? sendStateOf(r) : 'drafted') : (r.why === 'draft-present' ? 'draft' : 'nosession')
                        })()
                    flashStatus(id, state)
                  },
                  style: {
                    ...barActionStyle(canUse),
                    borderStyle: insertItem ? 'dashed' : 'solid',
                    background: insertItem
                      ? 'transparent'
                      : 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 12%, transparent)',
                  },
                },
                `${item.label}${suffix}`,
              )
            }

            const openEditor = () => {
              // 行序 = 配置数组顺序；两区各自「添加一条」，所以空配置就真的空着。
              setRows(buttons.map((b) => ({ label: b.label, text: b.text, mode: b.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND })))
              setError(customLoadError !== '' && buttons.length === 0
                ? `${t('custom.loadFailed')}：${customLoadError}`
                : '')
              // 每次打开都重新给一次「第一次拖动后提示」的机会。
              setDragHint(false)
              setDragHintShown(false)
              setOpen(true)
            }

            const updateRow = (index, patch) => {
              setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
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
              saveCustomButtons(parsed.buttons)
                .then((cfg) => {
                  setButtons(cfg.buttons)
                  setOpen(false)
                  if (kind === 'right' && typeof onSaved === 'function') onSaved()
                })
                .catch((e) => setError(String((e && e.message) || e)))
            }

            const customButtons = buttons.map((item, i) => buildCustom(item, i))

            const manage = h(
              'button',
              {
                type: 'button',
                className: 'dsh-custom-manage',
                title: t('custom.manageTitle'),
                'aria-label': t('custom.manageTitle'),
                onClick: openEditor,
                style: barActionStyle(true),
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
            /** 二选一的分段控件：发送 / 填入。比下拉少一次点击，两个选项都可见。 */
            const modeSelect = (value, onChange, className) => {
              const current = value === MODE_INSERT ? MODE_INSERT : MODE_SEND
              const segment = (mode, label, token) => {
                const active = current === mode
                return h(
                  'button',
                  {
                    type: 'button',
                    className: `dsh-mode-option ${token}`,
                    role: 'radio',
                    'aria-checked': active,
                    title: t('custom.modeTitle'),
                    onClick: () => onChange(mode),
                    style: {
                      minWidth: '34px',
                      height: '22px',
                      padding: '0 8px',
                      border: 0,
                      borderRadius: '999px',
                      background: active ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'transparent',
                      color: active ? '#fff' : 'inherit',
                      opacity: active ? 1 : 0.65,
                      font: 'inherit',
                      fontSize: '11px',
                      fontWeight: active ? 600 : 500,
                      cursor: 'pointer',
                      lineHeight: '1',
                    },
                  },
                  label,
                )
              }
              return h(
                'div',
                {
                  className,
                  role: 'radiogroup',
                  'aria-label': t('custom.modeTitle'),
                  title: t('custom.modeTitle'),
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '2px',
                    padding: '2px',
                    flex: '0 0 auto',
                    borderRadius: '999px',
                    border: '1px solid color-mix(in srgb, CanvasText 14%, transparent)',
                    background: 'color-mix(in srgb, CanvasText 5%, transparent)',
                  },
                },
                segment(MODE_SEND, t('custom.modeSend'), 'dsh-mode-send'),
                segment(MODE_INSERT, t('custom.modeInsert'), 'dsh-mode-insert'),
              )
            }
            const rowStyle = (extra) => ({ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px', ...extra })

            /** 一条自定义行；↑↓ 只跟本区的邻居换位。 */
            const customRowOf = (row, i) => {
              const upIndex = sectionNeighbor(rows, i, -1)
              const downIndex = sectionNeighbor(rows, i, 1)
              return h(
                'div',
                {
                  key: `custom-row-${i}`,
                  style: {
                    ...rowStyle(),
                    padding: '6px',
                    borderRadius: '8px',
                    background: 'color-mix(in srgb, CanvasText 4%, transparent)',
                    border: '1px solid color-mix(in srgb, CanvasText 8%, transparent)',
                  },
                },
                h('input', {
                  className: 'dsh-custom-label-input',
                  value: row.label,
                  placeholder: t('custom.labelPlaceholder'),
                  'aria-label': t('custom.labelPlaceholder'),
                  onChange: (e) => updateRow(i, { label: e?.target?.value ?? '' }),
                  style: { ...inputStyle, width: '104px', flex: '0 0 auto' },
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

            /** 一个分区：标题 + 说明 + 右侧添加按钮，然后是行。 */
            const sectionOf = (className, title, hint, children, addButton) => h(
              'div',
              { className, style: { marginTop: '14px' } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
                  h('div', { style: { fontWeight: 600, opacity: 0.85, whiteSpace: 'nowrap' } }, title),
                  h('div', { style: { opacity: 0.55, fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, hint),
                ),
                addButton,
              ),
              ...children,
              children.length === 0 ? h('div', { style: { opacity: 0.55, marginTop: '8px' } }, t('custom.empty')) : null,
            )

            const sendRows = []
            const insertRows = []
            rows.forEach((row, i) => {
              const target = row.mode === MODE_INSERT ? insertRows : sendRows
              target.push(customRowOf(row, i))
            })

            const editor = open
              ? editorLayer(h(
                  React.Fragment,
                  null,
                  h('div', {
                    className: 'dsh-custom-editor-backdrop',
                    'aria-hidden': true,
                    onClick: () => setOpen(false),
                    style: {
                      position: 'fixed',
                      top: 0,
                      right: 0,
                      bottom: 0,
                      left: 0,
                      background: 'transparent',
                      zIndex: 2147483646,
                    },
                  }),
                  h(
                  'div',
                  { className: 'dsh-custom-editor-panel', style: editorStyle(editorPos), 'data-dsh-editor-panel': '1' },
                  h(
                    'div',
                    {
                      className: 'dsh-custom-editor-header',
                      title: t('custom.dragHint'),
                      onPointerDown: onHeaderPointerDown,
                      onPointerMove: onHeaderPointerMove,
                      onPointerUp: endHeaderDrag,
                      onPointerCancel: endHeaderDrag,
                      onDoubleClick: resetEditorPos,
                      style: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '14px 16px 10px',
                        borderBottom: '1px solid color-mix(in srgb, CanvasText 12%, transparent)',
                        flex: '0 0 auto',
                        cursor: 'grab',
                        userSelect: 'none',
                        touchAction: 'none',
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
                      h('strong', { style: { fontSize: '13px' } }, t('custom.editorTitle')),
                      dragHint
                        ? h('span', { className: 'dsh-editor-drag-hint', style: { opacity: 0.6, fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, t('custom.dragHintShort'))
                        : null,
                    ),
                    h('button', {
                      type: 'button',
                      className: 'dsh-custom-close',
                      title: t('custom.closeTitle'),
                      'aria-label': t('custom.closeTitle'),
                      onClick: () => setOpen(false),
                      style: closeStyle,
                    }, '×'),
                  ),
                  h(
                    'div',
                    { style: { padding: '12px 16px', overflowY: 'auto', flex: '1 1 auto', minHeight: 0 } },
                    h('div', { style: { opacity: 0.65 } }, t('custom.hint')),
                    h(
                      'div',
                      { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px', marginTop: '10px' } },
                      h(
                        'div',
                        { className: 'dsh-layout-row', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                        h('span', { style: { opacity: 0.75 } }, t('custom.layoutTitle')),
                        h(
                          'select',
                          {
                            className: 'dsh-layout-select',
                            value: layout,
                            title: t('custom.layoutHint'),
                            onChange: (event) => setLayout(event.target.value),
                            style: { ...inputStyle, padding: '4px 6px' },
                          },
                          h('option', { value: 'below' }, t('custom.layoutBelow')),
                          h('option', { value: 'card' }, t('custom.layoutCard')),
                          h('option', { value: 'bar' }, t('custom.layoutBar')),
                        ),
                      ),
                      h(
                        'label',
                        {
                          className: 'dsh-model-compact-row',
                          title: t('custom.modelCompactTitle'),
                          style: { display: 'flex', alignItems: 'center', gap: '6px', opacity: 0.85, cursor: 'pointer' },
                        },
                        h('input', {
                          type: 'checkbox',
                          className: 'dsh-model-compact',
                          checked: modelCompact,
                          onChange: (event) => {
                            const next = Boolean(event?.target?.checked)
                            setModelCompact(next)
                            writeModelCompact(next)
                            applyModelCompact(next)
                          },
                        }),
                        h('span', null, t('custom.modelCompact')),
                      ),
                      h(
                        'div',
                        { className: 'dsh-size-row', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                        h('span', { style: { opacity: 0.75 } }, t('custom.sizeTitle')),
                        h(
                          'select',
                          {
                            className: 'dsh-size-select',
                            value: actionSize,
                            title: t('custom.sizeHint'),
                            onChange: (event) => {
                              const next = SIZES.includes(event.target.value) ? event.target.value : 'standard'
                              setActionSize(next)
                              writeActionSize(next)
                              applyActionSize(next)
                            },
                            style: { ...inputStyle, padding: '4px 6px' },
                          },
                          h('option', { value: 'compact' }, t('custom.sizeCompact')),
                          h('option', { value: 'standard' }, t('custom.sizeStandard')),
                          h('option', { value: 'large' }, t('custom.sizeLarge')),
                        ),
                      ),
                    ),
                    sectionOf('dsh-section-send', t('custom.sectionSend'), t('custom.sectionSendHint'), sendRows, addButtonOf(MODE_SEND, 'dsh-custom-add-send')),
                    sectionOf('dsh-section-insert', t('custom.sectionInsert'), t('custom.sectionInsertHint'), insertRows, addButtonOf(MODE_INSERT, 'dsh-custom-add-insert')),
                    error !== '' ? h('div', { style: { color: 'crimson', marginTop: '8px' } }, error) : null,
                  ),
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        justifyContent: 'flex-end',
                        gap: '8px',
                        padding: '10px 16px',
                        borderTop: '1px solid color-mix(in srgb, CanvasText 12%, transparent)',
                        flex: '0 0 auto',
                      },
                    },
                    h('button', {
                      type: 'button',
                      className: 'dsh-custom-cancel',
                      title: t('custom.cancelTitle'),
                      'aria-label': t('custom.cancelTitle'),
                      onClick: () => setOpen(false),
                      style: actionStyle(true),
                    }, t('custom.cancel')),
                    h('button', {
                      type: 'button',
                      className: 'dsh-custom-save',
                      title: t('custom.saveTitle'),
                      'aria-label': t('custom.saveTitle'),
                      onClick: save,
                      style: {
                        ...actionStyle(true),
                        background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
                        color: '#fff',
                        borderColor: 'transparent',
                      },
                    }, t('custom.save')),
                  ),
                )))
              : null

            // 同一行分两组：插入文字类靠左（对着附件键），直接发送类靠右（对着发送键）。
            // 「＋」固定在左组最前，不参与排序。
            const insertNodes = []
            const sendNodes = []
            for (let i = 0; i < customButtons.length; i++) {
              if (buttons[i].mode === MODE_INSERT) insertNodes.push(customButtons[i])
              else sendNodes.push(customButtons[i])
            }

            const groupStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px', minWidth: 0 }
            if (kind === 'left') {
              return h(React.Fragment, null, h('div', { className: 'dsh-action-bar-insert', style: groupStyle }, manage, ...insertNodes), editor)
            }
            if (kind === 'right') {
              return h('div', { className: 'dsh-action-bar-send', style: { ...groupStyle, justifyContent: 'flex-end' } }, ...sendNodes)
            }

            const host = actionRowHost(layout)
            const row = h(
              'div',
              {
                className: 'dsh-action-row',
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  width: host !== null ? '100%' : 'calc(100% - 2 * var(--dsh-composer-side-clearance, 0px))',
                  maxWidth: 'var(--dsh-composer-card-max-width, 100%)',
                  margin: '0 auto',
                  marginTop: host !== null && layout !== 'card' ? '6px' : 0,
                },
              },
              h('div', { className: 'dsh-action-row-insert', style: groupStyle }, manage, ...insertNodes),
              h('div', { className: 'dsh-action-row-send', style: { ...groupStyle, justifyContent: 'flex-end', marginLeft: 'auto' } }, ...sendNodes),
            )
            const rowLayer = host !== null && typeof ReactDOM?.createPortal === 'function'
              ? ReactDOM.createPortal(row, host)
              : row

            return h(React.Fragment, null, rowLayer, editor)
          }
          return ActionPanel
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

        let currentLayout = readActionLayout()
        let seats = []

        function clearSeats() {
          for (const item of seats) {
            try { item.dispose() } catch { /* 已经卸掉就算了 */ }
          }
          seats = []
          removeActionHosts()
        }

        /** 注册当前布局的格子：below/card 一格 dock；bar 两格（input.left + input.right）。 */
        function applyLayout(mode, persist = true) {
          currentLayout = mode
          if (persist) writeActionLayout(mode)
          clearSeats()
          if (mode === 'bar') {
            seats.push({ id: ID_INSERT, dispose: seat(SLOT_INSERT, ID_INSERT, ORDER_INSERT, makeActionPanel(ctx, 'left', mode, setActionLayout, () => refreshRightSeat())) })
            seats.push({ id: ID_SEND, dispose: seat(SLOT_SEND, ID_SEND, ORDER_SEND, makeActionPanel(ctx, 'right', mode, setActionLayout)) })
          } else {
            seats.push({ id: ID_ACTIONS, dispose: seat(SLOT_DOCK, ID_ACTIONS, ORDER_DOCK, makeActionPanel(ctx, 'dock', mode, setActionLayout)) })
          }
        }

        /** 编辑器里的位置下拉：切换即生效（localStorage 记住）。 */
        function setActionLayout(mode) {
          if (!LAYOUTS.includes(mode) || mode === currentLayout) return
          applyLayout(mode)
        }

        /** 控制行模式保存后，另一侧那格是独立组件；重挂一次让它读新配置。 */
        function refreshRightSeat() {
          if (currentLayout !== 'bar') return
          const entry = seats.find((item) => item.id === ID_SEND)
          if (entry) {
            try { entry.dispose() } catch { /* 已经卸掉就算了 */ }
          }
          const dispose = seat(SLOT_SEND, ID_SEND, ORDER_SEND, makeActionPanel(ctx, 'right', 'bar', setActionLayout))
          if (entry) entry.dispose = dispose
          else seats.push({ id: ID_SEND, dispose })
        }

        applyLayout(currentLayout, false)
        applyModelCompact(readModelCompact())
        applyActionSize(readActionSize())

        // 预热配置：动作行首帧就能拿到自己的按钮；失败由 ensure 内部降级为空配置。
        ensureCustomButtons()
      },
      /** 仅供单测的纯函数（不是公开 API，宿主不读）。 */
      __internals: { blankCustomRow, moveRow, moveInSection, sectionNeighbor, validateCustomRows, sendText, insertAtCaret, decodeActionText, MAX_CUSTOM, clampEditorPos, readEditorPos, writeEditorPos },
    }
  },
})
