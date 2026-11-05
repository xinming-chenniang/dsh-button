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
import { apply as applyTools } from '../lib/tools.js'
import { configPath, loadConfig, saveConfig, validateConfig, validateHidden, validatePresets, runButtonsAction, MAX_BUTTONS, PRESET_IDS, DEFAULT_BUTTONS, DEFAULT_PRESETS } from '../lib/buttons.js'

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
    buttons: [{ label: '收尾', text: '收尾', mode: 'send', source: 'static', style: 'secondary', side: 'right' }],
    hidden: [],
    presets: DEFAULT_PRESETS,
  })
  assert.deepEqual(validateConfig({ buttons: [{ label: '知识库', text: '用 knowledge-base 查一下' }] }), {
    ok: true,
    buttons: [{ label: '知识库', text: '用 knowledge-base 查一下', mode: 'send', source: 'static', style: 'secondary', side: 'right' }],
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
  assert.deepEqual(validateConfig([{ label: '旧', text: '旧' }]).buttons, [{ label: '旧', text: '旧', mode: 'send', source: 'static', style: 'secondary', side: 'right' }])
})

test('validateConfig：外观可选；未知外观明确报错；已删除的 icon 并入标签', () => {
  // 显式写外观：主色 / 警示 / 虚线 都原样保留
  assert.deepEqual(
    validateConfig([{ label: '主', text: 'x', style: 'primary' }, { label: '危', text: 'x', style: 'danger' }, { label: '线', text: 'x', style: 'ghost' }]).buttons,
    [
      { label: '主', text: 'x', mode: 'send', source: 'static', style: 'primary', side: 'right' },
      { label: '危', text: 'x', mode: 'send', source: 'static', style: 'danger', side: 'right' },
      { label: '线', text: 'x', mode: 'send', source: 'static', style: 'ghost', side: 'right' },
    ],
  )
  // 旧配置的 icon（早期开发分支独有）：读入时并进标签，输出不再有 icon 字段
  assert.deepEqual(validateConfig([{ label: '收', text: 'x', icon: ' 🏁 ' }]).buttons, [{ label: '🏁 收', text: 'x', mode: 'send', source: 'static', style: 'secondary', side: 'right' }])
  // 只有图标、没标签时，图标本身就是标签（不留尾随空格）
  assert.deepEqual(validateConfig([{ label: '', text: 'x', icon: '⚡' }]).buttons, [{ label: '⚡', text: 'x', mode: 'send', source: 'static', style: 'secondary', side: 'right' }])
  // 非法 icon 直接忽略（不再因为图标报错）；并入后超长也放弃图标，配置仍合法
  assert.deepEqual(validateConfig([{ label: 'a', text: 'b', icon: '🏁🏁🏁' }]).buttons, [{ label: 'a', text: 'b', mode: 'send', source: 'static', style: 'secondary', side: 'right' }])
  assert.deepEqual(validateConfig([{ label: 'a'.repeat(12), text: 'b', icon: '🏁' }]).buttons, [{ label: 'a'.repeat(12), text: 'b', mode: 'send', source: 'static', style: 'secondary', side: 'right' }])
  // 外观写错
  const badStyle = validateConfig([{ label: 'a', text: 'b', style: 'neon' }])
  assert.equal(badStyle.ok, false)
  assert.match(badStyle.message, /外观/)
  assert.match(badStyle.message, /primary/)
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
    buttons: [{ label: 'a=b', text: '第一行\n第二行', mode: 'send', source: 'static', style: 'secondary', side: 'right' }],
    hidden: [],
    presets: DEFAULT_PRESETS,
  })
})

test('MAX_BUTTONS：放宽到 40（溢出交给动作条「⋯」面板）', () => {
  assert.equal(MAX_BUTTONS, 40)
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ label: `b${i}`, text: 'x' }))
  assert.equal(validateConfig(rows(40)).ok, true, '40 条应当合法')
  assert.equal(validateConfig(rows(41)).ok, false, '41 条应当被拒')
})

test('validateConfig：mode 只接受 send / insert，未知值明确报错', () => {
  assert.deepEqual(validateConfig([{ label: '模板', text: 'x', mode: 'insert' }]).buttons, [{ label: '模板', text: 'x', mode: 'insert', source: 'static', style: 'ghost', side: 'left' }])
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
    assert.deepEqual(fresh.buttons.map((b) => b.label), ['重发', '继续', '讨论', 'skill', '解释选中区域'])
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
    assert.deepEqual(loaded.buttons, [{ label: '收尾', text: '收尾', mode: 'send', source: 'static', style: 'secondary', side: 'right' }])
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
    assert.deepEqual(res.out.payload.buttons, [{ label: '知识库', text: '用 knowledge-base 查', mode: 'insert', source: 'static', style: 'ghost', side: 'left' }])
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
      { label: '收尾', text: '收尾', mode: 'send', source: 'static', style: 'secondary', side: 'right' },
      { label: '模板', text: '插入用', mode: 'insert', source: 'static', style: 'ghost', side: 'left' },
    ])
    assert.deepEqual(res.out.payload.hidden, ['resend'])
    assert.deepEqual(res.out.payload.presets, {
      continue: { label: '继续吧', text: '继续吧', mode: 'send' },
      resend: { label: '再来一次', mode: 'insert' },
    })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(saved.buttons, [
      { label: '收尾', text: '收尾', mode: 'send', source: 'static', style: 'secondary', side: 'right' },
      { label: '模板', text: '插入用', mode: 'insert', source: 'static', style: 'ghost', side: 'left' },
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

    assert.deepEqual(loadConfig(file).buttons, [{ label: '旧', text: '旧', mode: 'send', source: 'static', style: 'secondary', side: 'right' }])
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


test('validateConfig：source 缺省 static；动态来源文字可空；未知来源明确报错', () => {
  // 缺省 = 静态文字（旧配置原样可用）
  assert.equal(validateConfig([{ label: '旧', text: '旧' }]).buttons[0].source, 'static')
  // 动态来源：文字是可选模板，空串合法
  const resend = validateConfig([{ label: '重发', source: 'last-user' }])
  assert.equal(resend.ok, true)
  assert.deepEqual(resend.buttons[0], { label: '重发', text: '', mode: 'send', source: 'last-user', style: 'secondary', side: 'right' })
  // 模板原样保留
  const selection = validateConfig([{ label: '解释', text: '讨论：{{value}}', source: 'selection', mode: 'insert' }])
  assert.equal(selection.ok, true)
  assert.equal(selection.buttons[0].source, 'selection')
  assert.equal(selection.buttons[0].text, '讨论：{{value}}')
  // 未知来源：明确报错，不当静态吞掉
  const bad = validateConfig([{ label: 'x', text: 'y', source: 'clipboard' }])
  assert.equal(bad.ok, false)
  assert.match(bad.message, /来源/)
  // 静态来源仍然必须有文字
  assert.equal(validateConfig([{ label: 'x', source: 'static' }]).ok, false)
})

test('saveConfig / loadConfig：source 往返（动态来源与模板原样读回）', async () => {
  await withConfigFile(async ({ file }) => {
    saveConfig([
      { label: '重发', text: '重发：{{value}}', mode: 'send', source: 'last-user', style: 'secondary', side: 'right' },
      { label: '解释', text: '', mode: 'insert', source: 'selection', style: 'ghost', side: 'left' },
    ], [], DEFAULT_PRESETS, file)
    const loaded = loadConfig(file)
    assert.equal(loaded.ok, true)
    assert.deepEqual(loaded.buttons, [
      { label: '重发', text: '重发：{{value}}', mode: 'send', source: 'last-user', style: 'secondary', side: 'right' },
      { label: '解释', text: '', mode: 'insert', source: 'selection', style: 'ghost', side: 'left' },
    ])
  })
})

test('POST 路由：动态来源保存后原样返回（source 与模板都不丢）', async () => {
  await withConfigFile(async ({ file }) => {
    const handler = buttonsHandler()
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', body: { buttons: [{ label: '重发', text: '{{value}}', source: 'last-user', mode: 'send' }] } }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.payload.buttons[0].source, 'last-user')
    assert.equal(res.out.payload.buttons[0].text, '{{value}}')
    assert.equal(loadConfig(file).buttons[0].source, 'last-user')
  })
})

// ---------------------------------------------------------------- 工具半部

test('工具：list 读默认值；add / remove / save 与界面同一条路径', async () => {
  await withConfigFile(async ({ file }) => {
    // 文件不存在 → 默认的 5 条，defaults=true
    const listed = runButtonsAction({ action: 'list' })
    assert.equal(listed.ok, true)
    assert.equal(listed.defaults, true)
    assert.equal(listed.buttons.length, DEFAULT_BUTTONS.length)
    assert.equal(listed.path, resolve(file))

    // add：追加一条并落盘
    const added = runButtonsAction({ action: 'add', button: { label: '跑测试', text: '运行全部测试并修复失败项' } })
    assert.equal(added.ok, true, JSON.stringify(added))
    assert.equal(added.buttons.length, DEFAULT_BUTTONS.length + 1)
    assert.equal(added.added.label, '跑测试')
    assert.equal(loadConfig(file).buttons.at(-1).label, '跑测试')
    assert.equal(loadConfig(file).buttons.at(-1).mode, 'send', '省略 mode = send')

    // add 非法：缺文字 → 报错且不改文件
    const before = readFileSync(file, 'utf8')
    const bad = runButtonsAction({ action: 'add', button: { label: '空的', text: '' } })
    assert.equal(bad.ok, false)
    assert.equal(bad.error, 'bad-buttons')
    assert.equal(readFileSync(file, 'utf8'), before, '校验失败不得写盘')

    // remove 按标签
    const removed = runButtonsAction({ action: 'remove', label: '跑测试' })
    assert.equal(removed.ok, true, JSON.stringify(removed))
    assert.equal(removed.removed.label, '跑测试')
    assert.equal(loadConfig(file).buttons.length, DEFAULT_BUTTONS.length)

    // remove 不存在 → not-found
    assert.equal(runButtonsAction({ action: 'remove', label: '根本没有' }).error, 'not-found')

    // 同名歧义 → ambiguous，且提示给 index
    runButtonsAction({ action: 'add', button: { label: '重名', text: 'a' } })
    runButtonsAction({ action: 'add', button: { label: '重名', text: 'b' } })
    const ambiguous = runButtonsAction({ action: 'remove', label: '重名' })
    assert.equal(ambiguous.error, 'ambiguous')
    const byIndex = runButtonsAction({ action: 'remove', index: loadConfig(file).buttons.findIndex((b) => b.label === '重名') })
    assert.equal(byIndex.ok, true, JSON.stringify(byIndex))
    assert.equal(loadConfig(file).buttons.filter((b) => b.label === '重名').length, 1)

    // save：整表覆盖（只留一条）
    const saved = runButtonsAction({ action: 'save', buttons: [{ label: '唯一', text: '只有我', mode: 'insert' }] })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    const after = loadConfig(file).buttons
    assert.equal(after.length, 1)
    assert.equal(after[0].label, '唯一')
    assert.equal(after[0].mode, 'insert')
    assert.equal(after[0].side, 'left', 'insert 默认在左')

    // 未知 action
    assert.equal(runButtonsAction({ action: 'nope' }).error, 'unknown-action')
  })
})

test('工具：apply 注册 dsh_button，execute 直通 runButtonsAction', async () => {
  await withConfigFile(async () => {
    const registered = []
    const ctx = {
      get: (name) => (name === 'tools' ? { register: (definition) => { registered.push(definition); return () => {} } } : undefined),
      effect: (fn) => fn(),
    }
    applyTools(ctx)
    assert.equal(registered.length, 1, '应当注册一个工具')
    const tool = registered[0]
    assert.equal(tool.name, 'dsh_button')
    assert.equal(tool.parameters.properties.action.enum.join(','), 'list,add,remove,save')
    assert.equal(tool.parameters.properties.button.required.join(','), 'label,text')

    const value = await tool.execute({ action: 'list' })
    assert.equal(value.ok, true)
    assert.equal(value.buttons.length, DEFAULT_BUTTONS.length)

    // 渲染出来是一段文本（不是 undefined）
    const rendered = tool.output.render({ action: 'list' }, value)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /button\(s\)/)

    // 没有 tools 服务时不注册、不抛
    const silent = []
    applyTools({ get: () => undefined, effect: (fn) => fn() })
    assert.equal(silent.length, 0)
  })
})
