/**
 * dsh-button —— 客户端半部：输入框那一排的动作。
 *
 *   0) 「继续」       —— 把「继续」两个字发进当前会话（`conversation.input.left`，最左）
 *                        "嗯，往下走"的通用答复：继续 / 按推荐执行 / 接受 / 好的 —— 都点它
 *   1) 「自定义按钮」 —— 用户自己配的 N 个按钮（标签 + 要发送的文字），一格平铺
 *                        配置在宿主侧 JSON 里，末尾「＋」打开编辑器
 *   2) 「重发上一条」 —— 把最后一条**真人**用户消息原样再发一条
 *                        （`conversation.input.right`，就在主发送/暂停键左侧）
 *
 * **「收尾」不再是写死的按钮**：需要就加一条 `收尾 = 收尾` 的自定义按钮。
 * **「收口」已删除**（2026-10-22）：它依赖外部 `closeout` CLI，对没装的用户是坏格子。
 *
 * 这些按钮都只是"替你打一段字并提交"，之后发生的事与手打完全一样。
 * 重发会覆盖当前草稿（已定），运行中提交按宿主正常语义排队成下一条。
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
 *   - 提交 = `conversation.input.for(scope).setDraft(text)` + `.submit()`。
 *
 * 刻意不做的事：不写全局 DOM（只用组件自己的元素与内联样式）、不注册路由、不碰凭据、不出网。
 * 重发只发**文本**：附件、图片、引用不会随按钮复制。
 */

window.__ModuleLoader__.load({
  id: 'dsh-button',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

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
      const res = await fetch(buttonsUrl(), init)
      const payload = await res.json().catch(() => null)
      if (!res.ok || payload === null || payload.ok !== true) {
        throw new Error((payload && payload.message) || `HTTP ${res.status}`)
      }
      return payload
    }

    /** 预设的默认标签/文字（与宿主 `DEFAULT_PRESETS` 一致）。 */
    const DEFAULT_PRESET_LABELS = { continue: '继续', resend: '重发上一条' }
    const DEFAULT_CONTINUE_TEXT = '继续'

    /** 把路由返回的 payload 收成 `{ buttons, hidden, presets }`；未知的 hidden 值直接忽略。 */
    function normalizeConfig(payload) {
      const buttons = Array.isArray(payload?.buttons) ? payload.buttons : []
      const hidden = Array.isArray(payload?.hidden)
        ? payload.hidden.filter((id) => PRESET_KEYS.includes(id))
        : []
      const rawPresets = payload?.presets !== null && typeof payload?.presets === 'object' ? payload.presets : {}
      const presets = {
        continue: {
          label: typeof rawPresets?.continue?.label === 'string' && rawPresets.continue.label.trim() !== ''
            ? rawPresets.continue.label.trim()
            : DEFAULT_PRESET_LABELS.continue,
          text: typeof rawPresets?.continue?.text === 'string' && rawPresets.continue.text.trim() !== ''
            ? rawPresets.continue.text.trim()
            : DEFAULT_CONTINUE_TEXT,
        },
        resend: {
          label: typeof rawPresets?.resend?.label === 'string' && rawPresets.resend.label.trim() !== ''
            ? rawPresets.resend.label.trim()
            : DEFAULT_PRESET_LABELS.resend,
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

    /** 编辑器里的一条空行。 */
    function blankCustomRow() {
      return { label: '', text: '' }
    }

    /**
     * 编辑器行 → 配置。规则尽量松：
     *   - 标签和文字都空的行走掉（不报错，方便边加边删）；
     *   - 只填了一半的行才报错，并指出是第几条；
     *   - 其余按 host 同样的上限校验。
     * @param {Array<{label: string, text: string}>} rows
     * @returns {{ok: true, buttons: Array<{label: string, text: string}>} | {ok: false, message: string}}
     */
    function validateCustomRows(rows) {
      const list = Array.isArray(rows) ? rows : []
      const buttons = []
      for (let i = 0; i < list.length; i++) {
        const label = typeof list[i]?.label === 'string' ? list[i].label.trim() : ''
        const value = typeof list[i]?.text === 'string' ? list[i].text.trim() : ''
        if (label === '' && value === '') continue
        if (label === '') return { ok: false, message: `第 ${i + 1} 条：标签不能为空` }
        if (value === '') return { ok: false, message: `第 ${i + 1} 条：要发送的文字不能为空` }
        if (label.length > MAX_CUSTOM_LABEL) return { ok: false, message: `第 ${i + 1} 条：标签超过 ${MAX_CUSTOM_LABEL} 字` }
        if (value.length > MAX_CUSTOM_TEXT) return { ok: false, message: `第 ${i + 1} 条：文字超过 ${MAX_CUSTOM_TEXT} 字` }
        buttons.push({ label, text: value })
      }
      if (buttons.length > MAX_CUSTOM) return { ok: false, message: `最多 ${MAX_CUSTOM} 条（当前 ${buttons.length} 条）` }
      return { ok: true, buttons }
    }

    /** 复制一份预设配置（避免直接改缓存对象）。 */
    function clonePresets(presets) {
      const p = presets ?? {}
      return {
        continue: {
          label: typeof p?.continue?.label === 'string' ? p.continue.label : DEFAULT_PRESET_LABELS.continue,
          text: typeof p?.continue?.text === 'string' ? p.continue.text : DEFAULT_CONTINUE_TEXT,
        },
        resend: {
          label: typeof p?.resend?.label === 'string' ? p.resend.label : DEFAULT_PRESET_LABELS.resend,
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
      'continue.title': '继续：把「继续」发进当前会话（"没异议、往下走"的通用答复，等价于手打继续）',
      'continue.queued': '已发出',
      'continue.drafted': '已填入，按回车',
      'continue.nosession': '没有打开的会话',
      'custom.manage': '＋',
      'custom.manageTitle': '自定义按钮：编辑并保存（左边标签，右边要发送的文字，最多 8 条）',
      'custom.editorTitle': '自定义按钮',
      'custom.hint': '一条一个动作：左边填标签（如「收尾」），右边填点下去要发出去的文字。',
      'custom.labelPlaceholder': '标签',
      'custom.textPlaceholder': '要发送的文字',
      'custom.add': '＋ 添加一条',
      'custom.remove': '删除',
      'custom.restore': '恢复',
      'custom.presets': '预设按钮',
      'custom.mine': '我的按钮',
      'custom.empty': '还没有按钮，点下面添加一条。',
      'custom.atLimit': '最多 8 条',
      'preset.continue.label': '继续',
      'preset.resend.label': '重发上一条',
      'preset.resend.dynamic': '最后一条我发的消息（动态）',
      'custom.save': '保存',
      'custom.cancel': '取消',
      'custom.saved': '已保存',
      'custom.sending': '已发出',
      'custom.drafted': '已填入，按回车',
      'custom.nosession': '没有打开的会话',
      'custom.loadFailed': '自定义按钮配置没读到',
      'resend.label': '重发上一条',
      'resend.title': '重发上一条：把最后一条我发的消息原样再发一次（只发文本）',
      'resend.sent': '已重发',
      'resend.none': '没有可重发的消息',
    }
    const en = {
      'continue.label': 'Continue',
      'continue.title': 'Continue: send 「继续」 into the current session (the generic "no objections, go on" reply)',
      'continue.queued': 'Sent',
      'continue.drafted': 'Drafted — press Enter',
      'continue.nosession': 'No open session',
      'custom.manage': '+',
      'custom.manageTitle': 'Custom buttons: edit and save (label on the left, text to send on the right, up to 8)',
      'custom.editorTitle': 'Custom buttons',
      'custom.hint': 'One action per row: a label on the left (e.g. "Wrap up") and the text to send on the right.',
      'custom.labelPlaceholder': 'Label',
      'custom.textPlaceholder': 'Text to send',
      'custom.add': '+ Add one',
      'custom.remove': 'Remove',
      'custom.restore': 'Restore',
      'custom.presets': 'Preset buttons',
      'custom.mine': 'My buttons',
      'custom.empty': 'No buttons yet — add one below.',
      'custom.atLimit': 'Up to 8',
      'preset.continue.label': 'Continue',
      'preset.resend.label': 'Resend last',
      'preset.resend.dynamic': 'Your last message (dynamic)',
      'custom.save': 'Save',
      'custom.cancel': 'Cancel',
      'custom.saved': 'Saved',
      'custom.sending': 'Sent',
      'custom.drafted': 'Drafted — press Enter',
      'custom.nosession': 'No open session',
      'custom.loadFailed': 'Could not load custom buttons',
      'resend.label': 'Resend last',
      'resend.title': 'Resend the last message you sent (text only)',
      'resend.sent': 'Sent',
      'resend.none': 'No message to resend',
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

    /**
     * 把一句话填进当前会话并提交（继续 / 自定义 / 重发共用这一半）。
     * @param {object} ctx cordis 上下文
     * @param {string} text 要发出去的字
     * @returns {{ok: boolean, submitted?: boolean, why?: string}}
     */
    function sendText(ctx, text) {
      const sessionId = currentSessionId(ctx)
      if (sessionId === undefined) return { ok: false, why: 'no-session' }
      try {
        const input = inputOf(ctx, sessionId)
        if (input === undefined) return { ok: false, why: 'no-scope' }
        input.setDraft(text)
        // `submit()` 在有些版本上没有：那就只填草稿，用户按回车 —— 比"点了没反应"好。
        if (typeof input.submit === 'function') {
          input.submit()
          return { ok: true, submitted: true }
        }
        return { ok: true, submitted: false }
      } catch (e) {
        try { console.warn(`[${NAMESPACE}] 发送「${text}」失败：`, e) } catch { /* 控制台不可用就算了 */ }
        return { ok: false, why: 'threw' }
      }
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
     * 把最后一条真人用户消息原样再发一条（覆盖当前草稿）。
     * @returns {{ok: boolean, submitted?: boolean, why?: string}}
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
        // border-box + 视口上限：不然 padding 会把 440px 撑成 468px，右侧"×"被窗口裁掉。
        width: 'min(440px, calc(100vw - 36px))',
        maxHeight: '62vh',
        overflow: 'auto',
        boxSizing: 'border-box',
        borderRadius: '10px',
        padding: '12px 14px',
        background: 'Canvas',
        color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 22%, transparent)',
        boxShadow: '0 10px 30px rgba(0,0,0,.3)',
        zIndex: 2147483000,
        fontSize: '12px',
        lineHeight: '1.6',
        wordBreak: 'break-word',
      }
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
      // 只注入 slots（注册按钮必需）与 locale（可选）；sessions / conversation 在点击时按需取，
      // 不放进 inject —— 少一个服务就等于少一个"插件永远 pending、不激活"的风险。
      inject: ['slots', 'locale'],
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
         * 造一个「发一句话」的按钮组件（目前只有「继续」用；自定义按钮直接复用 sendText）。
         * 标签与发送文字都从配置读（`presetLabel` / `presetText`），所以「继续」也能改名改字。
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
            const onClick = () => {
              const r = sendText(ctx, preset !== undefined ? presetText(preset) : t(`${prefix}.label`))
              setState(r.ok ? (r.submitted ? 'queued' : 'drafted') : 'nosession')
              // 一秒后收回提示，按钮回到常态（不弹窗、不占位）
              try { setTimeout(() => setState('idle'), 1200) } catch { /* 定时器不可用就算了 */ }
            }
            const extra = state === 'queued' ? ` · ${t(`${prefix}.queued`)}`
              : state === 'drafted' ? ` · ${t(`${prefix}.drafted`)}`
                : state === 'nosession' ? ` · ${t(`${prefix}.nosession`)}` : ''
            return h(
              'button',
              {
                type: 'button',
                className,
                title: t(`${prefix}.title`),
                'aria-label': t(`${prefix}.title`),
                disabled: !canUse,
                onClick,
                style: actionStyle(canUse),
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
            const [rows, setRows] = React.useState(() => [blankCustomRow()])
            const [error, setError] = React.useState('')
            const [note, setNote] = React.useState('')
            const canUse = currentSessionId(ctx) !== undefined

            // 首次渲染时拉一次配置；拿到后同步进 state（同一份缓存，之后的渲染不再请求）。
            ensureCustomButtons().then((cfg) => {
              if (JSON.stringify(cfg.buttons) !== JSON.stringify(buttons)) setButtons(cfg.buttons)
            })

            const send = (item) => {
              const r = sendText(ctx, item.text)
              setNote(r.ok ? t(r.submitted ? 'custom.sending' : 'custom.drafted') : t('custom.nosession'))
              try { setTimeout(() => setNote(''), 1200) } catch { /* 定时器不可用就算了 */ }
            }

            const openEditor = () => {
              setRows(buttons.length > 0 ? buttons.map((b) => ({ label: b.label, text: b.text })) : [blankCustomRow()])
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

            const addRow = () => {
              if (rows.length < MAX_CUSTOM) setRows([...rows, blankCustomRow()])
            }

            const removeRow = (index) => {
              setRows(rows.filter((_, i) => i !== index))
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

            const items = buttons.map((item, i) =>
              h(
                'button',
                {
                  key: `custom-${i}`,
                  type: 'button',
                  className: 'dsh-custom-action',
                  title: item.text,
                  'aria-label': item.text,
                  disabled: !canUse,
                  onClick: () => send(item),
                  style: actionStyle(canUse),
                },
                item.label,
              ),
            )

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
            const presetRows = PRESET_KEYS.map((key) => {
              const hiddenNow = hiddenList.includes(key)
              const draft = presetDraft[key]
              return h(
                'div',
                {
                  key: `preset-${key}`,
                  style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px', opacity: hiddenNow ? 0.55 : 1 },
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
                h(
                  'button',
                  {
                    type: 'button',
                    className: hiddenNow ? 'dsh-custom-preset-restore' : 'dsh-custom-preset-remove',
                    onClick: () => togglePreset(key),
                    style: { ...actionStyle(true), marginRight: 0 },
                  },
                  hiddenNow ? t('custom.restore') : t('custom.remove'),
                ),
              )
            })
            const rowNodes = rows.map((row, i) =>
              h(
                'div',
                { key: `custom-row-${i}`, style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px' } },
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
                    className: 'dsh-custom-remove',
                    title: t('custom.remove'),
                    'aria-label': t('custom.remove'),
                    onClick: () => removeRow(i),
                    style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '14px', padding: '0 4px' },
                  },
                  '×',
                ),
              ),
            )
            const addButton = h(
              'button',
              {
                type: 'button',
                className: 'dsh-custom-add',
                disabled: rows.length >= MAX_CUSTOM,
                onClick: addRow,
                style: { ...actionStyle(rows.length < MAX_CUSTOM), marginTop: '8px' },
              },
              rows.length >= MAX_CUSTOM ? t('custom.atLimit') : t('custom.add'),
            )
            const editor = open
              ? h(
                  'div',
                  { style: editorStyle() },
                  h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                    h('strong', null, t('custom.editorTitle')),
                    h('button', { type: 'button', onClick: () => setOpen(false), style: closeStyle }, '×'),
                  ),
                  h('div', { style: { opacity: 0.65, marginTop: '4px' } }, t('custom.hint')),
                  h('div', { style: { fontWeight: 600, opacity: 0.85, marginTop: '10px' } }, t('custom.presets')),
                  ...presetRows,
                  h('div', { style: { fontWeight: 600, opacity: 0.85, marginTop: '10px' } }, t('custom.mine')),
                  rows.length === 0 ? h('div', { style: { opacity: 0.6, marginTop: '8px' } }, t('custom.empty')) : null,
                  ...rowNodes,
                  addButton,
                  error !== '' ? h('div', { style: { color: 'crimson', marginTop: '6px' } }, error) : null,
                  h(
                    'div',
                    { style: { marginTop: '8px', display: 'flex', gap: '8px' } },
                    h('button', { type: 'button', className: 'dsh-custom-save', onClick: save, style: actionStyle(true) }, t('custom.save')),
                    h('button', { type: 'button', onClick: () => setOpen(false), style: actionStyle(true) }, t('custom.cancel')),
                  ),
                )
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
          const onClick = () => {
            const r = resendLast(ctx)
            setState(r.ok ? 'sent' : 'none')
            try { setTimeout(() => setState('idle'), 1200) } catch { /* 定时器不可用就算了 */ }
          }
          const extra = state === 'sent' ? ` · ${t('resend.sent')}`
            : state === 'none' ? ` · ${t('resend.none')}` : ''
          return h(
            'button',
            {
              type: 'button',
              className: 'dsh-resend-action',
              title: t('resend.title'),
              'aria-label': t('resend.title'),
              disabled: !canUse,
              onClick,
              style: actionStyle(canUse),
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
      __internals: { blankCustomRow, validateCustomRows, validatePresetDraft, clonePresets, MAX_CUSTOM },
    }
  },
})
