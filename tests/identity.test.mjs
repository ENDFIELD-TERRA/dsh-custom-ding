import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { activateHost } from '../lib/host/activate.mjs'

test('installation registers the custom plugin alongside the original plugin', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(await readFile(new URL('../dsh-plugin.json', import.meta.url), 'utf8'))
  const bundle = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.equal(pkg.name, 'dsh-custom-ding')
  assert.equal(manifest.id, 'terra.endfield.custom-ding')
  assert.match(bundle, /id: dsh-custom-ding\s+name: dsh-custom-ding/)
  assert.ok(manifest.permissions.every(permission => permission.scope === manifest.id))
  assert.ok(manifest.contributes['x-browser-ui'].every(item => item.id.startsWith(manifest.id + '.')))
})

test('both plugins retain their own browser module and settings page', async t => {
  const modules = new Map([['dsh-perlica-ding', { original: true }]])
  const sections = new Map([['perlica-ding', { original: true }]])
  const previousWindow = globalThis.window
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  })
  globalThis.window = { __ModuleLoader__: { load(registration) {
    assert.equal(modules.has(registration.id), false, 'loading the custom plugin must not replace an existing module')
    modules.set(registration.id, registration)
  } } }
  await import('../lib/browser/index.js')
  const mod = modules.get('dsh-custom-ding').factory(() => ({ createElement() {} }))
  mod.apply({ slots: {
    inject(_name, callback) { callback() },
    register(section, component) {
      assert.equal(sections.has(section.id), false, 'the original settings page stays registered')
      sections.set(section.id, component)
    },
  } })
  assert.equal(modules.get('dsh-perlica-ding').original, true)
  assert.equal(sections.get('perlica-ding').original, true)
  assert.equal(typeof sections.get('custom-ding'), 'function')
})

async function callRoute(route, path, body) {
  const req = new EventEmitter()
  req.url = path
  req.method = body === undefined ? 'GET' : 'POST'
  req.headers = { 'content-type': 'application/json' }
  let status, result
  const res = { writeHead(value) { status = value }, end(value) { result = JSON.parse(value) } }
  queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify(body ?? {}))); req.emit('end') })
  await route.handler(req, res)
  return { status, result }
}

test('new settings do not read or overwrite the original plugin files or route', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ding-identity-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let dispose
  const originalDir = join(home, 'dsh-perlica-ding')
  const originalVolume = '{"volume":31}\n'
  const originalPreferences = '{"notificationsEnabled":true,"sounds":{}}\n'
  try {
    await mkdir(originalDir)
    await writeFile(join(originalDir, 'state.json'), originalVolume)
    await writeFile(join(originalDir, 'preferences.json'), originalPreferences)
    const routes = new Map([['/perlica-ding/api', { original: true }]])
    const services = {
      subprocess: { spawn() { throw new Error('saving settings must not play audio') } },
      webServer: { register(route) {
        assert.equal(routes.has(route.path), false, 'the original HTTP route stays registered')
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      } },
    }
    dispose = await activateHost({
      get: name => services[name],
      on() { return () => {} },
      effect: callback => callback(),
      logger: () => ({ info() {}, warn() {}, error() {} }),
    }, {})
    const route = routes.get('/custom-ding/api')
    const state = await callRoute(route, '/custom-ding/api/state')
    assert.equal(state.status, 200)
    assert.equal(state.result.volume, 100)
    assert.equal(state.result.notificationsEnabled, false)
    assert.equal((await callRoute(route, '/perlica-ding/api/state')).status, 404)
    assert.equal((await callRoute(route, '/custom-ding/api/volume', { volume: 64 })).status, 200)
    assert.equal((await callRoute(route, '/custom-ding/api/notifications', { enabled: true })).status, 200)
    assert.equal(JSON.parse(await readFile(join(home, 'dsh-custom-ding', 'state.json'))).volume, 64)
    assert.equal(await readFile(join(originalDir, 'state.json'), 'utf8'), originalVolume)
    assert.equal(await readFile(join(originalDir, 'preferences.json'), 'utf8'), originalPreferences)
    assert.equal(routes.get('/perlica-ding/api').original, true)
  } finally {
    await dispose?.()
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
