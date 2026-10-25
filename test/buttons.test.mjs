/**
 * 自定义按钮 + 预设隐藏：配置读写 + 路由的测试。
 *
 * 覆盖两层：
 *   1. `lib/buttons.js` 的纯函数（校验、hidden、读、原子写）—— 不碰 DSH；
 *   2. `lib/index.js` 注册的 `GET/POST /api/dsh-button/buttons` —— 用假 req/res 直接调 handler。
 * 配置文件全部落在 `mkdtemp` 里，跑完即删；不改用户真实的 `~/.dsh`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply } from '../lib/index.js'
import { configPath, loadConfig, saveConfig, validateConfig, validateHidden, validatePresets, MAX_BUTTONS, PRESET_IDS, DEFAULT_BUTTONS, DEFAULT_PRESETS } from '../lib/buttons.js'

const ROUTE = '/api/dsh-button/buttons'

/** 临时目录 + 指向其中 buttons.json 的环境变量，finally 里恢复。 */
function withConfigFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-button-cfg-'))
  const file = join(dir, 'buttons.json')
  const prev = process.env.DSH_BUTTON_CONFIG
  process.env.DSH_BUTTON_CONFIG = file
  return Promise.resolve(fn({ dir, file })).finally(() => {
    if (prev === undefined) delete process.env.DSH_BUTTON_CONFIG
    else process.env.DSH_BUTTON_CONFIG = prev
    rmSync(dir, { recursive: true, force: true })
  })
}

function fakeReq({ method = 'GET', body = undefined, addr = '127.0.0.1', host = '127.0.0.1:53579', origin } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    socket: { remoteAddress: addr },
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text)
    },
  }
}

function fakeRes() {
  const out = { status: 0, headers: null, payload: null }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(buf) {
      out.payload = buf === undefined ? null : JSON.parse(String(buf))
    },
  }
}

/** 起插件，返回自定义按钮那条路由的 handler。 */
function buttonsHandler() {
  const routes = new Map()
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    webServer: {
      register: (opts) => {
        routes.set(opts.path, opts)
        return () => {}
      },
    },
  }
  apply(ctx)
  const captured = routes.get(ROUTE)
  assert.ok(captured, `应当注册 ${ROUTE}`)
  assert.equal(captured.kind, 'exact')
  return captured.handler
}

test('validateConfig：接受数组与 {buttons}，去掉首尾空白，hidden 默认空、presets 用默认值', () => {
  assert.deepEqual(validateConfig([{ label: ' 收尾 ', text: ' 收尾 ' }]), {
    ok: true,
    buttons: [{ label: '收尾', text: '收尾', mode: 'send', style: 'secondary', icon: '' }],
    hidden: [],
    presets: DEFAULT_PRESETS,
  })
  assert.deepEqual(validateConfig({ buttons: [{ label: '知识库', text: '用 knowledge-base 查一下' }] }), {
    ok: true,
    buttons: [{ label: '知识库', text: '用 knowledge-base 查一下', mode: 'send', style: 'secondary', icon: '' }],
    hidden: [],
    presets: DEFAULT_PRESETS,
  })
  assert.deepEqual(validateConfig({ buttons: [], hidden: ['continue', 'resend'] }), {
    ok: true,
    buttons: [],
    hidden: ['continue', 'resend'],
    presets: DEFAULT_PRESETS,
  })
  // 1.2.x 写的配置没有 mode 字段 = 直接发送（向后兼容）；没有 style 也按 mode 派生
  assert.deepEqual(validateConfig([{ label: '旧', text: '旧' }]).buttons, [{ label: '旧', text: '旧', mode: 'send', style: 'secondary', icon: '' }])
})

test('validateConfig：外观与图标可选；未知外观/超长图标明确报错', () => {
  // 显式写外观：主色 / 警示 / 虚线 都原样保留
  assert.deepEqual(
    validateConfig([{ label: '主', text: 'x', style: 'primary' }, { label: '危', text: 'x', style: 'danger' }, { label: '线', text: 'x', style: 'ghost' }]).buttons,
    [
      { label: '主', text: 'x', mode: 'send', style: 'primary', icon: '' },
      { label: '危', text: 'x', mode: 'send', style: 'danger', icon: '' },
      { label: '线', text: 'x', mode: 'send', style: 'ghost', icon: '' },
    ],
  )
  // 图标：一个 emoji / 一个字符都可以，首尾空白被吃掉
  assert.deepEqual(validateConfig([{ label: '收', text: 'x', icon: ' 🏁 ' }]).buttons, [{ label: '收', text: 'x', mode: 'send', style: 'secondary', icon: '🏁' }])
  // 外观写错
  const badStyle = validateConfig([{ label: 'a', text: 'b', style: 'neon' }])
  assert.equal(badStyle.ok, false)
  assert.match(badStyle.message, /外观/)
  assert.match(badStyle.message, /primary/)
  // 图标超过 MAX_ICON 个码位
  const badIcon = validateConfig([{ label: 'a', text: 'b', icon: '🏁🏁🏁' }])
  assert.equal(badIcon.ok, false)
  assert.match(badIcon.message, /图标/)
  // 图标里不能有空白
  assert.equal(validateConfig([{ label: 'a', text: 'b', icon: 'a b' }]).ok, false)
})

test('validateConfig：拒绝超限、空字段与换行标签；允许 "=" 与多行文字', () => {
  assert.equal(validateConfig(null).ok, false)
  assert.equal(validateConfig({ buttons: 'nope' }).ok, false)
  assert.equal(validateConfig(Array.from({ length: MAX_BUTTONS + 1 }, () => ({ label: 'a', text: 'b' }))).ok, false)
  assert.equal(validateConfig([{ label: '', text: 'x' }]).ok, false)
  assert.equal(validateConfig([{ label: 'x', text: '' }]).ok, false)
  assert.equal(validateConfig([{ label: 'a\nb', text: 'x' }]).ok, false)
  assert.equal(validateConfig([{ label: 'a'.repeat(30), text: 'x' }]).ok, false)
  // 编辑器不再用「标签 = 文字」的行格式，标签里的 "=" 就是普通字符；文字可以是多行
  assert.deepEqual(validateConfig([{ label: 'a=b', text: '第一行\n第二行' }]), {
    ok: true,
    buttons: [{ label: 'a=b', text: '第一行\n第二行', mode: 'send', style: 'secondary', icon: '' }],
    hidden: [],
    presets: DEFAULT_PRESETS,
  })
})

test('validateConfig：mode 只接受 send / insert，未知值明确报错', () => {
  assert.deepEqual(validateConfig([{ label: '模板', text: 'x', mode: 'insert' }]).buttons, [{ label: '模板', text: 'x', mode: 'insert', style: 'ghost', icon: '' }])
  const bad = validateConfig([{ label: '模板', text: 'x', mode: 'paste' }])
  assert.equal(bad.ok, false)
  assert.match(bad.message, /mode/)
  assert.match(bad.message, /send/)
  assert.match(bad.message, /insert/)
  const badPreset = validateConfig({ buttons: [], presets: { continue: { mode: 'steer' } } })
  assert.equal(badPreset.ok, false)
  assert.match(badPreset.message, /continue/)
})

test('validatePresets：缺省补默认值；自定义标签/文字有效；超长或换行报错', () => {
  assert.deepEqual(validatePresets(undefined), { ok: true, presets: DEFAULT_PRESETS })
  assert.deepEqual(validatePresets({ continue: { label: ' 继续吧 ', text: ' 继续吧 ' }, resend: { label: ' 再来一次 ' } }), {
    ok: true,
    presets: {
      continue: { label: '继续吧', text: '继续吧', mode: 'send' },
      resend: { label: '再来一次', mode: 'send' },
    },
  })
  assert.deepEqual(validatePresets({ continue: { mode: 'insert' }, resend: { mode: 'insert' } }).presets, {
    continue: { label: '继续', text: '继续', mode: 'insert' },
    resend: { label: '重发上一条', mode: 'insert' },
  })
  assert.equal(validatePresets({ continue: { label: 'a'.repeat(30) } }).ok, false)
  assert.equal(validatePresets({ resend: { label: 'a\nb' } }).ok, false)
  assert.equal(validatePresets({ continue: { text: 'a\nb' } }).ok, false)
})

test('validateHidden：只允许已知预设、去重；未知值报错', () => {
  assert.deepEqual(validateHidden(undefined), { ok: true, hidden: [] })
  assert.deepEqual(validateHidden(['continue', 'continue', 'resend']), { ok: true, hidden: ['continue', 'resend'] })
  const bad = validateHidden(['continue', 'closeout'])
  assert.equal(bad.ok, false)
  assert.match(bad.message, /closeout/)
  assert.deepEqual(PRESET_IDS, ['continue', 'resend'])
})

test('loadConfig：文件不存在 → 自带默认按钮；坏 JSON → 明确报错而不是当空配置', async () => {
  await withConfigFile(({ file }) => {
    const fresh = loadConfig(file)
    assert.equal(fresh.ok, true)
    assert.equal(fresh.exists, false)
    assert.equal(fresh.buttons.length, DEFAULT_BUTTONS.length)
    assert.deepEqual(fresh.buttons.map((b) => b.label), ['总结', '继续', '讨论', '说明'])
    writeFileSync(file, '{ not json', 'utf8')
    const bad = loadConfig(file)
    assert.equal(bad.ok, false)
    assert.match(bad.message, /JSON/)
  })
})

test('loadConfig：文件存在但按钮为空 → 不回退到默认按钮（用户清空是明确意图）', async () => {
  await withConfigFile(({ file }) => {
    saveConfig([], [], DEFAULT_PRESETS, file)
    const loaded = loadConfig(file)
    assert.equal(loaded.exists, true)
    assert.deepEqual(loaded.buttons, [])
  })
})

test('saveConfig：自动建目录、原子写，读回来是同一份（含 hidden）', async () => {
  await withConfigFile(({ dir, file }) => {
    const nested = join(dir, 'nested', 'buttons.json')
    const saved = saveConfig([{ label: '收尾', text: '收尾', mode: 'send' }], ['resend'], DEFAULT_PRESETS, nested)
    assert.equal(saved.ok, true, saved.message)
    const loaded = loadConfig(nested)
    assert.equal(loaded.ok, true)
    assert.deepEqual(loaded.buttons, [{ label: '收尾', text: '收尾', mode: 'send', style: 'secondary', icon: '' }])
    assert.deepEqual(loaded.hidden, ['resend'])
    assert.match(readFileSync(nested, 'utf8'), /"hidden"/)
    assert.match(readFileSync(nested, 'utf8'), /"mode"/)
  })
})

test('GET 路由：返回当前配置、hidden、presets 与路径', async () => {
  await withConfigFile(async ({ file }) => {
    saveConfig([{ label: '知识库', text: '用 knowledge-base 查', mode: 'insert' }], ['continue'], DEFAULT_PRESETS, file)
    const handler = buttonsHandler()
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.payload.ok, true)
    assert.deepEqual(res.out.payload.buttons, [{ label: '知识库', text: '用 knowledge-base 查', mode: 'insert', style: 'ghost', icon: '' }])
    assert.deepEqual(res.out.payload.hidden, ['continue'])
    assert.deepEqual(res.out.payload.presets, DEFAULT_PRESETS)
    assert.equal(res.out.payload.defaults, false, '已有配置文件时不应再标记为默认')
    assert.equal(res.out.payload.path, file)
  })
})

test('GET 路由：首次安装（无配置文件）返回默认按钮并标记 defaults', async () => {
  await withConfigFile(async ({ file }) => {
    const handler = buttonsHandler()
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.payload.defaults, true)
    assert.equal(res.out.payload.buttons.length, DEFAULT_BUTTONS.length)
    assert.equal(existsSync(file), false, 'GET 不应顺手建文件')
  })
})

test('POST 路由：保存合法配置（含 hidden、presets 与 mode）并落盘', async () => {
  await withConfigFile(async ({ file }) => {
    const handler = buttonsHandler()
    const res = fakeRes()
    await handler(
      fakeReq({
        method: 'POST',
        body: {
          buttons: [
            { label: '收尾', text: '收尾' },
            { label: '模板', text: '插入用', mode: 'insert' },
          ],
          hidden: ['resend'],
          presets: { continue: { label: '继续吧', text: '继续吧' }, resend: { label: '再来一次', mode: 'insert' } },
        },
      }),
      res,
    )
    assert.equal(res.out.status, 200)
    assert.deepEqual(res.out.payload.buttons, [
      { label: '收尾', text: '收尾', mode: 'send', style: 'secondary', icon: '' },
      { label: '模板', text: '插入用', mode: 'insert', style: 'ghost', icon: '' },
    ])
    assert.deepEqual(res.out.payload.hidden, ['resend'])
    assert.deepEqual(res.out.payload.presets, {
      continue: { label: '继续吧', text: '继续吧', mode: 'send' },
      resend: { label: '再来一次', mode: 'insert' },
    })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(saved.buttons, [
      { label: '收尾', text: '收尾', mode: 'send', style: 'secondary', icon: '' },
      { label: '模板', text: '插入用', mode: 'insert', style: 'ghost', icon: '' },
    ])
    assert.deepEqual(saved.hidden, ['resend'])
    assert.deepEqual(saved.presets.continue, { label: '继续吧', text: '继续吧', mode: 'send' })
    assert.deepEqual(saved.presets.resend, { label: '再来一次', mode: 'insert' })
  })
})

test('POST 路由：非法配置 → 400，且不覆盖旧文件（含非法 hidden）', async () => {
  await withConfigFile(async ({ file }) => {
    saveConfig([{ label: '旧', text: '旧', mode: 'send' }], [], DEFAULT_PRESETS, file)
    const handler = buttonsHandler()

    const badButton = fakeRes()
    await handler(fakeReq({ method: 'POST', body: { buttons: [{ label: 'a\nb', text: 'x' }] } }), badButton)
    assert.equal(badButton.out.status, 400)
    assert.equal(badButton.out.payload.code, 'bad-buttons')

    const badHidden = fakeRes()
    await handler(fakeReq({ method: 'POST', body: { buttons: [], hidden: ['closeout'] } }), badHidden)
    assert.equal(badHidden.out.status, 400)
    assert.match(String(badHidden.out.payload.message), /closeout/)

    assert.deepEqual(loadConfig(file).buttons, [{ label: '旧', text: '旧', mode: 'send', style: 'secondary', icon: '' }])
  })
})

test('路由的安全边界：非 loopback 403 / 跨源 403 / 其它方法 405', async () => {
  const handler = buttonsHandler()
  const remote = fakeRes()
  await handler(fakeReq({ method: 'GET', addr: '192.168.1.9' }), remote)
  assert.equal(remote.out.status, 403)

  const cross = fakeRes()
  await handler(fakeReq({ method: 'GET', origin: 'https://evil.example' }), cross)
  assert.equal(cross.out.status, 403)
  assert.equal(cross.out.payload.code, 'cross-origin')

  const put = fakeRes()
  await handler(fakeReq({ method: 'PUT' }), put)
  assert.equal(put.out.status, 405)
})

test('configPath：DSH_BUTTON_CONFIG 优先于 DSH_HOME', () => {
  const custom = process.platform === 'win32' ? 'C:/tmp/x.json' : '/tmp/x.json'
  assert.equal(configPath({ DSH_BUTTON_CONFIG: custom }), resolve(custom))
  assert.equal(configPath({ DSH_HOME: 'D:/home/.dsh' }), join('D:/home/.dsh', 'dsh-button', 'buttons.json'))
})

