/**
 * dsh-task-journal — browser half（手写 ModuleLoader bundle，无构建步骤）。
 *
 * 在 Web 界面里提供一个**独立的任务日志面板**：设置页左侧导航多一项
 * 「任务日志」，右侧是完整界面：
 *   - 顶部：会话选择器 + 刷新 + 导出 + 一键重试
 *   - 统计条：任务 / 未完成 / 已完成 / 失败 / 模型参数
 *   - 标签页：任务清单、未完成的问题、模型与参数、完整日志
 *
 * 数据走同源 `/api/dsh-journal/*`（由 host 半提供），不依赖任何构建产物，
 * 只用 shell 已经提供的 `react`。所有颜色取自主题变量，切换明暗主题不会坏。
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-journal',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useCallback, useMemo } = React

    const NS = 'dsh-task-journal'

    // ————————————————————————— API —————————————————————————

    async function api(path, payload) {
      const init = payload === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      let res
      try {
        res = await fetch(`/api/dsh-journal${path}`, init)
      } catch (err) {
        throw new Error(`无法连接 DSH 主机：${err?.message ?? String(err)}`)
      }
      let data = null
      try { data = await res.json() } catch { /* 非 JSON */ }
      if (data === null) throw new Error(`请求失败（HTTP ${res.status}）`)
      if (data.error) throw new Error(data.error)
      return data
    }

    // ————————————————————————— 样式 —————————————————————————

    const STYLES = `
.dtj_root { display:flex; flex-direction:column; gap:14px; padding:4px 2px 24px; min-width:0; }
.dtj_bar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.dtj_bar label { font-size:12px; opacity:.7; }
.dtj_btn {
  appearance:none; border:1px solid var(--dsh-border, rgba(128,128,128,.35));
  background:var(--dsh-surface, rgba(128,128,128,.08)); color:inherit;
  border-radius:6px; padding:5px 11px; font-size:13px; cursor:pointer; line-height:1.4;
}
.dtj_btn:hover:not(:disabled) { background:var(--dsh-surface-hover, rgba(128,128,128,.16)); }
.dtj_btn:disabled { opacity:.45; cursor:not-allowed; }
.dtj_btn_primary { border-color:var(--dsh-accent, #4a7dff); }
.dtj_select {
  appearance:none; border:1px solid var(--dsh-border, rgba(128,128,128,.35));
  background:var(--dsh-surface, rgba(128,128,128,.08)); color:inherit;
  border-radius:6px; padding:5px 9px; font-size:12px; max-width:420px;
}
.dtj_cards { display:flex; flex-wrap:wrap; gap:10px; }
.dtj_card {
  flex:1 1 120px; min-width:110px; border:1px solid var(--dsh-border, rgba(128,128,128,.28));
  border-radius:8px; padding:10px 12px; background:var(--dsh-surface, rgba(128,128,128,.06));
}
.dtj_card .n { font-size:20px; font-weight:600; line-height:1.2; }
.dtj_card .k { font-size:11px; opacity:.65; margin-top:3px; }
.dtj_card.warn .n { color:#e0902a; }
.dtj_card.bad .n { color:#e05a5a; }
.dtj_card.good .n { color:#3fa46a; }
.dtj_tabs { display:flex; gap:4px; border-bottom:1px solid var(--dsh-border, rgba(128,128,128,.28)); flex-wrap:wrap; }
.dtj_tab {
  appearance:none; border:none; background:none; color:inherit; opacity:.6;
  padding:7px 12px; font-size:13px; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px;
}
.dtj_tab[data-on="1"] { opacity:1; border-bottom-color:var(--dsh-accent, #4a7dff); font-weight:600; }
.dtj_pane {
  border:1px solid var(--dsh-border, rgba(128,128,128,.28)); border-radius:8px;
  background:var(--dsh-surface, rgba(128,128,128,.05)); padding:12px 14px;
  max-height:60vh; overflow:auto;
}
.dtj_pre {
  margin:0; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size:12px; line-height:1.65; white-space:pre-wrap; word-break:break-word;
}
.dtj_note { font-size:12px; opacity:.65; }
.dtj_toast {
  position:fixed; right:20px; bottom:20px; z-index:9999; max-width:420px;
  border:1px solid var(--dsh-border, rgba(128,128,128,.35)); border-radius:8px;
  background:var(--dsh-surface, #2a2a2e); color:inherit; padding:11px 14px;
  font-size:13px; line-height:1.5; box-shadow:0 6px 24px rgba(0,0,0,.28); white-space:pre-wrap;
}
.dtj_toast.ok { border-left:3px solid #3fa46a; }
.dtj_toast.err { border-left:3px solid #e05a5a; }
.dtj_empty { opacity:.55; font-size:13px; padding:14px 0; }
.dtj_err { color:#e05a5a; font-size:13px; padding:8px 0; }
`

    // ————————————————————————— 小工具 —————————————————————————

    function Toast({ toast, onDone }) {
      useEffect(() => {
        if (toast === null) return undefined
        const t = setTimeout(() => onDone(), 6000)
        return () => clearTimeout(t)
      }, [toast, onDone])
      if (toast === null) return null
      return h('div', { className: `dtj_toast ${toast.ok ? 'ok' : 'err'}` }, toast.text)
    }

    function Card({ n, k, tone }) {
      return h('div', { className: `dtj_card${tone ? ` ${tone}` : ''}` },
        h('div', { className: 'n' }, String(n ?? '—')),
        h('div', { className: 'k' }, k))
    }

    function Pane({ text, empty }) {
      if (!text || text.trim() === '') return h('div', { className: 'dtj_empty' }, empty ?? '（暂无内容）')
      return h('div', { className: 'dtj_pane' }, h('pre', { className: 'dtj_pre' }, text))
    }

    // ————————————————————————— 主面板 —————————————————————————

    function JournalSection() {
      const [sessions, setSessions] = useState([])
      const [session, setSession] = useState('')
      const [summary, setSummary] = useState(null)
      const [tab, setTab] = useState('tasks')
      const [texts, setTexts] = useState({})
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [toast, setToast] = useState(null)
      const [live, setLive] = useState(false)

      const say = useCallback((text, ok = true) => setToast({ text, ok }), [])

      const loadSessions = useCallback(async () => {
        try {
          const r = await api('/sessions')
          const list = r.sessions ?? []
          setSessions(list)
          setSession((cur) => {
            if (cur !== '' && list.some((s) => s.session === cur)) return cur
            return list[0]?.session ?? ''
          })
          setErr('')
          return list
        } catch (e) { setErr(e.message); return [] }
      }, [])

      const loadSummary = useCallback(async (sid) => {
        try {
          const r = await api(`/summary${sid ? `?session=${encodeURIComponent(sid)}` : ''}`)
          setSummary(r)
          setErr('')
          // host 回退到了某个会话，而列表还是空：把它补进列表，避免下拉框空着。
          if (r.session) {
            setSessions((cur) => (cur.some((s) => s.session === r.session)
              ? cur
              : [{ session: r.session, kinds: [], mtime: Date.now() }, ...cur]))
            setSession((cur) => (cur === '' ? r.session : cur))
          }
        } catch (e) { setErr(e.message); setSummary(null) }
      }, [])

      const loadText = useCallback(async (sid, which) => {
        try {
          const r = await api(`/${which}${sid ? `?session=${encodeURIComponent(sid)}` : ''}`)
          setTexts((cur) => ({ ...cur, [which]: r.text }))
        } catch (e) { setTexts((cur) => ({ ...cur, [which]: `加载失败：${e.message}` })) }
      }, [])

      // 首次：拉会话列表。
      useEffect(() => { loadSessions() }, [loadSessions])

      // 会话变化：拉汇总。没有会话也拉一次——host 会回退到最近活跃的会话。
      useEffect(() => {
        loadSummary(session)
      }, [session, sessions.length, loadSummary])

      // 切标签页：按需拉文本。
      useEffect(() => {
        const map = { tasks: 'tasks', failures: 'failures', models: 'models', journal: 'journal' }
        const which = map[tab]
        if (which) loadText(session, which)
      }, [tab, session, sessions.length, loadText])

      // 汇总带 live 标记：活跃会话时每 5 秒自动刷新一次。
      useEffect(() => {
        if (!summary?.live) { setLive(false); return undefined }
        setLive(true)
        const id = setInterval(() => {
          loadSummary(session)
          const map = { tasks: 'tasks', failures: 'failures', models: 'models', journal: 'journal' }
          if (map[tab]) loadText(session, map[tab])
        }, 5000)
        return () => clearInterval(id)
      }, [summary?.live, session, tab, loadSummary, loadText])

      const onExport = useCallback(async (format) => {
        setBusy(true)
        try {
          const r = await api('/export', { session, format })
          say(`✅ 导出完成：${r.files?.length ?? 0} 个文件\n${r.dir}`, true)
        } catch (e) { say(`导出失败：${e.message}`, false) }
        finally { setBusy(false) }
      }, [session, say])

      const onRetry = useCallback(async () => {
        setBusy(true)
        try {
          const r = await api('/retry', { session })
          say(r.ok ? `✅ ${r.message}` : `无法重试：${r.message}`, r.ok === true)
          if (r.ok) loadSummary(session)
        } catch (e) { say(`重试失败：${e.message}`, false) }
        finally { setBusy(false) }
      }, [session, say, loadSummary])

      const onRefresh = useCallback(async () => {
        setBusy(true)
        await loadSessions()
        await loadSummary(session)
        const map = { tasks: 'tasks', failures: 'failures', models: 'models', journal: 'journal' }
        if (map[tab]) await loadText(session, map[tab])
        setBusy(false)
        say('✅ 已刷新', true)
      }, [session, tab, loadSessions, loadSummary, loadText, say])

      const counts = summary?.counts ?? {}
      const tabs = [
        ['tasks', `任务清单${counts.tasks ? ` (${counts.tasks})` : ''}`],
        ['failures', `未完成的问题${counts.failures ? ` (${counts.failures})` : ''}`],
        ['models', `模型与参数${counts.models ? ` (${counts.models})` : ''}`],
        ['journal', '完整日志'],
      ]

      const body = useMemo(() => {
        const map = { tasks: 'tasks', failures: 'failures', models: 'models', journal: 'journal' }
        const which = map[tab]
        const text = texts[which]
        // 还没有任何会话日志：给明确空状态，而不是一直"加载中"。
        if (session === '' && sessions.length === 0) {
          return h('div', { className: 'dtj_empty' },
            '还没有找到会话日志。先在 DSH 里发一句话跑一轮，日志会自动生成，再点「刷新」。')
        }
        if (text === undefined) return h('div', { className: 'dtj_empty' }, '加载中…')
        if (which === 'failures' && (!text || !text.includes('## F'))) {
          return h('div', { className: 'dtj_empty' }, '这个会话还没有记录到未完成的任务。')
        }
        return h(Pane, { text })
      }, [tab, texts])

      return h('div', { className: 'dtj_root' },
        // 工具条
        h('div', { className: 'dtj_bar' },
          h('label', null, '会话'),
          h('select', {
            className: 'dtj_select',
            value: session,
            onChange: (e) => setSession(e.target.value),
          },
          sessions.length === 0
            ? h('option', { value: '' }, '（还没有会话日志）')
            : sessions.map((s) => h('option', { key: s.session, value: s.session }, s.session))),
          h('button', { className: 'dtj_btn', onClick: onRefresh, disabled: busy }, '刷新'),
          h('button', { className: 'dtj_btn', onClick: () => onExport('md'), disabled: busy || session === '' }, '导出汇总'),
          h('button', { className: 'dtj_btn', onClick: () => onExport('all'), disabled: busy || session === '' }, '导出全部'),
          h('button', { className: 'dtj_btn dtj_btn_primary', onClick: onRetry, disabled: busy || session === '' }, '一键重试'),
          live ? h('span', { className: 'dtj_note' }, '● 实时（每 5 秒刷新）') : null,
        ),

        // 统计
        h('div', { className: 'dtj_cards' },
          h(Card, { n: counts.tasks, k: '任务总数' }),
          h(Card, { n: counts.done, k: '已完成', tone: 'good' }),
          h(Card, { n: counts.open, k: '未完成', tone: counts.open > 0 ? 'warn' : undefined }),
          h(Card, { n: counts.failures, k: '失败记录', tone: counts.failures > 0 ? 'bad' : undefined }),
          h(Card, { n: counts.models, k: '模型参数变更' }),
        ),

        summary?.latestModel
          ? h('div', { className: 'dtj_note' }, `当前模型：${summary.latestModel}`)
          : null,
        summary?.dir ? h('div', { className: 'dtj_note' }, `日志目录：${summary.dir}`) : null,

        err !== '' ? h('div', { className: 'dtj_err' }, err) : null,

        // 标签页
        h('div', { className: 'dtj_tabs' },
          tabs.map(([id, label]) => h('button', {
            key: id, className: 'dtj_tab', 'data-on': tab === id ? '1' : '0',
            onClick: () => setTab(id),
          }, label))),

        body,

        h(Toast, { toast, onDone: () => setToast(null) }),
      )
    }

    // ————————————————————————— 插件入口 —————————————————————————

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.setAttribute('data-plugin', NS)
        tag.textContent = STYLES
        document.head.appendChild(tag)
        return () => { if (tag.parentNode !== null) tag.parentNode.removeChild(tag) }
      }, `${NS}: styles`)

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'task-journal',
        order: 20,
        label: () => '任务日志',
      }, JournalSection))
    }

    module.exports = { name: NS, inject: ['slots'], apply }
    return module.exports
  },
})
