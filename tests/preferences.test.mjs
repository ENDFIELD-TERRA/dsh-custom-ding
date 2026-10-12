import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPreferencesStore, validateAudio } from '../lib/host/preferences.mjs'

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'ding-preferences-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  return { stateDir, store: createPreferencesStore({ stateDir, logger: { warn() {} } }) }
}

test('failed persistence retains the selected sound and cleans the uncommitted upload', async t => {
  const { stateDir, store } = await fixture(t)
  const first = await readFile(new URL('../sounds/done.wav', import.meta.url))
  const second = await readFile(new URL('../sounds/ask.wav', import.meta.url))
  await store.setSound({ kind: 'done', name: 'first.wav', audio: first.toString('base64') })
  const previous = store.snapshot()
  const file = join(stateDir, 'preferences.json')
  await rename(file, file + '.saved')
  await mkdir(file)
  await assert.rejects(store.setSound({ kind: 'done', name: 'second.wav', audio: second.toString('base64') }))
  await assert.rejects(store.setNotifications(true))
  assert.deepEqual(store.snapshot(), previous)
  assert.deepEqual(await readdir(join(stateDir, 'sounds')), [previous.sounds.done.file])
  await rm(file, { recursive: true })
  await rename(file + '.saved', file)
  await store.setNotifications(true)
  assert.equal(store.snapshot().notificationsEnabled, true, 'a later save recovers once the filesystem is writable')
})

test('damaged preferences are preserved and notification permission returns to off', async t => {
  const { stateDir, store } = await fixture(t)
  const damaged = JSON.stringify({ notificationsEnabled: true, sounds: { done: { name: 'unsafe.wav', file: '../state.json', duration: 1 } } })
  await writeFile(join(stateDir, 'preferences.json'), damaged)
  assert.deepEqual(await store.read(), { notificationsEnabled: false, sounds: {} })
  const backup = (await readdir(stateDir)).find(name => name.startsWith('preferences.json.corrupt-'))
  assert.equal(await readFile(join(stateDir, backup), 'utf8'), damaged)
})

test('malformed audio cannot bypass duration and chunk validation', async () => {
  const original = await readFile(new URL('../sounds/done.wav', import.meta.url))
  assert.ok(validateAudio(original) > 0)
  const truncated = original.subarray(0, 40)
  assert.throws(() => validateAudio(truncated))
  const inconsistent = Buffer.from(original)
  inconsistent.writeUInt32LE(1, 28)
  assert.throws(() => validateAudio(inconsistent))
  const oversizedChunk = Buffer.from(original)
  oversizedChunk.writeUInt32LE(0xffffffff, 16)
  assert.throws(() => validateAudio(oversizedChunk))
})
