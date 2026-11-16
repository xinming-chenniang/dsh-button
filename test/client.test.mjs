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
import { MAX_BUTTONS, MAX_MENU_ITEMS } from '../lib/buttons.js'

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
  // 组件里只用到「挂载时注册一次监听」这一种 effect：测试里立即执行，cleanup 先忽略即可。
  useEffect: (fn) => {
    if (typeof fn === 'function') fn()
  },
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
function makeCtx({ byId = { 'session-test': { retainedBy: { mainView: 1 } } }, entries = [], calls = [], draft = '', running = false, insert = null, sessionTitle = undefined, sessionModel = undefined, occurrences = null, quotes = null, quote = null } = {}) {
  const services = {
    sessions: {
      list: { getSnapshot: () => ({ ids: Object.keys(byId), byId }) },
      scope: (id) => ({ id }),
      binding: () => ({
        eventSource: { getSnapshot: () => ({ revision: 1, entries, hasMore: false }) },
        session: {
          getSnapshot: () => ({
            running,
            ...(sessionTitle === undefined ? {} : { title: sessionTitle }),
            ...(sessionModel === undefined ? {} : { model: sessionModel }),
          }),
          // 宿主的真实公开面：当前模型在 `modelSelection` 投影里（next 优先，lastUsed 兜底）
          projections: {
            faceOf: (key) => ({
              getSnapshot: () => (key === 'modelSelection' && sessionModel !== undefined
                ? { next: { provider: 'deepseek', model: typeof sessionModel === 'string' ? sessionModel : sessionModel?.name } }
                : {}),
            }),
          },
        },
      }),
    },
    conversation: {
      input: {
        for: (scope) => {
          calls.push(['for', scope.id])
          const api = {
            draftSnapshot: {
              text: draft,
              ...(occurrences === null ? {} : { references: occurrences }),
              ...(quotes === null ? {} : { quotes }),
            },
            setDraft: (text) => calls.push(['setDraft', text]),
            submit: () => calls.push(['submit']),
          }
          if (insert !== null) {
            api.snapshot = {
              draftRev: insert.draftRev,
              phase: insert.phase ?? 'plain',
              ...(occurrences === null ? {} : { occurrences }),
              ...(insert.claim === undefined ? {} : { claim: insert.claim }),
            }
            api.caretSpan = () => ({ start: insert.caret[0], end: insert.caret[1] })
            api.insertText = (text, span) => {
              calls.push(['insertText', text, span])
              return insert.applied ?? true
            }
            api.focus = () => calls.push(['focus'])
          }
          // 宿主 0.2.2 的引用卡入口（provide 通道的动作面）：只有显式给了 `quote` 才挂。
          if (quote !== null) {
            api.actions = {
              insertQuote: (text) => {
                calls.push(['insertQuote', text])
                return quote.applied ?? true
              },
            }
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

/** 等一个任务：拖动落点会推迟到下一个任务提交（避免在 dragend 之前重建被拖行的 DOM）。 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
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
  assert.deepEqual(blankCustomRow(), { label: '', text: '', mode: 'send', source: 'static', style: 'secondary', side: 'right' })
  assert.deepEqual(blankCustomRow('insert'), { label: '', text: '', mode: 'insert', source: 'static', style: 'ghost', side: 'left' })
  // 位置显式指定时以它为准（位置与动作解耦：左侧也可以是发送按钮）
  assert.deepEqual(blankCustomRow('send', 'left'), { label: '', text: '', mode: 'send', source: 'static', style: 'secondary', side: 'left' })
  // 空行直接跳过，不要求用户自己删干净
  assert.deepEqual(validateCustomRows([
    { label: ' 收尾 ', text: ' 收尾 ' },
    blankCustomRow(),
  ]), {
    ok: true,
    buttons: [{ label: '收尾', text: '收尾', mode: 'send', source: 'static', style: 'secondary', side: 'right' }],
  })
  // mode 原样带上（编辑器按位置分区，位置与动作解耦）
  assert.deepEqual(validateCustomRows([{ label: '模板', text: 'x', mode: 'insert' }]), {
    ok: true,
    buttons: [{ label: '模板', text: 'x', mode: 'insert', source: 'static', style: 'ghost', side: 'left' }],
  })
  // 外观原样带上；旧的 icon 字段已删除，行里带了也忽略
  assert.deepEqual(validateCustomRows([{ label: '主', text: 'x', style: 'primary' }]), {
    ok: true,
    buttons: [{ label: '主', text: 'x', mode: 'send', source: 'static', style: 'secondary', side: 'right' }],
  })
  assert.deepEqual(validateCustomRows([{ label: '主', text: 'x', icon: '🏁' }]), {
    ok: true,
    buttons: [{ label: '主', text: 'x', mode: 'send', source: 'static', style: 'secondary', side: 'right' }],
  })
  // 位置显式指定时原样带上，与 mode 解耦（左侧的发送按钮合法）
  assert.deepEqual(validateCustomRows([{ label: '左发', text: 'x', side: 'left' }]), {
    ok: true,
    buttons: [{ label: '左发', text: 'x', mode: 'send', source: 'static', style: 'secondary', side: 'left' }],
  })
  // 只填一半才报错；报错用「侧别 + 标签」，并提示可以改来源
  const labelOnly = validateCustomRows([{ label: '只有标签', text: '' }])
  assert.equal(labelOnly.ok, false)
  assert.match(labelOnly.message, /「只有标签」/)
  assert.match(labelOnly.message, /文字不能为空/)
  assert.match(labelOnly.message, /\{\}/)
  assert.equal(validateCustomRows([{ label: '', text: '只有文字' }]).ok, false)
  // 上限与长度
  const tooMany = Array.from({ length: MAX_CUSTOM + 1 }, (_, i) => ({ label: `b${i}`, text: 'x' }))
  assert.equal(validateCustomRows(tooMany).ok, false)
  assert.equal(validateCustomRows([{ label: 'a'.repeat(30), text: 'x' }]).ok, false)
  assert.equal(validateCustomRows([{ label: 'a', text: 'x'.repeat(600) }]).ok, false)
  // 不带 "=" 的标签也合法（旧的行格式要求已取消）
  assert.deepEqual(validateCustomRows([{ label: 'a=b', text: 'x' }]), { ok: true, buttons: [{ label: 'a=b', text: 'x', mode: 'send', source: 'static', style: 'secondary', side: 'right' }] })
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

    const drag = async (from, to) => {
      findAllByClass(mounted.tree, 'dsh-custom-drag-handle')[from].props.onDragStart({})
      findAllByClass(mounted.tree, 'dsh-custom-row')[to].props.onDrop({ preventDefault() {}, stopPropagation() {} })
      await tick()
    }
    /** 标签 → React key。key 必须跟着**行对象**走，不能跟着下标走。 */
    const keyByLabel = () => {
      const map = {}
      for (const node of findAllByClass(mounted.tree, 'dsh-custom-row')) {
        const label = findByClass(node, 'dsh-custom-label-input').props.value
        map[label] = node.props.key
      }
      return map
    }
    assert.equal(findAllByClass(mounted.tree, 'dsh-custom-up').length, 0, '↑ 按钮已移除（改成拖动）')
    assert.equal(findAllByClass(mounted.tree, 'dsh-custom-down').length, 0, '↓ 按钮已移除（改成拖动）')
    assert.equal(findAllByClass(mounted.tree, 'dsh-custom-side').length, 0, '⇄ 按钮已移除（改成拖动）')
    const keysBefore = keyByLabel()

    // 把乙拖到甲上 → 乙 甲 丙
    await drag(1, 0)
    assert.deepEqual(labelsOf(), ['乙', '甲', '丙'])

    // 把丙拖到乙上 → 丙 乙 甲
    await drag(2, 0)
    assert.deepEqual(labelsOf(), ['丙', '乙', '甲'])
    // 反例：key 用下标的话这里每一行都换 key → React 会在 dragend 之前重建 DOM，
    // 拖拽源节点消失，Chrome 的拖影就留在屏幕上（实测「残影」）、原位虚影也没人复位。
    assert.deepEqual(keyByLabel(), keysBefore, '行 key 跟行对象走：重排不能重建 DOM')

    // 拖到自己身上：顺序不变
    await drag(1, 1)
    assert.deepEqual(labelsOf(), ['丙', '乙', '甲'], '拖到自己身上不改变顺序')

    findByClass(mounted.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(posts.length, 1, '保存应当只发一次 POST')
    assert.deepEqual(posts[0].buttons.map((item) => item.label), ['丙', '乙', '甲'], '落盘顺序 = 编辑器行序')
    assert.deepEqual(
      findAllByClass(mounted.tree, 'dsh-custom-action').map((button) => button.children[0]),
      ['丙', '乙', '甲'],
      '保存后按钮条按新顺序渲染',
    )
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('动作条：成功路径不弹状态（填入看输入框、发送看界面）；失败才提示且不撑宽按钮', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [{ label: '讨论', text: '只讨论', mode: 'insert' }],
      hidden: ['continue'],
      presets: {},
    }),
  })
  const mountWith = async (insert) => {
    const ctx = makeCtx({ calls: [], draft: '', insert })
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { mounted: mountDock(ctx) }
  }
  try {
    // 成功填入：输入框里看得见，不该弹任何状态
    const okRun = await mountWith({ caret: [0, 0], draftRev: 0 })
    actionByLabel(okRun.mounted.tree, '讨论').props.onClick({})
    const afterOk = actionByLabel(okRun.mounted.tree, '讨论')
    assert.equal(afterOk.children.length, 1, '成功后按钮里只有一个文本子节点（没状态）')
    assert.equal(findByClass(afterOk, 'dsh-action-status'), null, '成功路径不弹状态标签')

    // 失败（宿主拒绝）：必须出声，且是绝对定位的小标签，不参与布局
    const failRun = await mountWith({ caret: [0, 0], draftRev: 1, applied: false })
    actionByLabel(failRun.mounted.tree, '讨论').props.onClick({})
    const afterFail = actionByLabel(failRun.mounted.tree, '讨论')
    const pill = findByClass(afterFail, 'dsh-action-status')
    assert.ok(pill, '失败要提示')
    assert.equal(pill.props.style.position, 'absolute', '绝对定位：按钮宽度不变，不触发换行')
    assert.equal(afterFail.props.style.position, 'relative', '按钮是标签的定位容器')
    assert.equal(afterFail.children[0], '讨论', '标签文本里不拼状态')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器：拖动落点用零回流插入线指示（插占位节点会让界面来回跳）', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [
        { label: '甲', text: 'a' },
        { label: '乙', text: 'b' },
        { label: '丙', text: 'c' },
      ],
      hidden: ['continue'],
      presets: {},
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()
    const labels = () => findAllByClass(mounted.tree, 'dsh-custom-label-input').map((input) => input.props.value)
    const rightSection = () => findByClass(mounted.tree, 'dsh-section-right')
    /** 带插入指示线（box-shadow）的节点。指示线用样式画，**不插节点**：插节点会推走下面的行，dragover 目标来回横跳。 */
    const lineOf = (node) => String(node?.props?.style?.boxShadow ?? '')
    const rowsWithLine = () => findAllByClass(mounted.tree, 'dsh-custom-row').filter((node) => lineOf(node) !== '')
    const addButtonLine = () => lineOf(findByClass(mounted.tree, 'dsh-custom-add-right'))
    const rowCount = () => findAllByClass(mounted.tree, 'dsh-custom-row').length
    const sectionChildCount = () => (rightSection().children ?? []).length
    const countsBefore = [rowCount(), sectionChildCount()]
    assert.deepEqual(rowsWithLine().length, 0, '没在拖的时候不该有插入线')

    findAllByClass(mounted.tree, 'dsh-custom-drag-handle')[0].props.onDragStart({})
    findAllByClass(mounted.tree, 'dsh-custom-row')[2].props.onDragOver({ preventDefault() {} })
    await tick()
    assert.equal(rowsWithLine().length, 1, '拖到第 3 行上：那一行出一条插入线')
    assert.equal(rowsWithLine()[0], findAllByClass(mounted.tree, 'dsh-custom-row')[2], '线画在目标行上沿')
    assert.match(lineOf(rowsWithLine()[0]), /box-shadow|inset/, '指示线是 box-shadow，不是占位节点')

    // 关键回归：反复 dragover 不能让面板结构变化（否则就是「界面一直来回跳」的成因）
    for (let round = 0; round < 5; round += 1) {
      findAllByClass(mounted.tree, 'dsh-custom-row')[1].props.onDragOver({ preventDefault() {} })
      findAllByClass(mounted.tree, 'dsh-custom-row')[2].props.onDragOver({ preventDefault() {} })
    }
    assert.deepEqual([rowCount(), sectionChildCount()], countsBefore, 'dragover 期间行数/分区子节点数必须不变（零回流）')

    // 拖到分区标题/空白/「＋ 新按钮」= 落在本区末尾：线画在本区**最后一行下沿**
    rightSection().props.onDragOver({ preventDefault() {} })
    assert.equal(rowsWithLine().length, 1, '落在区末尾时：只有最后一行出一条下沿线')
    assert.equal(rowsWithLine()[0], findAllByClass(mounted.tree, 'dsh-custom-row')[2], '线画在最后一行下沿')
    assert.match(lineOf(rowsWithLine()[0]), /-2px/, '下沿线的方向是朝下的')
    assert.equal(addButtonLine(), '', '有行的时候不额外画按钮框')

    // 空分区：线画不到行上，改在「＋ 新按钮」上用虚线外框标出来（outline 也不回流）
    const leftSection = () => findByClass(mounted.tree, 'dsh-section-left')
    leftSection().props.onDragOver({ preventDefault() {} })
    assert.equal(rowsWithLine().length, 0, '切到空分区后，右侧行上的线要撤掉')
    assert.match(
      String(findByClass(mounted.tree, 'dsh-custom-add-left').props.style?.outline ?? ''),
      /dashed/,
      '空分区的「＋ 新按钮」用虚线外框标出来',
    )

    // 松手：移到本区末尾
    rightSection().props.onDragOver({ preventDefault() {} })
    rightSection().props.onDrop({ preventDefault() {}, stopPropagation() {} })
    await tick()
    assert.equal(rowsWithLine().length, 0, '松手后插入线消失')
    assert.equal(addButtonLine(), '', '松手后「＋ 新按钮」也没有框')
    assert.deepEqual(labels(), ['乙', '丙', '甲'], '拖到区末尾 = 移到该区最后')

    // 收起（Esc / 点遮罩）不该留下插入线
    findAllByClass(mounted.tree, 'dsh-custom-drag-handle')[0].props.onDragStart({})
    rightSection().props.onDragOver({ preventDefault() {} })
    findAllByClass(mounted.tree, 'dsh-custom-drag-handle')[0].props.onDragEnd({ currentTarget: { parentElement: null } })
    assert.equal(rowsWithLine().length, 0, '拖动结束后插入线消失')
    assert.equal(addButtonLine(), '', '拖动结束后按钮上的框也消失')

    // 拖到自己那一行：位置不变，也不该画出「区末尾」的假线
    findAllByClass(mounted.tree, 'dsh-custom-drag-handle')[0].props.onDragStart({})
    findAllByClass(mounted.tree, 'dsh-custom-row')[0].props.onDragOver({ preventDefault() {}, stopPropagation() {} })
    assert.equal(rowsWithLine().length, 0, '拖到自己身上不画线')
    assert.equal(addButtonLine(), '', '拖到自己身上也不落到区末尾')
    findAllByClass(mounted.tree, 'dsh-custom-drag-handle')[0].props.onDragEnd({ currentTarget: { parentElement: null } })
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
    assert.match(String(button.props.style.borderColor), /CanvasText/, '填入类按钮用中性描边区分（不再用虚线）')
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
    assert.match(String(insertButton.props.style.borderColor), /CanvasText/, '填入=中性描边')
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
      { label: '甲', text: 'a', mode: 'send', source: 'static', style: 'secondary', side: 'right' },
      { label: '乙', text: 'b', mode: 'insert', source: 'static', style: 'ghost', side: 'left' },
    ], '每条按钮的位置与方式都要原样落盘')
    assert.deepEqual(posts[0].hidden, ['continue'])
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器：「＋ 新按钮」在每区行列表下方（标题行不再放按钮）', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  const base = {
    buttons: [{ label: '甲', text: 'a' }, { label: '乙', text: 'b', mode: 'insert' }],
    hidden: ['continue'],
    presets: {},
  }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ...base }) })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    for (const side of ['left', 'right']) {
      const section = findByClass(mounted.tree, `dsh-section-${side}`)
      const add = findByClass(section, `dsh-custom-add-${side}`)
      assert.ok(add, `${side} 区要有「＋ 新按钮」`)
      assert.equal(section.children[section.children.length - 1], add, '「＋ 新按钮」必须是分区最后一个节点（在行列表下方）')
      const header = section.children[0]
      assert.equal(findByClass(header, `dsh-custom-add-${side}`), null, '标题行里不能再有添加按钮')
      assert.equal(add.props.style.width, 'auto', '左对齐文字按钮，不占满整行（整宽虚线框是企业表单套路）')
      assert.equal(add.props.style.background, 'transparent', '透明底，hover 才出浅底')
      assert.equal(add.children[0], '＋ 新按钮')
    }
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器：⇄ 换侧才换区；改方式不换区；每区「＋ 新按钮」沿用本区位置', async () => {
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
    // 没有 ⇄ 了：把甲拖到左侧分区上 → 换到左侧并排在末尾
    findAllByClass(section('right'), 'dsh-custom-drag-handle')[0].props.onDragStart({})
    section('left').props.onDrop({ preventDefault() {}, stopPropagation() {} })
    await tick()
    assert.deepEqual(labels('left'), ['', '甲'], '拖到分区上 = 移到该区末尾并换侧')
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
    // 把丙拖到甲上（全局下标：乙 0、甲 1、丙 2）
    findAllByClass(mounted.tree, 'dsh-custom-drag-handle')[2].props.onDragStart({})
    findAllByClass(mounted.tree, 'dsh-custom-row')[1].props.onDrop({ preventDefault() {}, stopPropagation() {} })
    await tick()

    rightSection = findByClass(mounted.tree, 'dsh-section-right')
    assert.deepEqual(labelsOf(rightSection), ['丙', '甲'], '拖动排序：丙插到甲前面')
    assert.deepEqual(labelsOf(findByClass(mounted.tree, 'dsh-section-left')), ['乙'], '另一区顺序不变')
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
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-add-left')), '新按钮（左侧）')
    assert.equal(titleOf(findByClass(mounted.tree, 'dsh-custom-add-right')), '新按钮（右侧）')
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
    assert.equal(findByClass(dock.tree, 'dsh-layout-select'), null, '显示选项默认收起')
    findByClass(dock.tree, 'dsh-display-toggle').props.onClick()
    const select = findByClass(dock.tree, 'dsh-layout-select')
    assert.ok(select, '编辑器里应当有位置下拉')
    assert.equal(select.props.value, 'below')
    select.props.onChange({ target: { value: 'bar' } })
    assert.equal(ctx.registrations.length, 2)
    assert.deepEqual(ctx.registrations.map((item) => item.options.id).sort(), [`${PKG.name}:insert`, `${PKG.name}:send`])

    const left = mountRegistration(ctx, `${PKG.name}:insert`)
    findByClass(left.tree, 'dsh-custom-manage').props.onClick()
    findByClass(left.tree, 'dsh-display-toggle').props.onClick()
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
    // 把继续拖到乙上 → 甲 继续 乙
    findAllByClass(mounted.tree, 'dsh-custom-drag-handle')[0].props.onDragStart({})
    findAllByClass(mounted.tree, 'dsh-custom-row')[2].props.onDrop({ preventDefault() {}, stopPropagation() {} })
    await tick()
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
        { label: '右填', text: 'b', mode: 'insert', source: 'static', side: 'right' },
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

test('菜单按钮（档 6）：点开上拉选项，选一条才执行；旧选项带「·旧」提示', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls })
  const prevFetch = globalThis.fetch
  const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [{
        label: '选项',
        text: '',
        mode: 'send',
        kind: 'menu',
        at: staleAt,
        side: 'left',
        items: [{ label: '落盘', text: '写进去' }, { label: '只看差异', text: '只看差异', mode: 'insert' }],
      }],
      hidden: ['continue'],
      presets: {},
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const menu = findByClass(mounted.tree, 'dsh-custom-menu')
    assert.ok(menu, '菜单按钮带 dsh-custom-menu 类')
    assert.equal(menu.props['aria-haspopup'], 'menu')
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [], '只点开、不执行')
    menu.props.onClick()
    assert.ok(findByClass(mounted.tree, 'dsh-menu-panel'), '点开后出现选项面板')
    const items = findAllByClass(mounted.tree, 'dsh-menu-item')
    assert.equal(items.length, 2, '面板列出全部选项')
    assert.match(String(findByClass(mounted.tree, 'dsh-menu-meta').children.join('')), /写于 24 小时前/, '超过 24h 标「·旧」')
    items[0].props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [['setDraft', '写进去'], ['submit']], '选中的那条按 send 执行')
    assert.equal(findByClass(mounted.tree, 'dsh-menu-panel'), null, '执行后关闭面板')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('菜单按钮（档 6）：面板贴着被点的按钮往上弹（上拉菜单定位）', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx({ calls: [] })
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [{ label: '选项', text: '', mode: 'send', kind: 'menu', side: 'right', items: [{ label: 'A', text: 'a' }] }],
      hidden: ['continue'],
      presets: {},
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const menu = findByClass(mounted.tree, 'dsh-custom-menu')
    menu.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 500, top: 600, width: 80, height: 28 }) } })
    const panel = findByClass(mounted.tree, 'dsh-menu-panel')
    assert.ok(panel, '点开后出现菜单')
    // 视口读不到时按 1024×768 算：底边贴按钮上边 6px，左边 = 按钮左边，宽高由 min/max 三重钉死
    assert.equal(panel.props.style.bottom, '174px', '整叠底边在按钮上方 6px')
    // 外框透明（不要浮层面板），左右边与触发按钮严格重合
    assert.equal(panel.props.style.left, '500px', '左边缘对齐按钮左边缘')
    assert.equal(panel.props.style.width, '80px', '整叠与触发按钮等宽')
    assert.equal(panel.props.style.minWidth, '80px', 'min-width 钉死：内容再长也撑不宽')
    assert.equal(panel.props.style.maxWidth, '80px', 'max-width 钉死')
    assert.equal(panel.props.style.background, 'transparent', '外框透明：不做浮层底')
    assert.equal(panel.props.style.backdropFilter, undefined, '没有背景模糊')
    // 选项就是动作条同款按钮，不是列表行
    const items = findAllByClass(mounted.tree, 'dsh-menu-item')
    assert.equal(items.length, 1)
    assert.match(items[0].props.className, /dsh-custom-action/, '选项复用动作条按钮的类名')
    assert.match(items[0].props.className, /dsh-style-secondary/, '外观跟着触发按钮（secondary）')
    assert.match(String(items[0].props.style.outline), /1px solid/, '展开项加内描边，与触发按钮区分')
    assert.match(String(items[0].props.style.background), /Canvas/, '按钮自己是不透明底色（混 Canvas），背后文字透不出来')
    assert.doesNotMatch(String(items[0].props.style.background), /transparent/, '底色不混 transparent')
    assert.equal(items[0].props.style.marginRight, 0, '竖排里去掉动作条按钮自带的右边距')
    assert.equal(items[0].props.style.boxSizing, 'border-box', 'border-box：padding/边框不吃进宽度之外')
    // 点背景关闭
    findByClass(mounted.tree, 'dsh-menu-backdrop').props.onClick()
    assert.equal(findByClass(mounted.tree, 'dsh-menu-panel'), null, '点背景关闭菜单')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('窗口重新聚焦时重拉配置：agent 中途改的按钮/菜单会自己出现在按钮行上', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx({ calls: [] })
  const prevFetch = globalThis.fetch
  const menuPayload = (labels) => ({
    ok: true,
    buttons: [{
      label: '选项', text: '', mode: 'send', kind: 'menu', side: 'right',
      items: labels.map((label) => ({ label, text: label.toLowerCase() })),
    }],
    hidden: ['continue'],
    presets: {},
  })
  let payload = menuPayload(['A'])
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload })
  // 只给这一个用例装监听器表：改的是 loadPlugin 建好的那个 window 对象，不动 ModuleLoader。
  const focusHandlers = []
  globalThis.window.addEventListener = (type, fn) => { if (type === 'focus') focusHandlers.push(fn) }
  globalThis.window.removeEventListener = () => {}
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    assert.match(String(findByClass(mounted.tree, 'dsh-custom-menu').props.title), /1 个选项/, '挂载时是 1 项')
    // 模拟 agent 中途 set_options：配置变成 2 项，然后用户切回窗口
    payload = menuPayload(['A', 'B'])
    assert.ok(focusHandlers.length > 0, '挂载时注册了 focus 监听')
    focusHandlers.forEach((fn) => fn())
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.match(String(findByClass(mounted.tree, 'dsh-custom-menu').props.title), /2 个选项/, '回到前台后按钮行自己更新')
  } finally {
    globalThis.fetch = prevFetch
    delete globalThis.window.addEventListener
    delete globalThis.window.removeEventListener
  }
})

test('菜单按钮：贴近屏幕顶端时改成向下展开（否则会把叠压得很矮）', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx({ calls: [] })
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [{ label: '选项', text: '', mode: 'send', kind: 'menu', side: 'right', items: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }] }],
      hidden: ['continue'],
      presets: {},
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    // 按钮在顶部：上方只有 30px，放不下两三项 → 翻到下方
    findByClass(mounted.tree, 'dsh-custom-menu').props.onClick({
      currentTarget: { getBoundingClientRect: () => ({ left: 500, top: 30, width: 80, height: 28 }) },
    })
    const panel = findByClass(mounted.tree, 'dsh-menu-panel')
    assert.equal(panel.props.style.top, '64px', '翻到按钮下方 6px（30 + 28 + 6）')
    assert.equal(panel.props.style.bottom, undefined, '不再用 bottom 定位')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('菜单按钮：编辑器往返不丢 items / at，且与宿主上限一致', async () => {
  const plugin = await loadPlugin()
  const { editorRowOf, storedRowOf, validateCustomRows, MAX_MENU_ITEMS: clientMax } = plugin.__internals
  assert.equal(clientMax, MAX_MENU_ITEMS, '客户端上限必须与宿主 MAX_MENU_ITEMS 一致')
  const menu = {
    label: '选项',
    text: '',
    mode: 'send',
    kind: 'menu',
    items: [{ label: 'A', text: 'a', mode: 'send' }],
    at: '2026-11-15T18:16:00+08:00',
    source: 'static',
    side: 'left',
  }
  const row = editorRowOf(menu, 'zh')
  assert.deepEqual(row.items, menu.items, '菜单选项进编辑器行')
  assert.equal(row.at, menu.at)
  const back = storedRowOf(row)
  assert.deepEqual(back.items, menu.items, '保存时折回存盘格式，选项不丢')
  assert.equal(back.at, menu.at)
  const checked = validateCustomRows([back])
  assert.equal(checked.ok, true, '菜单行允许没有主文字')
  assert.equal(checked.buttons[0].kind, 'menu')
  assert.deepEqual(checked.buttons[0].items, menu.items)
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
    findByClass(mounted.tree, 'dsh-display-toggle').props.onClick()
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
    findByClass(mounted.tree, 'dsh-display-toggle').props.onClick()
    const select = findByClass(mounted.tree, 'dsh-size-select')
    assert.ok(select, '设置里应当有按钮大小')
    assert.equal(select.props.value, 'compact')
    assert.equal(attrs['data-dsh-button-size'], 'compact', '默认紧凑档：apply 时就设 data 属性')
    select.props.onChange({ target: { value: 'standard' } })
    assert.equal(globalThis.localStorage.getItem('dsh-button:size'), 'standard')
    assert.equal(attrs['data-dsh-button-size'], undefined, '标准档走 CSS 回退值，不设 data 属性')
    assert.ok(styles.some((style) => /--dsh-btn-h:24px/.test(style.textContent)), '应当注入紧凑 CSS 变量')
    assert.equal(findByClass(mounted.tree, 'dsh-custom-action').props.style.height, 'var(--dsh-btn-h, 28px)')
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
    // 外观固定（2026-11-10）：配置里写的 style 不再生效，一律按方式派生。
    const primary = actionByLabel(tree, '主')
    assert.match(String(primary.props.className), /dsh-style-secondary/, '旧 style: primary 被忽略')
    assert.match(String(actionByLabel(tree, '危').props.className), /dsh-style-secondary/, '旧 style: danger 被忽略')
    assert.match(String(actionByLabel(tree, '线').props.className), /dsh-style-secondary/, '发送类 = 浅底，哪怕写了 ghost')
    const plain = actionByLabel(tree, '默认')
    assert.equal(plain.props.style.borderStyle, 'solid', '不写外观时发送类 = 实线')
    assert.match(String(plain.props.style.background), /color-mix/)
    assert.match(String(plain.props.style.borderColor), /color-mix/, '浅底边框跟底色同源（主色淡边），不用全局深边')
    const legacyIcon = actionByLabel(tree, '带图')
    assert.ok(legacyIcon, '旧配置里带 icon 的按钮仍应渲染（icon 已被忽略）')
    assert.equal(legacyIcon.children[0], '带图', '旧 icon 字段不再拼到标签前')
    assert.equal(legacyIcon.props.style.borderStyle, 'solid', 'insert 缺省 = 中性描边')
    assert.equal(legacyIcon.props.style.background, 'transparent', '填入 = 透明底描边')
    assert.match(String(legacyIcon.props.className), /dsh-style-ghost/, 'class 上带样式 token')
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

test('编辑器：外观固定（没有外观下拉）；图标字段与预览框都已移除', async () => {
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
    assert.equal(findByClass(mounted.tree, 'dsh-custom-style'), null, '外观下拉已移除')
    // A 风格定稿后预览框整体删除：DOM 里不该再有任何预览节点
    assert.equal(findByClass(mounted.tree, 'dsh-editor-preview'), null, '预览框已移除')
    assert.equal(findAllWithClassToken(mounted.tree, 'dsh-preview-action').length, 0, '不再渲染预览按钮')
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
    // 编辑器从 ⋮（左组）打开，把「甲」改成填入（外观随方式变成描边），保存
    const left = mountRegistration(ctx, 'dsh-button:insert')
    findByClass(left.tree, 'dsh-custom-manage').props.onClick()
    findByClass(left.tree, 'dsh-mode-insert').props.onClick()
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
    assert.match(String(button.props.className), /dsh-style-ghost/, '保存的方式（及派生外观）立即在右组生效')
  } finally {
    globalThis.fetch = prevFetch
    if (prevStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = prevStorage
  }
})

// ── 档 2：来源选择器（last-user / draft / selection + {{value}} 模板） ──────────────

test('档 2：resolveActionText 读静态 / 上一条 / 草稿 / 选区，并套模板', async () => {
  const plugin = await loadPlugin()
  const { resolveActionText, lastUserMessage, selectionText } = plugin.__internals

  // 静态来源：配置里的文字（执行时才解码换行）
  assert.deepEqual(resolveActionText(makeCtx(), { text: '第一行\\n第二行' }), { ok: true, text: '第一行\n第二行' })

  // 上一条：只认 user/message + source.kind === 'user'（注入/引用/压缩检查点不算）
  const entries = [
    userMessage(1, '更早的一条'),
    userMessage(2, '被注入的', 'inject'),
    { event: { type: 'user/message', seq: 3, data: { content: '最后一条', source: { kind: 'user' } } } },
  ]
  const lastCtx = makeCtx({ entries })
  assert.equal(lastUserMessage(lastCtx), '最后一条')
  assert.deepEqual(resolveActionText(lastCtx, { source: 'last-user' }), { ok: true, text: '最后一条' })
  assert.deepEqual(resolveActionText(lastCtx, { source: 'last-user', text: '重发：{{value}}' }), { ok: true, text: '重发：最后一条' })
  // 模板里没有占位符 = 固定文字（用户写的字原样保留）
  assert.deepEqual(resolveActionText(lastCtx, { source: 'last-user', text: '请继续' }), { ok: true, text: '请继续' })

  // content 是数组时只收 text 块（reasoning / tool-call 不是输入框里的内容）
  const arrayCtx = makeCtx({
    entries: [{
      event: {
        type: 'user/message',
        seq: 4,
        data: { source: { kind: 'user' }, message: { content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '正文' }] } },
      },
    }],
  })
  assert.equal(lastUserMessage(arrayCtx), '正文')

  // 草稿来源：读当前草稿
  assert.deepEqual(resolveActionText(makeCtx({ draft: '半句草稿' }), { source: 'draft' }), { ok: true, text: '半句草稿' })

  // 选区来源：caretSpan 里的文字
  const selCtx = makeCtx({ draft: '选中这段文字', insert: { caret: [0, 4], draftRev: 1 } })
  const input = selCtx.get('conversation').input.for({ id: 's' })
  assert.equal(selectionText(input), '选中这段')
  assert.deepEqual(resolveActionText(selCtx, { source: 'selection', text: '解释：{{value}}' }), { ok: true, text: '解释：选中这段' })

  // 读不到内容 → no-source；没有会话 → no-session
  assert.deepEqual(resolveActionText(makeCtx({ draft: '' }), { source: 'draft' }), { ok: false, why: 'no-source' })
  assert.deepEqual(resolveActionText(makeCtx({ byId: {} }), { source: 'last-user' }), { ok: false, why: 'no-session' })
})

test('档 2：上一条来源 + 发送 = 重发上一条', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch

  const calls = []
  const ctx = makeCtx({ calls, entries: [userMessage(1, '上一条内容')] })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '重发', text: '', source: 'last-user', mode: 'send' }] }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    actionByLabel(mounted.tree, '重发').props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
      ['setDraft', '上一条内容'],
      ['submit'],
    ])
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('档 2：草稿来源 + 发送 = 直接提交草稿（不经过 setDraft）', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  const calls = []
  const ctx = makeCtx({ calls, draft: '已经写好的草稿' })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '发草稿', text: '', source: 'draft', mode: 'send' }] }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    actionByLabel(mounted.tree, '发草稿').props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [['submit']], '草稿来源直接提交，不经过 setDraft')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('档 2：选区来源 + 填入 = 用模板替换选区', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  const calls = []
  const ctx = makeCtx({ calls, draft: '请解释这段：甲', insert: { caret: [0, 5], draftRev: 7 } })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '解释', text: '讨论：{{value}}', source: 'selection', mode: 'insert' }] }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    actionByLabel(mounted.tree, '解释').props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
      ['insertText', '讨论：请解释这段', { start: 0, end: 5, draftRev: 7 }],
      ['focus'],
    ])
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('档 2：来源取不到内容时提示「没有可用的内容」，并且不调用宿主', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  const calls = []
  const ctx = makeCtx({ calls, entries: [] })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '重发', text: '', source: 'last-user', mode: 'send' }] }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    actionByLabel(mounted.tree, '重发').props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [], '没有内容时不能往宿主里塞空消息')
    const pill = findByClass(mounted.tree, 'dsh-action-status')
    assert.ok(pill, '应当出现状态提示')
    assert.equal(pill.children[0], '没有可用的内容')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('变量化来源：编辑器没有来源下拉，来源显示成文字里的 {{变量}}；保存时折回 source + {{value}}', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const posts = []
  const base = {
    buttons: [
      { label: '重发', text: '', source: 'last-user', mode: 'send' },
      { label: '解释', text: '解释：{{value}}', source: 'selection', mode: 'insert' },
    ],
    hidden: ['continue'],
    presets: {},
  }
  const prevFetch = globalThis.fetch
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

    assert.equal(findByClass(mounted.tree, 'dsh-custom-source'), null, '来源下拉已经去掉')
    assert.equal(findByClass(mounted.tree, 'dsh-quote-toggle'), null, '没有独立的引用开关')
    assert.equal(findByClass(mounted.tree, 'dsh-quote-source'), null, '没有「引用什么」下拉')
    const texts = findAllByClass(mounted.tree, 'dsh-custom-text-input').map((input) => input.props.value)
    assert.deepEqual(texts.sort(), ['{{上一条}}', '解释：{{选中}}'].sort(), '来源摊成文字里的变量')

    findByClass(mounted.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const saved = posts[0].buttons.map(({ label, text, source }) => ({ label, text, source }))
    assert.deepEqual(saved, [
      { label: '重发', text: '', source: 'last-user' },
      { label: '解释', text: '解释：{{value}}', source: 'selection' },
    ], '存盘格式与旧配置逐字一致')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('档 2：动作按钮的 mousedown 不夺输入框焦点（保住选区）', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '选中', text: '', source: 'selection', mode: 'insert' }] }),
  })
  try {
    const ctx = makeCtx({ draft: '选中文字', insert: { caret: [0, 4], draftRev: 1 } })
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const button = actionByLabel(mounted.tree, '选中')
    assert.ok(button, '应当渲染选中按钮')
    assert.equal(typeof button.props.onMouseDown, 'function', '按钮要挂 mousedown 处理器')
    let prevented = false
    button.props.onMouseDown({ preventDefault: () => { prevented = true } })
    assert.equal(prevented, true, 'mousedown 必须 preventDefault，否则输入框失焦、选区折叠')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('档 2：选区来源没有选区时提示「没有可用的内容」，不调用宿主', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  const calls = []
  // 光标折叠（start === end）：没有选区
  const ctx = makeCtx({ calls, draft: '文字', insert: { caret: [2, 2], draftRev: 1 } })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '选中', text: '', source: 'selection', mode: 'insert' }] }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    actionByLabel(mounted.tree, '选中').props.onClick()
    // 选区折叠时会把焦点还给输入框再读一次（可能多一次 focus），但**不能**往宿主里写任何东西
    const writes = calls.filter((call) => ['setDraft', 'submit', 'insertText'].includes(call[0]))
    assert.deepEqual(writes, [], '没有选区时不能往宿主里塞字')
    const pill = findByClass(mounted.tree, 'dsh-action-status')
    assert.ok(pill, '应当出现状态提示')
    assert.equal(pill.children[0], '没有可用的内容')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('变量化来源：editorRowOf / storedRowOf 往返；主变量优先选中 > 草稿；旧 quote 折算成引用变量', async () => {
  const plugin = await loadPlugin()
  const { editorRowOf, storedRowOf, placeholderNamesOf } = plugin.__internals
  const pick = ({ text, source, mode }) => ({ text, source, mode })
  // 往返：旧配置 → 编辑器 → 存盘，逐字不变
  for (const b of [
    { label: 'a', text: '', source: 'last-user', mode: 'send' },
    { label: 'b', text: '解释：{{value}}', source: 'selection', mode: 'insert' },
    { label: 'c', text: '固定', mode: 'send' },
    { label: 'd', text: '', source: 'time', mode: 'insert' },
  ]) {
    const back = storedRowOf(editorRowOf(b))
    assert.deepEqual(pick(back), pick({ source: 'static', ...b }), `往返：${b.label}`)
  }
  // 旧 mode=quote / quote:true → 折算成文字里的引用变量（不再有 quote 字段）
  assert.deepEqual(pick(storedRowOf(editorRowOf({ label: 'f', text: '', source: 'selection', mode: 'quote' }))),
    { text: '{{引用选中}}', source: 'static', mode: 'insert' })
  assert.deepEqual(pick(storedRowOf(editorRowOf({ label: 'g', text: '解释这段', source: 'last-assistant', quote: true, mode: 'send' }))),
    { text: '{{引用AI回答}}\\n\\n解释这段', source: 'static', mode: 'send' })
  // 旧「引用草稿」没有对应变量（自己抄自己），兜底成引用选中
  assert.equal(storedRowOf(editorRowOf({ label: 'h', text: '', source: 'draft', quote: true })).text, '{{引用选中}}')
  // 两个内置变量：选中当主变量，时间留在文字里（运行时自动读）；引用变量不折 source
  assert.deepEqual(pick(storedRowOf({ text: '{{时间}} 解释 {{选中}}', mode: 'insert' })),
    { text: '{{时间}} 解释 {{value}}', source: 'selection', mode: 'insert' })
  assert.deepEqual(pick(storedRowOf({ text: '{{引用选中}} 解释 {{选中}}', mode: 'insert' })),
    { text: '{{引用选中}} 解释 {{value}}', source: 'selection', mode: 'insert' })
  // 英文别名也认
  assert.deepEqual(pick(storedRowOf({ text: 'Explain {{selection}}', mode: 'insert' })),
    { text: 'Explain {{value}}', source: 'selection', mode: 'insert' })
  // 内置变量 / 引用变量都不算「要问你填」的
  assert.deepEqual(placeholderNamesOf('{{选中}} {{时间}} {{引用选中}} {{文件}}'), ['文件'])
})

test('编辑器：引用不是开关/下拉，而是 `{}` 菜单里的「引用块」变量；插到文字开头', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const posts = []
  const prevFetch = globalThis.fetch
  const base = {
    buttons: [{ label: '解释', text: '解释：{{value}}', source: 'last-assistant', mode: 'insert' }],
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

    assert.equal(findByClass(mounted.tree, 'dsh-quote-toggle'), null, '没有独立开关')
    assert.equal(findByClass(mounted.tree, 'dsh-quote-source'), null, '没有「引用什么」下拉')
    assert.deepEqual([...new Set(findAllWithClassToken(mounted.tree, 'dsh-mode-option').map((o) => o.children.join('')))], ['发', '填'], '方式只有发 / 填')

    findByClass(mounted.tree, 'dsh-add-var').props.onClick()
    const chips = findAllWithClassToken(mounted.tree, 'dsh-var-chip')
    assert.deepEqual(chips.map((chip) => chip.props['data-var']),
      ['selection', 'last-user', 'last-assistant', 'draft', 'session-title', 'model', 'time',
        'quote:selection', 'quote:last-user', 'quote:last-assistant', 'custom'], '自动读取七个 + 引用块三个 + 问我一个')
    chips.find((chip) => chip.props['data-var'] === 'quote:last-assistant').props.onClick()
    assert.equal(findByClass(mounted.tree, 'dsh-custom-text-input').props.value,
      '{{引用AI回答}}\\n\\n解释：{{AI回答}}', '引用变量放开头，空行接提示')

    findByClass(mounted.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(posts[0].buttons.map(({ label, text, source }) => ({ label, text, source })), [
      { label: '解释', text: '{{引用AI回答}}\\n\\n解释：{{value}}', source: 'last-assistant' },
    ], '引用变量留在文字里，只有主变量折回 source')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('引用变量 + 发送：整段（引用块 + 提示）一次提交，不走宿主 insertQuote；有草稿不发送', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '引用发', text: '{{引用AI回答}}\\n\\n解释这段', mode: 'send' }] }),
  })
  const assistant = { event: { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: '回答正文' }] } } } }
  try {
    const calls = []
    const ctx = makeCtx({ calls, entries: [assistant], quote: {}, insert: { caret: [0, 0], draftRev: 1 } })
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    actionByLabel(mountDock(ctx).tree, '引用发').props.onClick()
    const seen = calls.filter((call) => call[0] !== 'for')
    assert.deepEqual(seen.map((call) => call[0]).filter((name) => name === 'insertQuote'), [], '不走宿主 insertQuote')
    assert.deepEqual(seen[0], ['setDraft', '> 回答正文\n\n解释这段'], '引用块 + 提示作为一条消息文字')
    assert.equal(seen[seen.length - 1][0], 'submit', '最后提交')

    const calls2 = []
    const busy = makeCtx({ calls: calls2, entries: [assistant], quote: {}, draft: '我写了一半' })
    plugin.apply(busy)
    await new Promise((resolve) => setTimeout(resolve, 0))
    actionByLabel(mountDock(busy).tree, '引用发').props.onClick()
    assert.deepEqual(calls2.filter((call) => call[0] !== 'for'), [], '有草稿：不发送')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('引用变量：读不到内容时整次不执行，状态「没有可用的内容」（不发一条空 ">"）', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '引用', text: '{{引用选中}}', mode: 'send' }] }),
  })
  try {
    const calls = []
    const ctx = makeCtx({ calls, draft: '' })
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    actionByLabel(mounted.tree, '引用').props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [], '没有可引用的内容就什么都不做')
    assert.equal(findByClass(mounted.tree, 'dsh-action-status').children[0], '没有可用的内容')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('变量化来源：第二个内置变量在点击时自动读取，不弹填参面板', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  const calls = []
  const ctx = makeCtx({ calls, sessionModel: 'deepseek-chat' })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '报模型', text: '当前是 {{模型}}', mode: 'send' }] }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    actionByLabel(mounted.tree, '报模型').props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] === 'setDraft'), [['setDraft', '当前是 deepseek-chat']])
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('变量化来源：{{草稿}} 包住草稿——填入整段替换、发送包好再提交', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  const calls = []
  const ctx = makeCtx({ calls, draft: 'hello' })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [
      { label: '包', text: '翻译：{{value}}', source: 'draft', mode: 'insert' },
      { label: '包发', text: '翻译：{{value}}', source: 'draft', mode: 'send' },
    ] }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    actionByLabel(mounted.tree, '包').props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [['setDraft', '翻译：hello']], '填入 = 整段替换，不提交')
    calls.length = 0
    actionByLabel(mounted.tree, '包发').props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [['setDraft', '翻译：hello'], ['submit']], '发送 = 包好再提交')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('档 2：页面选区（选中历史对话）+ 填入 = 取文本插入光标处', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  const prevGetSel = globalThis.getSelection
  const calls = []
  const ctx = makeCtx({ calls, draft: '草稿', insert: { caret: [0, 0], draftRev: 3 } })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '引用', text: '针对这段：{{value}}', source: 'selection', mode: 'insert' }] }),
  })
  globalThis.getSelection = () => ({ toString: () => '历史对话里的一段' })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const button = actionByLabel(mounted.tree, '引用')
    // 点击本身可能把页面选区清掉：mousedown 先存一份
    button.props.onMouseDown({ preventDefault() {} })
    globalThis.getSelection = () => ({ toString: () => '' })
    button.props.onClick()
    const inserts = calls.filter((call) => call[0] === 'insertText')
    assert.deepEqual(inserts, [['insertText', '针对这段：历史对话里的一段', { start: 0, end: 0, draftRev: 3 }]])
  } finally {
    globalThis.fetch = prevFetch
    if (prevGetSel === undefined) delete globalThis.getSelection
    else globalThis.getSelection = prevGetSel
  }
})

test('档 2：页面选区 + 发送 = 把选中的历史文字作为消息发出', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  const prevGetSel = globalThis.getSelection
  const calls = []
  const ctx = makeCtx({ calls, draft: '' })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '发这段', text: '', source: 'selection', mode: 'send' }] }),
  })
  globalThis.getSelection = () => ({ toString: () => '这段历史文字' })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const button = actionByLabel(mounted.tree, '发这段')
    button.props.onMouseDown({ preventDefault() {} })
    globalThis.getSelection = () => ({ toString: () => '' })
    button.props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
      ['setDraft', '这段历史文字'],
      ['submit'],
    ])
  } finally {
    globalThis.fetch = prevFetch
    if (prevGetSel === undefined) delete globalThis.getSelection
    else globalThis.getSelection = prevGetSel
  }
})

// ── 草稿两套坐标：detect（结构节点折 1 格）↔ clipboard（结构节点展开）────────────────
//
// 宿主 `caretSpan()` 给 detect 坐标，`draftSnapshot.text` 是 clipboard 投影。草稿里有
// `@文件` chip / `/命令` chip / 引用卡时两套偏移不等价；1.3.3 直接混用，读数会切成 chip 尾巴、
// 多行填入会插错位置（2026-11-09 离线复现）。这组用例钉住折算与「chip 不被摊平」。

/** 一枚 `@文件` chip：clipboard 里 10 个字符（`@docs/a.md`），detect 里只占 1 个。 */
const FILE_CHIP = { source: 'reference', ref: '@docs/a.md', label: 'a.md', clipboardText: '@docs/a.md', offset: 0, length: 10, appearance: 'file' }

test('坐标：含 chip 的草稿，选区读取按 clipboard 折算', async () => {
  const plugin = await loadPlugin()
  const { selectionText } = plugin.__internals
  // clipboard = "@docs/a.md hello"；detect = "￼ hello"（chip 折 1 格）
  const input = {
    draftSnapshot: { text: '@docs/a.md hello', references: [FILE_CHIP] },
    snapshot: { draftRev: 1, phase: 'plain', occurrences: [FILE_CHIP] },
    caretSpan: () => ({ start: 2, end: 7 }),
  }
  assert.equal(selectionText(input), 'hello', 'detect 2..7 先折成 clipboard 12..17，才是 hello')
})

test('坐标：选区来源套模板时用的是折算后的文字', async () => {
  const plugin = await loadPlugin()
  const { resolveActionText } = plugin.__internals
  const ctx = makeCtx({ draft: '@docs/a.md hello', occurrences: [FILE_CHIP], insert: { caret: [2, 7], draftRev: 1 } })
  assert.deepEqual(resolveActionText(ctx, { source: 'selection', text: '解释：{{value}}' }), { ok: true, text: '解释：hello' })
})

test('坐标：多行填入写结构化草稿，chip 不被摊平', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, draft: '@docs/a.md hello', occurrences: [FILE_CHIP], insert: { caret: [2, 7], draftRev: 7 } })
  const result = plugin.__internals.insertAtCaret(ctx, '解释：\n第二行')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
    ['setDraft', { text: '@docs/a.md 解释：\n第二行', references: [FILE_CHIP] }],
    ['focus'],
  ], '插入后 chip 的 offset/length 原样保留（纯字符串 setDraft 会把它摊平）')
})

test('坐标：引用卡（quotes）在多行填入后仍在，位置按插入长度平移', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const quote = { offset: 5, length: 3, text: '引用' }
  // clipboard = "hello" + 引用卡(clipboard 3 字) + "!"；detect = "hello￼!"，caret 5 = 引用卡之前
  const ctx = makeCtx({ calls, draft: 'helloQRS!', quotes: [quote], insert: { caret: [5, 5], draftRev: 4 } })
  const result = plugin.__internals.insertAtCaret(ctx, 'X\nY')
  assert.deepEqual(result, { ok: true, fallback: true }, '插在草稿中间：宿主 setDraft 会把光标放到末尾（状态文案据此说「已填入末尾」）')
  assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
    ['setDraft', { text: 'helloX\nYQRS!', references: [], quotes: [{ offset: 8, length: 3, text: '引用' }] }],
    ['focus'],
  ])
})

test('坐标：已认领的 /命令 chip 折 1 格，命令 chip 在填入后保留', async () => {
  const plugin = await loadPlugin()
  const { selectionText } = plugin.__internals
  const token = '/goal '
  const input = {
    draftSnapshot: { text: '/goal 把这事做完', references: [] },
    snapshot: { draftRev: 3, phase: 'claimed', claim: { token }, occurrences: [] },
    // detect = "￼ 把这事做完"：命令 chip 1 格 + 尾部分隔空格 + 5 个字
    caretSpan: () => ({ start: 2, end: 7 }),
  }
  assert.equal(selectionText(input), '把这事做完')

  const calls = []
  const ctx = makeCtx({
    calls,
    draft: '/goal 把这事做完',
    occurrences: [],
    insert: { caret: [7, 7], draftRev: 3, phase: 'claimed', claim: { token } },
  })
  plugin.__internals.insertAtCaret(ctx, 'X\nY')
  assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
    ['setDraft', { text: '/goal 把这事做完X\nY', references: [], command: { token } }],
    ['focus'],
  ], '命令 chip 由宿主按 token 还原，不要退化成字面文字')
})

test('坐标：没有结构节点（纯文本草稿 / 老宿主）仍写纯字符串，行为与 1.3.3 一致', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, draft: 'hello', insert: { caret: [5, 5], draftRev: 2 } })
  plugin.__internals.insertAtCaret(ctx, 'A\nB')
  assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
    ['setDraft', 'helloA\nB'],
    ['focus'],
  ])

  // 新宿主：字段在、但数组是空的 —— 同样走纯字符串（等价路径，不依赖结构化 setDraft）
  const calls2 = []
  const ctx2 = makeCtx({ calls: calls2, draft: 'hello', occurrences: [], quotes: [], insert: { caret: [5, 5], draftRev: 2 } })
  plugin.__internals.insertAtCaret(ctx2, 'A\nB')
  assert.deepEqual(calls2.filter((call) => call[0] !== 'for'), [
    ['setDraft', 'helloA\nB'],
    ['focus'],
  ])
})

// ── 引用并入变量：`{{引用选中}}` 就是文字，发出去是 Markdown 引用块 ─────────────────

test('引用变量：原文逐行写成 "> " 引用块；空行留 ">"', async () => {
  const plugin = await loadPlugin()
  const { formatQuoted } = plugin.__internals
  assert.equal(formatQuoted('一行'), '> 一行')
  assert.equal(formatQuoted('两行\n第二行'), '> 两行\n> 第二行', '多行逐行加')
  assert.equal(formatQuoted('a\r\n\r\nb'), '> a\n>\n> b', 'CRLF 归一，空行也是引用块的一行')
  assert.equal(formatQuoted(''), '>')
})

test('引用变量 + 填入：插入引用块文字到光标，不提交', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  const prevGetSel = globalThis.getSelection
  const calls = []
  const ctx = makeCtx({ calls, draft: '', insert: { caret: [0, 0], draftRev: 3 } })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '引用', text: '{{引用选中}}', mode: 'insert' }] }),
  })
  globalThis.getSelection = () => ({ toString: () => '历史原文' })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const button = actionByLabel(mounted.tree, '引用')
    // 点击会清掉页面选区：mousedown 先存一份
    button.props.onMouseDown({ preventDefault() {} })
    globalThis.getSelection = () => ({ toString: () => '' })
    button.props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
      ['insertText', '> 历史原文', { start: 0, end: 0, draftRev: 3 }],
      ['focus'],
    ], '引用块就是普通文字，走宿主光标插入')
  } finally {
    globalThis.fetch = prevFetch
    if (prevGetSel === undefined) delete globalThis.getSelection
    else globalThis.getSelection = prevGetSel
  }
})

test('校验：旧 quote 行折算成引用变量；客户端不再产出 quote 字段', async () => {
  const plugin = await loadPlugin()
  const { blankCustomRow, validateCustomRows } = plugin.__internals
  assert.deepEqual(blankCustomRow('quote'), { label: '', text: '', mode: 'send', source: 'static', style: 'secondary', side: 'right' }, '没有 quote 点法了')
  assert.deepEqual(validateCustomRows([{ label: '引用', text: '', mode: 'quote', source: 'selection' }]), {
    ok: true,
    buttons: [{ label: '引用', text: '{{引用选中}}', mode: 'insert', source: 'static', style: 'ghost', side: 'left' }],
  })
  assert.deepEqual(validateCustomRows([{ label: '引用', text: '{{引用AI回答}}\\n\\n解释', mode: 'send' }]), {
    ok: true,
    buttons: [{ label: '引用', text: '{{引用AI回答}}\\n\\n解释', mode: 'send', source: 'static', style: 'secondary', side: 'right' }],
  })
})

test('编辑器：旧 mode=quote 按钮显示成文字里的 {{引用…}}，保存成普通按钮', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const posts = []
  const prevFetch = globalThis.fetch
  const base = {
    buttons: [{ label: '引用', text: '解释这段', mode: 'quote', source: 'last-assistant' }],
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

    assert.equal(findByClass(mounted.tree, 'dsh-quote-toggle'), null, '迁移后没有开关')
    const left = findByClass(mounted.tree, 'dsh-section-left')
    assert.equal(findAllWithClassToken(left, 'dsh-mode-insert')[0].props['aria-checked'], true, '旧 quote 点法 = 填入')
    assert.equal(findByClass(mounted.tree, 'dsh-custom-text-input').props.value, '{{引用AI回答}}\\n\\n解释这段')

    findByClass(mounted.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(posts[0].buttons, [
      { label: '引用', text: '{{引用AI回答}}\\n\\n解释这段', mode: 'insert', source: 'static', style: 'ghost', side: 'left' },
    ])
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('旧 quote 配置在运行时也折算：点一下发出引用块 + 提示（不依赖宿主 insertQuote）', async () => {
  const plugin = await loadPlugin()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '引用发', text: '解释这段', mode: 'send', quote: true, source: 'last-assistant' }] }),
  })
  const assistant = { event: { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: '回答正文' }] } } } }
  try {
    const calls = []
    const ctx = makeCtx({ calls, entries: [assistant] })
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    actionByLabel(mountDock(ctx).tree, '引用发').props.onClick()
    assert.deepEqual(calls.filter((call) => call[0] !== 'for'), [
      ['setDraft', '> 回答正文\n\n解释这段'],
      ['submit'],
    ], '旧配置读入即折算，和手写 {{引用AI回答}} 等价')
  } finally {
    globalThis.fetch = prevFetch
  }
})


test('档 2：上一条 AI 回答 / 会话标题 / 当前模型 / 本地时间都能当来源', async () => {
  const plugin = await loadPlugin()
  const { resolveActionText, lastAssistantMessage } = plugin.__internals

  const assistant = (seq, text) => ({
    event: {
      type: 'assistant/message',
      seq,
      data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text }] } },
    },
  })
  const ctx = makeCtx({
    entries: [userMessage(1, '问题'), assistant(2, '回答正文')],
    sessionTitle: '我的会话',
    sessionModel: { name: 'deepseek-chat' },
  })
  assert.equal(lastAssistantMessage(ctx), '回答正文', '只收 text 块，跳过 reasoning')
  assert.deepEqual(resolveActionText(ctx, { source: 'last-assistant' }), { ok: true, text: '回答正文' })
  assert.deepEqual(resolveActionText(ctx, { source: 'last-assistant', text: '接着这条说：{{value}}' }), { ok: true, text: '接着这条说：回答正文' })
  assert.deepEqual(resolveActionText(ctx, { source: 'session-title' }), { ok: true, text: '我的会话' })
  assert.deepEqual(resolveActionText(ctx, { source: 'model' }), { ok: true, text: 'deepseek-chat' })

  // 本地时间：直接可读，格式 YYYY-MM-DD HH:mm
  const time = resolveActionText(makeCtx(), { source: 'time' })
  assert.equal(time.ok, true)
  assert.match(time.text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

  // 宿主没暴露标题 / 模型 → no-source（提示「没有可用的内容」，不猜）
  assert.deepEqual(resolveActionText(makeCtx(), { source: 'session-title' }), { ok: false, why: 'no-source' })
  assert.deepEqual(resolveActionText(makeCtx(), { source: 'model' }), { ok: false, why: 'no-source' })
})

test('模板占位符：名字去重、`value` 是保留名、填值替换（缺值 = 空）', async () => {
  const plugin = await loadPlugin()
  const { placeholderNamesOf, fillPlaceholders } = plugin.__internals

  assert.deepEqual(placeholderNamesOf('总结 {{file}}，再看 {{file}} 和 {{value}}'), ['file'], '同名只出现一次，value 不算')
  assert.deepEqual(placeholderNamesOf('{{ 文件名 }} {{a-b}} {{x_1}}'), ['文件名', 'a-b', 'x_1'], '中文名、连字符、下划线都认；两端空格忽略')
  assert.deepEqual(placeholderNamesOf('{{value}}'), [], '只有保留名时没有可填项')
  assert.deepEqual(placeholderNamesOf('没有占位符'), [])
  assert.deepEqual(placeholderNamesOf(''), [])
  assert.deepEqual(placeholderNamesOf(undefined), [], '非字符串按空处理')

  assert.equal(fillPlaceholders('总结 {{file}}', { file: 'a.js' }), '总结 a.js')
  assert.equal(fillPlaceholders('a {{x}} b {{y}}', { x: '1' }), 'a 1 b ', '没给值的替换成空')
  assert.equal(fillPlaceholders('{{value}} 与 {{v}}', { v: '2' }), '{{value}} 与 2', 'value 原样留着')
  assert.equal(fillPlaceholders('{{x}}', { x: 1 }), '', '非字符串值不参与替换')
})

test('模板占位符：点按钮先弹填参面板，填完才发送', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls })
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '总结文件', text: '总结 {{file}} 这个文件' }] }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const button = actionByLabel(mounted.tree, '总结文件')
    assert.ok(button, '自定义按钮应当渲染出来')

    button.props.onClick()
    assert.deepEqual(calls, [], '有占位符时不应立刻发送')
    const input = findByClass(mounted.tree, 'dsh-fill-input')
    assert.ok(input, '应弹出填参面板')
    assert.equal(input.props['data-placeholder-name'], 'file', '输入框按占位符名字生成')

    input.props.onChange({ target: { value: 'a.js' } })
    findByClass(mounted.tree, 'dsh-fill-ok').props.onClick()
    assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '总结 a.js 这个文件'], ['submit']], '填完才发送，且替换进模板')
    assert.equal(findByClass(mounted.tree, 'dsh-fill-panel'), null, '执行后面板关闭')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('模板占位符：控制行模式下右侧（发送类）按钮也能弹面板', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls })
  const prevFetch = globalThis.fetch
  const prevStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => 'bar', setItem: () => {} }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '发一段', text: '给 {{who}} 发消息', mode: 'send' }] }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 右侧那一格组件自己的 useState 槽：面板必须在它里面出现（左右是两格独立组件）
    const right = mountRegistration(ctx, `${PKG.name}:send`)
    const button = actionByLabel(right.tree, '发一段')
    assert.ok(button, '发送类按钮应渲染在右格')
    button.props.onClick()
    assert.deepEqual(calls, [], '有占位符时不应立刻发送')
    const input = findByClass(right.tree, 'dsh-fill-input')
    assert.ok(input, '右侧组件里也要挂填参面板')
    input.props.onChange({ target: { value: '老王' } })
    findByClass(right.tree, 'dsh-fill-ok').props.onClick()
    assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '给 老王 发消息'], ['submit']])
  } finally {
    globalThis.fetch = prevFetch
    globalThis.localStorage = prevStorage
  }
})

test('模板占位符：取消不执行；`{{value}}` 不触发面板', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls })
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      buttons: [
        { label: '取消我', text: '{{thing}} 再想想' },
        { label: '保留值', text: '原样 {{value}}' },
      ],
    }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)

    actionByLabel(mounted.tree, '取消我').props.onClick()
    findByClass(mounted.tree, 'dsh-fill-input').props.onChange({ target: { value: 'x' } })
    findByClass(mounted.tree, 'dsh-fill-cancel').props.onClick()
    assert.deepEqual(calls, [], '取消后什么都不执行')
    assert.equal(findByClass(mounted.tree, 'dsh-fill-panel'), null, '取消后面板关闭')

    actionByLabel(mounted.tree, '保留值').props.onClick()
    assert.equal(findByClass(mounted.tree, 'dsh-fill-panel'), null, 'value 是保留名，不弹面板')
    assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '原样 {{value}}'], ['submit']], '静态按钮里的 {{value}} 原样发出')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('编辑器：每行一行（没有 ⚙ 抽屉）；方式单字内联，{} 才展开变量菜单；标签可留空', async () => {
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
    return { ok: true, status: 200, json: async () => ({ ok: true, buttons: [{ label: '甲', text: 'a', mode: 'insert' }], hidden: ['continue'], presets: {} }) }
  }
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    assert.equal(findByClass(mounted.tree, 'dsh-row-toggle'), null, '没有 ⚙ 开关')
    assert.equal(findByClass(mounted.tree, 'dsh-row-meta'), null, '没有抽屉')
    assert.equal(findByClass(mounted.tree, 'dsh-editor-hint'), null, '顶部说明行已移到标题悬停')
    const options = findAllWithClassToken(mounted.tree, 'dsh-mode-option')
    assert.deepEqual(options.map((o) => o.children.join('')), ['发', '填'], '方式单字内联（引用是独立开关）')
    assert.equal(findByClass(mounted.tree, 'dsh-var-menu'), null, '变量菜单默认不出')
    findByClass(mounted.tree, 'dsh-add-var').props.onClick()
    assert.ok(findByClass(mounted.tree, 'dsh-var-menu'), '点 {} 才出变量菜单')

    // 标签留空：占位显示自动标签，保存时补上
    findByClass(mounted.tree, 'dsh-custom-label-input').props.onChange({ target: { value: '' } })
    findByClass(mounted.tree, 'dsh-custom-text-input').props.onChange({ target: { value: '解释这段代码：\\n{{选中}}' } })
    assert.equal(findByClass(mounted.tree, 'dsh-custom-label-input').props.placeholder, '解释这段代码：', '占位里显示会用的标签')
    findByClass(mounted.tree, 'dsh-custom-save').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(posts[0].buttons[0].label, '解释这段代码：')
    assert.equal(posts[0].buttons[0].source, 'selection')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('可发现性：编辑器「＋ 变量」插入 {{名字}}，并提示这条会先问什么', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '总结', text: '总结这一轮' }] }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    findByClass(mounted.tree, 'dsh-custom-manage').props.onClick()

    const addVar = findAllByClass(mounted.tree, 'dsh-add-var')[0]
    assert.ok(addVar, '编辑器每行都有「＋ 变量」')
    // 行顺序来自当前配置（默认按钮也在这份清单里），所以按文字定位目标行，别假设第 0 行。
    const textInputs = findAllByClass(mounted.tree, 'dsh-custom-text-input')
    const target = textInputs.findIndex((input) => input.props.value === '总结这一轮')
    assert.ok(target >= 0, `找不到目标行，实际：${textInputs.map((i) => i.props.value).join(' | ')}`)
    const addVars = findAllByClass(mounted.tree, 'dsh-add-var')
    addVars[target].props.onClick()
    const chips = findAllByClass(mounted.tree, 'dsh-var-chip')
    assert.deepEqual(chips.map((chip) => chip.props['data-var']),
      ['selection', 'last-user', 'last-assistant', 'draft', 'session-title', 'model', 'time',
        'quote:selection', 'quote:last-user', 'quote:last-assistant', 'custom'], '自动读取七个 + 引用块三个 + 问我一个')
    chips.find((chip) => chip.props['data-var'] === 'selection').props.onClick()
    assert.equal(findAllByClass(mounted.tree, 'dsh-custom-text-input')[target].props.value, '总结这一轮{{选中}}', '内置变量插到文字末尾')
    assert.equal(findAllByClass(mounted.tree, 'dsh-add-var')[target].props['data-asks'], '', '内置变量不算「会先问你」')

    findAllByClass(mounted.tree, 'dsh-add-var')[target].props.onClick()
    findAllByClass(mounted.tree, 'dsh-var-chip').find((chip) => chip.props['data-var'] === 'custom').props.onClick()
    assert.equal(findAllByClass(mounted.tree, 'dsh-custom-text-input')[target].props.value, '总结这一轮{{选中}}{{变量}}')
    const hint = findAllByClass(mounted.tree, 'dsh-add-var')[target]
    assert.equal(hint.children.join(''), '{1}', '{} 按钮显示「问我」变量个数')
    assert.match(String(hint.props.title), /变量/, '悬停写出变量名')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('可发现性：带变量的按钮，悬浮提示里标出变量个数', async () => {
  const plugin = await loadPlugin()
  const ctx = makeCtx()
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, buttons: [{ label: '总结文件', text: '总结 {{file}} 和 {{scope}}' }] }),
  })
  try {
    plugin.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mounted = mountDock(ctx)
    const button = actionByLabel(mounted.tree, '总结文件')
    assert.ok(button)
    assert.match(button.props.title, /变量 2/, `标题应标出 2 个变量，实际：${button.props.title}`)
  } finally {
    globalThis.fetch = prevFetch
  }
})
