/**
 * dsh-button —— 宿主半部。
 *
 * v0.5：从「收尾按钮」独立成「输入框按钮」插件；「收口」面板可选依赖 dsh-closeout。
 * 客户端算不出 git 与磁盘事实（renderer 里没有进程与文件系统），
 * 所以真正跑检查的是这里：宿主侧起一条 loopback 路由，客户端点按钮时 POST 过来，
 * 这里 spawn `closeout --json`，把结构化结果原样交回去。
 *
 * 为什么走路由而不是客户端直接跑命令：
 *   - 客户端插件只有 slots / locale / sessions / conversation 这几个公开服务，没有进程权限；
 *   - 宿主插件能起子进程，但要给客户端一个**可控**的入口 —— 路由就是那个入口，
 *     而且它受同源 + loopback 双重限制（抄自 dsh-plugin-restart 的做法）。
 *
 * 刻意不做的事：不写文件（交接件仍由 CLI 的 --handoff 生成）、不碰凭据、不出外网。
 *
 * 怎么找到 `closeout`：
 *   1. 环境变量 `DSH_CLOSEOUT_BIN`（可指向 .cmd/.exe，或 .mjs —— 后者会用当前 node 跑）；
 *   2. 否则用 PATH 里的 `closeout`（`npm link` / `npm i -g` 之后就有）。
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const execAsync = promisify(exec)

/** 稳定插件名（必须与 `cordis.patch.yml` 的 insert id 一致）。 */
export const name = 'dsh-button'

/** 宿主侧需要 webServer 来注册路由。 */
export const inject = ['webServer']

const ROUTE = '/api/dsh-closeout'
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 只接受**本机 + 同源**的 POST。
 * 同源判断不能省：浏览器里任何页面都能向 127.0.0.1 发请求，Origin 头是唯一能区分"谁发起的"的东西。
 */
function guard(req, res) {
  const addr = req.socket?.remoteAddress ?? ''
  if (!LOOPBACK.test(addr)) {
    writeJson(res, 403, { ok: false, code: 'forbidden', message: 'closeout routes are loopback-only' })
    return false
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `method not allowed: ${req.method ?? ''}` })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let host = null
    try {
      host = new URL(origin).host
    } catch {
      host = null
    }
    if (host === null || host !== req.headers.host) {
      writeJson(res, 403, { ok: false, code: 'cross-origin', message: 'cross-origin request rejected' })
      return false
    }
  }
  return true
}

/** 读一个**有上限**的 JSON body；空体返回 null。 */
async function readJsonBody(req, maxBytes = 16 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.destroy()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 只接受"存在的目录"，其它一律当没给 —— 不把客户端送来的任意路径直接塞给 spawn 的 cwd。 */
function pickCwd(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const p = resolve(raw)
    return existsSync(p) && statSync(p).isDirectory() ? p : null
  } catch {
    return null
  }
}

/** 会话 id 白名单：只允许 `session-` + uuid 形态。它会被拼进命令行，所以别的一律当没给。 */
function pickSessionId(raw) {
  if (typeof raw !== 'string') return null
  return /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : null
}

/** 拼出运行命令：.mjs/.js 用当前 node 跑，其余当作可执行命令名。 */
function buildCommand(sessionId) {
  const bin = process.env.DSH_CLOSEOUT_BIN || 'closeout'
  const asScript = /\.(mjs|cjs|js)$/i.test(bin)
  const head = asScript ? `"${process.execPath}" "${bin}"` : `"${bin}"`
  // sessionId 已经过正则白名单（只允许 session- 加十六进制与连字符），可以直接拼进命令行。
  const tail = sessionId ? ` --session "${sessionId}" --cwd-from-session` : ''
  return `${head} --json --zh${tail}`
}

/** 跑一次检查；超时 30 秒、输出上限 4 MB（临时目录很脏时 JSON 会大）。 */
async function runCloseout(cwd, sessionId) {
  return execAsync(buildCommand(sessionId), {
    cwd,
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
}

export function apply(ctx) {
  const checkHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const cwd = pickCwd(body?.cwd)
    // 桌面端客户端拿不到 cwd（事件窗口里没有 session 头事件），只交会话 id；
    // 那就让 closeout 自己去会话库取 cwd（--cwd-from-session）。
    const sessionId = pickSessionId(body?.sessionId)
    if (cwd === null && sessionId === null) {
      writeJson(res, 400, { ok: false, code: 'bad-cwd', message: 'cwd must be an existing directory (or pass sessionId)' })
      return
    }
    const started = Date.now()
    try {
      const { stdout } = await runCloseout(cwd ?? process.cwd(), sessionId)
      const value = JSON.parse(stdout)
      writeJson(res, 200, { ok: true, value, meta: { cwd, sessionId, ms: Date.now() - started } })
    } catch (e) {
      // 把 stderr 带回去：最常见的失败是 PATH 里没有 closeout（没装 / 没 link）
      const reason = String(e?.stderr || e?.message || e)
      writeJson(res, 502, { ok: false, code: 'closeout-failed', message: reason })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${ROUTE}/check`, handler: checkHandler }),
    'dsh-closeout-button: check route',
  )
}

export default { name, inject, apply }
