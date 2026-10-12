/**
 * dsh-custom-ding — client half.
 *
 * Registers one Settings page ("提示音与通知") that lets the user dial the
 * notification volume with a slider and preview every sound kind with a
 * button, so the right level can be found by ear instead of by guessing.
 *
 * The page talks to this package's host half over a loopback HTTP route
 * (`/custom-ding/api/*`), so previews play through the same system-level
 * audio path the real notifications use.
 *
 * The transport lives in this file on purpose. A DSH plugin package serves
 * exactly one browser bundle (`exports["./client"]`), and a factory's
 * synchronous `require()` resolves only module-table specifiers — seed words,
 * materialized modules, boot-graph rows and registered package factories — so
 * a sibling file is not reachable. A package-local chunk (`require.async`)
 * would be the only alternative, and the installed plugin ecosystem ships
 * single-file bundles with zero such chunks; staying self-contained is both
 * the proven shape here and the smaller PR upstream.
 *
 * `createTransport` is exported so the test suite drives this real file.
 *
 * Bundle format: a classic script registering itself with the DSH client
 * module loader (`window.__ModuleLoader__.load`). No build step, no JSX.
 */
window.__ModuleLoader__.load({
  id: 'dsh-custom-ding',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    var DEFAULT_BASE = '/custom-ding/api'

    var ROUTE_MISSING_HEAD = '插件后台接口未就绪'
    var ROUTE_MISSING_TAIL = '——请重启 DSH 后重试'

    /**
     * Build one semantic transport error: an `Error` that also carries the
     * `{ code, status, message }` shape the caller switches on.
     *
     * @param {'route-missing'|'http'|'bad-payload'} code - failure class.
     * @param {string} message - user-facing text (already localized).
     * @param {number} [status] - HTTP status when one was observed.
     */
    function failure(code, message, status) {
      var error = new Error(message)
      error.code = code
      if (status !== undefined) error.status = status
      return error
    }

    /** Read and validate the frozen `0..100` volume field out of a payload. */
    function readVolume(payload, where) {
      if (payload === null || typeof payload !== 'object') {
        throw failure('bad-payload', where + ' 返回了无法解析的数据')
      }
      var volume = payload.volume
      if (typeof volume !== 'number' || !Number.isFinite(volume)) {
        throw failure('bad-payload', where + ' 返回的 volume 不是有效数字')
      }
      if (volume < 0 || volume > 100) {
        throw failure('bad-payload', where + ' 返回的 volume 超出 0..100：' + volume)
      }
      return volume
    }

    function readPreferences(data) {
      var sounds = {}
      ;['plan', 'done', 'ask', 'fail'].forEach(function (kind) {
        var sound = data.sounds && data.sounds[kind]
        if (sound && typeof sound.name === 'string') sounds[kind] = { name: sound.name }
      })
      return { notificationsEnabled: data.notificationsEnabled === true, sounds: sounds }
    }

    /** Convert decoded audio to the PCM format shared by all native players. */
    function encodeAudio(audio) {
      var channels = audio.numberOfChannels
      var frames = audio.length
      var rate = audio.sampleRate
      if (!Number.isInteger(frames) || frames <= 0 || ![1, 2].includes(channels)
        || !Number.isFinite(rate) || rate < 8000 || rate > 96000 || frames / rate > 30) {
        throw new Error('请选择不超过 30 秒的单声道或立体声音频')
      }
      var size = frames * channels * 2
      if (size + 44 > 12 * 1024 * 1024) throw new Error('转换后的音频不能超过 12 MB')
      var buffer = new ArrayBuffer(44 + size)
      var view = new DataView(buffer)
      function textAt(offset, value) {
        for (var i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
      }
      textAt(0, 'RIFF')
      view.setUint32(4, 36 + size, true)
      textAt(8, 'WAVE')
      textAt(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, channels, true)
      view.setUint32(24, rate, true)
      view.setUint32(28, rate * channels * 2, true)
      view.setUint16(32, channels * 2, true)
      view.setUint16(34, 16, true)
      textAt(36, 'data')
      view.setUint32(40, size, true)
      var samples = []
      for (var channel = 0; channel < channels; channel++) samples.push(audio.getChannelData(channel))
      for (var frame = 0; frame < frames; frame++) {
        for (var c = 0; c < channels; c++) {
          var sample = samples[c][frame]
          if (!Number.isFinite(sample)) throw new Error('音频包含无效采样')
          sample = Math.max(-1, Math.min(1, sample))
          view.setInt16(44 + (frame * channels + c) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
        }
      }
      return new Uint8Array(buffer)
    }

    async function importAudio(file) {
      if (!file || file.size === 0 || file.size > 12 * 1024 * 1024) throw new Error('请选择不超过 12 MB 的音频文件')
      var Context = window.AudioContext || window.webkitAudioContext
      if (!Context) throw new Error('当前浏览器不支持音频导入')
      var context = new Context({ sampleRate: 48000 })
      try {
        var decoded = await context.decodeAudioData(await file.arrayBuffer())
        var bytes = encodeAudio(decoded)
        var chunks = []
        for (var offset = 0; offset < bytes.length; offset += 8192) {
          chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + 8192)))
        }
        return btoa(chunks.join(''))
      } catch (error) {
        if (error && (error.name === 'EncodingError' || error.name === 'NotSupportedError')) {
          throw new Error('无法读取此音频，请尝试 WAV 或 MP3 文件')
        }
        throw error
      } finally {
        await context.close()
      }
    }

    /**
     * Create the transport used by the settings page. Pure logic: no DOM, no
     * timers, no polling, and no retry loop — one call, one request.
     *
     * @param {{ base?: string, fetchImpl?: Function }} [options]
     * @returns {{ getState: Function, setVolume: Function, preview: Function }}
     */
    function createTransport(options) {
      var opts = options || {}
      var base = typeof opts.base === 'string' && opts.base !== '' ? opts.base : DEFAULT_BASE
      var fetchImpl = typeof opts.fetchImpl === 'function'
        ? opts.fetchImpl
        : (typeof fetch === 'function' ? fetch : null)

      if (fetchImpl === null) {
        throw failure('bad-payload', '当前环境没有可用的 fetch，无法连接插件后台')
      }

      /** One request. Never retries, never polls. */
      function request(path, body) {
        var init = { headers: { 'content-type': 'application/json' } }
        if (body !== undefined) {
          init.method = 'POST'
          init.body = JSON.stringify(body)
        }

        return Promise.resolve()
          .then(function () {
            return fetchImpl(base + path, init)
          })
          .catch(function (cause) {
            if (cause && cause.code) throw cause
            // The request never reached a handler: same user-facing class as a
            // route the host has not registered yet.
            throw failure('route-missing', ROUTE_MISSING_HEAD + ROUTE_MISSING_TAIL)
          })
          .then(function (response) {
            var contentType = ''
            try {
              contentType = (response.headers && response.headers.get('content-type')) || ''
            } catch (ignored) {
              contentType = ''
            }

            // A non-JSON body means the request fell through to the web app's
            // SPA/static handler: the plugin route is not registered.
            if (!contentType.includes('application/json')) {
              throw failure(
                'route-missing',
                ROUTE_MISSING_HEAD + '（HTTP ' + response.status + '）' + ROUTE_MISSING_TAIL,
                response.status,
              )
            }

            return Promise.resolve()
              .then(function () {
                return response.json()
              })
              .catch(function () {
                throw failure('bad-payload', '插件后台返回了无法解析的数据', response.status)
              })
              .then(function (data) {
                if (data === null || typeof data !== 'object') {
                  throw failure('bad-payload', '插件后台返回了无法解析的数据', response.status)
                }
                if (!response.ok) {
                  var serverMessage = typeof data.error === 'string' && data.error !== ''
                    ? data.error
                    : 'HTTP ' + response.status
                  throw failure('http', serverMessage, response.status)
                }
                return data
              })
          })
      }

      return {
        /** GET /state — normalized to the frozen shape, tolerant on optional fields. */
        getState: function () {
          return Promise.resolve()
            .then(function () {
              return request('/state')
            })
            .then(function (data) {
              return {
                volume: readVolume(data, '/state'),
                enabled: data.enabled === true,
                debounceMs: typeof data.debounceMs === 'number' && Number.isFinite(data.debounceMs)
                  ? data.debounceMs
                  : 0,
                persistent: data.persistent === true,
                ...readPreferences(data),
                preferencesPersistent: data.preferencesPersistent === true,
                notificationsSupported: data.notificationsSupported === true,
                // Diagnostics only. `persistent` above is the single authority: an
                // unknown tier must never be read as "cannot persist" (ADR §9.6/§9.8
                // expect further tiers to appear).
                kind: typeof data.kind === 'string' && data.kind !== '' ? data.kind : 'none',
                kinds: Array.isArray(data.kinds)
                  ? data.kinds
                    .filter(function (entry) {
                      return entry !== null && typeof entry === 'object'
                        && typeof entry.id === 'string' && typeof entry.label === 'string'
                    })
                    .map(function (entry) {
                      return { id: entry.id, label: entry.label }
                    })
                  : [],
              }
            })
        },

        /**
         * POST /volume — returns the volume the HOST settled on. The server may
         * clamp, so the response is re-validated and its value is authoritative.
         */
        setVolume: function (volume) {
          if (typeof volume !== 'number' || !Number.isFinite(volume)) {
            return Promise.reject(failure('bad-payload', '音量必须是数字'))
          }
          return Promise.resolve()
            .then(function () {
              return request('/volume', { volume: volume })
            })
            .then(function (data) {
              return readVolume(data, '/volume')
            })
        },

        /** POST /preview — returns the kind the host actually played. */
        preview: function (kind) {
          if (typeof kind !== 'string' || kind === '') {
            return Promise.reject(failure('bad-payload', '试听档位无效'))
          }
          return Promise.resolve()
            .then(function () {
              return request('/preview', { kind: kind })
            })
            .then(function (data) {
              if (typeof data.played !== 'string' || data.played === '') {
                throw failure('bad-payload', '/preview 返回的 played 不是有效档位')
              }
              return data.played
            })
        },
        setSound: function (kind, name, audio) {
          return request('/sound', { kind: kind, name: name, audio: audio }).then(readPreferences)
        },
        resetSound: function (kind) {
          return request('/sound', { kind: kind, reset: true }).then(readPreferences)
        },
        setNotifications: function (enabled) {
          return request('/notifications', { enabled: enabled }).then(function (data) {
            if (typeof data.notificationsEnabled !== 'boolean') throw failure('bad-payload', '通知开关保存结果无效')
            return readPreferences(data)
          })
        },
        previewNotification: function () {
          return request('/notification-preview', {}).then(function (data) {
            if (data.sent !== true) throw failure('bad-payload', '通知发送结果无效')
          })
        },
      }
    }

    /**
     * One memoized transport for the page. A failed construction is not
     * cached, so the manual retry button can build it again.
     */
    var transportPromise = null
    function loadTransport() {
      if (transportPromise) return transportPromise
      transportPromise = Promise.resolve()
        .then(function () {
          return createTransport()
        })
        .catch(function (error) {
          transportPromise = null
          throw error
        })
      return transportPromise
    }

    /** Human-readable text for a transport failure. */
    function describe(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    var VOLUME_PRESETS = [
      { value: 100, label: '原声' },
      { value: 60, label: '适中' },
      { value: 30, label: '轻声' },
      { value: 0, label: '静音' },
    ]

    /**
     * Last-resort labels for the frozen four kinds, used only when the host
     * state carries no usable `kinds` list.
     */
    var KIND_FALLBACK = [
      { id: 'plan', label: '计划出方案' },
      { id: 'done', label: '任务完成' },
      { id: 'ask', label: '需要你回应' },
      { id: 'fail', label: '出错' },
    ]

    var styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        color: 'var(--dsw-alias-label-primary)',
        maxWidth: '560px',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      },
      title: { fontSize: '14px', fontWeight: 600, margin: 0 },
      hint: {
        fontSize: '12px',
        lineHeight: 1.7,
        color: 'var(--dsw-alias-label-secondary)',
        margin: 0,
      },
      sliderRow: { display: 'flex', alignItems: 'center', gap: '12px' },
      slider: { flex: 1, accentColor: 'var(--dsw-alias-brand-primary)', cursor: 'pointer' },
      volumeBadge: {
        minWidth: '52px',
        textAlign: 'right',
        fontSize: '13px',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
      },
      buttons: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
      button: {
        padding: '7px 14px',
        fontSize: '13px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'inherit',
        cursor: 'pointer',
      },
      buttonBusy: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      presetRow: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      preset: {
        padding: '4px 10px',
        fontSize: '12px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      presetActive: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      notice: { fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)', margin: 0 },
      footer: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', margin: 0 },
      soundRow: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' },
      fileInput: { width: '100%', fontSize: '12px', color: 'inherit' },
      switchLabel: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', cursor: 'pointer' },
    }

    function CustomDingSettings() {
      const [status, setStatus] = React.useState('loading')
      const [volume, setVolume] = React.useState(100)
      const [kinds, setKinds] = React.useState(KIND_FALLBACK)
      const [capability, setCapability] = React.useState({ persistent: false, kind: 'none' })
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)
      const [preferences, setPreferences] = React.useState({ sounds: {}, notificationsEnabled: false })
      const [preferencesReady, setPreferencesReady] = React.useState(false)
      const [notificationsSupported, setNotificationsSupported] = React.useState(false)
      const [customBusy, setCustomBusy] = React.useState('')
      const [savingVolume, setSavingVolume] = React.useState(false)

      const saveTimer = React.useRef(null)
      const previewTimer = React.useRef(null)
      const committedRef = React.useRef(100)
      const commitSeq = React.useRef(0)
      const draftVolume = React.useRef(100)
      const volumeQueue = React.useRef(Promise.resolve(true))
      const pendingVolumes = React.useRef(0)
      const mounted = React.useRef(true)

      React.useEffect(() => {
        let cancelled = false
        setStatus('loading')
        loadTransport()
          .then((transport) => transport.getState())
          .then((state) => {
            if (cancelled) return
            committedRef.current = state.volume
            draftVolume.current = state.volume
            setVolume(state.volume)
            setKinds(state.kinds.length > 0 ? state.kinds : KIND_FALLBACK)
            setCapability({ persistent: state.persistent, kind: state.kind })
            setPreferences(readPreferences(state))
            setPreferencesReady(state.preferencesPersistent)
            setNotificationsSupported(state.notificationsSupported)
            setNotice('')
            setStatus('ready')
          })
          .catch((error) => {
            if (cancelled) return
            setNotice(describe(error))
            setStatus('error')
          })
        return () => {
          cancelled = true
        }
      }, [reloadKey])

      // Every timer this component owns is released on unmount; there is no
      // polling loop and no interval anywhere in this page.
      /**
       * Persist a volume. On failure the local value falls back to the last
       * value the host acknowledged — a failed save is never shown as saved.
       */
      const commit = React.useCallback((value, seq) => {
        pendingVolumes.current += 1
        const saved = volumeQueue.current.then(() => loadTransport())
          .then((transport) => transport.setVolume(value))
          .then((settled) => {
            // Bookkeeping first: a superseded success still settled on the host, so the
            // rollback target must be the newest acknowledged value. Doing this behind
            // the guard let a later failure roll the slider back to a value that was
            // never stored. Only the visible update yields to the newer edit.
            committedRef.current = settled
            if (!mounted.current || seq !== commitSeq.current) return true
            draftVolume.current = settled
            setVolume(settled)
            setNotice('')
            setSavingVolume(false)
            return true
          })
          .catch((error) => {
            if (!mounted.current || seq !== commitSeq.current) return false
            setNotice('保存失败：' + describe(error))
            draftVolume.current = committedRef.current
            setVolume(committedRef.current)
            setSavingVolume(false)
            return false
          })
          .finally(() => { pendingVolumes.current -= 1 })
        volumeQueue.current = saved
        return saved
      }, [])

      const flushVolume = () => {
        if (!saveTimer.current) return pendingVolumes.current > 0 ? volumeQueue.current : Promise.resolve(true)
        clearTimeout(saveTimer.current)
        saveTimer.current = null
        return commit(draftVolume.current, commitSeq.current)
      }

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          if (saveTimer.current) {
            clearTimeout(saveTimer.current)
            saveTimer.current = null
            commit(draftVolume.current, commitSeq.current)
          }
          if (previewTimer.current) clearTimeout(previewTimer.current)
        }
      }, [commit])

      const onSlide = (event) => {
        const value = Number(event.target.value)
        draftVolume.current = value
        const seq = ++commitSeq.current
        setVolume(value)
        setSavingVolume(true)
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null
          commit(value, seq)
        }, 200)
      }

      const onPreset = (value) => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = null
        draftVolume.current = value
        setVolume(value)
        setSavingVolume(true)
        commit(value, ++commitSeq.current)
      }

      const onPreview = (kind) => {
        setBusy(kind)
        flushVolume()
          .then((saved) => {
            if (!saved) return
            return loadTransport().then((transport) => transport.preview(kind))
          })
          .catch((error) => setNotice('试听失败：' + describe(error)))
          .then(() => {
            if (!mounted.current) return
            if (previewTimer.current) clearTimeout(previewTimer.current)
            previewTimer.current = setTimeout(() => setBusy(''), 500)
          })
      }

      const changePreferences = async (key, action) => {
        setCustomBusy(key)
        setNotice('')
        try {
          const transport = await loadTransport()
          const result = await action(transport)
          if (mounted.current && result) setPreferences(result)
        } catch (error) {
          if (mounted.current) setNotice('操作失败：' + describe(error))
        } finally {
          if (mounted.current) setCustomBusy('')
        }
      }

      const onImport = (kind, event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        changePreferences(kind, async transport => transport.setSound(kind, file.name, await importAudio(file)))
      }

      const retry = () => {
        setNotice('')
        setReloadKey((n) => n + 1)
      }

      if (status === 'loading') {
        return h('div', { style: styles.page }, h('p', { style: styles.hint }, '正在读取插件状态…'))
      }

      // The host bridge is unreachable: surface the reason with one manual
      // retry button instead of a polling loop.
      if (status === 'error') {
        return h('div', { style: styles.page },
          h('div', { style: styles.card },
            h('h3', { style: styles.title }, '暂时无法连接插件后台'),
            h('p', { style: styles.hint }, notice),
            h('p', { style: styles.hint }, '如果刚刚安装或更新过插件，重启 DSH 后点下面的按钮重试即可。'),
            h('div', { style: styles.buttons },
              h('button', {
                type: 'button',
                onClick: retry,
                style: styles.button,
              }, '重试'),
            ),
          ),
        )
      }

      const persistent = capability.persistent === true

      return h(
        'div',
        { style: styles.page },
        h(
          'div',
          { style: styles.card },
          h('h3', { style: styles.title }, '提示音音量'),
          h('div', { style: styles.sliderRow },
            h('input', {
              type: 'range',
              min: 0,
              max: 100,
              step: 1,
              value: volume,
              onChange: onSlide,
              onPointerUp: flushVolume,
              onKeyUp: flushVolume,
              onBlur: flushVolume,
              style: styles.slider,
              'aria-label': '提示音音量',
              'aria-valuetext': volume + '%',
            }),
            h('span', { style: styles.volumeBadge }, volume + '%'),
          ),
          h('div', { style: styles.presetRow },
            VOLUME_PRESETS.map((preset) =>
              h('button', {
                key: preset.value,
                type: 'button',
                onClick: () => onPreset(preset.value),
                style: Object.assign(
                  {},
                  styles.preset,
                  volume === preset.value ? styles.presetActive : null,
                ),
              }, preset.label + ' ' + preset.value + '%'),
            ),
          ),
          h('p', { style: styles.hint },
            '拖动滑块调节音量，0% 为完全静音。',
            savingVolume ? '正在保存…' : persistent ? '设置会自动保存并立即生效。' : '当前环境无法持久化，重启后恢复默认。',
          ),
        ),
        h(
          'div',
          { style: styles.card },
          h('h3', { style: styles.title }, '自定义提示音'),
          h('p', { style: styles.hint }, '每个场景可选择独立音效。支持 WAV、MP3 等浏览器可读取的音频，最长 30 秒、最大 12 MB。'),
          !preferencesReady ? h('p', { style: styles.notice }, '自定义设置暂时无法保存，请检查后台状态后重试。') : null,
          h('div', null,
            kinds.map((kind) =>
              h('div', { key: kind.id, style: styles.soundRow },
                h('label', { htmlFor: 'ding-sound-' + kind.id, style: styles.title }, kind.label),
                h('p', { style: { ...styles.hint, overflowWrap: 'anywhere' } },
                  customBusy === kind.id ? '正在保存音效…' : preferences.sounds[kind.id]?.name || 'HAMA-SUSHI.wav（默认）'),
                h('input', {
                  id: 'ding-sound-' + kind.id, type: 'file', accept: 'audio/*,.wav,.mp3,.ogg,.m4a,.flac',
                  style: styles.fileInput, disabled: !!customBusy || !preferencesReady,
                  onChange: event => onImport(kind.id, event),
                }),
                h('div', { style: styles.buttons },
                  h('button', {
                    type: 'button', onClick: () => onPreview(kind.id), disabled: !!busy || !!customBusy,
                    style: Object.assign({}, styles.button, busy === kind.id ? styles.buttonBusy : null),
                  }, busy === kind.id ? '播放中…' : '试听'),
                  h('button', {
                    type: 'button', style: styles.button,
                    disabled: !!customBusy || !preferences.sounds[kind.id] || !preferencesReady,
                    onClick: () => changePreferences(kind.id, transport => transport.resetSound(kind.id)),
                  }, '恢复默认'),
                ),
              ),
            ),
          ),
        ),
        h('div', { style: styles.card },
          h('label', { style: styles.switchLabel },
            h('input', {
              type: 'checkbox', role: 'switch', checked: preferences.notificationsEnabled,
              disabled: !!customBusy || !preferencesReady || !notificationsSupported,
              onChange: event => {
                const enabled = event.target.checked
                changePreferences('notifications', transport => transport.setNotifications(enabled))
              },
            }),
            '弹窗通知',
          ),
          h('p', { style: styles.hint }, '默认关闭。开启后，计划就绪、任务完成、需要回应或出错时显示系统通知；音量为 0 时也能提醒。'),
          h('p', { style: styles.hint }, notificationsSupported
            ? '通知显示在运行 DSH 的电脑上，受系统通知权限和勿扰模式控制。'
            : '当前系统暂不支持弹窗通知。'),
          h('div', { style: styles.buttons },
            h('button', {
              type: 'button', style: styles.button,
              disabled: !preferences.notificationsEnabled || !!customBusy,
              onClick: () => changePreferences('notification-preview', async transport => {
                await transport.previewNotification()
                if (mounted.current) setNotice('已请求发送通知，请查看系统通知区域。')
              }),
            }, customBusy === 'notification-preview' ? '正在发送…' : '测试通知'),
          ),
        ),
        notice ? h('p', { style: styles.notice, role: 'status', 'aria-live': 'polite' }, notice) : null,
        h('p', { style: styles.footer }, 'DSH Custom Ding · 任务提示音与系统通知'),
      )
    }

    /** Register the settings page; `inject` scopes ctx.slots availability. */
    function apply(ctx) {
      const slots = ctx.slots || ctx.get('slots')
      if (!slots) return
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'custom-ding',
            order: 60,
            label: '提示音与通知',
          },
          CustomDingSettings,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.CustomDingSettings = CustomDingSettings
    exports.createTransport = createTransport
    exports.loadTransport = loadTransport
    exports.encodeAudio = encodeAudio
    return module.exports
  },
})
