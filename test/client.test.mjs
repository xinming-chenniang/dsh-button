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

/** 动作行（整行一个插槽格）的注册项。 */
function dockRegistration(ctx) {
  const registration = ctx.registrations.find((item) => item.options.id === `${PKG.name}:actions`)
  assert.ok(registration, '应当注册动作行（dsh-button:actions）')
  return registration
}

/** 挂载动作行组件（带 hooks 运行时）。 */
function mountDock(ctx) {
  const seat = dockRegistration(ctx).component()
  const Dock = seat.children[0].type
  return mountComponent(Dock)
}

/** 挂载一次动作行并取某个按钮（测试用；每次调用是新的组件实例）。 */
function dockButton(ctx, className) {
  const mounted = mountDock(ctx)
  const button = findByClass(mounted.tree, className)
  assert.ok(button, `动作行里找不到 ${className}`)
  return button
}

/** 按注册 id 挂载一个格子（bar 模式左右两格用）。 */
function mountRegistration(ctx, id) {
  const registration = ctx.registrations.find((item) => item.options.id === id)
  assert.ok(registration, `没有注册 ${id}`)
  const seat = registration.component()
  return mountComponent(seat.children[0].type)
}

test('插件对象形状：名字、注入面、动作行只注册一格（输入框上方）', async () => {
  const plugin = await loadPlugin()
  assert.equal(plugin.name, PKG.name)
  assert.ok(plugin.inject.includes('slots'), 'inject 必须含 slots')
  assert.ok(!plugin.inject.includes('conversation'), 'conversation 应当按需取，不进 inject（少一个 pending 风险）')
  assert.ok(!plugin.inject.includes('locale'), 'locale 可选，不进 inject；缺 locale 时回落中文')

  const ctx = makeCtx()
  plugin.apply(ctx)
  assert.equal(ctx.registrations.length, 1, '只应注册一格（整行动作）')
  const [reg] = ctx.registrations
  assert.equal(reg.options.name, 'conversation.composer.dock', '动作行挂在卡片下方的 dock 上（实际 portal 到它前面）')
  assert.equal(reg.options.id, `${PKG.name}:actions`)
  assert.equal(reg.options.order, 10)
  assert.ok(!ctx.registrations.some((item) => item.options.id === `${PKG.name}:suggest`), '按建议执行已合并，不应再有它')
})

test('继续：点击＝把「继续」填进当前会话并提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls })
  plugin.apply(ctx)

  const button = dockButton(ctx, 'dsh-continue-action')
  assert.equal(button.props.disabled, false, '有当前会话时继续可用')
  button.props.onClick()
  assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '继续'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})

test('有草稿时按钮不覆盖、不提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, draft: '我正在写的草稿' })
  plugin.apply(ctx)

  dockButton(ctx, 'dsh-continue-action').props.onClick()
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

  const button = dockButton(ctx, 'dsh-resend-action')
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

  const button = dockButton(ctx, 'dsh-resend-action')
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '真人说的'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})

test('重发兼容裸字符串 content', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, entries: [userMessage(1, '裸文本消息')] })
  plugin.apply(ctx)

  dockButton(ctx, 'dsh-resend-action').props.onClick()
  assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '裸文本消息'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})

test('没有打开的会话：动作按钮都禁用，点击不提交；「＋」入口仍可用', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, byId: {} })
  plugin.apply(ctx)

  const cont = dockButton(ctx, 'dsh-continue-action')
  const resend = dockButton(ctx, 'dsh-resend-action')
  assert.equal(cont.props.disabled, true)
  assert.equal(resend.props.disabled, true)
  assert.notEqual(dockButton(ctx, 'dsh-custom-manage').props.disabled, true, '编辑入口不依赖会话')

  cont.props.onClick()
  resend.props.onClick()
  assert.deepEqual(calls, [], '禁用状态下不应提交任何东西')
})

test('只有注入消息、没有真人消息：重发禁用，继续仍可用', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, entries: [userMessage(3, '注入内容', 'agent-instructions')] })
  plugin.apply(ctx)

  assert.equal(dockButton(ctx, 'dsh-resend-action').props.disabled, true)
  assert.equal(dockButton(ctx, 'dsh-continue-action').props.disabled, false)
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

  dockButton(ctx, 'dsh-continue-action').props.onClick()
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

test("删掉的预设不渲染（hidden=['continue']），重发仍在", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    assert.equal(findByClass(mounted.tree, 'dsh-continue-action'), null, '继续应当被隐藏')
    assert.ok(findByClass(mounted.tree, 'dsh-resend-action'), '重发仍应在')
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
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const tree = mounted.tree
    const button = findByClass(tree, 'dsh-custom-action')
    assert.ok(button, '应当渲染配置里的自定义按钮')
    assert.equal(button.children[0], '知识库')
    assert.equal(button.props.title, '用 knowledge-base 查我的体检', '悬浮提示只放文字预览，不再加方式前缀')
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
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    assert.equal(findByClass(mounted.tree, 'dsh-custom-action'), null)
    assert.ok(findByClass(mounted.tree, 'dsh-custom-manage'))
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
      presets: { continue: { label: '继续吧', text: '继续文字' } },
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const button = findByClass(mounted.tree, 'dsh-continue-action')
    assert.equal(button.children[0], '继续吧', '按钮文字应来自配置的 preset.continue.label')
    assert.equal(button.props.title, '继续文字', '悬浮提示和自定义按钮一样，只显示会发出去的文字（不是标签）')
    button.props.onClick()
    assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '继续文字'], ['submit']])
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
    const mounted = mountDock(ctx)
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
    const button = dockButton(ctx, 'dsh-continue-action')
    assert.equal(button.props.style.borderStyle, 'dashed', '填入类按钮用虚线边区分')
    assert.equal(button.props.title, '继续')
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
    const mounted = mountDock(ctx)
    const tree = mounted.tree
    const insertButton = findAllWithClassToken(tree, 'dsh-custom-action-insert')[0]
    assert.ok(insertButton, '插入类自定义按钮应当有自己的 class')
    assert.equal(insertButton.children[0], '模板')
    assert.equal(insertButton.props.title, '模板文字', '悬浮提示只放要填入的文字')
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
    const mounted = mountDock(ctx)
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
    const mounted = mountDock(ctx)
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
    const mounted = mountDock(ctx)
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
    const mounted = mountDock(ctx)
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

test('悬浮提示只放文字预览（不显示「直接发送 / 填入输入框」）；继续保留短句、重发不动', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const longText = '长'.repeat(200)
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [
        { label: '甲', text: '发送用的文字' },
        { label: '乙', text: longText, mode: 'insert' },
      ],
      hidden: [],
      presets: {},
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const tree = mounted.tree
    const cont = findByClass(tree, 'dsh-continue-action')
    assert.equal(cont.props.title, '继续', '继续与自定义按钮同一规则：只显示会发出去的文字')
    assert.doesNotMatch(String(cont.props.title), /直接发送|填入输入框/)

    const sendButton = findByClass(tree, 'dsh-custom-action')
    assert.equal(sendButton.props.title, '发送用的文字', '自定义按钮只显示文字预览')
    assert.equal(sendButton.props['aria-label'], sendButton.props.title, 'title 与 aria-label 同句')

    const insertButton = findAllWithClassToken(tree, 'dsh-custom-action-insert')[0]
    assert.equal(insertButton.props.title, `${'长'.repeat(120)}…`, '填入类也只显示截断后的文字')
    assert.ok(insertButton.props.title.length < longText.length, '长文字预览必须截断')
    assert.doesNotMatch(String(insertButton.props.title), /填入输入框/)
    assert.equal(findByClass(tree, 'dsh-custom-manage').props.title, '编辑动作按钮（可改方式、排序、删除）')

    // 重发先不管：保留旧规则，记录现状
    const resend = findByClass(tree, 'dsh-resend-action')
    assert.match(String(resend.props.title), /^重发上一条：/)
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器控件：都有说明性 title，预设删除/恢复跟随当前标签', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '甲', text: 'a' }], hidden: [], presets: {} }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    const titleOf = (node) => String(node?.props?.title ?? '')
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-save')), '保存到配置文件')
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-cancel')), '放弃修改')
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-close')), '关闭编辑器')
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-add-send')), '添加一条（发送）')
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-add-insert')), '添加一条（填入）')
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-remove')), '删除这条')
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-mode')), '点一下做什么')

    const removeContinue = findAllByClass(mounted.tree, 'dsh-custom-preset-remove')[0]
    assert.equal(titleOf(removeContinue), '从按钮条移除「继续」')
    removeContinue.props.onClick()
    assert.equal(titleOf(findAllByClass(mounted.tree, 'dsh-custom-preset-restore')[0]), '恢复「继续」')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('B1：动作行 portal 到卡片与统计行之间的宿主容器', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  const prevDocument = globalThis.document
  const host = {
    attrs: {},
    style: {},
    setAttribute(name) { this.attrs[name] = true },
    hasAttribute(name) { return this.attrs[name] === true },
  }
  const parent = {
    children: [],
    insertBefore(node) { this.children.push(node); return node },
  }
  const dock = { parentElement: parent }
  globalThis.document = { querySelector: () => dock, createElement: () => host }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, buttons: [] }) })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const layer = mounted.tree.children[0]
    assert.equal(layer.type, 'portal', '动作行应当走 portal')
    assert.equal(layer.props.container, host, 'portal 目标是自建宿主容器')
    assert.deepEqual(parent.children, [host], '宿主容器插在 dock 前面')
    assert.ok(findByClass(layer, 'dsh-action-row'), '整行内容在 portal 里')
  } finally {
    globalThis.fetch = prevFetch
    if (prevDocument === undefined) delete globalThis.document
    else globalThis.document = prevDocument
  }
})

test('布局 bar：两格注册，insert 进左、send＋入口进右', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  const prevStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => 'bar', setItem: () => {} }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [{ label: '模板', text: '模板文字', mode: 'insert' }],
      hidden: [],
      presets: { continue: { mode: 'insert', label: '继续吧', text: '继续文字' } },
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(ctx.registrations.length, 2, '控制行模式应当两格')
    assert.deepEqual(
      ctx.registrations.map((item) => item.options.id).sort(),
      [`${PKG.name}:insert`, `${PKG.name}:send`],
    )
    assert.equal(ctx.registrations.find((item) => item.options.id === `${PKG.name}:insert`)?.options.name, 'conversation.input.left')
    assert.equal(ctx.registrations.find((item) => item.options.id === `${PKG.name}:send`)?.options.name, 'conversation.input.right')

    const left = mountRegistration(ctx, `${PKG.name}:insert`)
    assert.equal(findByClass(left.tree, 'dsh-continue-action')?.children[0], '继续吧', 'insert 类继续在左')
    assert.ok(findAllWithClassToken(left.tree, 'dsh-custom-action-insert').length > 0, 'insert 类自定义在左')
    assert.equal(findByClass(left.tree, 'dsh-custom-manage'), null, '入口只在右侧')

    const right = mountRegistration(ctx, `${PKG.name}:send`)
    assert.ok(findByClass(right.tree, 'dsh-resend-action'), 'send 类重发在右')
    assert.equal(findByClass(right.tree, 'dsh-continue-action'), null, 'insert 类继续不在右')
    assert.ok(findByClass(right.tree, 'dsh-custom-manage'), '右侧有编辑器入口')
  } finally {
    globalThis.fetch = prevFetch
    if (prevStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = prevStorage
  }
})

test('编辑器位置下拉：below→bar→below 换注册，localStorage 记住', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const writes = []
  const prevStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => null, setItem: (key, value) => writes.push([key, value]) }
  try {
    plugin.apply(ctx)
    assert.equal(ctx.registrations.length, 1)
    const dock = mountDock(ctx)
    findByClass(dock.tree, 'dsh-custom-manage').props.onClick()
    const select = findByClass(dock.tree, 'dsh-layout-select')
    assert.ok(select, '编辑器里应当有位置下拉')
    assert.equal(select.props.value, 'below')
    select.props.onChange({ target: { value: 'bar' } })
    assert.equal(ctx.registrations.length, 2)
    assert.deepEqual(ctx.registrations.map((item) => item.options.id).sort(), [`${PKG.name}:insert`, `${PKG.name}:send`])

    const right = mountRegistration(ctx, `${PKG.name}:send`)
    findByClass(right.tree, 'dsh-custom-manage').props.onClick()
    findByClass(right.tree, 'dsh-layout-select').props.onChange({ target: { value: 'below' } })
    assert.equal(ctx.registrations.length, 1)
    assert.equal(ctx.registrations[0].options.id, `${PKG.name}:actions`)
    assert.deepEqual(writes, [['dsh-button:layout', 'bar'], ['dsh-button:layout', 'below']])
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = prevStorage
  }
})

test('布局 card：动作行宿主 append 进卡片', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevStorage = globalThis.localStorage
  const prevDocument = globalThis.document
  const host = {
    attrs: {},
    style: {},
    setAttribute(name, value) { this.attrs[name] = value },
    getAttribute(name) { return this.attrs[name] },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) },
  }
  const card = {
    children: [],
    appendChild(node) { this.children.push(node); return node },
  }
  const dock = { parentElement: { children: [card], insertBefore() {} }, previousElementSibling: card }
  globalThis.localStorage = { getItem: () => 'card', setItem: () => {} }
  globalThis.document = {
    querySelector: () => dock,
    createElement: () => host,
    querySelectorAll: () => [],
  }
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    assert.deepEqual(card.children, [host], '宿主容器应 append 进卡片')
    assert.equal(host.getAttribute('data-dsh-action-row'), 'card')
    const layer = mounted.tree.children[0]
    assert.equal(layer.type, 'portal')
    assert.equal(layer.props.container, host)
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = prevStorage
    if (prevDocument === undefined) delete globalThis.document
    else globalThis.document = prevDocument
  }
})

test('内容框转义：\\n / \\t / \\\\ 解码，换行按钮追加可读标记', async () => {
  const plugin = await loadPlugin()
  const { decodeActionText, appendNewlineToken } = plugin.__internals
  assert.equal(decodeActionText('第一行\\n第二行'), '第一行\n第二行')
  assert.equal(decodeActionText('A\\tB'), 'A\tB')
  assert.equal(decodeActionText('C\\\\n'), 'C\\n')
  assert.equal(appendNewlineToken('abc'), 'abc\\n')
  assert.equal(appendNewlineToken(''), '\\n')
})

test('编辑器：内容框和 ↑ 之间新增换行按钮，点一下在末尾追加 \\n', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const posts = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      posts.push(body)
      return { ok: true, status: 200, json: async () => ({ ok: true, ...body }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        buttons: [{ label: '多行', text: '第一行', mode: 'insert' }],
        hidden: [],
        presets: { continue: { text: '继续文字', mode: 'send' } },
      }),
    }
  }
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    const customText = findByClass(mounted.tree, 'dsh-custom-text-input')
    assert.equal(customText.props.value, '第一行')
    findByClass(mounted.tree, 'dsh-custom-newline').props.onClick()
    assert.equal(findByClass(mounted.tree, 'dsh-custom-text-input').props.value, '第一行\\n')

    const presetText = findByClass(mounted.tree, 'dsh-preset-text-input')
    assert.equal(presetText.props.value, '继续文字')
    findByClass(mounted.tree, 'dsh-preset-newline').props.onClick()
    assert.equal(findByClass(mounted.tree, 'dsh-preset-text-input').props.value, '继续文字\\n')

    findByClass(mounted.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(posts.length, 1)
    assert.equal(posts[0].buttons[0].text, '第一行\\n')
    assert.equal(posts[0].presets.continue.text, '继续文字\\n')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('执行时解码：发送和填入都把 \\n 变成真换行', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, insert: { caret: [0, 0], draftRev: 1 } })
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [
        { label: '发', text: '第一行\\n第二行', mode: 'send' },
        { label: '填', text: '甲\\n乙', mode: 'insert' },
      ],
      hidden: [],
      presets: {},
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-action').props.onClick()
    assert.deepEqual(calls.slice(-3), [
      ['for', 'session-test'],
      ['setDraft', '第一行\n第二行'],
      ['submit'],
    ])
    calls.length = 0
    findAllWithClassToken(mounted.tree, 'dsh-custom-action-insert')[0].props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
      ['insertText', '甲\n乙', { start: 0, end: 0, draftRev: 1 }],
      ['focus'],
    ])
  } finally {
    globalThis.fetch = prevFetch
  }
})
