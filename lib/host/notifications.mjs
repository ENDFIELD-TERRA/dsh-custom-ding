import { win32 } from 'node:path'
import { KIND_LABELS, KINDS } from '../core/kinds.mjs'
import { encodePowerShellCommand } from './engine.mjs'

const CANCELLED = Symbol('cancelled')
const SEND_TIMEOUT_MS = 10000
const PLATFORM_HELP = {
  win32: '请检查 Windows 系统通知权限，并确认已安装 DSH 桌面版或 Windows PowerShell。',
  darwin: '请在 macOS 桌面会话中运行，并检查系统设置中的通知权限与专注模式。',
  linux: '请安装 notify-send（libnotify）或 gdbus（GLib），并连接桌面会话的 D-Bus 通知服务。',
}

function windowsDirectory(env) {
  const root = env.SystemRoot || env.WINDIR
  return typeof root === 'string' && /^[a-z]:[\\/]/i.test(root) ? root : 'C:\\Windows'
}

function notificationError(platform, code, message, cause) {
  return Object.assign(new Error(`${message}。${PLATFORM_HELP[platform] ?? ''}`, { cause }), {
    code,
    status: code === 'notification-timeout' ? 504 : code === 'notification-unavailable' ? 503 : 502,
  })
}

/** Only fixed, local status labels enter the system notification. */
export function notificationCommand(platform, kind, { env = process.env } = {}) {
  if (!KINDS.includes(kind)) throw new TypeError('Unknown notification kind')
  const title = 'DeepSeek Harness'
  const message = KIND_LABELS[kind]
  if (platform === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast duration="short"><visual><binding template="ToastGeneric"><text>${title}</text><text>${message}</text></binding></visual><audio silent="true"/></toast>')
$app = Get-StartApps | Where-Object { $_.AppID -eq 'com.deepseek.dsh' } | Select-Object -First 1
if (-not $app) { $app = Get-StartApps | Where-Object { $_.AppID -like '*WindowsPowerShell*v1.0*powershell.exe' } | Select-Object -First 1 }
if (-not $app) { throw 'No registered notification application is available' }
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app.AppID)
if ($null -ne $notifier.Setting -and $notifier.Setting -ne 'Enabled') { throw 'System notifications are disabled for this application' }
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Group = 'custom-ding'
$toast.Tag = '${kind}'
$notifier.Show($toast)
`
    const powershell = win32.join(windowsDirectory(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    // The subprocess host owns console visibility, as it does for sound playback.
    return [powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)]
  }
  if (platform === 'darwin') return ['/usr/bin/osascript', '-e', `display notification "${message}" with title "${title}"`]
  if (platform === 'linux') return ['notify-send', '--app-name=DeepSeek Harness', '--expire-time=5000', '--hint=boolean:suppress-sound:true', title, message]
  throw new Error('当前系统不支持弹窗通知')
}

/** The second Linux sender is used only when the first executable is missing. */
export function notificationCommands(platform, kind, options) {
  const primary = notificationCommand(platform, kind, options)
  if (platform !== 'linux') return [primary]
  return [primary, [
    'gdbus', 'call', '--session', '--timeout', '5',
    '--dest', 'org.freedesktop.Notifications',
    '--object-path', '/org/freedesktop/Notifications',
    '--method', 'org.freedesktop.Notifications.Notify',
    'DeepSeek Harness', '0', '', 'DeepSeek Harness', KIND_LABELS[kind],
    '[]', "{'suppress-sound': <true>}", '5000',
  ]]
}

export function createNotifier({ platform, spawn, debounceMs, now = Date.now, logger = console, env = process.env, timeoutMs = SEND_TIMEOUT_MS }) {
  const lastShown = new Map()
  const active = new Set()
  let disposed = false
  const supported = Object.hasOwn(PLATFORM_HELP, platform)
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, SEND_TIMEOUT_MS) : SEND_TIMEOUT_MS

  const stop = handle => {
    try { Promise.resolve(handle?.kill?.()).catch(error => logger.warn('Could not stop a notification process', error)) }
    catch (error) { logger.warn('Could not stop a notification process', error) }
  }

  function run(argv) {
    return new Promise((resolve, reject) => {
      let handle
      let timer
      let settled = false
      const operation = { cancel: () => { finish(null, CANCELLED); stop(handle) } }
      function finish(error, outcome) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        active.delete(operation)
        if (error) reject(error)
        else resolve(outcome)
      }
      try {
        handle = spawn(argv, { cwd: platform === 'win32' ? windowsDirectory(env) : '/', graceMs: limit })
        if (typeof handle?.done?.then !== 'function') {
          finish(notificationError(platform, 'notification-unconfirmed', '无法确认通知是否发送'))
          stop(handle)
          return
        }
        active.add(operation)
        timer = setTimeout(() => {
          finish(notificationError(platform, 'notification-timeout', '通知发送超时'))
          stop(handle)
        }, limit)
        Promise.resolve(handle.done).then(outcome => finish(null, outcome), error => finish(error))
        if (disposed) operation.cancel()
      } catch (error) { finish(error) }
    })
  }

  return {
    supported,
    async notify(kind, { force = false } = {}) {
      if (disposed || !supported || !KINDS.includes(kind)) return false
      const stamp = now()
      if (!force && lastShown.has(kind) && stamp - lastShown.get(kind) < debounceMs) return false
      if (!force) lastShown.set(kind, stamp)
      const commands = notificationCommands(platform, kind, { env })
      for (let index = 0; index < commands.length; index++) {
        if (disposed) return false
        try {
          const outcome = await run(commands[index])
          if (outcome === CANCELLED) return false
          if (outcome?.exitCode === 0 && !outcome.signal) return true
          if (outcome?.exitCode === 127 && !outcome.signal) {
            throw Object.assign(new Error('Notification command not found'), { code: 'ENOENT' })
          }
          throw notificationError(platform, 'notification-failed', '系统未能确认通知发送成功', outcome)
        } catch (error) {
          const missing = error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT'
          if (missing && index + 1 < commands.length) continue
          if (typeof error?.code === 'string' && error.code.startsWith('notification-')) throw error
          throw notificationError(platform, missing ? 'notification-unavailable' : 'notification-failed', '系统未能发送弹窗通知', error)
        }
      }
      return false
    },
    dispose() {
      disposed = true
      for (const operation of active) operation.cancel()
    },
  }
}
