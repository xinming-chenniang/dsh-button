/**
 * dsh-closeout-button 客户端半部的冒烟测试（无需浏览器）。
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

const SLOT_CLOSEOUT = 'conversation.input.left'
const SLOT_SUGGEST = 'conversation.input.left'
const SLOT_RESEND = 'conversation.input.right'

/** 最小的 React 替身：createElement 记形状，useState 取初值，Component 只当基类。 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [init, () => {}],
  Fragment: Symbol('Fragment'),
  Component: class Component {
    constructor(props) { this.props = props }
  },
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
    assert.equal(name, 'react', `工厂只应 require('react')，实际要了 ${name}`)
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
 */
function makeCtx({ byId = { 'session-test': { retainedBy: { mainView: 1 } } }, entries = [], calls = [] } = {}) {
  const services = {
    sessions: {
      list: { getSnapshot: () => ({ ids: Object.keys(byId), byId }) },
      scope: (id) => ({ id }),
      binding: () => ({ eventSource: { getSnapshot: () => ({ revision: 1, entries, hasMore: false }) } }),
    },
    conversation: {
      input: {
        for: (scope) => {
          calls.push(['for', scope.id])
          return {
            setDraft: (text) => calls.push(['setDraft', text]),
            submit: () => calls.push(['submit']),
          }
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
        ctx.registrations.push({ options, component })
        return () => {}
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

test('插件对象形状：名字、注入面、四个按钮分别注册到两个插槽', async () => {
  const plugin = await loadPlugin()
  assert.equal(plugin.name, PKG.name)
  assert.ok(plugin.inject.includes('slots'), 'inject 必须含 slots')
  assert.ok(!plugin.inject.includes('conversation'), 'conversation 应当按需取，不进 inject（少一个 pending 风险）')

  const ctx = makeCtx()
  plugin.apply(ctx)
  assert.equal(ctx.registrations.length, 4, '应当注册四个按钮（收尾 + 按建议执行 + 收口面板 + 重发）')
  const left = ctx.registrations.filter((item) => item.options.name === SLOT_CLOSEOUT)
  assert.equal(left.length, 3, '输入框左侧应当有三个动作：收尾 + 按建议执行 + 收口面板')
  assert.deepEqual(left.map((item) => item.options.order), [5, 6, 7], '按建议执行在收尾右边，面板再往右')
  const leftIds = left.map((item) => item.options.id)
  assert.equal(new Set(leftIds).size, 3, `同一个插槽里的格子键必须互不相同（复用 id = 顶掉别人的格子）：${JSON.stringify(leftIds)}`)
  assert.equal(ctx.registrations.find((item) => item.options.name === SLOT_RESEND)?.options.id, PKG.name)
  assert.equal(left[0].options.id, PKG.name)
})

test('收尾：点击＝把「收尾」填进当前会话并提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls })
  plugin.apply(ctx)

  const button = buttonAt(ctx, SLOT_CLOSEOUT, 'dsh-closeout-action')
  assert.equal(button.props.disabled, false, '有当前会话时收尾可用')
  button.props.onClick()
  assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '收尾'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})

test('按建议执行：点击＝把「按建议执行」填进当前会话并提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls })
  plugin.apply(ctx)

  const button = buttonAt(ctx, SLOT_SUGGEST, 'dsh-suggest-action')
  assert.equal(button.props.disabled, false, '有当前会话时按建议执行可用')
  button.props.onClick()
  assert.deepEqual(calls, [['for', 'session-test'], ['setDraft', '按建议执行'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
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

test('没有打开的会话：三个按钮都禁用，点击不提交', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, byId: {} })
  plugin.apply(ctx)

  const closeout = buttonAt(ctx, SLOT_CLOSEOUT, 'dsh-closeout-action')
  const suggest = buttonAt(ctx, SLOT_SUGGEST, 'dsh-suggest-action')
  const resend = buttonAt(ctx, SLOT_RESEND, 'dsh-resend-action')
  assert.equal(closeout.props.disabled, true)
  assert.equal(suggest.props.disabled, true)
  assert.equal(resend.props.disabled, true)

  closeout.props.onClick()
  suggest.props.onClick()
  resend.props.onClick()
  assert.deepEqual(calls, [], '禁用状态下不应提交任何东西')
})

test('只有注入消息、没有真人消息：重发禁用，收尾与按建议执行仍可用', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const ctx = makeCtx({ calls, entries: [userMessage(3, '注入内容', 'agent-instructions')] })
  plugin.apply(ctx)

  assert.equal(buttonAt(ctx, SLOT_RESEND, 'dsh-resend-action').props.disabled, true)
  assert.equal(buttonAt(ctx, SLOT_CLOSEOUT, 'dsh-closeout-action').props.disabled, false)
  assert.equal(buttonAt(ctx, SLOT_SUGGEST, 'dsh-suggest-action').props.disabled, false)
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

  buttonAt(ctx, SLOT_CLOSEOUT, 'dsh-closeout-action').props.onClick()
  assert.deepEqual(calls, [['for', 'session-a'], ['setDraft', '收尾'], ['submit']], `实际调用：${JSON.stringify(calls)}`)
})
