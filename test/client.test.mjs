/**
 * dsh-button 客户端半部的冒烟测试（无需浏览器）。
 *
 * 为什么要有：这是个**只活在客户端**的插件，装到应用里才知道长什么样；但"注册到哪个插槽、
 * 点下去到底调了什么"这两件事可以离线钉死 —— 它们正是最容易写错的（插槽名、服务取值路径）。
 *
 * 做法：假 `window.__ModuleLoader__` + 假 `require('react')` + 假 ctx，把组件当普通函数调一次，
 * 再手动触发它的 onClick。不引任何依赖（本仓的规矩：clone 下来就能跑）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')
/** 包名是这些 id 的唯一来源：改名时断言跟着它走，源码漏改就 FAIL。 */
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))

const SLOT_CONTINUE = 'conversation.input.left'
const SLOT_CUSTOM = 'conversation.input.left'
const SLOT_RESEND = 'conversation.input.right'

/** 最小的 React 替身：createElement 记形状，useState 取初值（支持惰性初始化函数）。 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  // mountComponent 渲染期间会指向那一份状态槽，让 setState 真的驱动重渲染；
  // 其他调用（直接调组件函数）仍拿到「初值 + 空 setter」。
  useState: (init) => {
    if (hookForTest !== null) return hookForTest(init)
    return [typeof init === 'function' ? init() : init, () => {}]
  },
  Fragment: Symbol('Fragment'),
  Component: class Component {
    constructor(props) { this.props = props }
  },
}

/** 当前挂载的极简 hooks 运行时（见 mountComponent）；渲染外为 null。 */
let hookForTest = null

/** 最小的 react-dom 替身：只提供 createPortal（客户端只在编辑器浮层用它）。 */
const fakeReactDOM = {
  createPortal: (children, container) => ({ type: 'portal', props: { container }, children: [children] }),
}

/** 载入客户端半部，拿回它交给宿主的插件对象。 */
let loadSeq = 0
async function loadPlugin() {
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: (entry) => loaded.push(entry) } }
  // 带查询串 import：ESM 会缓存模块体，不去重的话第二、三个用例拿到的是空数组（不重新执行）。
  await import(`${pathToFileURL(CLIENT).href}?case=${loadSeq++}`)
  assert.equal(loaded.length, 1, '客户端半部应当只调用一次 __ModuleLoader__.load')
  assert.equal(loaded[0].id, PKG.name, `模块 id 必须等于包名（否则装载不上）：期望 ${PKG.name}`)
  return loaded[0].factory((name) => {
    if (name === 'react-dom') return fakeReactDOM
    assert.equal(name, 'react', `工厂只应 require('react') / 'react-dom'，实际要了 ${name}`)
    return fakeReact
  })
}

/** 造一条已记录事件（history entry 形状是 `{ event }`）。 */
function userMessage(seq, content, sourceKind = 'user') {
  return { event: { type: 'user/message', seq, time: '2026-10-20T00:00:00.000Z', data: { id: `m${seq}`, content, source: { kind: sourceKind } } } }
}

/**
 * 假 ctx：只实现这个插件用到的表面。
 * `entries` 是会话事件窗口（`binding.eventSource.getSnapshot().entries`）。
 * `insert` 非空时，给输入门面加上宿主的光标插入 API（`caretSpan` / `snapshot.draftRev` / `insertText` / `focus`）。
 */
function makeCtx({ byId = { 'session-test': { retainedBy: { mainView: 1 } } }, entries = [], calls = [], draft = '', running = false, insert = null } = {}) {
  const services = {
    sessions: {
      list: { getSnapshot: () => ({ ids: Object.keys(byId), byId }) },
      scope: (id) => ({ id }),
      binding: () => ({
        eventSource: { getSnapshot: () => ({ revision: 1, entries, hasMore: false }) },
        session: { getSnapshot: () => ({ running }) },
      }),
    },
    conversation: {
      input: {
        for: (scope) => {
          calls.push(['for', scope.id])
          const api = {
            draftSnapshot: { text: draft },
            setDraft: (text) => calls.push(['setDraft', text]),
            submit: () => calls.push(['submit']),
          }
          if (insert !== null) {
            api.snapshot = { draftRev: insert.draftRev, phase: insert.phase }
            api.caretSpan = () => ({ start: insert.caret[0], end: insert.caret[1] })
            api.insertText = (text, span) => {
              calls.push(['insertText', text, span])
              return insert.applied ?? true
            }
            api.focus = () => calls.push(['focus'])
          }
          return api
        },
      },
    },
  }
  const ctx = {
    get: (name) => services[name],
    effect: () => {},
    locale: {},
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => {
        const entry = { options, component }
        ctx.registrations.push(entry)
        // 真实 slots 的 disposer 会移除这个格子；删预设靠它。
        return () => {
          const at = ctx.registrations.indexOf(entry)
          if (at >= 0) ctx.registrations.splice(at, 1)
        }
      },
    },
    registrations: [],
    calls,
  }
  return ctx
}

/** 沿元素树找第一个 class 命中的元素。 */
function findByClass(node, className) {
  if (node === null || typeof node !== 'object') return null
  if (node.props?.className === className) return node
  for (const child of node.children ?? []) {
    const hit = findByClass(child, className)
    if (hit) return hit
  }
  return null
}

/** 沿元素树找第一个 type 命中的元素（门户节点的 type 是 'portal'）。 */
function findByType(node, type) {
  if (node === null || typeof node !== 'object') return null
  if (node.type === type) return node
  for (const child of node.children ?? []) {
    const hit = findByType(child, type)
    if (hit) return hit
  }
  return null
}

/** 收集所有 class 命中的元素（编辑器里每行都有 ↑↓，必须按序取）。 */
function findAllByClass(node, className) {
  const found = []
  const walk = (item) => {
    if (item === null || typeof item !== 'object') return
    if (item.props?.className === className) found.push(item)
    for (const child of item.children ?? []) walk(child)
  }
  walk(node)
  return found
}

/** 按 class token 收集（预设行的 class 是「dsh-preset-label-input dsh-preset-continue-label」这种组合）。 */
function findAllWithClassToken(node, token) {
  const found = []
  const walk = (item) => {
    if (item === null || typeof item !== 'object') return
    const tokens = String(item.props?.className ?? '').split(/\s+/)
    if (tokens.includes(token)) found.push(item)
    for (const child of item.children ?? []) walk(child)
  }
  walk(node)
  return found
}

/**
 * 挂载一个组件，支持 setState 触发重渲染（假 React 默认的 useState 只给初值）。
 * 每个 useState 一个槽；setter 支持函数式更新，像真 React 一样在槽值上合并。
 */
function mountComponent(Component) {
  const slots = []
  let cursor = 0
  let tree = null
  const render = () => {
    cursor = 0
    hookForTest = (init) => {
      const index = cursor++
      if (slots[index] === undefined) slots[index] = { value: typeof init === 'function' ? init() : init }
      const slot = slots[index]
      const set = (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        render()
      }
      return [slot.value, set]
    }
    try {
      tree = Component()
    } finally {
      hookForTest = null
    }
  }
  render()
  return { get tree() { return tree }, render }
}

/** 取某个插槽注册出来的按钮元素：先按插槽筛，再按 class 认。 */
function buttonAt(ctx, slot, className) {
  const candidates = ctx.registrations.filter((item) => item.options.name === slot)
  assert.ok(candidates.length > 0, `应当注册到 ${slot}`)
  for (const registration of candidates) {
    const seat = registration.component()
    const inner = seat.children[0].type
    const button = findByClass(inner(), className)
    if (button) return button
  }
  assert.fail(`${slot} 里找不到 ${className} 按钮`)
}

/** 挂载自定义按钮那一格组件（带 hooks 运行时）。 */
function mountCustomActions(ctx) {
  const registration = ctx.registrations.find((item) => item.options.id === `${PKG.name}:custom`)
  assert.ok(registration, '应当注册自定义按钮那一格')
  const seat = registration.component()
  const CustomActions = seat.children[0].type
  return mountComponent(CustomActions)
}

test('插件对象形状：名字、注入面、三格分别注册到两个插槽', async () => {
  const plugin = await loadPlugin()
  assert.equal(plugin.name, PKG.name)
  assert.ok(plugin.inject.includes('slots'), 'inject 必须含 slots')
  assert.ok(!plugin.inject.includes('conversation'), 'conversation 应当按需取，不进 inject（少一个 pending 风险）')
  assert.ok(!plugin.inject.includes('locale'), 'locale 可选，不进 inject；缺 locale 时回落中文')

  const ctx = makeCtx()
  plugin.apply(ctx)
  assert.equal(ctx.registrations.length, 3, '应当注册三格（继续 + 自定义 + 重发）')
  const left = ctx.registrations.filter((item) => item.options.name === SLOT_CUSTOM)
  assert.equal(left.length, 2, '输入框左侧应当有两个动作：继续 + 自定义')
  assert.deepEqual(left.map((item) => item.options.order), [4, 5], '继续最左，自定义其次')
  const leftIds = left.map((item) => item.options.id)
  assert.equal(new Set(leftIds).size, 2, `同一个插槽里的格子键必须互不相同（复用 id = 顶掉别人的格子）：${JSON.stringify(leftIds)}`)
  assert.equal(ctx.registrations.find((item) => item.options.name === SLOT_RESEND)?.options.id, PKG.name)
  assert.equal(left[0].options.id, `${PKG.name}:continue`, '继续那一格必须用自己的键')
  assert.equal(left[1].options.id, `${PKG.name}:custom`, '自定义按钮那一格必须用自己的键')
  assert.ok(!left.some((item) => item.options.id === `${PKG.name}:suggest`), '按建议执行已合并，不应再有它')
  assert.ok(!left.some((item) => item.options.id === `${PKG.name}:panel`), '收口已删除，不应再有面板格子')
})

test('继续：点击＝把「继续」填进当前会话并提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls })
  plugin.apply(ctx)

  const button = buttonAt(ctx, SLOT_CONTINUE, 'dsh-continue-action')
  assert.equal(button.props.disabled, false, '有当前会话时继续可用')
  button.props.onClick()
  assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '继续'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})

test('有草稿时按钮不覆盖、不提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, draft: '我正在写的草稿' })
  plugin.apply(ctx)

  buttonAt(ctx, SLOT_CONTINUE, 'dsh-continue-action').props.onClick()
  assert.deepEqual(calls, [['for', 'session-test']], `有草稿时只应读取 input，不应 setDraft/submit：${JSON.stringify(calls)}`)
})

test('sendText 报告忙态，供「已排队」提示使用', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx({ running: true })
  const result = plugin.__internals.sendText(ctx, '继续')
  assert.equal(result.ok, true)
  assert.equal(result.submitted, true)
  assert.equal(result.running, true)
})

test('重发上一条：取最后一条真人消息的文本，覆盖草稿并提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({
    calls,
    entries: [
      userMessage(1, '最早的'),
      userMessage(2, [{ type: 'text', text: '上一条消息' }]),
    ],
  })
  plugin.apply(ctx)

  const button = buttonAt(ctx, SLOT_RESEND, 'dsh-resend-action')
  assert.equal(button.props.disabled, false, '有上一条用户消息时可用')
  button.props.onClick()
  assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '上一条消息'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})

test('重发跳过注入消息（source.kind 不是 user），且按 seq 取最新', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({
    calls,
    entries: [
      userMessage(5, '真人说的'),
      userMessage(9, '注入的技能调用', 'skill-invocation'),
      userMessage(7, '注入的引用', 'session-reference'),
    ],
  })
  plugin.apply(ctx)

  const button = buttonAt(ctx, SLOT_RESEND, 'dsh-resend-action')
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '真人说的'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})

test('重发兼容裸字符串 content', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, entries: [userMessage(1, '裸文本消息')] })
  plugin.apply(ctx)

  buttonAt(ctx, SLOT_RESEND, 'dsh-resend-action').props.onClick()
  assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '裸文本消息'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})

test('没有打开的会话：动作按钮都禁用，点击不提交；「＋」入口仍可用', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, byId: {} })
  plugin.apply(ctx)

  const cont = buttonAt(ctx, SLOT_CONTINUE, 'dsh-continue-action')
  const resend = buttonAt(ctx, SLOT_RESEND, 'dsh-resend-action')
  assert.equal(cont.props.disabled, true)
  assert.equal(resend.props.disabled, true)
  assert.notEqual(buttonAt(ctx, SLOT_CUSTOM, 'dsh-custom-manage').props.disabled, true, '编辑入口不依赖会话')

  cont.props.onClick()
  resend.props.onClick()
  assert.deepEqual(calls, [], '禁用状态下不应提交任何东西')
})

test('只有注入消息、没有真人消息：重发禁用，继续仍可用', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, entries: [userMessage(3, '注入内容', 'agent-instructions')] })
  plugin.apply(ctx)

  assert.equal(buttonAt(ctx, SLOT_RESEND, 'dsh-resend-action').props.disabled, true)
  assert.equal(buttonAt(ctx, SLOT_CONTINUE, 'dsh-continue-action').props.disabled, false)
})

test('老宿主留下的 state.current 仍然优先（两份取值路径都要活）', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, byId: { 'session-a': {}, 'session-b': { retainedBy: { mainView: 1 } } } })
  // 同时给出 current 与 mainView 行：应当听 current 的
  ctx.get('sessions').list.getSnapshot = () => ({
    current: 'session-a',
    ids: ['session-a', 'session-b'],
    byId: { 'session-a': {}, 'session-b': { retainedBy: { mainView: 1 } } },
  })
  plugin.apply(ctx)

  buttonAt(ctx, SLOT_CONTINUE, 'dsh-continue-action').props.onClick()
  assert.deepEqual(calls, [['for', 'session-a'], ['setDraft', '继续'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})

test('自定义按钮：表单行 → 配置（空行跳过、半空行报错、上限与长度校验）', async () => {
  const plugin = await loadPlugin()
  const { blankCustomRow, validateCustomRows, MAX_CUSTOM } = plugin.__internals
  assert.deepEqual(blankCustomRow(), { label: '', text: '', mode: 'send' })
  assert.deepEqual(blankCustomRow('insert'), { label: '', text: '', mode: 'insert' })
  // 空行直接跳过，不要求用户自己删干净
  assert.deepEqual(validateCustomRows([
    { label: ' 收尾 ', text: ' 收尾 ' },
    blankCustomRow(),
  ]), {
    ok: true,
    buttons: [{ label: '收尾', text: '收尾', mode: 'send' }],
  })
  // mode 原样带上（编辑器按方式分区）
  assert.deepEqual(validateCustomRows([{ label: '模板', text: 'x', mode: 'insert' }]), {
    ok: true,
    buttons: [{ label: '模板', text: 'x', mode: 'insert' }],
  })
  // 只填一半才报错，并指明第几条
  const labelOnly = validateCustomRows([{ label: '只有标签', text: '' }])
  assert.equal(labelOnly.ok, false)
  assert.match(labelOnly.message, /第 1 条/)
  assert.match(labelOnly.message, /文字/)
  assert.equal(validateCustomRows([{ label: '', text: '只有文字' }]).ok, false)
  // 上限与长度
  const tooMany = Array.from({ length: MAX_CUSTOM + 1 }, (_, i) => ({ label: `b${i}`, text: 'x' }))
  assert.equal(validateCustomRows(tooMany).ok, false)
  assert.equal(validateCustomRows([{ label: 'a'.repeat(30), text: 'x' }]).ok, false)
  assert.equal(validateCustomRows([{ label: 'a', text: 'x'.repeat(600) }]).ok, false)
  // 不带 "=" 的标签也合法（旧的行格式要求已取消）
  assert.deepEqual(validateCustomRows([{ label: 'a=b', text: 'x' }]), { ok: true, buttons: [{ label: 'a=b', text: 'x', mode: 'send' }] })
})

test("删掉的预设真的从插槽移除（hidden=['continue']）", async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [], hidden: ['continue'] }),
  })
  try {
    plugin.apply(ctx)
    // apply 先全注册（2 预设 + 自定义 = 3）；配置到达后按 hidden 注销。
    assert.equal(ctx.registrations.length, 3)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(ctx.registrations.length, 2, `实际：${JSON.stringify(ctx.registrations.map((r) => r.options.id))}`)
    assert.ok(!ctx.registrations.some((item) => item.options.id === `${PKG.name}:continue`), '继续那一格应被移除')
    assert.ok(ctx.registrations.some((item) => item.options.id === PKG.name), '重发仍应在')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('自定义按钮：读到配置后渲染成按钮，点击发配置里的文字；「＋」入口常驻', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls })
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '知识库', text: '用 knowledge-base 查我的体检' }] }),
  })
  try {
    plugin.apply(ctx)
    const registration = ctx.registrations.find((item) => item.options.id === `${PKG.name}:custom`)
    assert.ok(registration, '应当注册一格自定义按钮')
    // 先真正执行一次组件（发起配置请求），等它落地后再渲染一次：
    // 真实 React 里由 setState 驱动重渲染，这里手动重跑。
    registration.component().children[0].type()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const seat = registration.component()
    const inner = seat.children[0].type
    const tree = inner()
    const button = findByClass(tree, 'dsh-custom-action')
    assert.ok(button, '应当渲染配置里的自定义按钮')
    assert.equal(button.children[0], '知识库')
    assert.equal(button.props.title, '用 knowledge-base 查我的体检')
    button.props.onClick()
    assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '用 knowledge-base 查我的体检'], ['submit']])
    assert.ok(findByClass(tree, 'dsh-custom-manage'), '「＋」入口应当常驻')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('自定义按钮：配置为空时只渲染「＋」入口，不渲染任何动作按钮', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, buttons: [] }) })
  try {
    plugin.apply(ctx)
    const registration = ctx.registrations.find((item) => item.options.id === `${PKG.name}:custom`)
    const seat = registration.component()
    const inner = seat.children[0].type
    await new Promise((resolve) => setTimeout(resolve, 0))
    const tree = inner()
    assert.equal(findByClass(tree, 'dsh-custom-action'), null)
    assert.ok(findByClass(tree, 'dsh-custom-manage'))
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('预设草稿：默认值、可改标签与文字、长度/换行校验', async () => {
  const plugin = await loadPlugin()
  const { clonePresets, validatePresetDraft } = plugin.__internals
  assert.deepEqual(clonePresets(undefined), {
    continue: { label: '继续', text: '继续', mode: 'send' },
    resend: { label: '重发上一条', mode: 'send' },
  })
  assert.deepEqual(validatePresetDraft({ continue: { label: '继续吧', text: '继续吧', mode: 'insert' }, resend: { label: '再来一次' } }), {
    ok: true,
    presets: {
      continue: { label: '继续吧', text: '继续吧', mode: 'insert' },
      resend: { label: '再来一次', mode: 'send' },
    },
  })
  assert.equal(validatePresetDraft({ continue: { label: '', text: 'x' } }).ok, false)
  assert.equal(validatePresetDraft({ continue: { label: 'a', text: '' } }).ok, false)
  assert.equal(validatePresetDraft({ resend: { label: 'a'.repeat(30) } }).ok, false)
  assert.equal(validatePresetDraft({ resend: { label: 'a\nb' } }).ok, false)
})

test('预设读取配置：继续的标签与发送文字都来自配置（remount 后生效）', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls })
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [],
      hidden: [],
      presets: { continue: { label: '继续吧', text: '继续吧' } },
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const registration = ctx.registrations.find((item) => item.options.id === `${PKG.name}:continue`)
    assert.ok(registration, '继续应当仍在插槽里（hidden 为空）')
    const seat = registration.component()
    const inner = seat.children[0].type
    const button = findByClass(inner(), 'dsh-continue-action')
    assert.equal(button.children[0], '继续吧', '按钮文字应来自配置的 preset.continue.label')
    button.props.onClick()
    assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '继续吧'], ['submit']])
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('moveRow：搬一条；越界/原地返回原数组，且不改入参', async () => {
  const plugin = await loadPlugin()
  const { moveRow } = plugin.__internals
  const rows = [{ label: 'a' }, { label: 'b' }, { label: 'c' }]
  assert.deepEqual(moveRow(rows, 1, 0).map((row) => row.label), ['b', 'a', 'c'], '上移一位')
  assert.deepEqual(moveRow(rows, 0, 2).map((row) => row.label), ['b', 'c', 'a'], '下移到底')
  assert.equal(moveRow(rows, 0, 0), rows, '原地不动返回原数组（不触发多余渲染）')
  assert.equal(moveRow(rows, -1, 0), rows, '负数下标不生效')
  assert.equal(moveRow(rows, 0, 3), rows, '越界目标不生效')
  assert.equal(moveRow(rows, 1.5, 0), rows, '非整数下标不生效')
  assert.equal(moveRow(null, 0, 1), null, '非数组原样返回')
  assert.deepEqual(rows.map((row) => row.label), ['a', 'b', 'c'], '不得改动入参')
})

test('自定义按钮：编辑器里 ↑↓ 手动调整顺序，保存后按新顺序落盘与渲染', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const posts = []
  const prevFetch = globalThis.fetch
  const base = {
    buttons: [
      { label: '甲', text: 'a' },
      { label: '乙', text: 'b' },
      { label: '丙', text: 'c' },
    ],
    hidden: [],
    presets: {},
  }
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      posts.push(body)
      return { ok: true, status: 200, json: async () => ({ ok: true, ...body }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, ...base }) }
  }
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const registration = ctx.registrations.find((item) => item.options.id === `${PKG.name}:custom`)
    const seat = registration.component()
    const CustomActions = seat.children[0].type
    const mounted = mountComponent(CustomActions)
    const labelsOf = () => findAllByClass(mounted.tree, 'dsh-custom-label-input').map((input) => input.props.value)

    // 点「＋」打开编辑器：行序 = 配置数组顺序
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()
    assert.deepEqual(labelsOf(), ['甲', '乙', '丙'])

    let ups = findAllByClass(mounted.tree, 'dsh-custom-up')
    let downs = findAllByClass(mounted.tree, 'dsh-custom-down')
    assert.equal(ups.length, 3, '每条自定义按钮都应有 ↑')
    assert.equal(ups[0].props.disabled, true, '第一条不能再上移')
    assert.equal(downs[2].props.disabled, true, '最后一条不能再下移')
    assert.equal(ups[1].props.disabled, false)

    // 乙上移一位 → 乙 甲 丙
    ups[1].props.onClick()
    assert.deepEqual(labelsOf(), ['乙', '甲', '丙'])

    // 丙上移一位 → 乙 丙 甲
    findAllByClass(mounted.tree, 'dsh-custom-up')[2].props.onClick()
    assert.deepEqual(labelsOf(), ['乙', '丙', '甲'])

    // 最后一条已到底：直接点也不该越界
    findAllByClass(mounted.tree, 'dsh-custom-down')[2].props.onClick()
    assert.deepEqual(labelsOf(), ['乙', '丙', '甲'], '越界的下移应当被忽略')

    findByClass(mounted.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(posts.length, 1, '保存应当只发一次 POST')
    assert.deepEqual(posts[0].buttons.map((item) => item.label), ['乙', '丙', '甲'], '落盘顺序 = 编辑器行序')
    assert.deepEqual(
      findAllByClass(mounted.tree, 'dsh-custom-action').map((button) => button.children[0]),
      ['乙', '丙', '甲'],
      '保存后按钮条按新顺序渲染',
    )
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('填入：走宿主光标插入 API（caretSpan + draftRev + insertText），不提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, draft: '前后', insert: { caret: [1, 1], draftRev: 7 } })
  assert.deepEqual(plugin.__internals.insertAtCaret(ctx, '中间'), { ok: true })
  assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
    ['insertText', '中间', { start: 1, end: 1, draftRev: 7 }],
    ['focus'],
  ], `实际调用：${JSON.stringify(calls)}`)
})

test('填入：宿主拒绝（版本号不匹配）与忙态都不提交、不覆盖草稿', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const rejected = makeCtx({ calls, insert: { caret: [0, 0], draftRev: 1, applied: false } })
  assert.deepEqual(plugin.__internals.insertAtCaret(rejected, 'x'), { ok: false, why: 'rejected' })
  assert.equal(calls.some((call) => call[0] === 'setDraft' || call[0] === 'submit'), false, '被拒绝时不能退化成覆盖草稿')
  assert.deepEqual(calls.map((call) => call[0]), ['for', 'insertText'], `只应尝试一次插入：${JSON.stringify(calls)}`)

  const busyCalls = []
  const busy = makeCtx({ calls: busyCalls, insert: { caret: [0, 0], draftRev: 1, phase: 'submitting' } })
  assert.deepEqual(plugin.__internals.insertAtCaret(busy, 'x'), { ok: false, why: 'busy' })
  assert.deepEqual(busyCalls, [['for', 'session-test']])
})

test('填入：旧宿主没有插入 API 时追加到草稿末尾，并标记 fallback', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, draft: '已有内容' })
  assert.deepEqual(plugin.__internals.insertAtCaret(ctx, '新内容'), { ok: true, fallback: true })
  assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [['setDraft', '已有内容\n新内容']])

  const emptyCalls = []
  const empty = makeCtx({ calls: emptyCalls })
  assert.deepEqual(plugin.__internals.insertAtCaret(empty, '只填这句'), { ok: true, fallback: true })
  assert.deepEqual(emptyCalls.filter((call) => call[0] !== 'for'), [['setDraft', '只填这句']])
})

test('继续：配置成「填入」时点一下只填光标处，不提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, insert: { caret: [2, 2], draftRev: 3 } })
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [], hidden: [], presets: { continue: { mode: 'insert' } } }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const button = buttonAt(ctx, SLOT_CONTINUE, 'dsh-continue-action')
    assert.equal(button.props.style.borderStyle, 'dashed', '填入类按钮用虚线边区分')
    assert.match(String(button.props.title), /填入/)
    button.props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
      ['insertText', '继续', { start: 2, end: 2, draftRev: 3 }],
      ['focus'],
    ], `不应 submit：${JSON.stringify(calls)}`)
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('自定义按钮：mode=insert 的按钮点击只填入光标处，不提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, insert: { caret: [0, 0], draftRev: 2 } })
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [
        { label: '模板', text: '模板文字', mode: 'insert' },
        { label: '收尾', text: '收尾', mode: 'send' },
      ],
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const registration = ctx.registrations.find((item) => item.options.id === `${PKG.name}:custom`)
    const inner = registration.component().children[0].type
    const tree = inner()
    const insertButton = findAllWithClassToken(tree, 'dsh-custom-action-insert')[0]
    assert.ok(insertButton, '插入类自定义按钮应当有自己的 class')
    assert.equal(insertButton.children[0], '模板')
    assert.match(String(insertButton.props.title), /填入/)
    insertButton.props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
      ['insertText', '模板文字', { start: 0, end: 0, draftRev: 2 }],
      ['focus'],
    ], `插入按钮不应 submit：${JSON.stringify(calls)}`)
    // 同一排里的直接发送按钮仍然是原来的行为
    const sendButton = findByClass(tree, 'dsh-custom-action')
    assert.ok(sendButton, '直接发送按钮保留原 class')
    sendButton.props.onClick()
    assert.deepEqual(calls.slice(-3), [
      ['for', 'session-test'], ['setDraft', '收尾'], ['submit'],
    ], `发送按钮仍应 setDraft+submit：${JSON.stringify(calls)}`)
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器：动作按「直接发送 / 填入输入框」两区分开；保存带上每条的方式', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx({ insert: { caret: [0, 0], draftRev: 1 } })
  const posts = []
  const prevFetch = globalThis.fetch
  const base = {
    buttons: [
      { label: '甲', text: 'a' },
      { label: '乙', text: 'b', mode: 'insert' },
    ],
    hidden: [],
    presets: { resend: { mode: 'insert' } },
  }
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      posts.push(body)
      return { ok: true, status: 200, json: async () => ({ ok: true, ...body }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, ...base }) }
  }
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountCustomActions(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    const sendSection = () => findByClass(mounted.tree, 'dsh-section-send')
    const insertSection = () => findByClass(mounted.tree, 'dsh-section-insert')
    // 直接发送区：继续（预设）+ 甲（自定义）；重发被改成填入，不在这一区
    assert.equal(findAllWithClassToken(sendSection(), 'dsh-preset-continue-label').length, 1)
    assert.equal(findAllWithClassToken(sendSection(), 'dsh-preset-resend-label').length, 0)
    assert.deepEqual(findAllWithClassToken(sendSection(), 'dsh-custom-label-input').map((input) => input.props.value), ['甲'])
    // 填入区：重发（预设）+ 乙（自定义）
    assert.equal(findAllWithClassToken(insertSection(), 'dsh-preset-resend-label').length, 1)
    assert.equal(findAllWithClassToken(insertSection(), 'dsh-preset-continue-label').length, 0)
    assert.deepEqual(findAllWithClassToken(insertSection(), 'dsh-custom-label-input').map((input) => input.props.value), ['乙'])
    assert.equal(findAllByClass(sendSection(), 'dsh-custom-mode')[0].props.value, 'send')
    assert.equal(findAllByClass(insertSection(), 'dsh-custom-mode')[0].props.value, 'insert')
    assert.equal(findAllByClass(sendSection(), 'dsh-preset-mode').every((select) => select.props.value === 'send'), true)
    assert.equal(findAllByClass(insertSection(), 'dsh-preset-mode')[0].props.value, 'insert')

    findByClass(mounted.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].buttons, [
      { label: '甲', text: 'a', mode: 'send' },
      { label: '乙', text: 'b', mode: 'insert' },
    ], '每条按钮的方式要原样落盘')
    assert.deepEqual(posts[0].presets, {
      continue: { label: '继续', text: '继续', mode: 'send' },
      resend: { label: '重发上一条', mode: 'insert' },
    })
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器：改方式会把这条移到另一区；每区的「添加一条」沿用本区方式', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  const base = { buttons: [{ label: '甲', text: 'a' }], hidden: [], presets: {} }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ...base }) })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountCustomActions(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    // 填入区一开始只有预设置位（这里预设都是直接发送，所以没有行）
    assert.equal(findAllWithClassToken(findByClass(mounted.tree, 'dsh-section-insert'), 'dsh-custom-label-input').length, 0)
    // 在填入区加一条：空行落在填入区
    findByClass(mounted.tree, 'dsh-custom-add-insert').props.onClick()
    assert.deepEqual(
      findAllWithClassToken(findByClass(mounted.tree, 'dsh-section-insert'), 'dsh-custom-label-input').map((input) => input.props.value),
      [''],
    )
    // 把「甲」改成填入：它移到填入区，按数组顺序排在空行前面
    findAllByClass(findByClass(mounted.tree, 'dsh-section-send'), 'dsh-custom-mode')[0].props.onChange({ target: { value: 'insert' } })
    assert.deepEqual(
      findAllWithClassToken(findByClass(mounted.tree, 'dsh-section-insert'), 'dsh-custom-label-input').map((input) => input.props.value),
      ['甲', ''],
    )
    assert.equal(findAllWithClassToken(findByClass(mounted.tree, 'dsh-section-send'), 'dsh-custom-label-input').length, 0)
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器：↑↓ 只在同区内换位（跳过另一区的行）', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  const base = {
    buttons: [
      { label: '甲', text: 'a' },
      { label: '乙', text: 'b', mode: 'insert' },
      { label: '丙', text: 'c' },
    ],
    hidden: [],
    presets: {},
  }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ...base }) })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountCustomActions(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    const labelsOf = (section) => findAllWithClassToken(section, 'dsh-custom-label-input').map((input) => input.props.value)
    let sendSection = findByClass(mounted.tree, 'dsh-section-send')
    assert.deepEqual(labelsOf(sendSection), ['甲', '丙'], '填入类那条不参与直接发送区的排序')
    const ups = findAllByClass(sendSection, 'dsh-custom-up')
    assert.equal(ups[0].props.disabled, true, '本区第一条不能再上移')
    assert.equal(ups[1].props.disabled, false)
    ups[1].props.onClick()

    sendSection = findByClass(mounted.tree, 'dsh-section-send')
    assert.deepEqual(labelsOf(sendSection), ['丙', '甲'], '同区内换位')
    assert.deepEqual(labelsOf(findByClass(mounted.tree, 'dsh-section-insert')), ['乙'], '另一区顺序不变')

    const downs = findAllByClass(sendSection, 'dsh-custom-down')
    assert.equal(downs[1].props.disabled, true, '本区最后一条不能再下移')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器浮层 portal 到 body：不再被宿主「回到底部」浮动按钮盖住', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  const prevDocument = globalThis.document
  const body = { tag: 'document.body' }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '甲', text: 'a' }] }),
  })
  globalThis.document = { body }
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountCustomActions(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    const portal = findByType(mounted.tree, 'portal')
    assert.ok(portal, '打开编辑器后应当用 createPortal 渲染（否则会被聊天区浮动按钮盖住）')
    assert.equal(portal.props.container, body, 'portal 容器必须是 document.body')
    assert.ok(findByClass(portal, 'dsh-section-send'), '编辑器内容应挂在 portal 里')
    assert.ok(findByClass(portal, 'dsh-custom-save'), '保存按钮也在 portal 里')
  } finally {
    globalThis.fetch = prevFetch
    if (prevDocument === undefined) delete globalThis.document
    else globalThis.document = prevDocument
  }
})
