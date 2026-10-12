import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { activateHost } from '../lib/host/activate.mjs'

async function fixture(t, directory) {
  const home = directory ?? await mkdtemp(join(tmpdir(), 'ding-settings-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const callbacks = new Map()
  const spawned = []
  const root = { id: 'main', session: { header: { cwd: home }, events: [] } }
  let route
  const services = {
    subprocess: { spawn(spec) { spawned.push(spec); return { done: Promise.resolve({ exitCode: 0 }), kill() {} } } },
    agents: { roots: () => [root] },
    webServer: { register(value) { route = value; return () => {} } },
  }
  const ctx = {
    get: name => services[name],
    on(name, callback) { callbacks.set(name, callback) },
    effect: factory => factory(),
    logger: () => ({ warn() {}, error() {}, info() {} }),
  }
  const dispose = await activateHost(ctx, { debounceMs: 0 })
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/perlica-ding/api`
  const request = async (path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await new Promise(resolve => server.close(resolve))
    await dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  t.after(async () => { await close(); if (!directory) await rm(home, { recursive: true, force: true }) })
  return { home, request, spawned, root, close, emit: (name, ...args) => callbacks.get(name)?.(...args) }
}

test('popup notifications start off, work while muted, and stop after switching off', async t => {
  const app = await fixture(t)
  assert.equal((await app.request('/state')).body.notificationsEnabled, false)
  await app.request('/volume', { volume: 0 })
  app.emit('agent/error', { agent: app.root })
  assert.equal(app.spawned.length, 0)
  assert.equal((await app.request('/notifications', { enabled: true })).status, 200)
  app.emit('agent/error', { agent: { id: 'child' } })
  assert.equal(app.spawned.length, 0, 'background work does not produce a popup')
  app.emit('agent/error', { agent: app.root })
  assert.equal(app.spawned.length, 1, 'a main conversation error requests a system popup even when muted')
  assert.equal((await app.request('/notifications', { enabled: false })).status, 200)
  app.emit('agent/error', { agent: app.root })
  assert.equal(app.spawned.length, 1)
})

test('an uploaded sound is used for previews, survives restart, and can be reset', async t => {
  const app = await fixture(t)
  const original = await readFile(new URL('../sounds/done.wav', import.meta.url))
  const upload = await app.request('/sound', { kind: 'done', name: '我的完成提示.wav', audio: original.toString('base64') })
  assert.equal(upload.status, 200)
  assert.equal(upload.body.sounds.done.name, '我的完成提示.wav')
  await app.request('/notifications', { enabled: true })
  await app.close()
  const restarted = await fixture(t, app.home)
  const state = (await restarted.request('/state')).body
  assert.equal(state.notificationsEnabled, true)
  assert.equal(state.sounds.done.name, '我的完成提示.wav')
  assert.equal((await restarted.request('/preview', { kind: 'done' })).status, 200)
  const command = restarted.spawned[0].argv
  const source = process.platform === 'win32'
    ? Buffer.from(command.at(-1), 'base64').toString('utf16le').match(/SoundPlayer '([^']+)'/)[1]
    : command.at(-1)
  assert.deepEqual(await readFile(source), original)
  assert.ok(source.startsWith(app.home), 'playback uses the uploaded copy')
  assert.equal((await restarted.request('/sound', { kind: 'done', reset: true })).status, 200)
  assert.deepEqual((await restarted.request('/state')).body.sounds, {})
  await restarted.close()
})

test('invalid audio and unsafe sound names cannot replace a saved sound', async t => {
  const app = await fixture(t)
  const original = await readFile(new URL('../sounds/ask.wav', import.meta.url))
  assert.equal((await app.request('/sound', { kind: 'ask', name: 'ask.wav', audio: original.toString('base64') })).status, 200)
  for (const body of [
    { kind: '../state', name: 'ask.wav', audio: original.toString('base64') },
    { kind: 'ask', name: 'bad.wav', audio: Buffer.from('not a wave').toString('base64') },
    { kind: 'ask', name: 'bad.wav', audio: original.subarray(0, 30).toString('base64') },
    { kind: 'ask', name: 'bad.wav', audio: '!!invalid!!' },
  ]) assert.equal((await app.request('/sound', body)).status, 400)
  assert.equal((await app.request('/state')).body.sounds.ask.name, 'ask.wav')
  assert.equal((await app.request('/notifications', { enabled: 'true' })).status, 400)
  assert.equal((await app.request('/sound', { kind: 'ask', reset: true }, { origin: 'https://untrusted.example' })).status, 403)
})

test('concurrent sound and notification changes survive together', async t => {
  const app = await fixture(t)
  const wav = (await readFile(new URL('../sounds/done.wav', import.meta.url))).toString('base64')
  const results = await Promise.all([
    app.request('/sound', { kind: 'done', name: 'done.wav', audio: wav }),
    app.request('/sound', { kind: 'plan', name: 'plan.wav', audio: wav }),
    app.request('/notifications', { enabled: true }),
  ])
  for (const result of results) assert.equal(result.status, 200)
  await app.close()
  const restarted = await fixture(t, app.home)
  const state = (await restarted.request('/state')).body
  assert.deepEqual(Object.keys(state.sounds).sort(), ['done', 'plan'])
  assert.equal(state.notificationsEnabled, true)
  await restarted.close()
})
