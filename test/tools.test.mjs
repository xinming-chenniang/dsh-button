/**
 * dsh_button（工具半部）的冒烟测试。
 *
 * 钉两件真机出过的事：
 *   ① 2026-11-22：**菜单盖的是哪一次调用的会话 id** —— 写错的话客户端会把菜单当成
 *      「别的会话的方案」，只显示一行「生成本轮选项」；用户点它，agent 又写回同一个错 id，永远转不出去。
 *   ② 2026-11-23：**多个会话同时写要各存各的** —— 以前一条按钮只有一批 items，
 *      后写的直接盖掉前一个（同时只能有一个会话写成功）；现在按会话各存一节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/tools.js'

/** 装一个只够 dsh_button 用的 ctx，返回注册到的工具定义。 */
function mountTool({ focusedSession = '' } = {}) {
  let definition = null
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (def) => { definition = def; return () => {} } }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ current: focusedSession }) } }
      return undefined
    },
    effect(fn) { return typeof fn === 'function' ? fn() : undefined },
  }
  apply(ctx)
  assert.ok(definition, '应当注册 dsh_button')
  return definition
}

/** 在临时 DSH_HOME 里跑 apply，返回 { def, home, buttons() }。 */
async function withTempHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-button-tools-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await run(home)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

/** 读回「下一步」这条按钮（直接看盘上的文件，验证真正写进去的形状）。 */
function readMenu(home) {
  const saved = JSON.parse(readFileSync(join(home, 'dsh-button', 'buttons.json'), 'utf8'))
  return saved.buttons.find((item) => item.label === '下一步')
}

test('set_options 盖的是「这次调用的会话」，不是界面聚焦的那个会话', async () => {
  await withTempHome(async (home) => {
    const def = mountTool({ focusedSession: 'session-focused-elsewhere' })
    // 先建一条普通按钮（模拟用户/agent 早先建好的「继续」）
    await def.execute({ action: 'add', button: { label: '下一步', text: '继续' } }, { agent: { id: 'session-caller' } })
    const written = await def.execute({
      action: 'set_options',
      label: '下一步',
      items: [{ label: '方案A', text: 'a' }],
    }, { agent: { id: 'session-caller' } })
    assert.equal(written.ok, true)
    const menu = readMenu(home)
    assert.deepEqual(menu.sessions['session-caller'].items.map((item) => item.label), ['方案A'], '必须用调用方会话 id')
    assert.equal(menu.sessions['session-focused-elsewhere'], undefined, '界面聚焦的那个不算数')
    assert.equal(menu.session, undefined, '旧形状的单个 session 字段不再写')
  })
})

test('调用方显式给了 session 时优先用它（例如替另一个会话写）', async () => {
  await withTempHome(async (home) => {
    const def = mountTool({ focusedSession: 'session-focused-elsewhere' })
    await def.execute({ action: 'add', button: { label: '下一步', text: '继续' } }, { agent: { id: 'session-caller' } })
    await def.execute({
      action: 'set_options',
      label: '下一步',
      items: [{ label: '方案A', text: 'a' }],
      session: 'session-other',
    }, { agent: { id: 'session-caller' } })
    const menu = readMenu(home)
    assert.deepEqual(Object.keys(menu.sessions), ['session-other'])
  })
})

test('拿不到调用上下文时退回界面聚焦的会话（老宿主）', async () => {
  await withTempHome(async (home) => {
    const def = mountTool({ focusedSession: 'session-focused-only' })
    await def.execute({ action: 'add', button: { label: '下一步', text: '继续' } })
    await def.execute({ action: 'set_options', label: '下一步', items: [{ label: 'A', text: 'a' }] })
    const menu = readMenu(home)
    assert.deepEqual(Object.keys(menu.sessions), ['session-focused-only'])
  })
})

test('两个会话各写各的，互不覆盖（同时只能有一个会话写成功 = 已修）', async () => {
  await withTempHome(async (home) => {
    const def = mountTool({ focusedSession: 'session-focused-elsewhere' })
    await def.execute({ action: 'add', button: { label: '下一步', text: '继续' } }, { agent: { id: 'session-a' } })
    await def.execute({ action: 'set_options', label: '下一步', items: [{ label: 'A1', text: 'a1' }] }, { agent: { id: 'session-a' } })
    const second = await def.execute({ action: 'set_options', label: '下一步', items: [{ label: 'B1', text: 'b1' }, { label: 'B2', text: 'b2' }] }, { agent: { id: 'session-b' } })
    assert.equal(second.ok, true)
    const menu = readMenu(home)
    assert.deepEqual(Object.keys(menu.sessions).sort(), ['session-a', 'session-b'])
    assert.deepEqual(menu.sessions['session-a'].items.map((item) => item.label), ['A1'], '先写的会话那份还在')
    assert.deepEqual(menu.sessions['session-b'].items.map((item) => item.label), ['B1', 'B2'])
    assert.ok(menu.sessions['session-a'].at, '各节各带写入时间')
  })
})

test('items: [] 只摘当前会话那一节，别的会话那份留着', async () => {
  await withTempHome(async (home) => {
    const def = mountTool({ focusedSession: 'session-focused-elsewhere' })
    await def.execute({ action: 'add', button: { label: '下一步', text: '继续' } }, { agent: { id: 'session-a' } })
    await def.execute({ action: 'set_options', label: '下一步', items: [{ label: 'A1', text: 'a1' }] }, { agent: { id: 'session-a' } })
    await def.execute({ action: 'set_options', label: '下一步', items: [{ label: 'B1', text: 'b1' }] }, { agent: { id: 'session-b' } })
    const cleared = await def.execute({ action: 'set_options', label: '下一步', items: [] }, { agent: { id: 'session-b' } })
    assert.equal(cleared.ok, true)
    const menu = readMenu(home)
    assert.deepEqual(Object.keys(menu.sessions), ['session-a'])
    assert.equal(menu.text, '继续', '按钮本身还在，退成普通文字按钮的语义只在该会话没别的东西时发生')
  })
})

test('一条按钮最多存 8 个会话的选项，超过淘汰最久没写的那个', async () => {
  await withTempHome(async (home) => {
    const def = mountTool()
    await def.execute({ action: 'add', button: { label: '下一步', text: '继续' } }, { agent: { id: 'session-0' } })
    for (let i = 0; i < 9; i++) {
      const at = `2026-11-2${Math.min(i, 8)}T00:00:00.000Z`
      await def.execute({
        action: 'set_options',
        label: '下一步',
        items: [{ label: `S${i}`, text: `s${i}` }],
        at,
      }, { agent: { id: `session-${i}` } })
    }
    const menu = readMenu(home)
    const ids = Object.keys(menu.sessions)
    assert.equal(ids.length, 8, '上限 8 节')
    assert.equal(ids.includes('session-0'), false, '最久没写的那节被淘汰')
    assert.equal(ids.includes('session-8'), true, '刚写的那节留着')
  })
})
