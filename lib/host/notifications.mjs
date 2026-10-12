import { KIND_LABELS, KINDS } from '../core/kinds.mjs'
import { encodePowerShellCommand } from './engine.mjs'

const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Only fixed, local status labels enter the system notification. */
export function notificationCommand(platform, kind) {
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
$toast.Group = 'perlica-ding'
$toast.Tag = '${kind}'
$notifier.Show($toast)
`
    return [WINDOWS_POWERSHELL, '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePowerShellCommand(script)]
  }
  if (platform === 'darwin') return ['/usr/bin/osascript', '-e', `display notification "${message}" with title "${title}"`]
  if (platform === 'linux') return ['notify-send', '--app-name=DeepSeek Harness', '--expire-time=5000', '--hint=boolean:suppress-sound:true', title, message]
  throw new Error('当前系统不支持弹窗通知')
}

export function createNotifier({ platform, spawn, debounceMs, now = Date.now, logger = console }) {
  const lastShown = new Map()
  const active = new Set()
  let disposed = false
  const supported = ['win32', 'darwin', 'linux'].includes(platform)
  return {
    supported,
    notify(kind, { force = false } = {}) {
      if (disposed || !supported || !KINDS.includes(kind)) return Promise.resolve(false)
      const stamp = now()
      if (!force && lastShown.has(kind) && stamp - lastShown.get(kind) < debounceMs) return Promise.resolve(false)
      if (!force) lastShown.set(kind, stamp)
      let handle
      try {
        handle = spawn(notificationCommand(platform, kind), { cwd: platform === 'win32' ? 'C:\\Windows' : '/', graceMs: 10000 })
        active.add(handle)
      } catch (error) { return Promise.reject(error) }
      return Promise.resolve(handle?.done).then(outcome => {
        if (typeof outcome?.exitCode === 'number' && outcome.exitCode !== 0) {
          throw new Error('系统未能发送弹窗通知，请检查系统通知设置及通知服务')
        }
        return true
      }).finally(() => active.delete(handle))
    },
    dispose() {
      disposed = true
      for (const handle of active) {
        try { Promise.resolve(handle?.kill?.()).catch(error => logger.warn('Could not stop a notification process', error)) }
        catch (error) { logger.warn('Could not stop a notification process', error) }
      }
      active.clear()
    },
  }
}
