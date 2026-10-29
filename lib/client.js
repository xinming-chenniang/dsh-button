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
    /**
     * 首次安装的默认布局 = ar（控制行）：用的是公开插槽，最稳。
     * 2026-10-26 试过改成 elow（卡片下方）当默认，用户决定仍以控制行为默认，改回。
     */
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
      } catch { /* localStorage 不可用就用标准档 */ }
      return 'standard'
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
        style.textContent = 'html[data-dsh-button-size="compact"]{--dsh-btn-h:24px;--dsh-btn-px:8px;--dsh-btn-fs:12px;--dsh-btn-radius:6px;--dsh-btn-gap:6px}html[data-dsh-button-size="standard"]{--dsh-btn-h:28px;--dsh-btn-px:10px;--dsh-btn-fs:12px;--dsh-btn-radius:6px;--dsh-btn-gap:6px}html[data-dsh-button-size="large"]{--dsh-btn-h:32px;--dsh-btn-px:12px;--dsh-btn-fs:13px;--dsh-btn-radius:8px;--dsh-btn-gap:8px}'
        document.head.appendChild(style)
        actionSizeStyle = true
      }
      if (value === 'standard') document.documentElement.removeAttribute('data-dsh-button-size')
      else document.documentElement.setAttribute('data-dsh-button-size', value)
    }

    /** 自定义按钮配置的读写路由（`lib/index.js` 的 BUTTONS_ROUTE）。 */
    const BUTTONS_URL = '/api/dsh-button/buttons'
    /** 自定义按钮上限：与宿主 `lib/buttons.js` 的 MAX_BUTTONS 保持一致。 */
    const MAX_CUSTOM = 40
    /** 动作条每侧最多显示几条；更多的收进「⋯」面板（可搜索），避免挤掉模型选择器。 */
    const MAX_VISIBLE_PER_SIDE = 6
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
     * 按钮外观（与宿主 `lib/buttons.js` 的 STYLES 一致）。缺省按 `mode` 派生：
     * send → secondary（浅色实底）、insert → ghost（透明 + 中性描边）。
     * 注意：1.3 的填入按钮是**虚线**，1.3.1 改成中性描边（虚线在大厂规范里表示「占位/未完成」，容易被误读）。
     * 外观与行为解耦：`ghost` 的发送按钮、`danger` 的填入按钮都合法。
     */
    const STYLES = ['secondary', 'primary', 'ghost', 'danger']
    /** 按钮在动作条上的位置（与宿主 buttons.js 的 SIDES 一致）。缺省按 mode 派生：insert 左、send 右。 */
    const SIDES = ['left', 'right']
    /**
     * 文字的来源（与宿主 buttons.js 的 SOURCES 一致）。缺省 `static`：
     *   last-user      —— 当前会话最后一条「我发的」消息；
     *   last-assistant —— 当前会话最后一条 AI 回答的正文；
     *   draft          —— 输入框里现在的草稿；
     *   selection      —— 输入框里当前选中的文字（或页面里选中的历史对话）；
     *   session-title  —— 当前会话标题；
     *   model          —— 当前会话的模型名；
     *   time           —— 本地时间（慎用：会破坏可复现）。
     * 非 static 时 `text` 是模板：`{{value}}` 处插入读到的文字；留空 = 原样。
     */
    const SOURCES = ['static', 'last-user', 'last-assistant', 'draft', 'selection', 'session-title', 'model', 'time']
    const TEMPLATE_TOKEN = '{{value}}'

    /** 一条按钮的文字来源：显式写了就用，没写按静态文字。 */
    function sourceOfButton(item) {
      return SOURCES.includes(item?.source) ? item.source : 'static'
    }

    /**
     * 点击按钮那一刻捕获的页面选区（历史对话里选中的文字）。
     * 点击本身可能把页面 Selection 清掉，所以在 `mousedown` 里先存一份，`click` 时用。
     */
    let pageSelectionSnapshot = ''
    /**
     * 页面里选中的文字——可能是聊天记录，不是输入框。
     * 输入框内选区由宿主 `caretSpan()` 提供（可精确替换），这里只兜底「选中历史对话」这种页面选区。
     */
    function pageSelectionText() {
      try {
        const selection = globalThis.getSelection?.()
        if (selection === null || selection === undefined) return ''
        return typeof selection.toString === 'function' ? String(selection.toString()) : ''
      } catch { /* 试探式读取：拿不到页面选区就当没有 */ }
      return ''
    }

    /** 一条按钮最终用的外观：显式写了就用，没写按 mode 派生。 */
    function styleOfButton(item) {
      return STYLES.includes(item?.style) ? item.style : (item?.mode === MODE_INSERT ? 'ghost' : 'secondary')
    }

    /** 一条按钮的位置：显式写了就用，没写按 mode 派生（insert 左、send 右）。 */
    function sideOfButton(item) {
      return SIDES.includes(item?.side) ? item.side : (item?.mode === MODE_INSERT ? 'left' : 'right')
    }

    /**
     * 把路由 payload 收成 `{ buttons }`。
     * 旧配置的 `presets.continue` 并成第一条普通按钮；`hidden: ['continue']` 表示已经并过/用户删了，
     * 不再补。`presets.resend` 已废弃，忽略。
     */
    function normalizeConfig(payload) {
      const buttons = Array.isArray(payload?.buttons)
        ? payload.buttons
          .filter((item) => item !== null && typeof item === 'object')
          .map((item) => {
            const mode = item.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND
            return {
              label: typeof item.label === 'string' ? item.label : '',
              text: typeof item.text === 'string' ? item.text : '',
              mode,
              source: sourceOfButton(item),
              style: STYLES.includes(item.style) ? item.style : (mode === MODE_INSERT ? 'ghost' : 'secondary'),
              side: SIDES.includes(item.side) ? item.side : (mode === MODE_INSERT ? 'left' : 'right'),
            }
          })
        : []
      const hidden = Array.isArray(payload?.hidden) ? payload.hidden : []
      const preset = payload?.presets?.continue !== null && typeof payload?.presets?.continue === 'object'
        ? payload.presets.continue
        : {}
      const label = typeof preset.label === 'string' && preset.label.trim() !== '' ? preset.label.trim() : DEFAULT_CONTINUE_LABEL
      const text = typeof preset.text === 'string' && preset.text.trim() !== '' ? preset.text.trim() : DEFAULT_CONTINUE_TEXT
      const mode = preset.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND
      if (!hidden.includes('continue') && buttons.length < MAX_CUSTOM && !buttons.some((item) => item.label === label && item.text === text)) {
        buttons.unshift({ label, text, mode, style: mode === MODE_INSERT ? 'ghost' : 'secondary', side: mode === MODE_INSERT ? 'left' : 'right' })
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

    /** 编辑器里的一条空行。`mode` 决定点一下做什么，`side` 决定它落在左区还是右区（缺省按 mode 派生）。 */
    function blankCustomRow(mode = MODE_SEND, side) {
      const value = mode === MODE_INSERT ? MODE_INSERT : MODE_SEND
      const place = SIDES.includes(side) ? side : (value === MODE_INSERT ? 'left' : 'right')
      return { label: '', text: '', mode: value, source: 'static', style: value === MODE_INSERT ? 'ghost' : 'secondary', side: place }
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

    /** 同区（同一侧）相邻的下一行下标；没有就 -1。↑↓ 只在本侧内换位。 */
    function sectionNeighbor(list, index, direction) {
      if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length) return -1
      const side = sideOfButton(list[index])
      for (let i = index + direction; i >= 0 && i < list.length; i += direction) {
        if (sideOfButton(list[i]) === side) return i
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
     *   - 标签和文字都空的**静态**行走掉（不报错，方便边加边删）；
     *   - 动态来源（last-user / draft / selection）的行只要有标签，文字是可选模板；
     *   - 只填了一半的行才报错，并指出是第几条；
     *   - 其余按 host 同样的上限校验；`mode` / `source` 原样带上。
     * @param {Array<{label: string, text: string, mode?: string, source?: string}>} rows
     * @returns {{ok: true, buttons: Array<{label: string, text: string, mode: string, source: string}>} | {ok: false, message: string}}
     */
    function validateCustomRows(rows) {
      const list = Array.isArray(rows) ? rows : []
      const buttons = []
      // 报错里用「侧别 + 标签」而不是全局序号：编辑器是左右两区，说「第 6 条」用户看不出来是哪一行。
      const nameOf = (row, i) => {
        const label = typeof row?.label === 'string' ? row.label.trim() : ''
        if (label === '') return `第 ${i + 1} 条`
        return `${sideOfButton(row) === 'left' ? '左侧' : '右侧'}「${label}」`
      }
      for (let i = 0; i < list.length; i++) {
        const row = list[i]
        const label = typeof row?.label === 'string' ? row.label.trim() : ''
        const value = typeof row?.text === 'string' ? row.text.trim() : ''
        const source = sourceOfButton(row)
        const where = nameOf(row, i)
        if (label === '' && value === '' && source === 'static') continue
        if (label === '') return { ok: false, message: `第 ${i + 1} 条：标签不能为空` }
        if (source === 'static' && value === '') {
          return { ok: false, message: `${where}：静态文字不能为空 —— 想读「上一条 / 草稿 / 选区」，请把这一行的「来源」改成对应项` }
        }
        if (label.length > MAX_CUSTOM_LABEL) return { ok: false, message: `${where}：标签超过 ${MAX_CUSTOM_LABEL} 字` }
        if (value.length > MAX_CUSTOM_TEXT) return { ok: false, message: `${where}：文字超过 ${MAX_CUSTOM_TEXT} 字` }
        const mode = list[i]?.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND
        const style = STYLES.includes(list[i]?.style) ? list[i].style : (mode === MODE_INSERT ? 'ghost' : 'secondary')
        const side = SIDES.includes(list[i]?.side) ? list[i].side : (mode === MODE_INSERT ? 'left' : 'right')
        buttons.push({ label, text: value, mode, source, style, side })
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
      'custom.sourceTitle': '来源',
      'custom.sourceHint': '文字从哪来：静态文字直接用下面的内容；上一条 / 草稿 / 选区在点击时才去读',
      'custom.sourceStatic': '静态文字',
      'custom.sourceLastUser': '上一条我发的',
      'custom.sourceDraft': '当前草稿',
      'custom.sourceSelection': '当前选区',
      'custom.sourceLastAssistant': '上一条 AI 回答',
      'custom.sourceSessionTitle': '会话标题',
      'custom.sourceModel': '当前模型',
      'custom.sourceTime': '当前时间',
      'custom.templatePlaceholder': '模板（可选）：{{value}} 处插入读到的文字，留空 = 原样',
      'custom.selectionEmptyHint': '留空 = 选区被替换成它自己（看起来没变化）；写「解释这个：{{value}}」这样才有内容',
      'custom.none': '没有可用的内容',
      'custom.editorTitle': '设置',
      'custom.hint': '一条一个动作：标签 + 文字；「发送」点一下就发出去，「填入」只填到光标处。外观可选（浅底 / 主色 / 描边 / 警示）。按住 ⠿ 拖动排序，拖到另一侧分区即换区。每侧超过 6 条会收进「⋯ 全部动作」，那里可以搜索。',
      'custom.dragHint': '拖动标题栏移动面板；双击标题栏复位',
      'custom.dragToast': '位置已保存 · 双击标题栏或点 ⟲ 可复位',
      'custom.resetPos': '复位面板位置',
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
      'custom.add': '＋ 新按钮',
      'custom.remove': '删除',
      'custom.moveUp': '上移',
      'custom.moveDown': '下移',
      'custom.restore': '恢复',
      'custom.sectionLeft': '左侧',
      'custom.sectionLeftHint': '排在动作条左边（贴着附件键）的按钮',
      'custom.sectionRight': '右侧',
      'custom.sectionRightHint': '排在动作条右边的按钮',
      'custom.addLeft': '新按钮（左侧）',
      'custom.addRight': '新按钮（右侧）',
      'custom.moveToLeft': '移到左侧',
      'custom.moveToRight': '移到右侧',
      'custom.modeSend': '发送',
      'custom.modeInsert': '填入',
      'custom.modeTitle': '点一下做什么',
      'custom.styleTitle': '外观',
      'custom.styleHint': '外观只影响长相；点一下做什么看「发送 / 填入」',
      'custom.styleSecondary': '浅底',
      'custom.stylePrimary': '主色',
      'custom.styleGhost': '描边',
      'custom.styleDanger': '警示',
      'custom.ctrlSendHint': 'Ctrl + 点击直接发送',
      'custom.dragRow': '拖动排序；拖到另一区可换侧',
      'custom.removeRow': '删除这条',
      'custom.presetRemove': '从按钮条移除「%s」',
      'custom.presetRestore': '恢复「%s」',
      'custom.saveTitle': '保存到配置文件',
      'custom.saving': '保存中…',
      'custom.cancelTitle': '放弃修改',
      'custom.closeTitle': '关闭编辑器',
      'custom.empty': '还没有按钮，点下面「＋ 新按钮」添加。',
      'custom.atLimit': `最多 ${MAX_CUSTOM} 条`,
      'custom.allActions': '全部动作（可搜索）',
      'custom.searchActions': '搜索动作…',
      'custom.noMatchActions': '没有匹配的动作',
      'custom.closePanel': '关闭面板',
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
      'custom.sourceTitle': 'Source',
      'custom.sourceHint': 'Where the text comes from: static text is used as-is; last message / draft / selection is read when you click',
      'custom.sourceStatic': 'Static text',
      'custom.sourceLastUser': 'My last message',
      'custom.sourceDraft': 'Current draft',
      'custom.sourceSelection': 'Current selection',
      'custom.sourceLastAssistant': 'Last answer',
      'custom.sourceSessionTitle': 'Session title',
      'custom.sourceModel': 'Current model',
      'custom.sourceTime': 'Current time',
      'custom.templatePlaceholder': 'Template (optional): {{value}} is replaced by the read text; empty = as-is',
      'custom.selectionEmptyHint': 'Empty = the selection is replaced by itself (no visible change); write something like "Explain: {{value}}"',
      'custom.none': 'Nothing to use',
      'custom.editorTitle': 'Settings',
      'custom.hint': 'One action per row: label + text. "Send" submits it; "Insert" only puts it at the caret. Look is optional (tint / solid / outline / alert). Drag ⠿ to reorder; drop on the other side to switch sides. Beyond 6 per side, the rest go into "⋯ All actions", which is searchable.',
      'custom.dragHint': 'Drag the title bar to move the panel; double-click it to reset',
      'custom.dragToast': 'Position saved — double-click the title bar or click ⟲ to reset',
      'custom.resetPos': 'Reset panel position',
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
      'custom.add': '+ New button',
      'custom.remove': 'Remove',
      'custom.moveUp': 'Move up',
      'custom.moveDown': 'Move down',
      'custom.restore': 'Restore',
      'custom.sectionLeft': 'Left side',
      'custom.sectionLeftHint': 'Buttons shown on the left of the action row (next to attach)',
      'custom.sectionRight': 'Right side',
      'custom.sectionRightHint': 'Buttons shown on the right of the action row',
      'custom.addLeft': 'New button (left)',
      'custom.addRight': 'New button (right)',
      'custom.moveToLeft': 'Move to the left',
      'custom.moveToRight': 'Move to the right',
      'custom.modeSend': 'Send',
      'custom.modeInsert': 'Insert',
      'custom.modeTitle': 'What a click does',
      'custom.styleTitle': 'Look',
      'custom.styleHint': 'The look only; what a click does is set under Send / Insert',
      'custom.styleSecondary': 'Tint',
      'custom.stylePrimary': 'Solid',
      'custom.styleGhost': 'Outline',
      'custom.styleDanger': 'Alert',
      'custom.ctrlSendHint': 'Ctrl + click sends it now',
      'custom.dragRow': 'Drag to reorder; drop on the other side to move it there',
      'custom.removeRow': 'Remove this row',
      'custom.presetRemove': 'Remove "%s" from the button bar',
      'custom.presetRestore': 'Restore "%s"',
      'custom.saveTitle': 'Save to the config file',
      'custom.saving': 'Saving…',
      'custom.cancelTitle': 'Discard changes',
      'custom.closeTitle': 'Close the editor',
      'custom.empty': 'No buttons yet — add one below.',
      'custom.atLimit': `Up to ${MAX_CUSTOM}`,
      'custom.allActions': 'All actions (searchable)',
      'custom.searchActions': 'Search actions…',
      'custom.noMatchActions': 'No matching action',
      'custom.closePanel': 'Close panel',
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

    /**
     * 一条会话记录里的正文文本。`content` 可能是字符串，也可能是 `[{ type, text }]` 数组；
     * 数组里只收 `type === 'text'` 的块（reasoning / tool-call 不是输入框里的内容）。
     */
    function contentText(content) {
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content.map((part) => {
          if (typeof part === 'string') return part
          if (part?.type !== undefined && part.type !== 'text') return ''
          return typeof part?.text === 'string' ? part.text : ''
        }).join('')
      }
      return typeof content?.text === 'string' ? content.text : ''
    }

    /**
     * 一条历史记录是不是「我发的消息」；是就返回它的文本。
     * 判据沿用 1.2.3 的重发实现：`type === 'user/message'` 且 `data.source.kind === 'user'`
     * （注入、引用、技能调用、压缩检查点都不是）。
     */
    function userMessageText(entry) {
      const event = entry?.event ?? entry
      if (event === null || typeof event !== 'object') return ''
      if (event.type !== 'user/message') return ''
      const data = event.data ?? {}
      if (data.source?.kind !== 'user') return ''
      const message = data.message ?? {}
      return contentText(message.content ?? data.content ?? message.text)
    }

    /** 当前会话里最后一条「我发的」消息；读不到就返回 ''。 */
    function lastUserMessage(ctx, sessionId = currentSessionId(ctx)) {
      if (sessionId === undefined) return ''
      try {
        const entries = sessionsOf(ctx)?.binding?.(sessionId)?.eventSource?.getSnapshot?.()?.entries
        if (!Array.isArray(entries)) return ''
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const text = userMessageText(entries[i])
          if (text.trim() !== '') return text
        }
      } catch { /* 试探式读取：读不到就当作没有上一条消息 */ }
      return ''
    }

    /** 取第一个非空字符串；都取不到返回 ''。 */
    function pickString(...values) {
      for (const value of values) {
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
      return ''
    }

    /**
     * 一条历史记录是不是 AI 的回答；是就返回它的正文。
     * 正文在 `data.message.content`（数组里只收 `type === 'text'` 的块，reasoning / tool-call 不进来）；
     * role 不是 assistant 的（比如 user）跳过。
     */
    function assistantMessageText(entry) {
      const event = entry?.event ?? entry
      if (event === null || typeof event !== 'object') return ''
      if (String(event.type ?? '') !== 'assistant/message') return ''
      const data = event.data ?? {}
      const message = data.message ?? {}
      const role = String(message.role ?? data.role ?? '')
      if (role !== '' && role !== 'assistant') return ''
      return contentText(message.content ?? data.content ?? message.text)
    }

    /** 当前会话里最后一条 AI 回答的正文；读不到就返回 ''。 */
    function lastAssistantMessage(ctx, sessionId = currentSessionId(ctx)) {
      if (sessionId === undefined) return ''
      try {
        const entries = sessionsOf(ctx)?.binding?.(sessionId)?.eventSource?.getSnapshot?.()?.entries
        if (!Array.isArray(entries)) return ''
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const text = assistantMessageText(entries[i])
          if (text.trim() !== '') return text
        }
      } catch { /* 试探式读取：读不到就当作没有回答 */ }
      return ''
    }

    /** 当前会话标题；宿主没暴露就读不到（返回 ''）。 */
    function sessionTitleOf(ctx, sessionId = currentSessionId(ctx)) {
      if (sessionId === undefined) return ''
      try {
        const sessions = sessionsOf(ctx)
        const state = sessions?.list?.getSnapshot?.()
        const row = state?.byId?.[sessionId]
        const snap = sessions?.binding?.(sessionId)?.session?.getSnapshot?.()
        return pickString(row?.title, row?.name, row?.label, snap?.title, snap?.name)
      } catch { /* 试探式读取：宿主形状不认识就当没有 */ }
      return ''
    }

    /** 当前会话的模型名；模型可能是字符串或 `{ name, id }`，也接受行上的 model 字段。 */
    function modelNameOf(ctx, sessionId = currentSessionId(ctx)) {
      if (sessionId === undefined) return ''
      try {
        const sessions = sessionsOf(ctx)
        const state = sessions?.list?.getSnapshot?.()
        const row = state?.byId?.[sessionId]
        const snap = sessions?.binding?.(sessionId)?.session?.getSnapshot?.()
        const model = row?.model ?? snap?.model
        if (typeof model === 'string') return pickString(model)
        return pickString(model?.name, model?.id, row?.modelName, snap?.modelName)
      } catch { /* 试探式读取：宿主形状不认识就当没有 */ }
      return ''
    }

    /** 本地时间（`YYYY-MM-DD HH:mm`）。会写死时间戳、破坏可复现，所以来源里标了「慎用」。 */
    function nowText() {
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** 输入框里当前选中的文字；没有选区（或宿主太旧）就返回 ''。 */
    function selectionText(input) {
      try {
        const caret = typeof input?.caretSpan === 'function' ? input.caretSpan() : null
        if (caret === null || typeof caret !== 'object') return ''
        if (!Number.isInteger(caret.start) || !Number.isInteger(caret.end) || caret.start >= caret.end) return ''
        return currentDraftOf(input).slice(caret.start, caret.end)
      } catch { /* 试探式读取：取不到选区就当没有 */ }
      return ''
    }

    /**
     * 一次读取选区需要的三件东西：输入门面、`caretSpan()`、当前草稿。
     * 「选区来源」执行时用它——读内容和插入位置必须来自**同一次**读取，
     * 否则点击让输入框失去焦点（选区折叠）后，第二次读到的 span 就对不上了。
     * @returns {{input: object|undefined, caret: object|null, draft: string} | null} null = 没有会话
     */
    function locateSelection(ctx) {
      const sessionId = currentSessionId(ctx)
      if (sessionId === undefined) return null
      const input = inputOf(ctx, sessionId)
      if (input === undefined) return { input: undefined, caret: null, draft: '' }
      const read = () => (typeof input.caretSpan === 'function' ? input.caretSpan() : null)
      const valid = (span) => span !== null && typeof span === 'object'
        && Number.isInteger(span.start) && Number.isInteger(span.end)
      let caret = read()
      if (!valid(caret) || caret.start >= caret.end) {
        // 选区可能因点击失焦丢了：先把焦点还给输入框，Lexical 会恢复它记住的选区，再读一次。
        try { if (typeof input.focus === 'function') input.focus() } catch { /* 焦点还原失败就按当前状态读 */ }
        const retried = read()
        if (valid(retried)) caret = retried
      }
      return { input, caret, draft: currentDraftOf(input) }
    }

    /** 套模板：`{{value}}` 处插入读到的文字；模板留空 = 原样；模板里没有占位符 = 固定文字。 */
    function applyTemplate(templateText, raw) {
      const template = decodeActionText(templateText)
      return template.includes(TEMPLATE_TOKEN)
        ? template.split(TEMPLATE_TOKEN).join(raw)
        : (template.trim() === '' ? raw : template)
    }

    /**
     * 一条动作真正要用的文字（档 2 来源选择器）：
     *   - `static`：配置里的 `text`（解码转义）；
     *   - 其余来源：先读运行时数据，再套 `text` 模板（`{{value}}` = 读到的文字；空模板 = 原样；
     *     模板里没有占位符 = 固定文字）。
     * @returns {{ok: true, text: string} | {ok: false, why: 'no-source' | 'no-session'}}
     */
    function resolveActionText(ctx, item) {
      const source = sourceOfButton(item)
      if (source === 'static') return { ok: true, text: decodeActionText(item.text) }
      const sessionId = currentSessionId(ctx)
      let raw = ''
      if (source === 'time') {
        raw = nowText()
      } else if (source === 'last-user') {
        if (sessionId === undefined) return { ok: false, why: 'no-session' }
        raw = lastUserMessage(ctx, sessionId)
      } else if (source === 'last-assistant') {
        if (sessionId === undefined) return { ok: false, why: 'no-session' }
        raw = lastAssistantMessage(ctx, sessionId)
      } else if (source === 'session-title') {
        if (sessionId === undefined) return { ok: false, why: 'no-session' }
        raw = sessionTitleOf(ctx, sessionId)
      } else if (source === 'model') {
        if (sessionId === undefined) return { ok: false, why: 'no-session' }
        raw = modelNameOf(ctx, sessionId)
      } else {
        if (sessionId === undefined) return { ok: false, why: 'no-session' }
        const input = inputOf(ctx, sessionId)
        if (input === undefined) return { ok: false, why: 'no-session' }
        if (source === 'draft') {
          raw = currentDraftOf(input)
        } else {
          raw = selectionText(input)
          // 输入框里没有选区：用页面选区（历史对话里选中的文字）。
          if (raw.trim() === '') {
            raw = pageSelectionSnapshot.trim() !== '' ? pageSelectionSnapshot : pageSelectionText()
            pageSelectionSnapshot = ''
          }
        }
      }
      if (raw.trim() === '') return { ok: false, why: 'no-source' }
      return { ok: true, text: applyTemplate(item.text, raw) }
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
     * 「当前草稿」来源 + 直接发送：草稿本身就是内容，所以**不**走 `sendText`
     * （`sendText` 会因为有草稿而拒绝，那正是草稿保护；这里草稿就是要发的东西）。
     * 空草稿 = 没有可发的内容。
     */
    function sendDraftText(ctx) {
      const sessionId = currentSessionId(ctx)
      if (sessionId === undefined) return { ok: false, why: 'no-session' }
      try {
        const input = inputOf(ctx, sessionId)
        if (input === undefined) return { ok: false, why: 'no-scope' }
        if (currentDraftOf(input).trim() === '') return { ok: false, why: 'empty' }
        const running = runningOf(ctx, sessionId)
        if (typeof input.submit === 'function') {
          input.submit()
          return { ok: true, submitted: true, running }
        }
        return { ok: false, why: 'threw' }
      } catch (e) {
        try { console.warn(`[${NAMESPACE}] 发送草稿失败：`, e) } catch { /* 控制台不可用就算了 */ }
        return { ok: false, why: 'threw' }
      }
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
    /**
     * 在给定的光标 / 选区 span 上插入文字（`insertAtCaret` 与「选区来源」共用）。
     *
     * 多行文本走 `setDraft`：宿主会把 \n 拆成段落，插入后能真正换行；
     * `insertText` 只往 TextNode 里塞原始 \n，排版不一定生效。
     * @param {object} input 输入门面
     * @param {string} text 要插入的文字
     * @param {{start: number, end: number}} caret 目标 span
     * @param {number} draftRev 输入框内容版本号（`insertText` 的 CAS）
     * @returns {{ok: true, fallback?: boolean} | {ok: false, why: string}}
     */
    function insertTextAtSpan(input, text, caret, draftRev) {
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
          return insertTextAtSpan(input, text, caret, draftRev)
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
    /** 正在拖的编辑器行下标（拖动排序用；null = 没在拖）。 */
    let editorDragRow = null
    /**
     * 行对象的稳定身份 → React key。
     * **必须稳定**：用下标当 key 时，松手重排会让 React 把行 DOM 节点销毁重建，
     * 而重建发生在原生 `dragend` 之前 —— 拖拽源节点消失 = `dragend` 可能不触发，
     * Chrome 的拖影会留在屏幕上（用户实测的「残影」），opacity 也没人复位。
     */
    const rowKeys = new WeakMap()
    let rowKeySeq = 0
    function rowKeyOf(row) {
      if (row === null || typeof row !== 'object') return 'row-invalid'
      if (!rowKeys.has(row)) {
        rowKeySeq += 1
        rowKeys.set(row, `row-${rowKeySeq}`)
      }
      return rowKeys.get(row)
    }
    /**
     * 复制出一条新行时**沿用旧行的 key**。
     * 编辑器每次编辑（`updateRow`）都会造新对象，换 key 会让 React 重建这一行的 DOM ——
     * 输入框会掉焦点，拖拽中的行被重建还会丢掉原生 `dragend`（拖影残留）。
     */
    function adoptRowKey(nextRow, sourceRow) {
      if (nextRow !== null && typeof nextRow === 'object' && sourceRow !== null && typeof sourceRow === 'object') {
        rowKeys.set(nextRow, rowKeyOf(sourceRow))
      }
      return nextRow
    }

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
        // 可见：标题栏上方的浮窗提示要"浮在面板上方"，不能被面板裁掉；正文自己管滚动。
        overflow: 'visible',
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
     * A 风格「像 DSH 自带设置」的样式覆盖（贴宿主：白底、紧凑行、无预览、填充式控件、操作按钮常显但很淡）。
     * 做成**注入样式表**而不是改各处 inline 样式：整体回退只需删掉这一段 + 取消调用，便于来回改风格。
     */
    let panelSkinStyle = false
    function injectPanelSkin() {
      if (panelSkinStyle) return
      if (typeof document === 'undefined' || document.head === undefined || document.head === null) return
      if (typeof document.createElement !== 'function') return
      const style = document.createElement('style')
      style.setAttribute('data-dsh-button', 'panel-skin')
      style.textContent = [
        '.dsh-custom-editor-panel{width:min(660px,calc(100vw - 36px))!important;border:1px solid color-mix(in srgb,CanvasText 8%,transparent)!important;box-shadow:0 10px 30px rgba(0,0,0,.12)!important;font-size:13px!important;line-height:1.5!important}',
        '.dsh-custom-editor-header{height:48px!important;padding:0 16px!important;border-bottom:1px solid color-mix(in srgb,CanvasText 6%,transparent)!important}',
        '.dsh-custom-editor-header + div{padding:8px 16px!important;overflow-x:hidden!important}',
        '.dsh-custom-editor-header + div > div:first-child{font-size:12px!important;opacity:.55!important;line-height:1.6!important}',
        '.dsh-section-left,.dsh-section-right{margin-top:12px!important}',
        '.dsh-section-left > div:first-child,.dsh-section-right > div:first-child{padding:8px 0 4px!important;border-bottom:1px solid color-mix(in srgb,CanvasText 6%,transparent)!important}',
        '.dsh-section-left > div:first-child > div:first-child,.dsh-section-right > div:first-child > div:first-child{font-size:12px!important;opacity:.7!important}',
        '.dsh-section-left > div:first-child > div:last-child,.dsh-section-right > div:first-child > div:last-child{font-size:12px!important}',
        '.dsh-section-left > div:not(:first-child),.dsh-section-right > div:not(:first-child){background:transparent!important;border:0!important;border-top:1px solid color-mix(in srgb,CanvasText 5%,transparent)!important;border-radius:0!important;padding:10px 0!important}',
        '.dsh-custom-label-input,.dsh-custom-text-input,.dsh-custom-editor-panel select{background:color-mix(in srgb,CanvasText 6%,transparent)!important;border:0!important;border-radius:6px!important}',
        '.dsh-custom-remove{opacity:.4!important}',
        // 「＋ 新按钮」＝左对齐文字按钮（不是整宽虚线框）；hover 才出浅底，和 ⋮ 图标按钮同一套交互语言
        '.dsh-custom-add-left,.dsh-custom-add-right{display:inline-block!important;width:auto!important;height:30px!important;background:transparent!important;border:0!important;border-radius:6px!important;color:var(--dsw-alias-state-business-primary,#4d6bfe)!important;text-align:left!important;padding:0 8px!important;font-size:13px!important;font-weight:500!important;margin-top:4px!important;transition:background 120ms ease!important}',
        '.dsh-custom-add-left:hover,.dsh-custom-add-right:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 8%,transparent)!important}',
        '.dsh-custom-add-left:focus-visible,.dsh-custom-add-right:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe)!important;outline-offset:1px!important}',
        '.dsh-custom-editor-panel > div:last-child{background:color-mix(in srgb,CanvasText 2%,transparent)!important;border-top:1px solid color-mix(in srgb,CanvasText 6%,transparent)!important}',
        '.dsh-custom-cancel,.dsh-custom-save{height:30px!important;font-size:13px!important}',
        // —— 其余 UI 的规范状态（焦点环 / hover / active / 过渡 / ⋯ 面板）——
        '.dsh-custom-editor-panel button:focus-visible,.dsh-action-panel button:focus-visible,.dsh-custom-action:focus-visible,.dsh-more-actions:focus-visible,.dsh-custom-manage:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe)!important;outline-offset:2px!important}',
        '.dsh-custom-editor-panel input:focus-visible,.dsh-custom-editor-panel select:focus-visible,.dsh-action-panel input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe)!important;outline-offset:0!important}',
        '.dsh-custom-action,.dsh-more-actions,.dsh-custom-manage,.dsh-panel-action,.dsh-custom-editor-panel button,.dsh-custom-editor-panel input,.dsh-custom-editor-panel select{transition:background 120ms ease,border-color 120ms ease,opacity 120ms ease,transform 120ms ease}',
        '.dsh-style-secondary:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 18%,transparent)!important;border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 50%,transparent)!important}',
        '.dsh-style-primary:hover{filter:brightness(1.07)}',
        '.dsh-style-ghost:hover{background:color-mix(in srgb,CanvasText 7%,transparent)!important}',
        '.dsh-style-danger:hover{background:color-mix(in srgb,#e5484d 18%,transparent)!important}',
        '.dsh-more-actions:hover,.dsh-custom-manage:hover{background:color-mix(in srgb,CanvasText 7%,transparent)!important}',
        // active：桌面端按 Primer 的克制做法只压一点亮度，不做缩放（缩放是移动端的触感语言）
        '.dsh-custom-action:active,.dsh-more-actions:active,.dsh-custom-manage:active{filter:brightness(.96)}',
        '.dsh-action-panel{border-radius:12px!important;border:1px solid color-mix(in srgb,CanvasText 8%,transparent)!important;box-shadow:0 12px 40px rgba(0,0,0,.18)!important}',
        '.dsh-action-panel-search{background:color-mix(in srgb,CanvasText 6%,transparent)!important;border:0!important;border-radius:6px!important;height:30px!important;font-size:13px!important}',
        '.dsh-panel-action:hover{background:color-mix(in srgb,CanvasText 6%,transparent)!important}',
        '.dsh-custom-save:hover{opacity:.92!important}',
        '.dsh-custom-cancel:hover{background:color-mix(in srgb,CanvasText 5%,transparent)!important}',
        '.dsh-custom-close:hover,.dsh-editor-reset:hover{background:color-mix(in srgb,CanvasText 8%,transparent)!important}',
        '.dsh-custom-remove:hover{color:#e5484d!important;opacity:.9!important}',
        // 行悬停：给「这一行是个可拖对象」一点提示，静态时仍然很淡
        '.dsh-custom-row{transition:background 120ms ease!important}',
        '.dsh-custom-row:hover{background:color-mix(in srgb,CanvasText 2.5%,transparent)!important}',
        '.dsh-custom-row:hover .dsh-custom-drag-handle{opacity:.9!important}',
        '.dsh-custom-drag-handle:hover{opacity:1!important;color:var(--dsw-alias-state-business-primary,#4d6bfe)!important}',
      ].join('\n')
      document.head.appendChild(style)
      panelSkinStyle = true
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
        justifyContent: 'center',
        gap: '6px',
        height: '26px',
        padding: '0 8px',
        marginRight: '6px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        // 控件感：500 比 400 在 12–13px 下更像按钮（Primer / Fluent 的按钮都用 medium）
        fontWeight: 500,
        fontSize: '12px',
        lineHeight: '1',
        cursor: canUse ? 'pointer' : 'not-allowed',
        opacity: canUse ? 1 : 0.5,
        whiteSpace: 'nowrap',
      }
    }

    /** 动作条按钮：高度/内边距/字号/圆角/间距跟随「按钮大小」设置，面板控件保持标准。 */
    function barActionStyle(canUse) {
      return {
        ...actionStyle(canUse),
        height: 'var(--dsh-btn-h, 28px)',
        padding: '0 var(--dsh-btn-px, 10px)',
        fontSize: 'var(--dsh-btn-fs, 12px)',
        borderRadius: 'var(--dsh-btn-radius, 6px)',
        marginRight: 'var(--dsh-btn-gap, 6px)',
      }
    }

    /**
     * 语义外观 → 按钮样式。四种都只取宿主主题变量，深浅色和示例皮肤下自动跟着变：
     *   secondary（默认）浅色实底 —— 1.3 的发送按钮
     *   primary         主色实底白字
     *   ghost           透明 + 中性描边（略淡的字）—— 填入按钮的默认外观
     *   danger          红色系（「别点错」的动作）
     */
    function appearanceStyle(style, canUse) {
      // position:relative 是给「已填入 / 已发送」的悬浮标签定位用的（绝对定位，不改变按钮宽度）
      const base = { ...barActionStyle(canUse), borderStyle: 'solid', position: 'relative' }
      if (style === 'primary') {
        return { ...base, background: 'var(--dsw-alias-state-business-primary, #4d6bfe)', color: '#fff', borderColor: 'transparent' }
      }
      // 描边（原「虚线」）：中性细边 + 略淡的字，透明底。虚线边框在大厂规范里多用于「占位/未完成」，
      // 放在动作按钮上容易被读成"这按钮没做完"；靠「有底 vs 无底」区分发送/填入已经够。
      if (style === 'ghost') {
        return {
          ...base,
          borderStyle: 'solid',
          borderColor: 'color-mix(in srgb, CanvasText 20%, transparent)',
          background: 'transparent',
          color: 'color-mix(in srgb, CanvasText 74%, transparent)',
        }
      }
      if (style === 'danger') {
        return {
          ...base,
          background: 'color-mix(in srgb, #e5484d 12%, transparent)',
          borderColor: 'color-mix(in srgb, #e5484d 55%, transparent)',
          color: '#e5484d',
        }
      }
      // 浅底：底色是主色 10%，边框也用主色（30%），不用全局 border 色 ——
      // 浅色主题下那圈深边看起来像黑框；10% 比 12% 更接近「淡底 chip」的克制感。
      return {
        ...base,
        background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 10%, transparent)',
        borderColor: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 30%, transparent)',
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
        // A 风格：注入一次样式表（浏览器里才执行；离线单测没有 document 时静默跳过）。
        injectPanelSkin()

        /**
         * 条上自定义动作的悬浮提示：只给文字预览（长文字截断），不再加「直接发送 / 填入输入框」前缀。
         * 点法看按钮有没有底色（填入=无底描边）和编辑器里的方式下拉，悬停只回答“会发什么字”。
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
              style: styleOfButton(b),
              side: sideOfButton(b),
            })))
            const [error, setError] = React.useState('')
            const [statuses, setStatuses] = React.useState({})
            /** 「⋯ 全部动作」面板：打开状态 + 搜索词（按标签/文字过滤）。 */
            const [panelOpen, setPanelOpen] = React.useState(false)
            const [panelQuery, setPanelQuery] = React.useState('')
            /** 拖动时的目标行下标：让「被挤的行」提前滑动让位，松手前就能看到结果。 */
            const [dropSlot, setDropSlot] = React.useState(null)
            /** 正在拖的行下标：原位虚影（拖动中的那一行淡下去）。用状态而非直接改 DOM。 */
            const [dragFrom, setDragFrom] = React.useState(null)
            /** 保存中：按钮置灰 + 文案切换，避免点了没反馈。 */
            const [saving, setSaving] = React.useState(false)
            const [modelCompact, setModelCompact] = React.useState(readModelCompact)
            const [actionSize, setActionSize] = React.useState(readActionSize)
            const [editorPos, setEditorPos] = React.useState(readEditorPos)
            /** 每次打开面板后、第一次真的拖动结束时：浮一条独立提示 + 露出复位按钮（只做一次）。 */
            const [toastVisible, setToastVisible] = React.useState(false)
            const [toastShown, setToastShown] = React.useState(false)
            const [resetVisible, setResetVisible] = React.useState(false)
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
              // 这次打开后的第一次「真的拖动」：浮一条独立提示 + 露出复位按钮（只做一次）。
              if (!moved || toastShown) return
              setToastShown(true)
              setToastVisible(true)
              setResetVisible(true)
              try { setTimeout(() => setToastVisible(false), 2600) } catch { /* 定时器不可用就让提示一直显示 */ }
            }
            const resetEditorPos = () => {
              setEditorPos(null)
              writeEditorPos(null)
              setResetVisible(false)
              setToastVisible(false)
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
            /**
             * 按钮的「已填入 / 已发送」临时状态。
             * **不能拼进按钮文字**：拼进去按钮就变宽，动作条是 flex-wrap，会当场换行把输入区顶一下（用户实测「跳行」）。
             * 改成绝对定位的悬浮小标签：不占布局，按钮宽度恒定。
             */
            const statusPillStyle = {
              position: 'absolute',
              left: '50%',
              bottom: 'calc(100% + 6px)',
              transform: 'translateX(-50%)',
              padding: '2px 6px',
              borderRadius: '6px',
              background: 'color-mix(in srgb, CanvasText 88%, transparent)',
              color: 'Canvas',
              fontSize: '11px',
              lineHeight: '1.4',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 2,
              boxShadow: '0 2px 8px rgba(0,0,0,.18)',
            }
            /**
             * 成功路径**一律不提示**（2026-10-26 用户定）：
             * - 填入：文字已经在输入框里看得见，再弹一句是噪音；
             * - 发送 / 提交：点了界面就开始干活，本身就是反馈。
             * 只有「点了却没按预期发生」才出声：排队（没真发）、有草稿（没发）、没会话、插入失败。
             */
            const SILENT_STATES = new Set(['inserted', 'insertedEnd', 'sent', 'submitted'])
            const statusFor = (prefix, id) => {
              const state = statuses[id] ?? 'idle'
              if (SILENT_STATES.has(state)) return ''
              return statusSuffix(t, prefix, state)
            }


            /** 来源的人话名字（编辑器、标题、面板共用）。 */
            const sourceNameOf = (source) => ({
              'last-user': t('custom.sourceLastUser'),
              'last-assistant': t('custom.sourceLastAssistant'),
              draft: t('custom.sourceDraft'),
              selection: t('custom.sourceSelection'),
              'session-title': t('custom.sourceSessionTitle'),
              model: t('custom.sourceModel'),
              time: t('custom.sourceTime'),
            }[source] ?? t('custom.sourceStatic'))

            /**
             * 执行一条自定义动作（按钮与「⋯」面板共用同一套逻辑）：
             * 先按 `source` 解析出文字（档 2：last-user / draft / selection 在点击时才读），
             * 再照旧：填入类默认插到光标处；Ctrl / Cmd + 点击改成直接发送（草稿保护仍在）。
             * 例外：`draft` 来源 + 直接发送 = 提交当前草稿本身（草稿就是内容，不经过 setDraft）。
             * @returns {string} 状态后缀用的状态名
             */
            const executeCustom = (item, event, id) => {
              const source = sourceOfButton(item)
              const insertItem = item.mode === MODE_INSERT
              const forceSend = insertItem && (event?.ctrlKey === true || event?.metaKey === true)
              if (source === 'draft' && (forceSend || !insertItem)) {
                const r = sendDraftText(ctx)
                if (r.ok) return r.submitted ? sendStateOf(r) : 'drafted'
                return r.why === 'empty' ? 'none' : 'nosession'
              }
              // 「当前选区」+ 填入：
              //   1) 输入框里有选区 → 用宿主 `caretSpan()` 精确替换选区（读内容和插入位置必须同一次读取）；
              //   2) 输入框里没有选区、但页面里有选中文字（历史对话）→ 只取文本，插到光标处。
              // 点击按钮会让输入框失去焦点（选区折叠），所以 `mousedown` 里先存了一份页面选区。
              // 发送类（含填入类 Ctrl 点击）不走这里，交给下面的 `resolveActionText` + `sendText`。
              if (source === 'selection' && insertItem && !forceSend) {
                try {
                  const located = locateSelection(ctx)
                  if (located === null || located.input === undefined) return 'nosession'
                  const { input, caret, draft } = located
                  const hasComposerSelection = caret !== null && typeof caret === 'object'
                    && Number.isInteger(caret.start) && Number.isInteger(caret.end) && caret.start < caret.end
                  if (hasComposerSelection) {
                    const raw = draft.slice(caret.start, caret.end)
                    if (raw.trim() === '') return 'none'
                    const text = applyTemplate(item.text, raw)
                    const draftRev = input.snapshot?.draftRev
                    if (Number.isInteger(draftRev) && typeof input.insertText === 'function') {
                      return insertStateOf(insertTextAtSpan(input, text, caret, draftRev))
                    }
                    // 旧宿主没有光标插入：追加到草稿末尾（状态里会说「已填入末尾」）
                    const next = draft === '' ? text : `${draft}\n${text}`
                    input.setDraft(next)
                    return 'insertedEnd'
                  }
                  // 输入框里没有选区：看页面选区（选中历史对话的那种），只取文本。
                  const pageText = pageSelectionSnapshot.trim() !== '' ? pageSelectionSnapshot : pageSelectionText()
                  pageSelectionSnapshot = ''
                  if (pageText.trim() === '') return 'none'
                  const text = applyTemplate(item.text, pageText)
                  return insertStateOf(insertAtCaret(ctx, text))
                } catch (e) {
                  try { console.warn(`[${NAMESPACE}] 选区来源执行失败：`, e) } catch { /* 控制台不可用就算了 */ }
                  return 'failed'
                }
              }
              const resolved = resolveActionText(ctx, item)
              if (!resolved.ok) return resolved.why === 'no-source' ? 'none' : 'nosession'
              const text = resolved.text
              if (forceSend || !insertItem) {
                const r = sendText(ctx, text)
                return r.ok ? (r.submitted ? sendStateOf(r) : 'drafted') : (r.why === 'draft-present' ? 'draft' : 'nosession')
              }
              return insertStateOf(insertAtCaret(ctx, text))
            }

            /** 自定义动作：标签文本，按自己的 mode 发或填；外观独立于 mode，来源独立于两者。 */
            const buildCustom = (item, i) => {
              const insertItem = item.mode === MODE_INSERT
              const source = sourceOfButton(item)
              const styleKey = styleOfButton(item)
              const id = `custom-${i}`
              const title = (source === 'static'
                ? customActionTitle(decodeActionText(item.text))
                : `${t('custom.sourceTitle')}：${sourceNameOf(source)}`)
                + (insertItem ? ` · ${t('custom.ctrlSendHint')}` : '')
              const status = statusFor('custom', id)
              return h(
                'button',
                {
                  key: id,
                  type: 'button',
                  className: `dsh-custom-action dsh-style-${styleKey}${insertItem ? ' dsh-custom-action-insert' : ''}`,
                  title,
                  'aria-label': title,
                  disabled: !canUse,
                  // 点击不要夺走输入框焦点：焦点一移走，输入框里的选区就折叠，
                  // 「选区来源」就什么都读不到（用户点「选中」没反应就是这么来的）。
                  // 同时把页面选区（历史对话里选中的文字）存一份——点击可能把它清掉。
                  onMouseDown: (event) => {
                    pageSelectionSnapshot = pageSelectionText()
                    event?.preventDefault?.()
                  },
                  onClick: (event) => flashStatus(id, executeCustom(item, event, id)),
                  style: appearanceStyle(styleKey, canUse),
                },
                ...(status === ''
                  ? [item.label]
                  : [item.label, h('span', {
                      className: 'dsh-action-status',
                      'aria-live': 'polite',
                      style: statusPillStyle,
                    }, status)]),
              )
            }

            const openEditor = () => {
              // 行序 = 配置数组顺序；两区各自「添加一条」，所以空配置就真的空着。
              setRows(buttons.map((b) => ({
                label: b.label,
                text: b.text,
                mode: b.mode === MODE_INSERT ? MODE_INSERT : MODE_SEND,
                source: sourceOfButton(b),
                style: styleOfButton(b),
                side: sideOfButton(b),
              })))
              setError(customLoadError !== '' && buttons.length === 0
                ? `${t('custom.loadFailed')}：${customLoadError}`
                : '')
              // 每次打开都重新给一次「第一次拖动后提示 + 复位按钮」的机会。
              setToastVisible(false)
              setToastShown(false)
              setResetVisible(false)
              setOpen(true)
            }

            const updateRow = (index, patch) => {
              setRows((current) => current.map((row, i) => (i === index ? adoptRowKey({ ...row, ...patch }, row) : row)))
            }

            /**
             * 提交一次拖动落点：**推迟到下一个任务**。
             * `drop` 和 `dragend` 在同一个任务里派发；如果在这里立刻重排，React 会在 `dragend` 之前
             * 重建/跨区搬走被拖行，源节点消失 → Chrome 的拖影可能留在屏幕上（用户实测的「残影」）。
             */
            const commitRowMove = (update) => {
              try { setTimeout(() => setRows(update), 0) } catch { setRows(update) }
            }

            const addRow = (side) => {
              if (rows.length >= MAX_CUSTOM) return
              const place = side === 'left' ? 'left' : 'right'
              setRows([...rows, blankCustomRow(place === 'left' ? MODE_INSERT : MODE_SEND, place)])
            }

            const removeRow = (index) => {
              setRows(rows.filter((_, i) => i !== index))
            }

            /** ↑ / ↓：在本区里跟同区的邻居换位。函数式更新，连点几次也不会读到旧快照。 */
            const moveRowTo = (index, offset) => {
              setRows((current) => moveInSection(current, index, offset))
            }

            const save = () => {
              if (saving) return
              const parsed = validateCustomRows(rows)
              if (!parsed.ok) {
                setError(parsed.message)
                return
              }
              setError('')
              setSaving(true)
              saveCustomButtons(parsed.buttons)
                .then((cfg) => {
                  setButtons(cfg.buttons)
                  setOpen(false)
                  // 控制行是左右两个独立组件：保存后另一侧必须重挂才能看到新配置。
                  // 编辑器入口 ⋮ 在左组，所以这里实际刷新的是右组（refreshRightSeat）。
                  if (typeof onSaved === 'function') onSaved()
                })
                .catch((e) => setError(String((e && e.message) || e)))
                .finally(() => setSaving(false))
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
                style: {
                  ...barActionStyle(true),
                  // 图标按钮按大厂惯例：正方形（宽 = 高）、**无边框**，只有 hover 才出浅底
                  width: 'var(--dsh-btn-h, 28px)',
                  padding: 0,
                  border: '1px solid transparent',
                },
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
                    title: mode === MODE_INSERT ? `${t('custom.modeInsert')} · ${t('custom.ctrlSendHint')}` : t('custom.modeTitle'),
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
            /** 外观下拉：四种语义样式；值就是配置里的 `style`。 */
            const styleSelect = (value, onChange, className) => h(
              'select',
              {
                className,
                value: STYLES.includes(value) ? value : 'secondary',
                title: t('custom.styleHint'),
                'aria-label': t('custom.styleTitle'),
                onChange: (event) => onChange(event.target.value),
                style: { ...inputStyle, padding: '4px 4px', width: '74px', flex: '0 0 auto' },
              },
              h('option', { value: 'secondary' }, t('custom.styleSecondary')),
              h('option', { value: 'primary' }, t('custom.stylePrimary')),
              h('option', { value: 'ghost' }, t('custom.styleGhost')),
              h('option', { value: 'danger' }, t('custom.styleDanger')),
            )
            /** 来源下拉：静态文字 / 上一条我发的 / 当前草稿 / 当前选区。 */
            const sourceSelect = (value, onChange, className) => h(
              'select',
              {
                className,
                value: SOURCES.includes(value) ? value : 'static',
                title: t('custom.sourceHint'),
                'aria-label': t('custom.sourceTitle'),
                onChange: (event) => onChange(event.target.value),
                style: { ...inputStyle, padding: '4px 4px', width: '96px', flex: '0 0 auto' },
              },
              h('option', { value: 'static' }, t('custom.sourceStatic')),
              h('option', { value: 'last-user' }, t('custom.sourceLastUser')),
              h('option', { value: 'last-assistant' }, t('custom.sourceLastAssistant')),
              h('option', { value: 'draft' }, t('custom.sourceDraft')),
              h('option', { value: 'selection' }, t('custom.sourceSelection')),
              h('option', { value: 'session-title' }, t('custom.sourceSessionTitle')),
              h('option', { value: 'model' }, t('custom.sourceModel')),
              h('option', { value: 'time' }, t('custom.sourceTime')),
            )
            /**
             * 文字框的占位提示：
             *   static → 要发送的文字；动态来源 → 模板；选区 + 空模板 → 直接警告「会被替换成它自己，看起来没变化」。
             */
            const textPlaceholderOf = (row) => {
              const source = sourceOfButton(row)
              if (source === 'static') return t('custom.textPlaceholder')
              if (source === 'selection' && typeof row.text === 'string' && row.text.trim() === '') return t('custom.selectionEmptyHint')
              return t('custom.templatePlaceholder')
            }
            const rowStyle = (extra) => ({ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px', ...extra })

            /**
             * 插入位置的指示线（目标行上沿；落在区末尾时画在本区最后一行下沿）。
             * **必须零回流**：早先用「与被拖行等高的插槽 div」插进文档流，插槽一出现就把下面的行整体下推，
             * 光标下方换成别的行 → 又触发 dragover → 插槽再换位置 → 再推回来：界面会一直来回跳。
             * 用 box-shadow 画线不改变布局，dragover 的命中目标就稳定了。
             */
            const dropLineStyle = (targeted, edge = 'top') => (targeted
              ? { boxShadow: `inset 0 ${edge === 'bottom' ? '-2px' : '2px'} 0 0 color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 80%, transparent)` }
              : null)

            /** 一条自定义行：拖动排序（拖到别的行上 = 插到该行位置并跟随该行所在区），× 删除。 */
            const customRowOf = (row, i) => {
              /** 把正在拖的行插到第 target 行之前；目标行在另一区时同时换侧。 */
              const dropAt = (target) => {
                const from = editorDragRow
                editorDragRow = null
                setDropSlot(null)
                setDragFrom(null)
                if (from === null || from === target) return
                commitRowMove((current) => {
                  if (from < 0 || from >= current.length || target < 0 || target >= current.length) return current
                  const next = current.slice()
                  const [moved] = next.splice(from, 1)
                  const at = from < target ? target - 1 : target
                  next.splice(at, 0, adoptRowKey({ ...moved, side: sideOfButton(current[target]) }, moved))
                  return next
                })
              }
              // 本区最后一行：落在「区末尾」时把线画在它的下沿（比画在圆角按钮上清楚）
              const rowSide = sideOfButton(row)
              const isLastOfSide = !rows.slice(i + 1).some((other) => sideOfButton(other) === rowSide)
              const rowNode = h(
                'div',
                {
                  key: `custom-row-${rowKeyOf(row)}`,
                  className: 'dsh-custom-row',
                  onDragOver: (event) => {
                    if (editorDragRow === null) return
                    event?.preventDefault?.()
                    // 别让分区拿到这次 dragover：否则会把「插到本行前」改成「移到本区末尾」。
                    event?.stopPropagation?.()
                    // 拖到自己那一行 = 位置不变，不画插槽（也避免落成「区末尾」的假提示）。
                    if (editorDragRow === i) {
                      setDropSlot(null)
                      return
                    }
                    // 让位预览：在目标位置渲染占位块、后面的行整体下移（标准 sortable 交互）。
                    setDropSlot(i)
                  },
                  onDrop: (event) => {
                    event?.preventDefault?.()
                    event?.stopPropagation?.()
                    dropAt(i)
                  },
                  style: {
                    ...rowStyle(),
                    padding: '6px',
                    borderRadius: '8px',
                    background: 'color-mix(in srgb, CanvasText 4%, transparent)',
                    border: '1px solid color-mix(in srgb, CanvasText 8%, transparent)',
                    // 原位虚影：用 React 状态改，不直接改 DOM —— 直接改的 opacity 在节点重建后会留在 DOM 上。
                    opacity: dragFrom === i ? 0.35 : 1,
                    // 插入指示线：零回流，避免 dragover 命中目标来回横跳
                    ...dropLineStyle(dropSlot === i),
                    // 落在「本区末尾」：线画在本区最后一行的下沿
                    ...dropLineStyle(dropSlot === `end:${rowSide}` && isLastOfSide, 'bottom'),
                  },
                },
                h(
                  'div',
                  { className: 'dsh-row-main', style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
                  // 拖动把手：draggable 只挂在这里。整行 draggable 会让输入框里按住左右的文字选择变成拖动。
                  h(
                    'span',
                    {
                      className: 'dsh-custom-drag-handle',
                      draggable: true,
                      title: t('custom.dragRow'),
                      'aria-label': t('custom.dragRow'),
                      onDragStart: (event) => {
                        editorDragRow = i
                        setDropSlot(null)
                        const row = event?.currentTarget?.parentElement
                        // 拖拽影像用**离屏快照**，不用活元素：
                        // 直接拿行元素会让 Chrome 在拖动期间持续跟踪源的样式/结构变化，收尾时留下清不掉的
                        // 半透明残影（2026-10-26 用户录屏实测：整段 5.7s 都挂着一行「收尾」副本）。
                        // 快照一拍即弃（下一帧就 remove），源的后续变化与它无关。
                        try {
                          if (row && event?.dataTransfer && typeof document !== 'undefined' && document.body) {
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData('text/plain', String(i))
                            const ghost = row.cloneNode(true)
                            try {
                              ghost.setAttribute('data-dsh-button', 'drag-ghost')
                              ghost.style.cssText = `position:fixed;left:-10000px;top:0;width:${row.offsetWidth || 320}px;height:${row.offsetHeight || 44}px;pointer-events:none`
                              document.body.appendChild(ghost)
                              event.dataTransfer.setDragImage(ghost, 20, 14)
                              setTimeout(() => { try { ghost.remove() } catch { /* 已经没了 */ } }, 0)
                            } catch { /* 快照失败：退回活元素当拖影 */ }
                          }
                        } catch { /* 不支持 setDragImage 的老浏览器：退回浏览器默认影像 */ }
                        // 原位虚影延到下一帧再上：在 dragstart 里同步改会让浏览器丢掉刚设好的拖拽影像。
                        // 回调里再确认一次「还在拖」——拖拽已经结束的话不能把虚影留在场上。
                        try {
                          setTimeout(() => { if (editorDragRow === i) setDragFrom(i) }, 0)
                        } catch { /* 定时器不可用就不做原位虚影 */ }
                      },
                      onDragEnd: () => {
                        editorDragRow = null
                        setDropSlot(null)
                        setDragFrom(null)
                      },
                      style: {
                        cursor: 'grab',
                        opacity: 0.55,
                        fontSize: '15px',
                        lineHeight: 1,
                        userSelect: 'none',
                        flex: '0 0 auto',
                        padding: '0 4px 0 2px',
                      },
                    },
                    '⠿',
                  ),
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
                    placeholder: textPlaceholderOf(row),
                    'aria-label': t('custom.textPlaceholder'),
                    onChange: (e) => updateRow(i, { text: e?.target?.value ?? '' }),
                    style: { ...inputStyle, flex: '1 1 auto' },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-custom-remove',
                      title: t('custom.removeRow'),
                      'aria-label': t('custom.removeRow'),
                      onClick: () => removeRow(i),
                      style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '14px', padding: '0 4px', flex: '0 0 auto' },
                    },
                    '×',
                  ),
                ),
                // 第二行：次要设置（来源 / 外观 / 方式）——从主行拆出来，主行只留「叫什么、发什么」。
                h(
                  'div',
                  {
                    className: 'dsh-row-meta',
                    style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '5px', paddingLeft: '22px', flexWrap: 'wrap' },
                  },
                  h('span', { style: { opacity: 0.45, fontSize: '11px', whiteSpace: 'nowrap' } }, t('custom.sourceTitle')),
                  sourceSelect(sourceOfButton(row), (next) => updateRow(i, { source: next }), 'dsh-custom-source'),
                  styleSelect(styleOfButton(row), (next) => updateRow(i, { style: next }), 'dsh-custom-style'),
                  modeSelect(row.mode, (next) => updateRow(i, { mode: next }), 'dsh-custom-mode'),
                ),
              )
              return rowNode
            }

            /**
             * 每侧一个「＋ 新按钮」：行列表下方、**左对齐的文字按钮**（Linear / Notion / Fluent 的做法）。
             * 不用整宽虚线框（Ant 的 `block dashed` 是"企业表单加一行"的套路）：它占一整行、视觉最重，
             * 而且虚线在本产品里已经统一表示「占位 / 未完成」，放在这里自相矛盾。
             */
            const addButtonOf = (side, className, dropTargeted) => {
              const title = t(side === 'left' ? 'custom.addLeft' : 'custom.addRight')
              const canAdd = rows.length < MAX_CUSTOM
              return h(
                'button',
                {
                  type: 'button',
                  className,
                  title,
                  'aria-label': title,
                  disabled: !canAdd,
                  onClick: () => addRow(side),
                  style: {
                    ...actionStyle(canAdd),
                    alignSelf: 'flex-start',
                    width: 'auto',
                    height: '30px',
                    marginTop: '4px',
                    marginRight: 0,
                    padding: '0 8px',
                    border: '1px solid transparent',
                    background: 'transparent',
                    color: canAdd ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'inherit',
                    // 空分区且拖到「区末尾」：线画不到行上，用虚线外框标在按钮上（outline 不回流）
                    ...(dropTargeted
                      ? { outline: '2px dashed color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 80%, transparent)', outlineOffset: '-2px' }
                      : null),
                  },
                },
                canAdd ? t('custom.add') : t('custom.atLimit'),
              )
            }

            /** 一个分区：标题 + 说明，然后是行列表；拖到分区标题/空白 = 移到本区末尾，「＋ 新按钮」固定在列表下方。 */
            const sectionOf = (className, title, hint, children, addButton) => {
              const side = className === 'dsh-section-left' ? 'left' : 'right'
              /** 「拖到本区末尾」的插槽标识：和行下标区分开，渲染在行列表之后。 */
              const endSlot = `end:${side}`
              const dropToSection = (event) => {
                event?.preventDefault?.()
                const from = editorDragRow
                editorDragRow = null
                setDropSlot(null)
                setDragFrom(null)
                if (from === null) return
                commitRowMove((current) => {
                  if (from < 0 || from >= current.length) return current
                  const next = current.slice()
                  const [moved] = next.splice(from, 1)
                  next.push(adoptRowKey({ ...moved, side }, moved))
                  return next
                })
              }
              return h(
                'div',
                {
                  className,
                  style: { marginTop: '14px' },
                  // 拖到分区标题、行间空隙、「＋ 新按钮」上都算「落在本区末尾」——和松手后的结果一致，所以这里也画插槽。
                  onDragOver: (event) => {
                    if (editorDragRow === null) return
                    event?.preventDefault?.()
                    setDropSlot(endSlot)
                  },
                  onDrop: dropToSection,
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
                  h('div', { style: { fontWeight: 600, opacity: 0.85, whiteSpace: 'nowrap' } }, title),
                  h('div', { style: { opacity: 0.55, fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, hint),
                ),
                ...children,
                children.length === 0 ? h('div', { style: { opacity: 0.55, marginTop: '8px' } }, t('custom.empty')) : null,
                typeof addButton === 'function' ? addButton(dropSlot === endSlot && children.length === 0) : addButton,
              )
            }

            const leftRows = []
            const rightRows = []
            rows.forEach((row, i) => {
              const target = sideOfButton(row) === 'left' ? leftRows : rightRows
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
                  toastVisible
                    ? h('div', {
                        className: 'dsh-editor-toast',
                        role: 'status',
                        style: {
                          position: 'absolute',
                          left: '50%',
                          transform: 'translateX(-50%)',
                          top: '-34px',
                          padding: '7px 14px',
                          borderRadius: '999px',
                          background: 'CanvasText',
                          color: 'Canvas',
                          fontSize: '12px',
                          lineHeight: '1.4',
                          whiteSpace: 'nowrap',
                          boxShadow: '0 8px 24px rgba(0,0,0,.35)',
                          pointerEvents: 'none',
                        },
                      }, t('custom.dragToast'))
                    : null,
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
                    h('strong', { style: { fontSize: '13px' } }, t('custom.editorTitle')),
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '2px' } },
                      resetVisible
                        ? h('button', {
                            type: 'button',
                            className: 'dsh-editor-reset',
                            title: t('custom.resetPos'),
                            'aria-label': t('custom.resetPos'),
                            onClick: resetEditorPos,
                            style: { ...closeStyle, fontSize: '13px' },
                          }, '⟲')
                        : null,
                      h('button', {
                        type: 'button',
                        className: 'dsh-custom-close',
                        title: t('custom.closeTitle'),
                        'aria-label': t('custom.closeTitle'),
                        onClick: () => setOpen(false),
                        style: closeStyle,
                      }, '×'),
                    ),
                  ),
                  h(
                    'div',
                    { style: { padding: '12px 16px', overflowY: 'auto', overflowX: 'hidden', flex: '1 1 auto', minHeight: 0 } },
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
                        { className: 'dsh-size-row', style: { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' } },
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
                    sectionOf('dsh-section-left', t('custom.sectionLeft'), t('custom.sectionLeftHint'), leftRows, (targeted) => addButtonOf('left', 'dsh-custom-add-left', targeted)),
                    sectionOf('dsh-section-right', t('custom.sectionRight'), t('custom.sectionRightHint'), rightRows, (targeted) => addButtonOf('right', 'dsh-custom-add-right', targeted)),
                  ),
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '10px 16px',
                        borderTop: '1px solid color-mix(in srgb, CanvasText 12%, transparent)',
                        flex: '0 0 auto',
                      },
                    },
                    // 失败原因放页脚（常驻可见）：正文会滚动，报错放正文末尾会被滚出视野。
                    h('div', {
                      className: 'dsh-custom-error',
                      role: 'alert',
                      style: { flex: '1 1 auto', minWidth: 0, color: 'crimson', fontSize: '12px', lineHeight: 1.4, wordBreak: 'break-word' },
                    }, error),
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
                      disabled: saving,
                      onClick: save,
                      style: {
                        ...actionStyle(!saving),
                        background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
                        color: '#fff',
                        borderColor: 'transparent',
                        opacity: saving ? 0.7 : 1,
                        cursor: saving ? 'progress' : 'pointer',
                      },
                    }, saving ? t('custom.saving') : t('custom.save')),
                  ),
                )))
              : null

            // 按钮按「左侧 / 右侧」分组（位置与动作解耦：左侧也可以放发送按钮）。
            // 「⋮」固定在左侧最前，不参与排序。
            const leftNodes = []
            const rightNodes = []
            for (let i = 0; i < customButtons.length; i++) {
              if (sideOfButton(buttons[i]) === 'left') leftNodes.push(customButtons[i])
              else rightNodes.push(customButtons[i])
            }

            // 容量：每侧最多显示 MAX_VISIBLE_PER_SIDE 条，其余收进「⋯」面板（面板里可搜索全部动作）。
            const leftVisible = leftNodes.slice(0, MAX_VISIBLE_PER_SIDE)
            const rightVisible = rightNodes.slice(0, MAX_VISIBLE_PER_SIDE)
            const hiddenCount = (leftNodes.length - leftVisible.length) + (rightNodes.length - rightVisible.length)
            const moreButton = hiddenCount > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-more-actions',
                    title: t('custom.allActions'),
                    'aria-label': t('custom.allActions'),
                    onClick: () => {
                      setPanelQuery('')
                      setPanelOpen(true)
                    },
                    style: barActionStyle(true),
                  },
                  `⋯ ${hiddenCount}`,
                )
              : null

            /** 「⋯」面板：搜索框 + 全部动作；点一条 = 执行它（Esc / 点遮罩关闭）。 */
            const panelQueryText = panelQuery.trim().toLowerCase()
            const panelItems = []
            buttons.forEach((item, index) => {
              const hay = `${item.label}\n${item.text}`.toLowerCase()
              if (panelQueryText !== '' && !hay.includes(panelQueryText)) return
              panelItems.push({ item, index })
            })
            const actionPanel = panelOpen
              ? editorLayer(h(
                  React.Fragment,
                  null,
                  h('div', {
                    className: 'dsh-action-panel-backdrop',
                    'aria-hidden': true,
                    onClick: () => setPanelOpen(false),
                    style: { position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'transparent', zIndex: 2147483646 },
                  }),
                  h(
                    'div',
                    {
                      className: 'dsh-action-panel',
                      style: {
                        position: 'fixed',
                        left: '50%',
                        top: '18vh',
                        transform: 'translateX(-50%)',
                        width: 'min(420px, 92vw)',
                        maxHeight: '60vh',
                        display: 'flex',
                        flexDirection: 'column',
                        background: 'Canvas',
                        color: 'CanvasText',
                        border: '1px solid color-mix(in srgb, CanvasText 16%, transparent)',
                        borderRadius: '10px',
                        boxShadow: '0 16px 48px rgba(0,0,0,.35)',
                        zIndex: 2147483647,
                        overflow: 'hidden',
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, CanvasText 12%, transparent)' } },
                      h('input', {
                        className: 'dsh-action-panel-search',
                        value: panelQuery,
                        placeholder: t('custom.searchActions'),
                        'aria-label': t('custom.searchActions'),
                        onChange: (e) => setPanelQuery(e?.target?.value ?? ''),
                        onKeyDown: (e) => { if (e?.key === 'Escape') setPanelOpen(false) },
                        style: { ...inputStyle, flex: '1 1 auto' },
                      }),
                      h('button', {
                        type: 'button',
                        className: 'dsh-action-panel-close',
                        title: t('custom.closePanel'),
                        'aria-label': t('custom.closePanel'),
                        onClick: () => setPanelOpen(false),
                        style: closeStyle,
                      }, '×'),
                    ),
                    h(
                      'div',
                      { className: 'dsh-action-panel-list', style: { overflowY: 'auto', padding: '6px' } },
                      ...panelItems.map(({ item, index }) => h(
                        'button',
                        {
                          key: `panel-${index}`,
                          type: 'button',
                          className: 'dsh-panel-action',
                          title: customActionTitle(decodeActionText(item.text)),
                          'aria-label': item.label,
                          // 与动作条按钮一致：点击不夺输入框焦点，保住选区（选区来源要用）。
                          onMouseDown: (event) => {
                            pageSelectionSnapshot = pageSelectionText()
                            event?.preventDefault?.()
                          },
                          onClick: (event) => {
                            flashStatus(`custom-${index}`, executeCustom(item, event, `custom-${index}`))
                            setPanelOpen(false)
                          },
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '8px',
                            width: '100%',
                            padding: '7px 9px',
                            border: 0,
                            borderRadius: '6px',
                            background: 'transparent',
                            color: 'inherit',
                            cursor: 'pointer',
                            font: 'inherit',
                            textAlign: 'left',
                          },
                        },
                        h('span', { className: 'dsh-panel-action-label', style: { fontWeight: 500 } }, item.label),
                        h('span', { className: 'dsh-panel-action-mode', style: { opacity: 0.55, fontSize: '11px', whiteSpace: 'nowrap' } },
                          (item.mode === MODE_INSERT ? t('custom.modeInsert') : t('custom.modeSend'))
                          + (sourceOfButton(item) === 'static' ? '' : ` · ${sourceNameOf(sourceOfButton(item))}`)),
                      )),
                      panelItems.length === 0 ? h('div', { style: { opacity: 0.55, padding: '10px 9px' } }, t('custom.noMatchActions')) : null,
                    ),
                  ),
                ))
              : null

            const groupStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px', minWidth: 0 }
            if (kind === 'left') {
              return h(React.Fragment, null, h('div', { className: 'dsh-action-bar-insert', style: groupStyle }, manage, ...leftVisible, moreButton), editor, actionPanel)
            }
            if (kind === 'right') {
              return h('div', { className: 'dsh-action-bar-send', style: { ...groupStyle, justifyContent: 'flex-end' } }, ...rightVisible)
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
              h('div', { className: 'dsh-action-row-insert', style: groupStyle }, manage, ...leftVisible, moreButton),
              h('div', { className: 'dsh-action-row-send', style: { ...groupStyle, justifyContent: 'flex-end', marginLeft: 'auto' } }, ...rightVisible),
            )
            const rowLayer = host !== null && typeof ReactDOM?.createPortal === 'function'
              ? ReactDOM.createPortal(row, host)
              : row

            return h(React.Fragment, null, rowLayer, editor, actionPanel)
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
      __internals: { blankCustomRow, moveRow, moveInSection, sectionNeighbor, validateCustomRows, sendText, sendDraftText, insertAtCaret, decodeActionText, resolveActionText, lastUserMessage, lastAssistantMessage, sessionTitleOf, modelNameOf, nowText, pickString, assistantMessageText, selectionText, userMessageText, contentText, sourceOfButton, MAX_CUSTOM, clampEditorPos, readEditorPos, writeEditorPos },
    }
  },
})
