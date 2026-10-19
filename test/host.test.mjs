/**
 * 宿主半部的路由测试（不启动 DSH、不依赖真实的 closeout）。
 *
 * 做法：假 ctx（`webServer.register` 只记录）+ 假 req/res，直接调 handler；
 * `DSH_CLOSEOUT_BIN` 指向一个 stub 脚本，于是 spawn 那一环也被覆盖到，
 * 但整个测试只依赖 node 本身 —— CI 上不需要装 closeout。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** 假的 req：`readJsonBody` 需要一个 async iterable。 */
function fakeReq({ method = 'POST', body = undefined, addr = '127.0.0.1', host = '127.0.0.1:53579', origin } = {}) {
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

/** 假的 res：把 writeHead / end 的结果收集起来。 */
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

/** 起一个插件，返回注册出来的 handler。 */
function loadHandler() {
  let captured = null
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    webServer: {
      register: (opts) => {
        captured = opts
        return () => {}
      },
    },
  }
  apply(ctx)
  assert.ok(captured, '应当注册一条路由')
  assert.equal(captured.kind, 'exact')
  assert.equal(captured.path, '/api/dsh-closeout/check')
  return captured.handler
}

test('POST 本机同源：跑 stub 并原样返回它的 JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-host-'))
  const stub = join(dir, 'stub.mjs')
  writeFileSync(stub, 'process.stdout.write(JSON.stringify({verdict:"safe",must:[],glance:[],fine:[],skipped:[]}))\n')
  const prev = process.env.DSH_CLOSEOUT_BIN
  process.env.DSH_CLOSEOUT_BIN = stub
  try {
    const handler = loadHandler()
    const res = fakeRes()
    await handler(fakeReq({ body: { cwd: dir } }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.payload.ok, true)
    assert.equal(res.out.payload.value.verdict, 'safe')
    assert.equal(res.out.payload.meta.cwd, dir)
  } finally {
    if (prev === undefined) delete process.env.DSH_CLOSEOUT_BIN
    else process.env.DSH_CLOSEOUT_BIN = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非 loopback 地址一律 403', async () => {
  const handler = loadHandler()
  const res = fakeRes()
  await handler(fakeReq({ addr: '192.168.1.9', body: { cwd: process.cwd() } }), res)
  assert.equal(res.out.status, 403)
  assert.equal(res.out.payload.code, 'forbidden')
})

test('非 POST 一律 405', async () => {
  const handler = loadHandler()
  const res = fakeRes()
  await handler(fakeReq({ method: 'GET', body: undefined }), res)
  assert.equal(res.out.status, 405)
})

test('跨源请求（Origin 与 Host 不一致）403', async () => {
  const handler = loadHandler()
  const res = fakeRes()
  await handler(fakeReq({ origin: 'https://evil.example', body: { cwd: process.cwd() } }), res)
  assert.equal(res.out.status, 403)
  assert.equal(res.out.payload.code, 'cross-origin')
})

test('同源 Origin（与 Host 一致）放行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-host-'))
  const stub = join(dir, 'stub.mjs')
  writeFileSync(stub, 'process.stdout.write(JSON.stringify({verdict:"no-delete"}))\n')
  const prev = process.env.DSH_CLOSEOUT_BIN
  process.env.DSH_CLOSEOUT_BIN = stub
  try {
    const handler = loadHandler()
    const res = fakeRes()
    await handler(fakeReq({ origin: 'http://127.0.0.1:53579', body: { cwd: dir } }), res)
    assert.equal(res.out.status, 200)
  } finally {
    if (prev === undefined) delete process.env.DSH_CLOSEOUT_BIN
    else process.env.DSH_CLOSEOUT_BIN = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cwd 不存在 → 400（不把任意路径塞给 spawn）', async () => {
  const handler = loadHandler()
  const res = fakeRes()
  await handler(fakeReq({ body: { cwd: join(tmpdir(), 'definitely-not-here-xyz') } }), res)
  assert.equal(res.out.status, 400)
  assert.equal(res.out.payload.code, 'bad-cwd')
})

test('closeout 跑失败 → 502，并且把 stderr 带到 message 里', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-host-'))
  const stub = join(dir, 'boom.mjs')
  writeFileSync(stub, 'process.stderr.write("no such command")\nprocess.exit(3)\n')
  const prev = process.env.DSH_CLOSEOUT_BIN
  process.env.DSH_CLOSEOUT_BIN = stub
  try {
    const handler = loadHandler()
    const res = fakeRes()
    await handler(fakeReq({ body: { cwd: dir } }), res)
    assert.equal(res.out.status, 502)
    assert.match(String(res.out.payload.message), /no such command/)
  } finally {
    if (prev === undefined) delete process.env.DSH_CLOSEOUT_BIN
    else process.env.DSH_CLOSEOUT_BIN = prev
    rmSync(dir, { recursive: true, force: true })
  }
})
