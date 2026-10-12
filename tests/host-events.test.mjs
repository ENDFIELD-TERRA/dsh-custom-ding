import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/host/entry-native.mjs'

// Use the host event dispatcher, plugin lifecycle, and configuration schema.
// Only OS processes and the root registry are replaced at their service seams.
async function fixture(t, { planMode } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ding-events-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const spawned = []
  const events = []
  const root = { id: 'main', session: {
    header: { cwd: home },
    get seq() { return events.length },
    eventAt: seq => events[seq],
  } }
  let route, fiber, server
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    await fiber?.dispose()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })
  ctx.provide('subprocess', { spawn(spec) {
    spawned.push(spec)
    return { done: Promise.resolve({ exitCode: 0 }), kill() {} }
  } })
  ctx.provide('agents', { roots: () => [root] })
  ctx.provide('webServer', { register(value) { route = value; return () => {} } })
  if (planMode) ctx.provide('planMode', planMode)

  let approvalAnswers = 0
  // A UI answerer handles the request without delegating to the next listener.
  ctx.on('approval/request', async () => { approvalAnswers++; return 'approved' })
  const ready = Promise.withResolvers()
  fiber = ctx.plugin({ ...plugin, async apply(scope, config) {
    try {
      const dispose = await plugin.apply(scope, config)
      ready.resolve()
      return dispose
    } catch (error) { ready.reject(error); throw error }
  } }, { debounceMs: 100 })
  await ready.promise

  server = createServer((req, res) => route.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/custom-ding/api`
  return {
    ctx, root, events, spawned,
    get approvalAnswers() { return approvalAnswers },
    async request(path, body) {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result))
      return result
    },
    emit(name, payload) { ctx.emit(root, name, { agent: root, ...payload }) },
    stop(turn) { return ctx.serial(root, 'agent/turn-stopping', { agent: root, turn }) },
    approve(subject = root) {
      return ctx.waterfall(subject, 'approval/request', { agent: subject }, () => 'unavailable')
    },
  }
}

function outputKinds(spawned) {
  return spawned.map(({ argv }) => {
    const command = argv.includes('-EncodedCommand')
      ? Buffer.from(argv.at(-1), 'base64').toString('utf16le')
      : argv.join(' ')
    return /ToastNotification|notify-send|gdbus|osascript/.test(command) ? 'popup' : 'sound'
  }).sort()
}

test('a command followed by a same-turn message still sends both notifications', async t => {
  const app = await fixture(t)
  await app.request('/notifications', { enabled: true })
  await app.request('/preview', { kind: 'done' })
  await app.request('/notification-preview', {})
  assert.deepEqual(outputKinds(app.spawned), ['popup', 'sound'])
  app.spawned.length = 0

  app.emit('agent/inbox/claimed', { turn: 1 })
  app.emit('tools/result', { name: 'pwsh' })
  app.emit('agent/inbox/claimed', { turn: 1 })
  await app.stop(1)
  assert.deepEqual(outputKinds(app.spawned), ['popup', 'sound'])

  app.emit('agent/inbox/claimed', { turn: 2 })
  app.emit('tools/result', { name: 'read' })
  await app.stop(2)
  assert.equal(app.spawned.length, 2, 'a later conversation without execution stays quiet')
})

test('an approval popup arrives even when the UI handles the request first', async t => {
  const app = await fixture(t)
  await app.request('/notifications', { enabled: true })
  assert.equal(await app.approve(), 'approved')
  assert.equal(app.approvalAnswers, 1, 'the notification does not replace the UI answer')
  assert.deepEqual(outputKinds(app.spawned), ['popup', 'sound'])
})

test('background approval requests do not interrupt the main conversation', async t => {
  const app = await fixture(t)
  await app.request('/notifications', { enabled: true })
  assert.equal(await app.approve({ id: 'child' }), 'approved')
  assert.deepEqual(app.spawned, [])
})

test('finishing a plan reads the current host plan-mode service', async t => {
  const app = await fixture(t, { planMode: { get: () => ({ active: true }) } })
  await app.request('/notifications', { enabled: true })
  app.emit('agent/inbox/claimed', { turn: 1 })
  await app.stop(1)
  assert.deepEqual(outputKinds(app.spawned), ['popup', 'sound'])
})

test('plan completion sees a service that becomes available after plugin activation', async t => {
  const app = await fixture(t)
  app.ctx.provide('planMode', { get: () => ({ active: true }) })
  await app.request('/notifications', { enabled: true })
  app.emit('agent/inbox/claimed', { turn: 1 })
  await app.stop(1)
  assert.deepEqual(outputKinds(app.spawned), ['popup', 'sound'])
})

test('plan completion works from the session event log without the plan-mode service', async t => {
  const app = await fixture(t)
  await app.request('/notifications', { enabled: true })
  app.events.push({ type: 'plan/mode', data: { active: true } })
  app.emit('agent/inbox/claimed', { turn: 1 })
  await app.stop(1)
  assert.deepEqual(outputKinds(app.spawned), ['popup', 'sound'])
})

test('leaving plan mode keeps a later ordinary conversation quiet', async t => {
  const app = await fixture(t)
  await app.request('/notifications', { enabled: true })
  app.events.push(
    { type: 'plan/mode', data: { active: true } },
    { type: 'plan/mode', data: { active: false } },
  )
  app.emit('agent/inbox/claimed', { turn: 1 })
  await app.stop(1)
  assert.deepEqual(app.spawned, [])
})

test('questions and errors notify through host events while child events stay quiet', async t => {
  const app = await fixture(t)
  await app.request('/notifications', { enabled: true })
  const result = await app.ctx.waterfall(app.root, 'tools/execute', { agent: app.root, name: 'ask_user_question' }, () => 'answered')
  assert.equal(result, 'answered')
  assert.deepEqual(outputKinds(app.spawned), ['popup', 'sound'])
  app.emit('agent/error', { agent: { id: 'child' } })
  assert.equal(app.spawned.length, 2)
  app.emit('agent/error', { error: new Error('test failure') })
  assert.deepEqual(outputKinds(app.spawned), ['popup', 'popup', 'sound', 'sound'])
})
