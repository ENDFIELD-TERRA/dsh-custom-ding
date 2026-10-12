import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KINDS } from '../core/kinds.mjs'

export const MAX_AUDIO_BYTES = 12 * 1024 * 1024
export const MAX_AUDIO_SECONDS = 30

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 })
}

/** Validate every chunk before accepting audio that the native player will open. */
export function validateAudio(bytes) {
  if (bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES
    || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw invalid('请选择有效的 WAV 音频（不超过 12 MB）')
  }
  let format
  let dataSize = 0
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size > bytes.length) throw invalid('音频文件不完整')
    if (id === 'fmt ') {
      if (size < 16 || format) throw invalid('音频格式无效')
      format = {
        code: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        rate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8),
        align: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14),
      }
    }
    if (id === 'data') {
      if (dataSize || size === 0) throw invalid('音频数据无效')
      dataSize = size
    }
    offset = start + size + (size % 2)
  }
  if (!format || !dataSize || offset !== bytes.length
    || ![1, 2].includes(format.channels) || format.rate < 8000 || format.rate > 96000
    || !(format.code === 1 && [8, 16, 24, 32].includes(format.bits)
      || format.code === 3 && format.bits === 32)
    || format.align !== format.channels * format.bits / 8
    || format.byteRate !== format.rate * format.align || dataSize % format.align !== 0) {
    throw invalid('请选择单声道或立体声 PCM WAV 音频')
  }
  const duration = dataSize / format.byteRate
  if (duration > MAX_AUDIO_SECONDS) throw invalid('提示音不能超过 30 秒')
  return duration
}

async function atomicWrite(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** New preferences use their own document, preserving existing volume stores. */
export function createPreferencesStore({ stateDir, logger = console }) {
  const file = join(stateDir, 'preferences.json')
  const soundDir = join(stateDir, 'sounds')
  let current = { notificationsEnabled: false, sounds: {} }
  let ready = false
  let queue = Promise.resolve()
  let initialization

  const snapshot = () => structuredClone(current)
  const cleanup = async name => {
    if (!name) return
    try { await rm(join(soundDir, name), { force: true }) }
    catch (error) { logger.warn('Could not remove an unused custom sound', error) }
  }

  async function load() {
    await mkdir(soundDir, { recursive: true })
    let text
    try { text = await readFile(file, 'utf8') }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      ready = true
      return snapshot()
    }
    try {
      const stored = JSON.parse(text)
      if (!stored || typeof stored.notificationsEnabled !== 'boolean'
        || !stored.sounds || typeof stored.sounds !== 'object' || Array.isArray(stored.sounds)) {
        throw new Error('Invalid notification preferences')
      }
      const sounds = {}
      for (const [kind, sound] of Object.entries(stored.sounds)) {
        if (!KINDS.includes(kind) || !sound || typeof sound.name !== 'string'
          || sound.name.length > 160 || !new RegExp(`^${kind}-[a-f0-9]{64}\\.wav$`).test(sound.file)
          || !Number.isFinite(sound.duration) || sound.duration <= 0 || sound.duration > MAX_AUDIO_SECONDS) {
          throw new Error('Invalid saved sound')
        }
        sounds[kind] = { name: sound.name, file: sound.file, duration: sound.duration }
      }
      current = { notificationsEnabled: stored.notificationsEnabled, sounds }
    } catch (error) {
      await rename(file, `${file}.corrupt-${randomUUID()}`)
      logger.warn('Damaged notification preferences were preserved; using defaults', error)
    }
    ready = true
    return snapshot()
  }

  const read = () => (initialization ??= load())
  const mutate = operation => {
    const result = queue.then(async () => { await read(); return operation() })
    queue = result.catch(() => {})
    return result
  }
  const persist = async next => {
    await atomicWrite(file, JSON.stringify(next, null, 2) + '\n')
    current = next
    return snapshot()
  }

  return {
    read,
    snapshot,
    persistent: () => ready,
    path: kind => current.sounds[kind] ? join(soundDir, current.sounds[kind].file) : null,
    setNotifications(enabled) {
      if (typeof enabled !== 'boolean') return Promise.reject(invalid('通知开关必须为开启或关闭'))
      return mutate(() => persist({ ...current, notificationsEnabled: enabled }))
    },
    setSound(body) {
      return mutate(async () => {
        const kind = body?.kind
        if (!KINDS.includes(kind)) throw invalid('未知的提示音场景')
        const sounds = { ...current.sounds }
        const previous = sounds[kind]?.file
        if (body.reset === true) {
          delete sounds[kind]
          const result = await persist({ ...current, sounds })
          await cleanup(previous)
          return result
        }
        if (typeof body.audio !== 'string' || body.audio.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) {
          throw invalid('音频文件过大或内容无效')
        }
        const bytes = Buffer.from(body.audio, 'base64')
        if (bytes.toString('base64') !== body.audio) throw invalid('音频编码无效')
        const duration = validateAudio(bytes)
        if (typeof body.name !== 'string' || body.name.length === 0 || body.name.length > 160) {
          throw invalid('音频文件名无效')
        }
        // Names are display-only; no client-supplied value becomes a file path.
        const name = body.name.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim()
        if (!name) throw invalid('音频文件名无效')
        const target = `${kind}-${createHash('sha256').update(bytes).digest('hex')}.wav`
        await atomicWrite(join(soundDir, target), bytes)
        sounds[kind] = { name, file: target, duration }
        let result
        try { result = await persist({ ...current, sounds }) }
        catch (error) { if (target !== previous) await cleanup(target); throw error }
        if (previous !== target) await cleanup(previous)
        return result
      })
    },
    async dispose() { await queue },
  }
}
