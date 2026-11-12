window.__ModuleLoader__.load({
  id: 'dsh-nico',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-nico'

    const colors = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l4)',
      bg: 'var(--dsw-alias-bg-layer-1)',
      error: 'var(--dsw-alias-state-error-primary)',
    }
    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 16 }
    const labelStyle = { color: colors.secondary, fontSize: 12, fontWeight: 500, lineHeight: '18px' }
    const hintStyle = { color: colors.tertiary, fontSize: 12, lineHeight: '18px', margin: 0 }
    const inputStyle = {
      appearance: 'none', border: '.5px solid ' + colors.border, borderRadius: 8,
      background: colors.bg, color: colors.primary, font: 'inherit', fontSize: 13,
      height: 36, padding: '0 32px 0 10px', maxWidth: 560, cursor: 'pointer',
    }

    const textStyle = { ...inputStyle, cursor: 'text', width: '100%', maxWidth: 560 }

    function routeOptions(catalog, current) {
      const rows = [{ value: '', label: '宿主默认模型' }]
      for (const group of catalog?.groups || []) {
        for (const model of group.models || []) {
          rows.push({
            value: group.id + '/' + model.id,
            label: group.name + ' / ' + (model.name || model.id) + ' · ' + model.id,
          })
        }
      }
      if (current && !rows.some((row) => row.value === current)) {
        rows.push({ value: current, label: current + '（当前选择）' })
      }
      return rows
    }

    function sttOptions(catalog, current) {
      const rows = [{ value: 'local', label: '本地 SenseVoiceSmall INT8（离线）' }]
      const seen = new Set()
      for (const group of catalog?.groups || []) {
        for (const model of group.models || []) {
          const hay = (model.id + ' ' + (model.name || '')).toLowerCase()
          if (!(hay.includes('asr') || hay.includes('speech') || hay.includes('sensevoice')) || seen.has(model.id)) continue
          seen.add(model.id)
          rows.push({ value: 'cloud:' + model.id, label: group.name + ' / ' + (model.name || model.id) + ' · 云端' })
        }
      }
      if (current && current.startsWith('cloud:') && !rows.some((row) => row.value === current)) {
        rows.push({ value: current, label: current.slice(6) + '（当前云端模型）' })
      }
      return rows
    }

    function catalogProviderForModel(catalog, modelId) {
    for (const group of catalog?.groups || []) {
      if (group.models?.some((m) => m.id === modelId)) return group.id
    }
    return ''
  }

  function ttsOptions(current) {
      const rows = [
        { value: 'say', label: 'macOS say（系统音色）' },
        { value: 'cosyvoice', label: 'CosyVoice2 本地部署（支持情感指令）' },
      ]
      if (current && !rows.some((row) => row.value === current)) {
        rows.push({ value: current, label: current + '（当前选择）' })
      }
      return rows
    }

    const VOICE_FALLBACK = [
      { value: '', label: '默认音色' },
      { value: 'default', label: '中文女（官方参考，适合中文播报）' },
      { value: 'cross_lingual', label: '跨语言参考（英文/多语言音色）' },
    ]
    function voiceRows(current) {
      const rows = VOICE_FALLBACK.slice()
      if (current && !rows.some((row) => row.value === current)) {
        rows.push({ value: current, label: current + '（当前选择）' })
      }
      return rows
    }
    // Fetch live voice descriptions from the running TTS server; fall back
    // to static labels when the server is offline.
    function useServerVoices(url) {
      const [voices, setVoices] = React.useState(null)
      React.useEffect(() => {
        if (!url) { setVoices(null); return }
        let live = true
        fetch(url.replace(/\/+$/, '') + '/voices', { signal: AbortSignal.timeout(3000) })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (!live || !j?.data?.length) { if (live) setVoices(null); return }
            const map = {}
            for (const v of j.data) map[v.id] = v.description || v.name || v.id
            setVoices(map)
          })
          .catch(() => { if (live) setVoices(null) })
        return () => { live = false }
      }, [url])
      return voices
    }

    function NicoSettingsTab({ scope, loadCatalog }) {
      const subscribe = React.useCallback((fn) => scope.subscribe(fn), [scope])
      const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope])
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const [catalog, setCatalog] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        let live = true
        loadCatalog().then((value) => { if (live) setCatalog(value) }).catch((e) => {
          if (live) setError(e?.message || String(e))
        })
        return () => { live = false }
      }, [loadCatalog])

      const value = snapshot.value || {}
      const greeting = value.greeting || ''
      const reasoning = value.reasoning || {}
      const currentRoute = reasoning.provider && reasoning.model ? reasoning.provider + '/' + reasoning.model : ''
      const stt = value.stt || {}
      const currentStt = stt.engine === 'cloud' && stt.model ? 'cloud:' + stt.model : 'local'
      const tts = value.tts || {}
      const currentTts = tts.engine === 'cosyvoice' ? 'cosyvoice' : 'say'
      const disabled = busy || snapshot.status !== 'ready' || !snapshot.writable

      const mutate = async (ops) => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const ok = await scope.mutate(ops)
          if (!ok) setError('保存失败，请重试。')
        } catch (e) {
          setError(e?.message || String(e))
        } finally {
          setBusy(false)
        }
      }
      // 引导语输入：value 直接绑 store 快照又没有 onChange 时，React 受控输入
      // 每敲一键就被弹回——打不了字也删不了字。本地草稿态：onChange 更新草稿，
      // 失焦时与 store 值不同才提交；store 变化（含自己提交成功）后清草稿。
      const [greetingDraft, setGreetingDraft] = React.useState(null)
      React.useEffect(() => { setGreetingDraft(null) }, [greeting])
      const greetingValue = greetingDraft !== null ? greetingDraft : greeting
      const changeGreeting = (event) => setGreetingDraft(event.target.value)
      const saveGreeting = () => {
        const next = greetingDraft !== null ? greetingDraft : greeting
        if (next === greeting) return
        void mutate([{ op: 'set', path: ['greeting'], value: next }])
      }
      // Built-in default shown under the field so the effective greeting is
      // visible. Keep in sync with DEFAULT_GREETING/CONTRACT in lib/dsh.mjs —
      // this tab is a browser bundle and cannot import the node module.
      const BUILTIN_GREETING =
        '你好，我是你的语音助手 Nico。之后我说的每句话请当作独立任务执行。' +
        '你的全部回复都会被转成语音朗读，因此必须遵守：' +
        '只说结论和关键结果，不超过两句话；' +
        '禁止朗读或复述任务输出、文件路径、代码、链接和列表，用平实的口语短句。' +
        '现在只回复两个字：收到'
      const resetGreeting = () => {
        if (greeting === '' && greetingDraft === null) return
        setGreetingDraft('')
        void mutate([{ op: 'set', path: ['greeting'], value: '' }])
      }
      const selectReasoning = (event) => {
        const selected = event.target.value
        const i = selected.indexOf('/')
        void mutate([
          { op: 'set', path: ['reasoning', 'provider'], value: i < 0 ? '' : selected.slice(0, i) },
          { op: 'set', path: ['reasoning', 'model'], value: i < 0 ? '' : selected.slice(i + 1) },
        ])
      }
      const selectStt = (event) => {
        const selected = event.target.value
        void mutate([
          { op: 'set', path: ['stt', 'engine'], value: selected.startsWith('cloud:') ? 'cloud' : 'local' },
          { op: 'set', path: ['stt', 'cloudProvider'], value: selected.startsWith('cloud:') ? (catalogProviderForModel(catalog, selected.slice(6))) : '' },
          { op: 'set', path: ['stt', 'model'], value: selected.startsWith('cloud:') ? selected.slice(6) : '' },
        ])
      }
      const selectTts = (event) => {
        void mutate([{ op: 'set', path: ['tts', 'engine'], value: event.target.value }])
      }
      const selectVoice = (event) => {
        void mutate([{ op: 'set', path: ['tts', 'voice'], value: event.target.value }])
      }
      // ── CosyVoice deploy card ────────────────────────────────────────────
      const ttsUrl = (tts.url || 'http://127.0.0.1:59993/v1').replace(/\/+$/, '')
      const [probe, setProbe] = React.useState({ checking: false, up: null })
      const voiceDesc = useServerVoices(ttsUrl)
      const [pending, setPending] = React.useState('')   // '' | 'deploy' | 'stop'
      const probeRef = React.useRef(null)
      const probeServer = React.useCallback(async () => {
        setProbe({ checking: true, up: null })
        try {
          const res = await fetch(ttsUrl + '/models', { signal: AbortSignal.timeout(2500) })
          setProbe({ checking: false, up: res.ok })
          return res.ok
        } catch { setProbe({ checking: false, up: false }); return false }
      }, [ttsUrl])
      React.useEffect(() => {
        if (currentTts !== 'cosyvoice') return
        void probeServer()
      }, [currentTts, ttsUrl, probeServer])
      const requestInstall = (action) => {
        if (disabled || pending) return
        setPending(action)
        void (async () => {
          const ok = await mutate([{ op: 'set', path: ['tts', 'install'], value: action }])
          if (ok) await mutate([{ op: 'set', path: ['tts', 'install'], value: '' }])
          // Poll liveness until the service answers (deploy ≈ 10–20 min, then
          // model load 30–90s). The plugin never reports back via settings —
          // runtime configEditor writes can take the host down.
          let up = await probeServer()
          const deadline = Date.now() + 30 * 60 * 1000
          while (!up && action === 'deploy' && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 8000))
            up = await probeRef.current()
          }
          setPending('')
        })()
      }
      probeRef.current = probeServer
      const buttonStyle = {
        border: '.5px solid ' + colors.border, borderRadius: 8, background: colors.bg,
        color: colors.primary, font: 'inherit', fontSize: 13, height: 32, padding: '0 14px',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
      }
      // CosyVoice text fields save on blur so typing isn't a save per keystroke.
      const ttsField = (key, id, placeholder, type) => h('input', {
        key: 'tts-' + key, id, type: type || 'text', 'aria-label': id,
        style: textStyle, placeholder, disabled,
        defaultValue: key === 'speed' ? String(tts.speed || 1) : String(tts[key] || ''),
        onBlur: (event) => {
          const next = event.target.value
          const prev = key === 'speed' ? String(tts.speed || 1) : String(tts[key] || '')
          if (next === prev) return
          void mutate([{ op: 'set', path: ['tts', key], value: key === 'speed' ? (Number(next) > 0 ? Number(next) : 1) : next }])
        },
      })
      const currentVoice = String(tts.voice || '')
      const voiceRowList = voiceDesc
        ? (() => {
            const rows = [{ value: '', label: '默认音色（服务端决定）' }]
            for (const [id, desc] of Object.entries(voiceDesc)) {
              rows.push({ value: id, label: desc })
            }
            if (currentVoice && !rows.some((r) => r.value === currentVoice)) {
              rows.push({ value: currentVoice, label: currentVoice })
            }
            return rows
          })()
        : voiceRows(currentVoice)
      const renderOptions = (rows) => rows.map((row) => h('option', { key: row.value, value: row.value }, row.label))

      return h('section', {
        style: { width: '100%', maxWidth: 720, color: colors.primary, display: 'flex', flexDirection: 'column', gap: 8 },
        'data-nico-settings': 'models',
      }, [
        h('h3', { key: 'title', style: { margin: 0, fontSize: 16, lineHeight: '24px' } }, 'Nico 语音模型'),
        h('p', { key: 'intro', style: { ...hintStyle, marginBottom: 4 } }, '按住右 ⌘ 说话。推理模型负责执行语音指令，语音识别模型负责把录音转成文字。'),
        h('div', { key: 'greeting', style: fieldStyle }, [
          h('label', { key: 'label', htmlFor: 'nico-greeting', style: labelStyle }, '会话引导语'),
          h('input', {
            key: 'input', id: 'nico-greeting', 'aria-label': 'Nico 会话引导语',
            style: textStyle, value: greetingValue, disabled,
            placeholder: '例如：任务完成后顺便提醒我确认。留空使用内置默认',
            onChange: changeGreeting,
            onBlur: saveGreeting,
          }),
          h('p', { key: 'hint', style: hintStyle }, 'Nico 固定会话首次创建时发送的引导语，告诉会话如何回答后续语音指令。这里填写的内容会追加在内置默认之后；留空即使用内置默认。修改保存后，下一条语音指令会自动用新引导语重建会话。'),
          h('details', { key: 'default', style: { marginTop: 4 } }, [
            h('summary', { style: { ...hintStyle, cursor: 'pointer', userSelect: 'none' } }, '查看内置默认'),
            h('p', { key: 'text', style: { ...hintStyle, margin: '4px 0 0', whiteSpace: 'pre-wrap' } }, BUILTIN_GREETING),
          ]),
          greeting ? h('button', {
            key: 'reset', style: { ...buttonStyle, marginTop: 4, alignSelf: 'flex-start' },
            onClick: resetGreeting, disabled,
          }, '恢复内置默认（清空自定义内容）') : null,
        ]),
        h('div', { key: 'reasoning', style: fieldStyle }, [
          h('label', { key: 'label', htmlFor: 'nico-reasoning-model', style: labelStyle }, '推理模型'),
          h('select', {
            key: 'select', id: 'nico-reasoning-model', 'aria-label': 'Nico 推理模型',
            style: inputStyle, value: currentRoute, disabled, onChange: selectReasoning,
          }, renderOptions(routeOptions(catalog, currentRoute))),
          h('p', { key: 'hint', style: hintStyle }, '使用宿主当前可用的模型目录；选择“宿主默认模型”则不覆盖默认路由。'),
        ]),
        h('div', { key: 'stt', style: fieldStyle }, [
          h('label', { key: 'label', htmlFor: 'nico-stt-model', style: labelStyle }, '语音识别模型'),
          h('select', {
            key: 'select', id: 'nico-stt-model', 'aria-label': 'Nico 语音识别模型',
            style: inputStyle, value: currentStt, disabled, onChange: selectStt,
          }, renderOptions(sttOptions(catalog, currentStt))),
          h('p', { key: 'hint', style: hintStyle }, '本地模型离线运行；云端 ASR 不可用时自动回退到本地模型。'),
        ]),
        h('div', { key: 'tts', style: fieldStyle }, [
          h('label', { key: 'label', htmlFor: 'nico-tts-engine', style: labelStyle }, '语音播报音色'),
          h('select', {
            key: 'select', id: 'nico-tts-engine', 'aria-label': 'Nico 语音播报音色',
            style: inputStyle, value: currentTts, disabled, onChange: selectTts,
          }, renderOptions(ttsOptions(currentTts))),
          h('p', { key: 'hint', style: hintStyle }, 'CosyVoice2 需本地部署并暴露 OpenAI 兼容 /v1/audio/speech 接口；CosyVoice 不可用时自动回退到 macOS say。'),
        ]),
        ...(currentTts === 'cosyvoice' ? [
          h('div', { key: 'tts-url', style: fieldStyle }, [
            h('label', { key: 'label', htmlFor: 'nico-tts-url', style: labelStyle }, '服务地址'),
            ttsField('url', 'nico-tts-url', 'http://127.0.0.1:59993/v1'),
            h('p', { key: 'hint', style: hintStyle }, '失焦保存。默认 http://127.0.0.1:59993/v1。'),
          ]),
          h('div', { key: 'tts-model', style: fieldStyle }, [
            h('label', { key: 'label', htmlFor: 'nico-tts-model', style: labelStyle }, 'TTS 模型'),
            ttsField('model', 'nico-tts-model', 'cosyvoice-2'),
          ]),
          h('div', { key: 'tts-voice', style: fieldStyle }, [
            h('label', { key: 'label', htmlFor: 'nico-tts-voice', style: labelStyle }, '音色'),
            h('select', {
              key: 'select', id: 'nico-tts-voice', 'aria-label': 'Nico TTS 音色',
              style: inputStyle, value: currentVoice, disabled, onChange: selectVoice,
            }, renderOptions(voiceRowList)),
            h('p', { key: 'hint', style: hintStyle }, '音色由参考音频决定（零样本克隆）；留空使用服务端默认参考。服务在线时自动加载音色描述。'),
          ]),
          h('div', { key: 'tts-instruct', style: fieldStyle }, [
            h('label', { key: 'label', htmlFor: 'nico-tts-instruct', style: labelStyle }, '情感指令（instruct）'),
            ttsField('instruct', 'nico-tts-instruct', '用开心的语气说'),
            h('p', { key: 'hint', style: hintStyle }, 'CosyVoice2 instruct2 情感描述，如：用开心的语气说 / 用温柔的耳语音量说；留空为中性播报。'),
          ]),
          h('div', { key: 'tts-speed', style: fieldStyle }, [
            h('label', { key: 'label', htmlFor: 'nico-tts-speed', style: labelStyle }, '语速'),
            ttsField('speed', 'nico-tts-speed', '1.0', 'number'),
            h('p', { key: 'hint', style: hintStyle }, '0.5 – 2.0，1 为正常语速。'),
          ]),
          h('div', { key: 'tts-deploy', style: { ...fieldStyle, gap: 10 } }, [
            h('label', { key: 'label', style: labelStyle }, '本地部署'),
            h('div', { key: 'buttons', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
              h('button', { key: 'probe', style: buttonStyle, disabled, onClick: () => void probeServer() },
                probe.checking ? '检测中…' : '检测服务'),
              h('button', { key: 'deploy', style: buttonStyle, disabled: disabled || pending === 'deploy', onClick: () => requestInstall('deploy') },
                pending === 'deploy' ? (probe.up ? '启动中…' : '部署中…（首次约 10–20 分钟）') : '下载部署'),
              h('button', { key: 'stop', style: buttonStyle, disabled: disabled || pending !== '', onClick: () => requestInstall('stop') },
                pending === 'stop' ? '停止中…' : '停止服务'),
            ]),
            h('p', { key: 'status', style: hintStyle },
              probe.checking ? '正在检测服务…'
                : probe.up ? '✅ 服务在线：' + ttsUrl
                : pending === 'deploy' ? '部署运行中，本页每 8 秒自动检测；详细进度看终端：tail -f ~/.dsh/nico/cosyvoice/deploy.log'
                : '○ 服务未响应（' + ttsUrl + '）。首次使用点「下载部署」；完成后会自动启动并变绿。'),
          ]),
        ] : []),
        h('p', { key: 'status', style: { ...hintStyle, color: error ? colors.error : colors.tertiary, marginTop: 8 } },
          error || (busy ? '保存中…' : snapshot.status === 'ready' ? '选择后立即保存。' : '正在读取 Nico 设置…')),
      ])
    }

    const inject = ['slots', 'remote', 'remote.session', 'configForms']
    function apply(ctx) {
      const scope = ctx.configForms.get(NS)
      const loadCatalog = async () => {
        const response = await ctx.remote.session.modelCatalog()
        if (!response.ok) throw new Error(response.error?.message || '无法读取模型目录')
        return response.value
      }
      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'nico',
        order: 20,
        label: () => 'Nico 语音',
        inject: () => ({ scope, loadCatalog }),
      }, NicoSettingsTab))), 'dsh-nico:settings-tab')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
