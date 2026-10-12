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
