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
import { MAX_BUTTONS } from '../lib/buttons.js'

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
  // 单测默认按“卡片下方”布局跑（多数断言按一格 dock 写）；发行默认 bar 有单独用例。
  if (globalThis.localStorage === undefined) {
    globalThis.localStorage = {
      getItem: (key) => (key === 'dsh-button:layout' ? 'below' : null),
      setItem: () => {},
    }
  }
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

/** 沿元素树找第一个 class 命中的元素（按 class token 匹配，允许一行带多个 class）。 */
function findByClass(node, className) {
  if (node === null || typeof node !== 'object') return null
  const tokens = String(node.props?.className ?? '').split(/\s+/)
  if (tokens.includes(className)) return node
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

/** 收集所有 class 命中的元素（编辑器里每行都有 ↑↓，必须按序取）；按 class token 匹配。 */
function findAllByClass(node, className) {
  const found = []
  const walk = (item) => {
    if (item === null || typeof item !== 'object') return
    const tokens = String(item.props?.className ?? '').split(/\s+/)
    if (tokens.includes(className)) found.push(item)
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

/** 按按钮文字找动作（继续现在也是普通按钮，label 就是它的文字）。 */
function actionByLabel(tree, label) {
  return findAllWithClassToken(tree, 'dsh-custom-action').find((button) => button.children[0] === label) ?? null
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

  const mounted = mountDock(ctx)
  const button = actionByLabel(mounted.tree, '继续')
  assert.ok(button, '继续现在也是普通按钮')
  assert.equal(button.props.disabled, false, '有当前会话时继续可用')
  button.props.onClick()
  assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '继续'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})

test('有草稿时按钮不覆盖、不提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, draft: '我正在写的草稿' })
  plugin.apply(ctx)

  const mounted = mountDock(ctx)
  actionByLabel(mounted.tree, '继续').props.onClick()
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

test('没有打开的会话：动作按钮都禁用，点击不提交；「＋」入口仍可用', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, byId: {} })
  plugin.apply(ctx)

  const mounted = mountDock(ctx)
  const cont = actionByLabel(mounted.tree, '继续')
  assert.equal(cont.props.disabled, true)
  assert.notEqual(findByClass(mounted.tree, 'dsh-custom-manage').props.disabled, true, '编辑入口不依赖会话')

  cont.props.onClick()
  assert.deepEqual(calls, [], '禁用状态下不应提交任何东西')
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

  const mounted = mountDock(ctx)
  actionByLabel(mounted.tree, '继续').props.onClick()
  assert.deepEqual(calls, [['for', 'session-a'], ['setDraft', '继续'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})

test('自定义按钮：表单行 → 配置（空行跳过、半空行报错、上限与长度校验）', async () => {
  const plugin = await loadPlugin()
  const { blankCustomRow, validateCustomRows, MAX_CUSTOM } = plugin.__internals
  assert.deepEqual(blankCustomRow(), { label: '', text: '', mode: 'send', style: 'secondary', side: 'right' })
  assert.deepEqual(blankCustomRow('insert'), { label: '', text: '', mode: 'insert', style: 'ghost', side: 'left' })
  // 位置显式指定时以它为准（位置与动作解耦：左侧也可以是发送按钮）
  assert.deepEqual(blankCustomRow('send', 'left'), { label: '', text: '', mode: 'send', style: 'secondary', side: 'left' })
  // 空行直接跳过，不要求用户自己删干净
  assert.deepEqual(validateCustomRows([
    { label: ' 收尾 ', text: ' 收尾 ' },
    blankCustomRow(),
  ]), {
    ok: true,
    buttons: [{ label: '收尾', text: '收尾', mode: 'send', style: 'secondary', side: 'right' }],
  })
  // mode 原样带上（编辑器按位置分区，位置与动作解耦）
  assert.deepEqual(validateCustomRows([{ label: '模板', text: 'x', mode: 'insert' }]), {
    ok: true,
    buttons: [{ label: '模板', text: 'x', mode: 'insert', style: 'ghost', side: 'left' }],
  })
  // 外观原样带上；旧的 icon 字段已删除，行里带了也忽略
  assert.deepEqual(validateCustomRows([{ label: '主', text: 'x', style: 'primary' }]), {
    ok: true,
    buttons: [{ label: '主', text: 'x', mode: 'send', style: 'primary', side: 'right' }],
  })
  assert.deepEqual(validateCustomRows([{ label: '主', text: 'x', icon: '🏁' }]), {
    ok: true,
    buttons: [{ label: '主', text: 'x', mode: 'send', style: 'secondary', side: 'right' }],
  })
  // 位置显式指定时原样带上，与 mode 解耦（左侧的发送按钮合法）
  assert.deepEqual(validateCustomRows([{ label: '左发', text: 'x', side: 'left' }]), {
    ok: true,
    buttons: [{ label: '左发', text: 'x', mode: 'send', style: 'secondary', side: 'left' }],
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
  assert.deepEqual(validateCustomRows([{ label: 'a=b', text: 'x' }]), { ok: true, buttons: [{ label: 'a=b', text: 'x', mode: 'send', style: 'secondary', side: 'right' }] })
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
    assert.equal(actionByLabel(mounted.tree, '继续'), null, 'hidden=continue 时不再补继续')
    assert.ok(findByClass(mounted.tree, 'dsh-custom-manage'), '编辑入口仍在')
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
    const button = actionByLabel(tree, '知识库')
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

test('配置为空时仍保留「继续」和「＋」入口', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, buttons: [] }) })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    assert.ok(actionByLabel(mounted.tree, '继续'), '继续是默认动作，不能再被当成特殊预设')
    assert.ok(findByClass(mounted.tree, 'dsh-custom-manage'))
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
    hidden: ['continue'],
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
    const mounted = mountDock(ctx)
    const button = actionByLabel(mounted.tree, '继续')
    assert.ok(button)
    assert.equal(button.props.style.borderStyle, 'dashed', '填入类按钮用虚线边区分')
    assert.match(button.props.title, /^继续 · Ctrl \+ 点击直接发送$/, '填入类提示带 Ctrl 直发说明')
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
    assert.equal(insertButton.props.style.borderStyle, 'dashed', '填入=虚线')
    assert.equal(insertButton.props.style.background, 'transparent', '填入=透明底')
    assert.match(insertButton.props.title, /^模板文字 · Ctrl \+ 点击直接发送$/, '悬浮提示只放要填入的文字，另加 Ctrl 直发说明')
    insertButton.props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
      ['insertText', '模板文字', { start: 0, end: 0, draftRev: 2 }],
      ['focus'],
    ], `插入按钮不应 submit：${JSON.stringify(calls)}`)
    // 同一排里的直接发送按钮仍然是原来的行为
    const sendButton = actionByLabel(tree, '收尾')
    assert.ok(sendButton, '直接发送按钮保留原 class')
    assert.equal(sendButton.props.style.borderStyle, 'solid', '发送=实线')
    assert.match(String(sendButton.props.style.background), /color-mix/, '发送=浅色填充')
    sendButton.props.onClick()
    assert.deepEqual(calls.slice(-3), [
      ['for', 'session-test'], ['setDraft', '收尾'], ['submit'],
    ], `发送按钮仍应 setDraft+submit：${JSON.stringify(calls)}`)
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器：动作按「左侧 / 右侧」两区分开；保存带上每条的位置与方式', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx({ insert: { caret: [0, 0], draftRev: 1 } })
  const posts = []
  const prevFetch = globalThis.fetch
  const base = {
    buttons: [
      { label: '甲', text: 'a' },
      { label: '乙', text: 'b', mode: 'insert' },
    ],
    hidden: ['continue'],
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
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    const leftSection = () => findByClass(mounted.tree, 'dsh-section-left')
    const rightSection = () => findByClass(mounted.tree, 'dsh-section-right')
    const labelsOf = (section) => findAllWithClassToken(section, 'dsh-custom-label-input').map((input) => input.props.value)
    // 缺省位置按方式派生：insert → 左侧、send → 右侧（与 1.3 的位置完全一致）
    assert.deepEqual(labelsOf(rightSection()), ['甲'])
    assert.deepEqual(labelsOf(leftSection()), ['乙'])
    assert.equal(findAllWithClassToken(rightSection(), 'dsh-mode-send')[0].props['aria-checked'], true)
    assert.equal(findAllWithClassToken(leftSection(), 'dsh-mode-insert')[0].props['aria-checked'], true)

    findByClass(mounted.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].buttons, [
      { label: '甲', text: 'a', mode: 'send', style: 'secondary', side: 'right' },
      { label: '乙', text: 'b', mode: 'insert', style: 'ghost', side: 'left' },
    ], '每条按钮的位置与方式都要原样落盘')
    assert.deepEqual(posts[0].hidden, ['continue'])
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器：⇄ 换侧才换区；改方式不换区；每区「添加一条」沿用本区位置', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  const base = { buttons: [{ label: '甲', text: 'a' }], hidden: ['continue'], presets: {} }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ...base }) })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    const section = (side) => findByClass(mounted.tree, `dsh-section-${side}`)
    const labels = (side) => findAllWithClassToken(section(side), 'dsh-custom-label-input').map((input) => input.props.value)

    // 左侧一开始没有行（甲是发送按钮，缺省在右侧）
    assert.deepEqual(labels('left'), [])
    // 在左侧加一条：空行落在左侧，动作默认「填入」
    findByClass(mounted.tree, 'dsh-custom-add-left').props.onClick()
    assert.deepEqual(labels('left'), [''])
    assert.equal(findAllWithClassToken(section('left'), 'dsh-mode-insert')[0].props['aria-checked'], true, '左侧新行默认填入')
    // 改「方式」不换区：甲改成填入后仍留在右侧（位置与动作解耦）
    findAllWithClassToken(section('right'), 'dsh-mode-insert')[0].props.onClick()
    assert.deepEqual(labels('right'), ['甲'], '改方式不换区')
    assert.equal(findAllWithClassToken(section('right'), 'dsh-mode-insert')[0].props['aria-checked'], true)
    // 点「⇄」才换侧：甲移到左侧，按数组顺序排在空行前面
    findAllWithClassToken(section('right'), 'dsh-custom-side')[0].props.onClick()
    assert.deepEqual(labels('left'), ['甲', ''], '换侧后按数组顺序插入本区')
    assert.deepEqual(labels('right'), [])
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
    hidden: ['continue'],
    presets: {},
  }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ...base }) })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    const labelsOf = (section) => findAllWithClassToken(section, 'dsh-custom-label-input').map((input) => input.props.value)
    let rightSection = findByClass(mounted.tree, 'dsh-section-right')
    assert.deepEqual(labelsOf(rightSection), ['甲', '丙'], '左侧那条（填入类）不参与右侧区的排序')
    const ups = findAllByClass(rightSection, 'dsh-custom-up')
    assert.equal(ups[0].props.disabled, true, '本区第一条不能再上移')
    assert.equal(ups[1].props.disabled, false)
    ups[1].props.onClick()

    rightSection = findByClass(mounted.tree, 'dsh-section-right')
    assert.deepEqual(labelsOf(rightSection), ['丙', '甲'], '同区内换位')
    assert.deepEqual(labelsOf(findByClass(mounted.tree, 'dsh-section-left')), ['乙'], '另一区顺序不变')

    const downs = findAllByClass(rightSection, 'dsh-custom-down')
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
    assert.ok(findByClass(portal, 'dsh-section-right'), '编辑器内容应挂在 portal 里')
    assert.ok(findByClass(portal, 'dsh-custom-save'), '保存按钮也在 portal 里')
    assert.ok(findByClass(portal, 'dsh-custom-editor-backdrop'), '面板背后有透明遮罩')
    findByClass(portal, 'dsh-custom-editor-backdrop').props.onClick()
    assert.equal(findByType(mounted.tree, 'portal'), null, '点击面板外关闭设置面板')
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
    const cont = actionByLabel(tree, '继续')
    assert.equal(cont.props.title, '继续', '继续现在是普通按钮：只显示会发出去的文字')
    assert.doesNotMatch(String(cont.props.title), /直接发送|填入输入框/)

    const sendButton = actionByLabel(tree, '甲')
    assert.equal(sendButton.props.title, '发送用的文字', '自定义按钮只显示文字预览')
    assert.equal(sendButton.props['aria-label'], sendButton.props.title, 'title 与 aria-label 同句')

    const insertButton = findAllWithClassToken(tree, 'dsh-custom-action-insert')[0]
    assert.equal(insertButton.props.title, `${'长'.repeat(120)}… · Ctrl + 点击直接发送`, '填入类也只显示截断后的文字')
    assert.ok(insertButton.props.title.length < longText.length, '长文字预览必须截断')
    assert.doesNotMatch(String(insertButton.props.title), /填入输入框/)
    assert.equal(findByClass(tree, 'dsh-custom-manage').props.title, '设置')
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
    json: async () => ({ ok: true, buttons: [{ label: '甲', text: 'a' }], hidden: ['continue'], presets: {} }),
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
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-add-left')), '添加一条（左侧）')
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-add-right')), '添加一条（右侧）')
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-remove')), '删除这条')
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-mode')), '点一下做什么')
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

test('发行默认布局是控制行（bar 两格）', async () => {
  const plugin = await loadPlugin()
  const prevStorage = globalThis.localStorage
  delete globalThis.localStorage
  const ctx = makeCtx()
  try {
    plugin.apply(ctx)
    assert.equal(ctx.registrations.length, 2)
    assert.deepEqual(ctx.registrations.map((item) => item.options.id).sort(), [`${PKG.name}:insert`, `${PKG.name}:send`])
  } finally {
    globalThis.localStorage = prevStorage
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
      buttons: [
        { label: '模板', text: '模板文字', mode: 'insert' },
        { label: '收尾', text: '收尾', mode: 'send' },
      ],
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
    assert.equal(actionByLabel(left.tree, '继续吧')?.children[0], '继续吧', 'insert 类继续在左')
    assert.ok(findAllWithClassToken(left.tree, 'dsh-custom-action-insert').length > 0, 'insert 类自定义在左')
    assert.ok(findByClass(left.tree, 'dsh-custom-manage'), '＋ 固定在左组')

    const right = mountRegistration(ctx, `${PKG.name}:send`)
    assert.equal(findByClass(right.tree, 'dsh-custom-manage'), null, '＋ 不在右侧')
    assert.equal(actionByLabel(right.tree, '继续吧'), null, 'insert 类继续不在右')
    assert.ok(actionByLabel(right.tree, '收尾'), 'send 类自定义在右')
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
  globalThis.localStorage = { getItem: (key) => (key === 'dsh-button:layout' ? 'below' : null), setItem: (key, value) => writes.push([key, value]) }
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

    const left = mountRegistration(ctx, `${PKG.name}:insert`)
    findByClass(left.tree, 'dsh-custom-manage').props.onClick()
    findByClass(left.tree, 'dsh-layout-select').props.onChange({ target: { value: 'below' } })
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

test('内容框转义：\\n / /n / \\t / \\\\ 解码', async () => {
  const plugin = await loadPlugin()
  const { decodeActionText } = plugin.__internals
  assert.equal(decodeActionText('第一行\\n第二行'), '第一行\n第二行')
  assert.equal(decodeActionText('第一行/n第二行'), '第一行\n第二行')
  assert.equal(decodeActionText('A\\tB'), 'A\tB')
  assert.equal(decodeActionText('C\\\\n'), 'C\\n')
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
      hidden: ['continue'],
      presets: {},
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    actionByLabel(mounted.tree, '发').props.onClick()
    assert.deepEqual(calls.slice(-3), [
      ['for', 'session-test'],
      ['setDraft', '第一行\n第二行'],
      ['submit'],
    ])
    calls.length = 0
    findAllWithClassToken(mounted.tree, 'dsh-custom-action-insert')[0].props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
      ['setDraft', '甲\n乙'],
      ['focus'],
    ])
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('继续也是普通按钮：能跟自定义一起排序；＋ 在左组最前；重发已移除', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const posts = []
  const prevFetch = globalThis.fetch
  const base = {
    buttons: [
      { label: '甲', text: 'a' },
      { label: '乙', text: 'b' },
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
    assert.equal(findByClass(mounted.tree, 'dsh-resend-action'), null, '重发按钮已移除')
    const insertGroup = findByClass(mounted.tree, 'dsh-action-row-insert')
    assert.equal(insertGroup.children[0].props.className, 'dsh-custom-manage', '＋ 固定在左组最前')

    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()
    const labelsOf = () => findAllWithClassToken(findByClass(mounted.tree, 'dsh-section-right'), 'dsh-custom-label-input')
      .map((input) => input.props.value)
    assert.deepEqual(labelsOf(), ['继续', '甲', '乙'], '继续现在是第一条普通按钮')
    // 继续下移一位 → 甲 继续 乙
    findAllByClass(mounted.tree, 'dsh-custom-down')[0].props.onClick()
    assert.deepEqual(labelsOf(), ['甲', '继续', '乙'], '继续可以跟自定义按钮换位')

    findByClass(mounted.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(posts[0].buttons.map((button) => button.label), ['甲', '继续', '乙'], '顺序按编辑器落盘')
    assert.deepEqual(posts[0].hidden, ['continue'])
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('动作条按 side 分组：左侧也能放发送按钮（位置与动作解耦）', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [
        { label: '左发', text: 'a', side: 'left' },
        { label: '右填', text: 'b', mode: 'insert', side: 'right' },
      ],
      hidden: ['continue'],
      presets: {},
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const leftGroup = findByClass(mounted.tree, 'dsh-action-row-insert')
    const rightGroup = findByClass(mounted.tree, 'dsh-action-row-send')
    assert.ok(actionByLabel(leftGroup, '左发'), '显式 side=left 的发送按钮在左组')
    assert.equal(actionByLabel(leftGroup, '右填'), null, 'insert 但 side=right 的不在左组')
    assert.ok(actionByLabel(rightGroup, '右填'), '显式 side=right 的填入按钮在右组')
    assert.equal(actionByLabel(rightGroup, '左发'), null, 'send 但 side=left 的不在右组')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('容量：每侧最多显示 6 条，多出来的收进「⋯ 全部动作」，面板可搜索并直接执行', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls })
  const prevFetch = globalThis.fetch
  const many = Array.from({ length: 8 }, (_, i) => ({ label: `动作${i + 1}`, text: `文字${i + 1}` }))
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, buttons: many, hidden: ['continue'], presets: {} }) })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const visible = findAllWithClassToken(mounted.tree, 'dsh-custom-action')
    assert.equal(visible.length, 6, '动作条每侧只显示 6 条')
    const more = findByClass(mounted.tree, 'dsh-more-actions')
    assert.ok(more, '有溢出时显示「⋯」入口')
    assert.equal(more.children[0], '⋯ 2', '入口上标出被收起的条数')
    // 打开面板：8 条都能找到
    more.props.onClick()
    assert.ok(findByClass(mounted.tree, 'dsh-action-panel'), '点开后有面板')
    assert.equal(findAllByClass(mounted.tree, 'dsh-panel-action').length, 8, '面板列出全部动作（含溢出的）')
    // 搜索过滤：按标签 / 文字都行
    const search = findByClass(mounted.tree, 'dsh-action-panel-search')
    search.props.onChange({ target: { value: '动作7' } })
    assert.deepEqual(findAllByClass(mounted.tree, 'dsh-panel-action').map((item) => item.props['aria-label']), ['动作7'])
    search.props.onChange({ target: { value: '文字8' } })
    assert.deepEqual(findAllByClass(mounted.tree, 'dsh-panel-action').map((item) => item.props['aria-label']), ['动作8'])
    search.props.onChange({ target: { value: '不存在' } })
    assert.equal(findAllByClass(mounted.tree, 'dsh-panel-action').length, 0)
    assert.ok(findByClass(mounted.tree, 'dsh-action-panel-list').children.some((child) => child?.children?.[0] === '没有匹配的动作'), '空结果有提示')
    // 点面板里的一条：执行并关面板
    search.props.onChange({ target: { value: '动作8' } })
    findByClass(mounted.tree, 'dsh-panel-action').props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [['setDraft', '文字8'], ['submit']], '面板里的发送直接走发送逻辑')
    assert.equal(findByClass(mounted.tree, 'dsh-action-panel'), null, '执行后关闭面板')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('容量：不超过 6 条时没有「⋯」入口；上限与宿主一致（40）', async () => {
  const plugin = await loadPlugin()
  const { MAX_CUSTOM, validateCustomRows } = plugin.__internals
  assert.equal(MAX_CUSTOM, MAX_BUTTONS, '客户端上限必须与宿主 MAX_BUTTONS 一致')
  assert.equal(MAX_CUSTOM, 40)
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ label: `b${i}`, text: 'x' }))
  assert.equal(validateCustomRows(rows(MAX_CUSTOM)).ok, true, '40 条应当合法')
  assert.equal(validateCustomRows(rows(MAX_CUSTOM + 1)).ok, false, '41 条应当被拒')

  // 6 条时动作条全显示，没有「⋯」
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: Array.from({ length: 6 }, (_, i) => ({ label: `a${i}`, text: 'x' })), hidden: ['continue'], presets: {} }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    assert.equal(findAllWithClassToken(mounted.tree, 'dsh-custom-action').length, 6)
    assert.equal(findByClass(mounted.tree, 'dsh-more-actions'), null, '没有溢出就不加「⋯」')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('保存失败：原因显示在常驻页脚（不藏在可滚动正文里），面板不关、按钮恢复可用', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  const base = { buttons: [{ label: '甲', text: 'a' }], hidden: ['continue'], presets: {} }
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      return { ok: false, status: 400, json: async () => ({ ok: false, message: '最多 8 个自定义按钮（当前 10 个）' }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, ...base }) }
  }
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()
    findByClass(mounted.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const errorBox = findByClass(mounted.tree, 'dsh-custom-error')
    assert.ok(errorBox, '失败原因必须有固定落点（页脚）')
    assert.equal(errorBox.children[0], '最多 8 个自定义按钮（当前 10 个）', '原因原文透出')
    const saveButton = findByClass(mounted.tree, 'dsh-custom-save')
    assert.ok(saveButton, '面板不关')
    assert.equal(saveButton.props.disabled, false, '失败后按钮恢复可用')
    assert.equal(saveButton.children[0], '保存')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('模型实验开关：勾选后写 localStorage 并强制收起', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevDocument = globalThis.document
  const prevStorage = globalThis.localStorage
  const attrs = {}
  const styles = []
  const root = {
    setAttribute(name, value) { attrs[name] = value },
    removeAttribute(name) { delete attrs[name] },
  }
  const head = { appendChild(node) { styles.push(node) } }
  globalThis.document = {
    documentElement: root,
    head,
    body: {},
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    querySelector: () => null,
  }
  globalThis.localStorage = {
    store: new Map([['dsh-button:layout', 'below']]),
    getItem(key) { return this.store.get(key) ?? null },
    setItem(key, value) { this.store.set(key, value) },
  }
  try {
    plugin.apply(ctx)
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()
    const checkbox = findByClass(mounted.tree, 'dsh-model-compact')
    assert.ok(checkbox, '编辑器里应当有模型收起开关')
    assert.equal(checkbox.props.checked, true)
    checkbox.props.onChange({ target: { checked: false } })
    assert.equal(globalThis.localStorage.getItem('dsh-button:model-compact'), '0')
    assert.ok(!Object.prototype.hasOwnProperty.call(attrs, 'data-dsh-button-model-compact'))
    assert.ok(styles.length >= 1, '应当注入作用域 CSS')
    assert.ok(styles.some((style) => /--dsh-composer-model-text-display:none/.test(style.textContent)))
  } finally {
    if (prevDocument === undefined) delete globalThis.document
    else globalThis.document = prevDocument
    if (prevStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = prevStorage
  }
})

test('按钮大小三档：写 localStorage、加根属性、动作条用 CSS 变量', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevDocument = globalThis.document
  const prevStorage = globalThis.localStorage
  const attrs = {}
  const styles = []
  const root = {
    setAttribute(name, value) { attrs[name] = value },
    removeAttribute(name) { delete attrs[name] },
  }
  const head = { appendChild(node) { styles.push(node) } }
  globalThis.document = {
    documentElement: root,
    head,
    body: {},
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    querySelector: () => null,
  }
  globalThis.localStorage = {
    store: new Map([['dsh-button:layout', 'below']]),
    getItem(key) { return this.store.get(key) ?? null },
    setItem(key, value) { this.store.set(key, value) },
  }
  try {
    plugin.apply(ctx)
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()
    const select = findByClass(mounted.tree, 'dsh-size-select')
    assert.ok(select, '设置里应当有按钮大小')
    assert.equal(select.props.value, 'large')
    assert.equal(attrs['data-dsh-button-size'], 'large', '默认就是大号')
    select.props.onChange({ target: { value: 'compact' } })
    assert.equal(globalThis.localStorage.getItem('dsh-button:size'), 'compact')
    assert.equal(attrs['data-dsh-button-size'], 'compact')
    assert.ok(styles.some((style) => /--dsh-btn-h:22px/.test(style.textContent)), '应当注入紧凑 CSS 变量')
    assert.equal(findByClass(mounted.tree, 'dsh-custom-action').props.style.height, 'var(--dsh-btn-h, 26px)')
  } finally {
    if (prevDocument === undefined) delete globalThis.document
    else globalThis.document = prevDocument
    if (prevStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = prevStorage
  }
})

test('外观：四种语义样式各自成型；旧 icon 字段不再渲染', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [
        { label: '主', text: 'a', style: 'primary' },
        { label: '危', text: 'b', style: 'danger' },
        { label: '线', text: 'c', style: 'ghost' },
        { label: '默认', text: 'd' },
        { label: '带图', text: 'e', icon: '🏁', mode: 'insert' },
      ],
      hidden: ['continue'],
      presets: {},
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const tree = mountDock(ctx).tree
    const primary = actionByLabel(tree, '主')
    assert.equal(primary.props.style.background, 'var(--dsw-alias-state-business-primary, #4d6bfe)', '主色 = 实底')
    assert.equal(primary.props.style.color, '#fff')
    const danger = actionByLabel(tree, '危')
    assert.equal(danger.props.style.color, '#e5484d', '警示 = 红字')
    assert.match(String(danger.props.style.background), /#e5484d/)
    const ghost = actionByLabel(tree, '线')
    assert.equal(ghost.props.style.borderStyle, 'dashed', '虚线 = 虚线边')
    assert.equal(ghost.props.style.background, 'transparent', '虚线 = 透明底')
    const plain = actionByLabel(tree, '默认')
    assert.equal(plain.props.style.borderStyle, 'solid', '不写外观时发送类 = 实线')
    assert.match(String(plain.props.style.background), /color-mix/)
    assert.match(String(plain.props.style.borderColor), /color-mix/, '浅底边框跟底色同源（主色淡边），不用全局深边')
    const legacyIcon = actionByLabel(tree, '带图')
    assert.ok(legacyIcon, '旧配置里带 icon 的按钮仍应渲染（icon 已被忽略）')
    assert.equal(legacyIcon.children[0], '带图', '旧 icon 字段不再拼到标签前')
    assert.equal(legacyIcon.props.style.borderStyle, 'dashed', 'insert 缺省 = 虚线')
    assert.match(String(primary.props.className), /dsh-style-primary/, 'class 上带样式 token')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('Ctrl + 点击：填入类直接发送；普通点击仍只填光标处', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, insert: { caret: [0, 0], draftRev: 1 } })
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '模板', text: '模板文字', mode: 'insert' }], hidden: ['continue'], presets: {} }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const tree = mountDock(ctx).tree
    const button = actionByLabel(tree, '模板')
    button.props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [['insertText', '模板文字', { start: 0, end: 0, draftRev: 1 }], ['focus']], '普通点击只填入')
    calls.length = 0
    button.props.onClick({ ctrlKey: true })
    assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '模板文字'], ['submit']], 'Ctrl + 点击直接发送')
    calls.length = 0
    button.props.onClick({ metaKey: true })
    assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '模板文字'], ['submit']], 'Cmd + 点击同样直接发送')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器：外观控件与实时预览', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '甲', text: 'a' }], hidden: ['continue'], presets: {} }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()
    assert.equal(findByClass(mounted.tree, 'dsh-custom-icon-input'), null, '图标输入框已删除')
    assert.equal(findByClass(mounted.tree, 'dsh-custom-style').props.value, 'secondary', '每行应有外观下拉')
    const previewOf = () => findAllWithClassToken(mounted.tree, 'dsh-preview-action')
    assert.ok(findByClass(mounted.tree, 'dsh-editor-preview'), '编辑器应有实时预览')
    assert.equal(previewOf().length, 1)
    assert.equal(previewOf()[0].children[0], '甲')
    // 改外观：预览按钮的 class 带新 token
    findByClass(mounted.tree, 'dsh-custom-style').props.onChange({ target: { value: 'danger' } })
    assert.match(String(previewOf()[0].props.className), /dsh-style-danger/, '预览里的外观跟着变')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('clampEditorPos：把面板夹回视口，四周至少留 margin', async () => {
  const plugin = await loadPlugin()
  const { clampEditorPos } = plugin.__internals
  const size = { width: 600, height: 400 }
  const viewport = { width: 1024, height: 768 }
  assert.deepEqual(clampEditorPos({ left: 100, top: 100 }, size, viewport), { left: 100, top: 100 }, '视口内不动')
  assert.deepEqual(clampEditorPos({ left: -50, top: -50 }, size, viewport), { left: 8, top: 8 }, '越界夹到 margin')
  assert.deepEqual(clampEditorPos({ left: 9999, top: 9999 }, size, viewport), { left: 416, top: 360 }, '右下夹到边界')
  // 面板比视口还大：至少露出 margin，不能算出负数
  assert.deepEqual(clampEditorPos({ left: 0, top: 0 }, { width: 2000, height: 2000 }, viewport), { left: 8, top: 8 })
})

test('设置面板可拖动：标题栏拖拽改 left/top 并记住；双击复位；按钮上不启动拖动', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  const prevStorage = globalThis.localStorage
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (key === 'dsh-button:layout' ? 'below' : (store.get(key) ?? null)),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '甲', text: 'a' }], hidden: ['continue'], presets: {} }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()
    const header = findByClass(mounted.tree, 'dsh-custom-editor-header')
    assert.ok(header, '标题栏是拖动手柄')
    assert.equal(header.props.style.cursor, 'grab')

    // 标题栏上的按钮不启动拖动（否则点 × 会被当成拖）
    header.props.onPointerDown({ button: 0, clientX: 0, clientY: 0, pointerId: 9, target: { tagName: 'BUTTON' }, currentTarget: { parentElement: null } })
    header.props.onPointerMove({ clientX: 999, clientY: 999, pointerId: 9 })
    assert.equal(findByClass(mounted.tree, 'dsh-custom-editor-panel').props.style.left, undefined, '没拖过就还是右下角默认位')

    // 从 (100,100) 拖到 (150,120)：面板从 (200,300) 移到 (250,320)
    header.props.onPointerDown({
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
      target: { tagName: 'STRONG' },
      currentTarget: {
        parentElement: { getBoundingClientRect: () => ({ left: 200, top: 300, width: 600, height: 400 }) },
        setPointerCapture() {},
      },
      preventDefault() {},
    })
    header.props.onPointerMove({ clientX: 150, clientY: 120, pointerId: 1 })
    const panel = findByClass(mounted.tree, 'dsh-custom-editor-panel')
    assert.equal(panel.props.style.left, '250px', '向右拖 50px')
    assert.equal(panel.props.style.top, '320px', '向下拖 20px')
    assert.equal(panel.props.style.right, 'auto', '拖过之后不再用右下角定位')
    assert.equal(store.get('dsh-button:editor-pos'), '{"left":250,"top":320}', '位置写进 localStorage')
    header.props.onPointerUp()

    // 双击标题栏复位：回到右下角默认位，并清掉记忆
    findByClass(mounted.tree, 'dsh-custom-editor-header').props.onDoubleClick()
    const reset = findByClass(mounted.tree, 'dsh-custom-editor-panel')
    assert.equal(reset.props.style.left, undefined, '复位后回到默认位')
    assert.equal(reset.props.style.right, '18px')
    assert.equal(store.has('dsh-button:editor-pos'), false, '复位清掉记忆')
  } finally {
    globalThis.fetch = prevFetch
    if (prevStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = prevStorage
  }
})

test('第一次拖动后：浮窗提示 + 复位按钮；未移动不提示；每次打开只提示一次', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  const prevStorage = globalThis.localStorage
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (key === 'dsh-button:layout' ? 'below' : (store.get(key) ?? null)),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '甲', text: 'a' }], hidden: ['continue'], presets: {} }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const drag = (from, to) => {
      const header = findByClass(mounted.tree, 'dsh-custom-editor-header')
      header.props.onPointerDown({
        button: 0,
        clientX: from[0],
        clientY: from[1],
        pointerId: 1,
        target: { tagName: 'STRONG' },
        currentTarget: {
          parentElement: { getBoundingClientRect: () => ({ left: 200, top: 300, width: 600, height: 400 }) },
          setPointerCapture() {},
        },
        preventDefault() {},
      })
      if (to !== null) header.props.onPointerMove({ clientX: to[0], clientY: to[1], pointerId: 1 })
      header.props.onPointerUp()
    }
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()
    assert.equal(findByClass(mounted.tree, 'dsh-editor-toast'), null, '还没拖动时没有浮窗')
    assert.equal(findByClass(mounted.tree, 'dsh-editor-reset'), null, '还没拖动时没有复位按钮')

    // 只按下不移动：不算拖动，不提示也不出按钮
    drag([10, 10], null)
    assert.equal(findByClass(mounted.tree, 'dsh-editor-toast'), null, '没有移动就不提示')

    // 真的拖一次：浮窗 + 复位按钮一起出现
    drag([10, 10], [60, 40])
    const toast = findByClass(mounted.tree, 'dsh-editor-toast')
    assert.ok(toast, '第一次拖动后浮出提示')
    assert.equal(toast.children[0], '位置已保存 · 双击标题栏或点 ⟲ 可复位')
    assert.equal(toast.props.role, 'status')
    assert.equal(toast.props.style.pointerEvents, 'none', '提示不挡点击')
    assert.equal(toast.props.style.position, 'absolute', '浮窗挂在面板内部上方')
    assert.equal(toast.props.style.top, '-34px', '浮在标题栏上方')
    assert.ok(findByClass(mounted.tree, 'dsh-editor-reset'), '第一次拖动后出现复位按钮')

    // 同一轮里再拖：不重复弹
    drag([20, 20], [70, 50])
    assert.equal(findAllByClass(mounted.tree, 'dsh-editor-toast').length, 1, '每次打开只提示一次')

    // 点复位：回默认位，提示与按钮一起收起
    findByClass(mounted.tree, 'dsh-editor-reset').props.onClick()
    const panel = findByClass(mounted.tree, 'dsh-custom-editor-panel')
    assert.equal(panel.props.style.left, undefined, '复位回默认位')
    assert.equal(panel.props.style.right, '18px')
    assert.equal(findByClass(mounted.tree, 'dsh-editor-reset'), null, '复位后按钮隐藏')
    assert.equal(findByClass(mounted.tree, 'dsh-editor-toast'), null, '复位后提示收起')

    // 关掉再打开：重置，再拖又重新出现
    findByClass(mounted.tree, 'dsh-custom-editor-backdrop').props.onClick()
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()
    assert.equal(findByClass(mounted.tree, 'dsh-editor-toast'), null, '重新打开后重置')
    drag([10, 10], [40, 30])
    assert.ok(findByClass(mounted.tree, 'dsh-editor-toast'), '重新打开后的第一次拖动再次提示')
    assert.ok(findByClass(mounted.tree, 'dsh-editor-reset'), '复位按钮也再次出现')
  } finally {
    globalThis.fetch = prevFetch
    if (prevStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = prevStorage
  }
})

test('控制行：左组保存后右组重挂，外观立即生效（不用重启）', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  const prevStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: (key) => (key === 'dsh-button:layout' ? 'bar' : null), setItem() {} }
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ ok: true, ...body }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, buttons: [{ label: '甲', text: 'a' }], hidden: ['continue'], presets: {} }),
    }
  }
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const regsOf = (id) => ctx.registrations.filter((item) => item.options.id === id)
    const oldSend = regsOf('dsh-button:send')[0]
    assert.ok(oldSend, '控制行应注册右组')
    // 编辑器从 ⋮（左组）打开，把「甲」的外观改成警示，保存
    const left = mountRegistration(ctx, 'dsh-button:insert')
    findByClass(left.tree, 'dsh-custom-manage').props.onClick()
    findByClass(left.tree, 'dsh-custom-style').props.onChange({ target: { value: 'danger' } })
    findByClass(left.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 右组必须被重挂：旧的注册被释放，换成新实例（不是叠加）
    const sendAfter = regsOf('dsh-button:send')
    assert.equal(sendAfter.length, 1, '重挂是替换，不是叠加')
    assert.ok(!ctx.registrations.includes(oldSend), '旧的右组注册应当被释放')
    assert.notEqual(sendAfter[0], oldSend, '右组换成了新实例')

    // 新右组拿到的是保存后的配置：按钮带警示色样式
    const right = mountComponent(sendAfter[0].component().children[0].type)
    const button = findByClass(right.tree, 'dsh-custom-action')
    assert.ok(button, '右组应当渲染「甲」')
    assert.match(String(button.props.className), /dsh-style-danger/, '保存的外观立即在右组生效')
  } finally {
    globalThis.fetch = prevFetch
    if (prevStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = prevStorage
  }
})
