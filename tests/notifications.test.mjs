import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNotifier, notificationCommand } from '../lib/host/notifications.mjs'

test('duplicate status popups are limited independently and a preview does not delay real events', async () => {
  const shown = []
  let clock = 0
  const notifier = createNotifier({
    platform: 'linux', debounceMs: 2500, now: () => clock,
    spawn: argv => { shown.push(argv); return { done: Promise.resolve({ exitCode: 0 }) } },
  })
  assert.equal(await notifier.notify('done', { force: true }), true)
  assert.equal(await notifier.notify('done'), true)
  assert.equal(await notifier.notify('done'), false)
  assert.equal(await notifier.notify('ask'), true)
  clock = 2500
  assert.equal(await notifier.notify('done'), true)
  assert.equal(shown.length, 4)
  assert.equal(shown[2].at(-1), '需要你回应')
})

test('system notification failures reach the caller', async () => {
  for (const spawn of [
    () => { throw new Error('not installed') },
    () => ({ done: Promise.reject(new Error('cannot launch')) }),
    () => ({ done: Promise.resolve({ exitCode: 1 }) }),
  ]) {
    const notifier = createNotifier({ platform: 'linux', spawn })
    await assert.rejects(notifier.notify('done'))
  }
})

test('deactivation stops pending notification processes and prevents new ones', async () => {
  let stopped = 0
  let settle
  const notifier = createNotifier({
    platform: 'win32',
    spawn: () => ({ done: new Promise(resolve => { settle = resolve }), kill() { stopped++ } }),
  })
  const pending = notifier.notify('plan')
  notifier.dispose()
  assert.equal(stopped, 1)
  assert.equal(await notifier.notify('done'), false)
  settle({ exitCode: 0 })
  await pending
})

test('unsupported platforms and unknown scenes never launch a process', async () => {
  const notifier = createNotifier({ platform: 'unknown', spawn: () => assert.fail('must not launch') })
  assert.equal(notifier.supported, false)
  assert.equal(await notifier.notify('done'), false)
  assert.throws(() => notificationCommand('win32', 'unknown'))
})

test('Windows notifications use the configured system directory', () => {
  const command = notificationCommand('win32', 'ask', { env: { SystemRoot: 'D:\\Windows' } })
  assert.equal(command[0], 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.ok(!command.includes('-WindowStyle'), 'the subprocess host controls window visibility')
  const script = Buffer.from(command.at(-1), 'base64').toString('utf16le')
  assert.ok(script.includes('需要你回应'))
  assert.ok(script.includes('<audio silent="true"/>'))
})

test('macOS submits each status to Notification Center without another sound', async () => {
  const shown = []
  const notifier = createNotifier({
    platform: 'darwin',
    spawn: (argv, options) => { shown.push({ argv, options }); return { done: Promise.resolve({ exitCode: 0 }) } },
  })
  for (const kind of ['plan', 'done', 'ask', 'fail']) assert.equal(await notifier.notify(kind), true)
  assert.equal(shown.length, 4)
  assert.equal(shown[0].argv[0], '/usr/bin/osascript')
  assert.match(shown[0].argv[2], /display notification "计划出方案" with title "DeepSeek Harness"/)
  for (const request of shown) {
    assert.equal(request.options.cwd, '/')
    assert.ok(!request.argv.join(' ').includes('sound name'))
  }
})

test('Linux uses the desktop D-Bus service when notify-send is not installed', async () => {
  for (const failure of ['throw', 'reject', 'exit']) {
    const shown = []
    const notifier = createNotifier({
      platform: 'linux',
      spawn: argv => {
        shown.push(argv)
        if (argv[0] === 'notify-send') {
          const error = Object.assign(new Error('not found'), { code: 'ENOENT' })
          if (failure === 'throw') throw error
          return { done: failure === 'reject' ? Promise.reject(error) : Promise.resolve({ exitCode: 127 }) }
        }
        return { done: Promise.resolve({ exitCode: 0 }) }
      },
    })
    assert.equal(await notifier.notify('ask'), true)
    assert.equal(shown.length, 2)
    const fallback = shown[1]
    assert.equal(fallback[0], 'gdbus')
    assert.ok(fallback.includes('--session'))
    assert.ok(fallback.includes('org.freedesktop.Notifications.Notify'))
    assert.deepEqual(fallback.slice(-8), ['DeepSeek Harness', '0', '', 'DeepSeek Harness', '需要你回应', '[]', "{'suppress-sound': <true>}", '5000'])
  }
})

test('Linux does not try a second sender after the notification service refuses the first', async () => {
  const shown = []
  const notifier = createNotifier({
    platform: 'linux',
    spawn: argv => { shown.push(argv); return { done: Promise.resolve({ exitCode: 1 }) } },
  })
  await assert.rejects(notifier.notify('done'), /D-Bus/)
  assert.equal(shown.length, 1)
})

test('missing Linux senders produce an actionable error', async () => {
  const notifier = createNotifier({
    platform: 'linux',
    spawn: () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }) },
  })
  await assert.rejects(notifier.notify('done'), error => error.code === 'notification-unavailable' && /notify-send.*gdbus/.test(error.message))
})

test('terminated processes and missing outcomes are never reported as sent', async () => {
  for (const outcome of [undefined, {}, { exitCode: null }, { exitCode: 0, signal: 'SIGTERM' }]) {
    const notifier = createNotifier({ platform: 'darwin', spawn: () => ({ done: Promise.resolve(outcome) }) })
    await assert.rejects(notifier.notify('done'))
  }
})

test('a stalled sender times out, stops its process and allows a manual retry', async () => {
  let stopped = 0
  let attempts = 0
  let guard
  const notifier = createNotifier({
    platform: 'linux', timeoutMs: 5,
    spawn: () => ({
      done: ++attempts === 1 ? new Promise(() => {}) : Promise.resolve({ exitCode: 0 }),
      kill() { stopped++ },
    }),
  })
  try {
    const result = await Promise.race([
      notifier.notify('done').then(() => 'sent', error => error.code),
      new Promise(resolve => { guard = setTimeout(() => resolve('still waiting'), 100) }),
    ])
    assert.equal(result, 'notification-timeout')
    assert.equal(stopped, 1)
    assert.equal(await notifier.notify('done', { force: true }), true)
  } finally { clearTimeout(guard); notifier.dispose() }
})

test('deactivation cancels a pending send before it can report success', async () => {
  let settle
  const notifier = createNotifier({
    platform: 'darwin',
    spawn: () => ({ done: new Promise(resolve => { settle = resolve }), kill() {} }),
  })
  const pending = notifier.notify('done')
  notifier.dispose()
  settle({ exitCode: 0 })
  assert.equal(await pending, false)
})
