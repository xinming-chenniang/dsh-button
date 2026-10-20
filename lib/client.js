/**
 * dsh-closeout-button —— 客户端半部：输入框那一排的动作，同一个插件。
 *
 *   0) 「继续」       —— 把「继续」两个字发进当前会话（`conversation.input.left`，最左）
 *                        "嗯，往下走"的通用答复：继续 / 按推荐执行 / 接受 / 好的 —— 都点它
 *   1) 「收尾」       —— 把「收尾」两个字发进当前会话（`conversation.input.left`）
 *   2) 「按建议执行」 —— 把「按建议执行」发进当前会话（同一个插槽，排在收尾右边一格）
 *   3) 「重发上一条」 —— 把最后一条**真人**用户消息原样再发一条
 *                        （`conversation.input.right`，就在主发送/暂停键左侧）
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
  id: 'dsh-closeout-button',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 与包名一致（`cordis.patch.yml` 的 insert id 也是它）。 */
    const NAMESPACE = 'dsh-closeout-button'
    /** 「收尾」按钮发出去的那两个字 —— 与工作区约定里的收尾触发词一致。 */
    const TRIGGER = '收尾'
    /** 「按建议执行」按钮发出去的那句话 —— 让 agent 别再来回问，直接照自己刚给的建议动手。 */
    const TRIGGER_SUGGEST = '按建议执行'
    /**
     * 「继续」按钮发出去的那两个字 —— "没异议、往下走"的通用答复。
     * 用「继续」而不是「按建议执行」：后者预设"agent 刚给了建议"，而多数时候只是"同意则继续"。
     * 想让按钮改词只改这一个常量。
     */
    const TRIGGER_CONTINUE = '继续'

    /**
     * 五个落点。想换位置只改这几行：
     *   'sidebar.footer.action'              左侧栏底部（`dsh-plugin-restart` 用它，已装机验证）
     *   'conversation.session.header.actions' 会话标题栏右侧（`dsh-session-manager` 用它）
     *   'conversation.input.left'            输入框左侧工具区（收尾与按建议执行都在这）
     *   'conversation.input.right'           主发送/暂停键左侧那一排（composer bar 的 trailing 区）。
     */
    const SLOT_CLOSEOUT = 'conversation.input.left'
    const SLOT_SUGGEST = 'conversation.input.left'
    const SLOT_CONTINUE = 'conversation.input.left'
    const SLOT_RESEND = 'conversation.input.right'
    /** 收口面板：与「按建议执行」同一个插槽，order 7。 */
    const SLOT_PANEL = 'conversation.input.left'
    /** 同插槽里的排序（越小越靠左）：「继续」最前（最常用），然后收尾，按建议执行紧随其后。 */
    const ORDER_CONTINUE = 4
    const ORDER_CLOSEOUT = 5
    const ORDER_SUGGEST = 6
    const ORDER_RESEND = 5
    const ORDER_PANEL = 7

    /**
     * 插槽里的「格子键」。同一个 list 插槽里放两个按钮＝两个格子，
     * 第二个必须用**自己的 id**（复用别人的 id 会顶掉对方那个格子）。
     */
    const ID_CONTINUE = `${NAMESPACE}:continue`
    const ID_CLOSEOUT = NAMESPACE
    const ID_SUGGEST = `${NAMESPACE}:suggest`
    const ID_RESEND = NAMESPACE
    const ID_PANEL = `${NAMESPACE}:panel`

    /** 宿主侧的路由（`lib/index.js` 里注册）。 */
    const CHECK_URL = '/api/dsh-closeout/check'
    /** 请求上限：超过就报错，不要让人对着「正在跑…」干等。 */
    const CHECK_TIMEOUT_MS = 20000

    /** 绝对化：相对路径在不同加载上下文（http / 自定义协议）里解析结果不一样，显式拼 origin 更稳。 */
    function checkUrl() {
      try {
        const origin = globalThis.location?.origin
        return origin && origin !== 'null' ? `${origin}${CHECK_URL}` : CHECK_URL
      } catch {
        return CHECK_URL
      }
    }

    const zh = {
      'continue.label': '继续',
      'continue.title': '继续：把「继续」发进当前会话（"没异议、往下走"的通用答复，等价于手打继续）',
      'continue.queued': '已发出',
      'continue.drafted': '已填入，按回车',
      'continue.nosession': '没有打开的会话',
      'closeout.label': '收尾',
      'closeout.title': '收尾：把「收尾」发进当前会话（跑收尾体检 → 按提示处置 → 写收尾报告）',
      'closeout.queued': '已发出',
      'closeout.drafted': '已填入，按回车',
      'closeout.nosession': '没有打开的会话',
      'suggest.label': '按建议执行',
      'suggest.title': '按建议执行：把「按建议执行」发进当前会话（让 agent 照自己刚给的建议直接动手，不再反问）',
      'suggest.queued': '已发出',
      'suggest.drafted': '已填入，按回车',
      'suggest.nosession': '没有打开的会话',
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
      'closeout.label': 'Wrap up',
      'closeout.title': 'Wrap up: send the closeout trigger into the current session',
      'closeout.queued': 'Sent',
      'closeout.drafted': 'Drafted — press Enter',
      'closeout.nosession': 'No open session',
      'suggest.label': 'Do as advised',
      'suggest.title': 'Do as advised: send 「按建议执行」 into the current session so the agent acts on its own advice',
      'suggest.queued': 'Sent',
      'suggest.drafted': 'Drafted — press Enter',
      'suggest.nosession': 'No open session',
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
     * 把一句话填进当前会话并提交（收尾 / 按建议执行 / 重发共用这一半）。
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

    /**
     * 当前会话记录的 cwd（`session` 事件里那个）。
     * 宿主跑 `closeout` 时要用它当工作目录 —— renderer 自己不知道自己在哪个项目里。
     * @param {object} ctx
     * @returns {string|undefined}
     */
    function sessionCwd(ctx) {
      const sessionId = currentSessionId(ctx)
      if (sessionId === undefined) return undefined
      try {
        const sessions = sessionsOf(ctx)
        const entries = sessions?.binding?.(sessionId)?.eventSource?.getSnapshot?.()?.entries
        if (!Array.isArray(entries)) return undefined
        for (const entry of entries) {
          const ev = entry?.event
          if (ev?.type === 'session' && typeof ev.data?.cwd === 'string' && ev.data.cwd !== '') return ev.data.cwd
        }
      } catch {
        // 试探式读取：拿不到就退回 undefined，让宿主用它自己的 cwd
      }
      return undefined
    }

    /**
     * 让宿主跑一次 closeout（宿主才有进程与文件系统）。
     * @param {object} ctx
     * @returns {Promise<{ok: boolean, value?: object, meta?: object, message?: string}>}
     */
    async function runCheck(ctx) {
      const cwd = sessionCwd(ctx)
      const url = checkUrl()
      const controller = new AbortController()
      const timer = globalThis.setTimeout(() => {
        try {
          controller.abort()
        } catch {
          // 定时器已烧掉也无所谓
        }
      }, CHECK_TIMEOUT_MS)
      // 桌面端的会话事件窗口里**没有** `session` 头事件，所以 cwd 常常取不到。
      // 取不到就退一步：把会话 id 交给宿主，由它去会话库取 cwd（--cwd-from-session）。
      const sessionId = currentSessionId(ctx)
      const payloadBody = {}
      if (cwd !== undefined) payloadBody.cwd = cwd
      if (sessionId !== undefined) payloadBody.sessionId = sessionId
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payloadBody),
          signal: controller.signal,
        })
        const payload = await res.json().catch(() => null)
        if (!res.ok || !payload || payload.ok !== true) {
          return { ok: false, url, cwd, message: (payload && payload.message) || `HTTP ${res.status}` }
        }
        return { ok: true, url, cwd, value: payload.value, meta: payload.meta }
      } catch (e) {
        const aborted = controller.signal.aborted
        return {
          ok: false,
          url,
          cwd,
          message: aborted
            ? `超过 ${Math.round(CHECK_TIMEOUT_MS / 1000)} 秒没有回应（宿主没注册路由，或 closeout 卡住）`
            : String(e && e.message ? e.message : e),
        }
      } finally {
        globalThis.clearTimeout(timer)
      }
    }

    /**
     * 纯客户端的会话统计（降级用）：只读已加载的事件窗口，不碰磁盘。
     * 宿主 HTTP 路由不通时（例如页面在 `dsh-app://` 下、协议未转发 `/api/`），
     * 至少还能回答「这个会话有多长 / 该不该交接」——那是关会话时最先要的那个判断。
     * @param {object} ctx
     * @returns {{calls: number, turns: number, span: number, lastReason: string|null}|null}
     */
    function sessionStats(ctx) {
      const sessionId = currentSessionId(ctx)
      if (sessionId === undefined) return null
      try {
        const sessions = sessionsOf(ctx)
        const entries = sessions?.binding?.(sessionId)?.eventSource?.getSnapshot?.()?.entries
        if (!Array.isArray(entries)) return null
        let calls = 0
        let turns = 0
        let first = null
        let last = null
        let lastReason = null
        for (const entry of entries) {
          const ev = entry?.event
          if (ev === undefined) continue
          if (ev.type === 'tool/call') calls++
          else if (ev.type === 'turn/start') turns++
          else if (ev.type === 'turn/end') lastReason = ev.data?.reason?.kind ?? ev.data?.reason ?? lastReason
          if (typeof ev.time === 'number') {
            if (first === null || ev.time < first) first = ev.time
            if (last === null || ev.time > last) last = ev.time
          }
        }
        const span = first && last ? Math.max(1, Math.ceil((last - first) / 86400000)) : 1
        return { calls, turns, span, lastReason }
      } catch {
        // 试探式读取：拿不到就返回 null，面板只显示错误原文
        return null
      }
    }

    /** 面板外观：用 CSS 系统色（Canvas / CanvasText），跟着宿主主题变，不猜具体主题变量。 */
    function panelStyle() {
      return {
        position: 'fixed',
        right: '18px',
        bottom: '92px',
        width: '440px',
        maxHeight: '62vh',
        overflow: 'auto',
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

    /**
     * 面板组件工厂：`ctx` 必须从外面传进来 —— 这个函数定义在 `apply()` 之外，
     * 直接引用 `ctx` 会抛 `ReferenceError: ctx is not defined`（v0.3.1 实测踩过）。
     */
    function makePanel(ctx) {
      function PanelAction() {
      const [status, setStatus] = React.useState('idle') // idle | loading | ready | error
      const [data, setData] = React.useState(null)
      const [message, setMessage] = React.useState('')
      const [open, setOpen] = React.useState(false)

      const run = () => {
        setStatus('loading')
        setMessage('')
        setOpen(true)
        // 兜底：无论 runCheck 怎么异常，状态都必须离开 loading —— 「永远转圈」是最糟的反馈。
        Promise.resolve()
          .then(() => runCheck(ctx))
          .then((r) => {
            if (r && r.ok) {
              setData(r.value)
              setStatus('ready')
            } else {
              setMessage((r && r.message) || '未知错误')
              setStatus('error')
            }
          })
          .catch((e) => {
            setMessage(String(e && e.message ? e.message : e))
            setStatus('error')
          })
      }

      const close = () => setOpen(false)

      /** 一组清单（跑一次就渲染一次，不需要 memo）。 */
      const section = (title, items) => {
        if (!Array.isArray(items) || items.length === 0) return null
        const rows = items.slice(0, 8).map((it, i) =>
          h(
            'div',
            { key: i, style: { paddingLeft: '8px' } },
            typeof it === 'string' ? it : it.text,
            typeof it === 'object' && it && it.next ? h('div', { style: { opacity: 0.6, paddingLeft: '12px' } }, `→ ${it.next}`) : null,
          ),
        )
        return h('div', { style: { marginTop: '8px' } }, h('div', { style: { fontWeight: 600, opacity: 0.85 } }, `${title}：${items.length}`), rows)
      }

      const body = () => {
        if (status === 'loading') return h('div', { style: { opacity: 0.7 } }, '正在跑 closeout…（最长 20 秒）')
        if (status === 'error') {
          // 降级：HTTP 路由不通时，用会话事件自己算一遍「够不够长、该不该交接」。
          const stats = sessionStats(ctx)
          return h(
            'div',
            { style: { color: 'crimson' } },
            '宿主路由没连上：',
            h('div', { style: { opacity: 0.8, marginTop: '4px' } }, message || '未知错误'),
            h('div', { style: { opacity: 0.5, marginTop: '6px', fontSize: '11px' } }, `页面：${(globalThis.location && globalThis.location.href) || '(未知)'}`),
            h('div', { style: { opacity: 0.5, fontSize: '11px' } }, `请求：${checkUrl()}`),
            stats
              ? h(
                  'div',
                  { style: { marginTop: '10px', color: 'CanvasText' } },
                  h('div', { style: { fontWeight: 600 } }, '先用会话本身判断：'),
                  h('div', null, `${stats.calls} 次调用 · ${stats.turns} 轮 · 跨 ${stats.span} 天${stats.lastReason ? ` · 末尾 ${stats.lastReason}` : ''}`),
                  h('div', { style: { opacity: 0.7 } }, stats.calls > 300 || stats.span > 1 ? '→ 该写交接件（超过 300 次或跨天）' : '→ 未超线，不需要交接件'),
                )
              : null,
            h('div', { style: { opacity: 0.6, marginTop: '8px' } }, 'git 与临时文件这两项只能在终端跑：closeout --zh'),
          )
        }
        if (!data) return null
        return h(
          'div',
          null,
          h('div', { style: { fontWeight: 600 } }, data.verdictText || data.verdict),
          data.sessionInfo ? h('div', { style: { opacity: 0.65, marginTop: '2px' } }, `该不该交接：${data.handoff && data.handoff.needed ? '要（' + (data.handoff.reasons || []).join(' / ') + '）' : '不需要'}`) : null,
          section('必须处理', data.must),
          section('顺手看一眼', data.glance),
          section('没查的（不等于没问题）', data.skipped),
        )
      }

      const label = status === 'loading' ? '检查中…' : status === 'ready' && data && Array.isArray(data.must) && data.must.length ? `收口 · ${data.must.length}` : '收口'

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-closeout-panel-action',
            title: '收口面板：跑一次 closeout，显示能不能关 / 该不该交接 / 还有哪些没落盘',
            'aria-label': '收口面板',
            disabled: status === 'loading',
            onClick: run,
            style: actionStyle(status !== 'loading'),
          },
          label,
        ),
        open ? h('div', { style: panelStyle() }, h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('strong', null, '收口'), h('button', { type: 'button', onClick: close, style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '14px' } }, '×')), body(), h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px' } }, h('button', { type: 'button', onClick: run, style: actionStyle(true) }, '重新检查'), h('button', { type: 'button', onClick: close, style: actionStyle(true) }, '关闭'))) : null,
      )
      }

      return PanelAction
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
         * 造一个「发一句话」的按钮组件 —— 收尾与按建议执行只差文案和内容。
         * @param {{className: string, prefix: string, trigger: string}} spec
         */
        function makeTriggerAction({ className, prefix, trigger }) {
          return function TriggerAction() {
            const [state, setState] = React.useState('idle')
            // 这类按钮只要求"有当前会话"。
            const canUse = currentSessionId(ctx) !== undefined
            const onClick = () => {
              const r = sendText(ctx, trigger)
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
              `${t(`${prefix}.label`)}${extra}`,
            )
          }
        }

        const ContinueAction = makeTriggerAction({
          className: 'dsh-continue-action',
          prefix: 'continue',
          trigger: TRIGGER_CONTINUE,
        })
        const CloseoutAction = makeTriggerAction({
          className: 'dsh-closeout-action',
          prefix: 'closeout',
          trigger: TRIGGER,
        })
        const SuggestAction = makeTriggerAction({
          className: 'dsh-suggest-action',
          prefix: 'suggest',
          trigger: TRIGGER_SUGGEST,
        })

        /** 面板组件要拿到 `ctx`（定义在 apply 外面，见 makePanel 的注释）。 */
        const PanelAction = makePanel(ctx)

        function ResendAction() {
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
            `${t('resend.label')}${extra}`,
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

        seat(SLOT_CONTINUE, ID_CONTINUE, ORDER_CONTINUE, ContinueAction)
        seat(SLOT_CLOSEOUT, ID_CLOSEOUT, ORDER_CLOSEOUT, CloseoutAction)
        seat(SLOT_SUGGEST, ID_SUGGEST, ORDER_SUGGEST, SuggestAction)
        seat(SLOT_PANEL, ID_PANEL, ORDER_PANEL, PanelAction)
        seat(SLOT_RESEND, ID_RESEND, ORDER_RESEND, ResendAction)
      },
    }
  },
})
