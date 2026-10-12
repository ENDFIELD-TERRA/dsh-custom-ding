/**
 * The native HTTP route behind the settings page.
 *
 * Evidence for the request shape (see ADR 0001 §4.5):
 *   - the desktop renderer's document origin is `dsh-app://app`;
 *   - `protocol.handle('dsh-app')` forwards every non-asset path to the harness
 *     HTTP carrier and, inside `forwardWebRequest`, DELETES `origin` and attaches
 *     the harness host cookie;
 *   - therefore "reject when Origin is missing" would kill the desktop path, and
 *     the rule below allows a missing Origin while allowlisting the two browser
 *     origins that can legitimately reach this route.
 *
 * The carrier owns authentication. These routes additionally restrict origins,
 * content type and body size. Uploaded sound names never become file paths;
 * only validated audio is stored in the plugin's own state directory.
 */

const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u
const MAX_BODY_BYTES = 8192
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 + MAX_BODY_BYTES

/** Whether a request may reach the handler, by Origin. */
export function originAllowed(origin) {
  if (origin === null || origin === undefined || origin === '') return true
  if (origin === 'dsh-app://app') return true
  return LOOPBACK_ORIGIN.test(origin)
}

/** Read a JSON body with a hard size cap. Returns undefined for an unparsable body. */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const declared = Number(req.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      resolve({ tooLarge: true })
      return
    }
    let size = 0
    const chunks = []
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish({ timeout: true }), 15000)
    timer.unref?.()
    req.on('data', (chunk) => {
      if (done) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > limit) {
        finish({ tooLarge: true })
        return
      }
      chunks.push(bytes)
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        finish({ value: parsed })
      } catch {
        finish({ invalid: true })
      }
    })
    req.on('error', () => finish({ invalid: true }))
    req.on('aborted', () => finish({ invalid: true }))
  })
}

/**
 * Build the `webServer.register` route descriptor.
 *
 * @param handlers - settings, sound import and preview operations.
 * @returns a prefix WebRoute for `/custom-ding/api`.
 */
export function nativeRoute(handlers) {
  return {
    kind: 'prefix',
    path: '/custom-ding/api',
    handler: async (req, res) => {
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(payload))
      }

      if (!originAllowed(req.headers?.origin ?? null)) {
        send(403, { error: 'origin not allowed' })
        return
      }

      const path = String(req.url || '').split('?')[0]
      const method = String(req.method || 'GET').toUpperCase()

      try {
        if (method === 'GET' && path === '/custom-ding/api/state') {
          send(200, await handlers.getState())
          return
        }

        const operations = {
          '/custom-ding/api/volume': body => handlers.setVolume(body?.volume),
          '/custom-ding/api/preview': body => handlers.preview(body?.kind),
          '/custom-ding/api/sound': body => handlers.setSound(body),
          '/custom-ding/api/notifications': body => handlers.setNotifications(body?.enabled),
          '/custom-ding/api/notification-preview': () => handlers.previewNotification(),
        }
        if (method === 'POST' && Object.hasOwn(operations, path)) {
          // Forces a CORS preflight for any cross-site caller; this carrier sends
          // no CORS headers, so a cross-site POST never reaches this handler.
          const contentType = String(req.headers?.['content-type'] || '').toLowerCase()
          if (!contentType.includes('application/json')) {
            send(415, { error: 'content-type must be application/json' })
            return
          }
          const body = await readJsonBody(req, path.endsWith('/sound') ? MAX_UPLOAD_BYTES : MAX_BODY_BYTES)
          if (body.timeout) {
            send(408, { error: 'request body timed out' })
            return
          }
          if (body.tooLarge) {
            send(413, { error: 'request body too large' })
            return
          }
          if (body.invalid) {
            send(400, { error: 'request body must be JSON' })
            return
          }

          send(200, await operations[path](body.value))
          return
        }

        send(404, { error: 'not found' })
      } catch (error) {
        // A failed write must never look like success (ADR 0001 §6). Handlers mark
        // caller mistakes with `status` (400/413); everything else is a 500.
        const status = Number.isInteger(error?.status) ? error.status : 500
        send(status, { error: String((error && error.message) || error) })
      }
    },
  }
}
