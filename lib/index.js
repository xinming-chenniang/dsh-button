/**
 * dsh-button —— 宿主半部。
 *
 * v1.2.2：只保留「自定义按钮」的配置读写（`GET/POST /api/dsh-button/buttons`）。
 * **「收口」已删除**：它 spawn 外部 `closeout` CLI，对没装该 CLI 的用户是坏格子；
 * 需要类似能力时，自己配一条自定义按钮把文字发给会话即可。
 *
 * 为什么配置要放在宿主：renderer 没有文件系统权限，配置又要能**手改、备份、跨端共用**，
 * 所以唯一事实源是一个 JSON 文件（见 `lib/buttons.js`），客户端只经这条路由读写它。
 *
 * 路由受 loopback + 同源双重限制（抄自 dsh-plugin-restart 的做法）；不碰凭据、不出外网。
 */
import { ROUTE as BUTTONS_ROUTE, loadConfig, saveConfig, validateConfig } from './buttons.js'

/** 稳定插件名（必须与 `cordis.patch.yml` 的 insert id 一致）。 */
export const name = 'dsh-button'

/** 宿主侧需要 webServer 来注册路由。 */
export const inject = ['webServer']

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
 * 只接受**本机 + 同源**的请求。`methods` 是允许的方法（默认只 POST）。
 * 同源判断不能省：浏览器里任何页面都能向 127.0.0.1 发请求，Origin 头是唯一能区分"谁发起的"的东西。
 */
function guard(req, res, methods = ['POST']) {
  const addr = req.socket?.remoteAddress ?? ''
  if (!LOOPBACK.test(addr)) {
    writeJson(res, 403, { ok: false, code: 'forbidden', message: 'dsh-button routes are loopback-only' })
    return false
  }
  if (!methods.includes(req.method)) {
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

export function apply(ctx) {
  /** 自定义按钮配置：读（GET）/ 写（POST）。 */
  const buttonsHandler = async (req, res) => {
    if (!guard(req, res, ['GET', 'POST'])) return
    if (req.method === 'GET') {
      const loaded = loadConfig()
      if (!loaded.ok) {
        writeJson(res, 500, { ok: false, code: 'bad-config', message: loaded.message })
        return
      }
      writeJson(res, 200, { ok: true, buttons: loaded.buttons, hidden: loaded.hidden, presets: loaded.presets, defaults: loaded.exists === false, path: loaded.path })
      return
    }
    const body = await readJsonBody(req)
    const checked = validateConfig(body)
    if (!checked.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-buttons', message: checked.message })
      return
    }
    const saved = saveConfig(checked.buttons, checked.hidden, checked.presets)
    if (!saved.ok) {
      writeJson(res, 500, { ok: false, code: 'write-failed', message: saved.message })
      return
    }
    writeJson(res, 200, { ok: true, buttons: checked.buttons, hidden: checked.hidden, presets: checked.presets, defaults: false, path: saved.path })
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: BUTTONS_ROUTE, handler: buttonsHandler }),
    'dsh-button: buttons route',
  )
}

export default { name, inject, apply }
