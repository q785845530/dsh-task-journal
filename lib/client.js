/**
 * dsh-task-journal — browser half（手写 ModuleLoader bundle，无构建步骤）。
 *
 * 在 Web 界面里提供一个**独立的任务日志面板**：设置页左侧导航多一项
 * 「任务日志」，右侧是完整界面：
 *   - 顶部：会话选择器 + 刷新 + 导出 + 一键重试
 *   - 统计条：任务 / 未完成 / 已完成 / 失败 / 模型参数 / 子智能体
 *   - 标签页：任务清单、未完成的问题、模型与参数、子智能体、完整日志
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
    /** 记住上次选中的会话，下次打开面板直接回到它。 */
    const LS_SESSION = `${NS}:last-session`
    const LS_TAB = `${NS}:last-tab`
    const lsGet = (k) => { try { return window.localStorage.getItem(k) } catch { return null } }
    const lsSet = (k, v) => { try { window.localStorage.setItem(k, v) } catch { /* 隐私模式等 */ } }

    /** 标签页 → 后端的文本接口名（subagents 页签走目录接口，不在这里）。 */
    const TAB_TEXT = {
      tasks: 'tasks', failures: 'failures', models: 'models',
      subagentLog: 'subagents', journal: 'journal',
    }

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
.dtj_paths { display:flex; flex-direction:column; gap:3px; font-size:12px; opacity:.7; }
.dtj_paths code {
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size:11px; opacity:.95; word-break:break-all;
  background:var(--dsh-surface, rgba(128,128,128,.10)); padding:1px 5px; border-radius:4px;
}
.dtj_pathrow { display:flex; gap:6px; align-items:baseline; }
.dtj_pathrow b { opacity:.6; font-weight:500; flex:0 0 auto; }
.dtj_actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.dtj_btn_danger { border-color:#e05a5a; }
.dtj_hist { display:flex; flex-direction:column; gap:6px; max-height:52vh; overflow:auto; }
.dtj_hrow {
  display:flex; flex-direction:column; gap:3px; padding:8px 10px; border-radius:6px;
  border:1px solid var(--dsh-border, rgba(128,128,128,.28));
  background:var(--dsh-surface, rgba(128,128,128,.05)); cursor:pointer;
}
.dtj_hrow:hover { background:var(--dsh-surface-hover, rgba(128,128,128,.14)); }
.dtj_hrow[data-on="1"] { border-color:var(--dsh-accent, #4a7dff); }
.dtj_hrow .h1 { font-size:12px; font-family:ui-monospace,monospace; }
.dtj_hrow .h2 { font-size:11px; opacity:.62; display:flex; gap:8px; flex-wrap:wrap; }
.dtj_badge { font-size:10px; padding:0 5px; border-radius:3px; background:rgba(128,128,128,.22); }
.dtj_badge.ok { background:rgba(63,164,106,.25); }
.dtj_search {
  border:1px solid var(--dsh-border, rgba(128,128,128,.35));
  background:var(--dsh-surface, rgba(128,128,128,.08)); color:inherit;
  border-radius:6px; padding:5px 9px; font-size:12px; flex:1 1 160px; min-width:120px;
}
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
.dtj_sgrow { display:flex; flex-direction:column; gap:4px; }
.dtj_sgroup { border:1px solid var(--dsh-border, rgba(128,128,128,.28)); border-radius:8px; overflow:hidden; }
.dtj_sghead {
  display:flex; align-items:baseline; gap:8px; padding:8px 11px; cursor:pointer;
  background:var(--dsh-surface, rgba(128,128,128,.07));
}
.dtj_sghead:hover { background:var(--dsh-surface-hover, rgba(128,128,128,.14)); }
.dtj_sghead .t { font-size:13px; font-weight:600; }
.dtj_sghead .d { font-size:11px; opacity:.62; }
.dtj_sghead .c { font-size:11px; opacity:.7; margin-left:auto; }
.dtj_sitem { padding:9px 12px; border-top:1px solid var(--dsh-border, rgba(128,128,128,.2)); }
.dtj_sitem .top { display:flex; flex-wrap:wrap; gap:7px; align-items:baseline; }
.dtj_sitem .nm { font-size:13px; font-weight:600; }
.dtj_sitem .id { font-size:11px; opacity:.55; font-family:ui-monospace,monospace; }
.dtj_sitem .sm { font-size:12px; opacity:.8; margin-top:3px; line-height:1.55; }
.dtj_sitem .use { font-size:12px; opacity:.66; margin-top:3px; line-height:1.55; }
.dtj_tag {
  font-size:10px; padding:1px 6px; border-radius:3px;
  background:rgba(128,128,128,.2); opacity:.85;
}
.dtj_tag.avail { background:rgba(63,164,106,.25); }
.dtj_tag.disc { background:rgba(224,144,42,.25); }
.dtj_sbtns { display:flex; gap:6px; margin-top:7px; flex-wrap:wrap; }
.dtj_meta { font-size:11px; opacity:.6; margin-top:3px; }
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



    /** 把存档摘要拼成一段可读文本。 */
    function previewText(digest, fmtTime) {
      const tasks = (digest.tasks ?? []).map((x, i) => `【任务 ${i + 1}】${fmtTime(x.at)}\n${x.text}`).join('\n\n')
      const replies = (digest.replies ?? []).slice(-3).map((x) => x.text).join('\n\n')
      let out = tasks
      if (replies !== '') out += `${out === '' ? '' : '\n\n'}${'─'.repeat(24)}\n（最近产出）\n${replies}`
      return out === '' ? '（这个会话没有可预览的任务记录）' : out
    }

    // ————————————————————————— 历史会话面板 —————————————————————————

    /** 浏览磁盘上的全部历史会话（含插件安装前的老会话）。 */
    function HistoryPanel({ current, onPick, onClose }) {
      const [list, setList] = useState(null)
      const [q, setQ] = useState('')
      const [digest, setDigest] = useState(null)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')

      const load = useCallback(async (query) => {
        setBusy(true)
        try {
          const r = await api(`/history?limit=200${query ? `&q=${encodeURIComponent(query)}` : ''}`)
          setList(r.sessions ?? [])
          setErr('')
        } catch (e) { setErr(e.message) }
        finally { setBusy(false) }
      }, [])

      useEffect(() => { load('') }, [load])

      const openDigest = useCallback(async (sid) => {
        setBusy(true)
        try {
          const r = await api(`/history/digest?session=${encodeURIComponent(sid)}`)
          setDigest(r)
          setErr('')
        } catch (e) { setErr(e.message); setDigest(null) }
        finally { setBusy(false) }
      }, [])

      const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN') : '')
      const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

      return h('div', { className: 'dtj_root' },
        h('div', { className: 'dtj_bar' },
          h('input', {
            className: 'dtj_search', placeholder: '按会话 id 或工作目录筛选…',
            value: q, onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') load(q) },
          }),
          h('button', { className: 'dtj_btn', onClick: () => load(q), disabled: busy }, '查询'),
          h('button', { className: 'dtj_btn', onClick: () => load(''), disabled: busy }, '全部'),
          h('button', { className: 'dtj_btn', onClick: onClose }, '返回当前会话'),
        ),
        err !== '' ? h('div', { className: 'dtj_err' }, err) : null,
        list === null
          ? h('div', { className: 'dtj_empty' }, busy ? '查询中…' : '')
          : h('div', { className: 'dtj_note' }, `共 ${list.length} 个历史会话（点击查看内容，或点「打开」切过去）`),

        h('div', { className: 'dtj_hist' },
          (list ?? []).map((s) => h('div', {
            key: s.sessionId,
            className: 'dtj_hrow',
            'data-on': (digest?.session === s.sessionId || current === s.sessionId) ? '1' : '0',
            onClick: () => openDigest(s.sessionId),
          },
          h('div', { className: 'h1' }, s.sessionId),
          h('div', { className: 'h2' },
            h('span', null, fmtTime(s.mtime)),
            h('span', null, fmtSize(s.size)),
            s.cwd ? h('span', null, s.cwd) : null,
            s.hasJournal ? h('span', { className: 'dtj_badge ok' }, '有任务日志')
              : h('span', { className: 'dtj_badge' }, '仅会话存档'),
            s.sessionId === current ? h('span', { className: 'dtj_badge ok' }, '当前') : null,
          ),
          h('div', { className: 'dtj_bar' },
            h('button', {
              className: 'dtj_btn',
              onClick: (e) => { e.stopPropagation(); onPick(s.sessionId) },
            }, '打开'),
          ),
          )),
        ),

        digest !== null
          ? h('div', null,
            h('div', { className: 'dtj_tabs' },
              h('span', { className: 'dtj_tab', 'data-on': '1' },
                `存档预览：${digest.session.slice(0, 30)}`)),
            h('div', { className: 'dtj_cards' },
              h(Card, { n: digest.turns, k: '轮数' }),
              h(Card, { n: digest.taskCount, k: '任务' }),
              h(Card, { n: digest.replyCount, k: '产出' }),
              h(Card, { n: fmtSize(digest.size), k: '存档大小' }),
            ),
            h('div', { className: 'dtj_pathrow' },
              h('b', null, '会话文件'), h('code', null, digest.file)),
            h('div', { className: 'dtj_pane' },
              h('pre', { className: 'dtj_pre' }, previewText(digest, fmtTime))),
          )
          : null,
      )
    }

    // ————————————————————————— 子智能体面板 —————————————————————————

    /** 一个可折叠的分类分组。 */
    function SubagentGroup({ g, onOpen, onUse }) {
      const [open, setOpen] = useState(true)
      return h('div', { className: 'dtj_sgroup' },
        h('div', { className: 'dtj_sghead', onClick: () => setOpen(!open) },
          h('span', { className: 't' }, `${open ? '▾' : '▸'} ${g.label}`),
          h('span', { className: 'd' }, g.desc),
          h('span', { className: 'c' }, `${g.entries.length} 个`),
        ),
        open ? g.entries.map((e) => h('div', { key: e.id, className: 'dtj_sitem' },
          h('div', { className: 'top' },
            h('span', { className: 'nm' }, e.name),
            h('span', { className: 'id' }, e.id),
            e.source === 'discovered'
              ? h('span', { className: 'dtj_tag disc' }, '运行期发现')
              : h('span', { className: 'dtj_tag' }, '内置'),
            e.kind === 'tool'
              ? h('span', { className: 'dtj_tag' }, '模型工具')
              : h('span', { className: 'dtj_tag' }, '后端'),
            e.availability ? h('span', { className: 'dtj_tag avail' }, e.availability) : null,
          ),
          h('div', { className: 'sm' }, e.summary ?? ''),
          h('div', { className: 'use' }, `用法：${String(e.usage ?? '').split('\n')[0]}`),
          e.tool || e.provider || e.package
            ? h('div', { className: 'meta' },
              [
                e.tool ? `工具 ${e.tool}` : null,
                e.provider ? `provider ${e.provider}` : null,
                e.package ? `包 ${e.package}` : null,
              ].filter(Boolean).join('　·　'))
            : null,
          h('div', { className: 'dtj_sbtns' },
            h('button', { className: 'dtj_btn', onClick: () => onOpen(e.id) }, '调用规格'),
            h('button', { className: 'dtj_btn', onClick: () => onUse(e) }, '生成调用单'),
          ),
        )) : null,
      )
    }

    /** 子智能体页签：目录 + 分类标签 + 归档动作。 */
    function SubagentPanel({ session, onToast }) {
      const [data, setData] = useState(null)
      const [cat, setCat] = useState('')
      const [q, setQ] = useState('')
      const [detail, setDetail] = useState(null)
      const [archive, setArchive] = useState(null)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [how, setHow] = useState('')

      const load = useCallback(async (category) => {
        setBusy(true)
        try {
          const r = await api(`/subagents/catalog${category ? `?category=${encodeURIComponent(category)}` : ''}`)
          setData(r)
          setErr('')
        } catch (e) { setErr(e.message) }
        finally { setBusy(false) }
      }, [])

      const loadArchive = useCallback(async () => {
        try {
          const r = await api(`/subagents/archive${session ? `?session=${encodeURIComponent(session)}` : ''}`)
          setArchive(r)
        } catch { /* 归档状态拿不到不影响目录浏览 */ }
      }, [session])

      useEffect(() => { load(cat) }, [load, cat])
      useEffect(() => { loadArchive() }, [loadArchive])

      const openDetail = useCallback(async (id) => {
        setBusy(true)
        try {
          const r = await api(`/subagents/entry?id=${encodeURIComponent(id)}`)
          setDetail(r)
          setErr('')
        } catch (e) { setErr(e.message) }
        finally { setBusy(false) }
      }, [])

      const onSave = useCallback(async (withSources) => {
        setBusy(true)
        try {
          const r = await api('/subagents/save', { session, sources: withSources })
          onToast(`✅ 已归档 ${r.count} 个子智能体（${r.files.length} 个文件）\n${r.dir}`
            + (r.sources ? `\n源码：${r.sources.ok}/${r.sources.total}` : ''), true)
          loadArchive()
        } catch (e) { onToast(`归档失败：${e.message}`, false) }
        finally { setBusy(false) }
      }, [session, onToast, loadArchive])

      const onSources = useCallback(async () => {
        setBusy(true)
        try {
          const r = await api('/subagents/sources', { session })
          onToast(`✅ 源码归档：${r.okCount}/${r.total} 个条目\n${r.dir}`, true)
          loadArchive()
        } catch (e) { onToast(`源码归档失败：${e.message}`, false) }
        finally { setBusy(false) }
      }, [session, onToast, loadArchive])

      const onUse = useCallback((e) => {
        const call = e.kind === 'provider'
          ? `${e.tool ?? 'subagent'}({ description: "<3-5 词描述>", prompt: "<自包含任务说明>" })`
          : `${e.tool ?? e.id}({ /* 见该工具的参数说明 */ })`
        setHow(`【${e.name}】\n分类：${e.category}\n\n${call}\n\n说明：${e.usage ?? ''}`)
      }, [])

      // 前端过滤：分类走接口，关键词在本地过滤。
      const groups = useMemo(() => {
        const gs = data?.groups ?? []
        const kw = q.trim().toLowerCase()
        if (kw === '') return gs
        return gs
          .map((g) => ({ ...g, entries: g.entries.filter((e) =>
            `${e.name} ${e.id} ${e.summary ?? ''} ${e.tool ?? ''} ${e.provider ?? ''} ${e.package ?? ''}`
              .toLowerCase().includes(kw)) }))
          .filter((g) => g.entries.length > 0)
      }, [data, q])

      const total = groups.reduce((n, g) => n + g.entries.length, 0)

      return h('div', { className: 'dtj_root' },
        h('div', { className: 'dtj_bar' },
          h('input', {
            className: 'dtj_search', placeholder: '按名称 / id / 工具 / 包名过滤…',
            value: q, onChange: (e) => setQ(e.target.value),
          }),
          h('select', {
            className: 'dtj_select', value: cat,
            onChange: (e) => setCat(e.target.value),
          },
          h('option', { value: '' }, '全部分类'),
          (data?.categories ?? []).map((c) => h('option', { key: c.id, value: c.id }, c.label))),
          h('button', { className: 'dtj_btn', onClick: () => { load(cat); loadArchive() }, disabled: busy }, '刷新'),
          h('button', { className: 'dtj_btn dtj_btn_primary', onClick: () => onSave(false), disabled: busy || session === '' }, '归档目录'),
          h('button', { className: 'dtj_btn', onClick: () => onSave(true), disabled: busy || session === '' }, '归档目录 + 源码'),
          h('button', { className: 'dtj_btn', onClick: onSources, disabled: busy || session === '' }, '仅归档源码'),
        ),

        h('div', { className: 'dtj_note' },
          data === null ? (busy ? '加载中…' : '')
            : `共 ${total} 个子智能体${cat === '' ? '' : `（分类：${data.categories.find((c) => c.id === cat)?.label ?? cat}）`}`
              + `　·　来源：内置目录 + 运行期自动发现`),

        archive !== null
          ? h('div', { className: 'dtj_paths' },
            h('div', { className: 'dtj_pathrow' },
              h('b', null, '归档目录'),
              h('code', null, archive.dir ?? '（还没有会话日志，无法定位）')),
            archive.exists
              ? h('div', { className: 'dtj_meta' },
                `已归档：条目 ${archive.counts.entries} 个　·　预设 ${archive.counts.presets} 个　·　源码 ${archive.counts.sources} 套`)
              : h('div', { className: 'dtj_meta' }, '尚未归档；点「归档目录」把调用规格与预设写到本地。'))
          : null,

        err !== '' ? h('div', { className: 'dtj_err' }, err) : null,

        how !== ''
          ? h('div', null,
            h('div', { className: 'dtj_bar' },
              h('b', { style: { fontSize: '12px' } }, '调用单'),
              h('button', { className: 'dtj_btn', onClick: () => setHow('') }, '关闭')),
            h('div', { className: 'dtj_pane' }, h('pre', { className: 'dtj_pre' }, how)))
          : null,

        detail !== null
          ? h('div', null,
            h('div', { className: 'dtj_bar' },
              h('b', { style: { fontSize: '12px' } }, detail.entry.name),
              h('span', { className: 'dtj_meta' }, detail.entry.id),
              h('button', { className: 'dtj_btn', onClick: () => setDetail(null) }, '关闭')),
            h('div', { className: 'dtj_pane' }, h('pre', { className: 'dtj_pre' }, detail.markdown)))
          : null,

        groups.length === 0
          ? h('div', { className: 'dtj_empty' },
            busy ? '加载中…' : '没有匹配的子智能体。清空过滤词或换一个分类。')
          : h('div', { className: 'dtj_sgrow' },
            groups.map((g) => h(SubagentGroup, { key: g.id, g, onOpen: openDetail, onUse }))),
      )
    }

    // ————————————————————————— 主面板 —————————————————————————

    function JournalSection() {
      const [sessions, setSessions] = useState([])
      const [session, setSession] = useState(() => lsGet(LS_SESSION) ?? '')
      const [summary, setSummary] = useState(null)
      const [tab, setTab] = useState(() => lsGet(LS_TAB) ?? 'tasks')
      const [texts, setTexts] = useState({})
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [toast, setToast] = useState(null)
      const [live, setLive] = useState(false)
      const [showHistory, setShowHistory] = useState(false)

      const say = useCallback((text, ok = true) => setToast({ text, ok }), [])

      // 选中会话或切换标签时记住，下次打开自动恢复。
      useEffect(() => { if (session !== '') lsSet(LS_SESSION, session) }, [session])
      useEffect(() => { lsSet(LS_TAB, tab) }, [tab])

      const loadSessions = useCallback(async () => {
        try {
          const r = await api('/sessions')
          const list = r.sessions ?? []
          setSessions(list)
          setSession((cur) => {
            // 优先保留当前（含上次记忆）的选择。
            if (cur !== '' && list.some((s) => s.session === cur)) return cur
            // 记忆的会话这次没出现在列表里（可能日志被清、或还没产生事件）：
            // 仍然把它留在选择器里，让用户能主动切回去看看。
            const remembered = lsGet(LS_SESSION)
            if (remembered !== null && remembered !== '' && cur === remembered) return cur
            return list[0]?.session ?? cur
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
            // 只在用户还没选（首次打开且无记忆）时才用回退会话。
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
        const map = TAB_TEXT
        const which = map[tab]
        if (which) loadText(session, which)
      }, [tab, session, sessions.length, loadText])

      // 汇总带 live 标记：活跃会话时每 5 秒自动刷新一次。
      useEffect(() => {
        if (!summary?.live) { setLive(false); return undefined }
        setLive(true)
        const id = setInterval(() => {
          loadSummary(session)
          const map = TAB_TEXT
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

      const onRetryNew = useCallback(async () => {
        setBusy(true)
        try {
          const r = await api('/retry-new', { session })
          say(r.ok ? `✅ ${r.message}` : `无法开新会话：${r.message}`, r.ok === true)
          if (r.ok) loadSessions()
        } catch (e) { say(`开新会话失败：${e.message}`, false) }
        finally { setBusy(false) }
      }, [session, say, loadSessions])

      const onAbandon = useCallback(async () => {
        setBusy(true)
        try {
          const r = await api('/abandon', { session })
          say(r.ok ? `✅ ${r.message}` : `无法标记失败：${r.message}`, r.ok === true)
          if (r.ok) { loadSummary(session); loadText(session, 'failures'); loadText(session, 'tasks') }
        } catch (e) { say(`标记失败出错：${e.message}`, false) }
        finally { setBusy(false) }
      }, [session, say, loadSummary, loadText])

      const onRefresh = useCallback(async () => {
        setBusy(true)
        await loadSessions()
        await loadSummary(session)
        const map = TAB_TEXT
        if (map[tab]) await loadText(session, map[tab])
        setBusy(false)
        say('✅ 已刷新', true)
      }, [session, tab, loadSessions, loadSummary, loadText, say])

      const counts = summary?.counts ?? {}
      const tabs = [
        ['tasks', `任务清单${counts.tasks ? ` (${counts.tasks})` : ''}`],
        ['failures', `未完成的问题${counts.failures ? ` (${counts.failures})` : ''}`],
        ['models', `模型与参数${counts.models ? ` (${counts.models})` : ''}`],
        ['subagents', `子智能体${counts.subagents ? ` (${counts.subagents})` : ''}`],
        ['subagentLog', '子智能体使用记录'],
        ['journal', '完整日志'],
      ]

      const body = useMemo(() => {
        // 子智能体目录页签：不是文本日志，单独渲染。
        if (tab === 'subagents') {
          return h(SubagentPanel, { session, onToast: say })
        }
        const which = TAB_TEXT[tab]
        const text = texts[which]
        // 还没有任何会话日志：给明确空状态，而不是一直"加载中"。
        if (session === '' && sessions.length === 0) {
          return h('div', { className: 'dtj_empty' },
            '还没有找到会话日志。先在 DSH 里发一句话跑一轮，日志会自动生成，再点「刷新」。')
        }
        if (which === undefined) return null
        if (text === undefined) return h('div', { className: 'dtj_empty' }, '加载中…')
        if (which === 'failures' && (!text || !text.includes('## F'))) {
          return h('div', { className: 'dtj_empty' }, '这个会话还没有记录到未完成的任务。')
        }
        if (which === 'subagents' && (!text || !text.includes('## S'))) {
          return h('div', { className: 'dtj_empty' }, '这个会话还没有委派过子智能体。')
        }
        return h(Pane, { text })
      }, [tab, texts, session, sessions.length, say])

      // 历史会话浏览模式：整块换成历史面板。
      if (showHistory) {
        return h(HistoryPanel, {
          current: session,
          onPick: (sid) => { setSession(sid); setShowHistory(false); say(`已切到 ${sid}`, true) },
          onClose: () => setShowHistory(false),
        })
      }

      return h('div', { className: 'dtj_root' },
        // 工具条
        h('div', { className: 'dtj_bar' },
          h('label', null, '会话'),
          h('select', {
            className: 'dtj_select',
            value: session,
            onChange: (e) => setSession(e.target.value),
          },
          (() => {
            const opts = sessions.map((s) => h('option', { key: s.session, value: s.session }, s.session))
            // 记忆的会话不在列表里时，补一个选项，避免选择器跳回别的会话。
            if (session !== '' && !sessions.some((s) => s.session === session)) {
              opts.unshift(h('option', { key: session, value: session }, `${session}（上次的会话）`))
            }
            if (opts.length === 0) return h('option', { value: '' }, '（还没有会话日志）')
            return opts
          })()),
          h('button', { className: 'dtj_btn', onClick: () => setShowHistory(true) }, '历史会话'),
          h('button', { className: 'dtj_btn', onClick: onRefresh, disabled: busy }, '刷新'),
          h('button', { className: 'dtj_btn', onClick: () => onExport('md'), disabled: busy || session === '' }, '导出汇总'),
          h('button', { className: 'dtj_btn', onClick: () => onExport('all'), disabled: busy || session === '' }, '导出全部'),
          h('button', { className: 'dtj_btn dtj_btn_primary', onClick: onRetry, disabled: busy || session === '' }, '一键重试'),
          h('button', { className: 'dtj_btn', onClick: onRetryNew, disabled: busy || session === '' }, '新会话续跑'),
          h('button', { className: 'dtj_btn dtj_btn_danger', onClick: onAbandon, disabled: busy || session === '' }, '标记失败'),
          live ? h('span', { className: 'dtj_note' }, '● 实时（每 5 秒刷新）') : null,
        ),

        // 统计
        h('div', { className: 'dtj_cards' },
          h(Card, { n: counts.tasks, k: '任务总数' }),
          h(Card, { n: counts.done, k: '已完成', tone: 'good' }),
          h(Card, { n: counts.open, k: '未完成', tone: counts.open > 0 ? 'warn' : undefined }),
          h(Card, { n: counts.failures, k: '失败记录', tone: counts.failures > 0 ? 'bad' : undefined }),
          h(Card, { n: counts.models, k: '模型参数变更' }),
          h(Card, { n: counts.subagents, k: '子智能体委派' }),
        ),

        summary?.latestModel
          ? h('div', { className: 'dtj_note' }, `当前模型：${summary.latestModel}`)
          : null,
        // 文件路径区：把每一份日志和会话原始文件的位置都列出来，方便直接打开。
        h('div', { className: 'dtj_paths' },
          summary?.dir
            ? h('div', { className: 'dtj_pathrow' },
              h('b', null, '日志目录'), h('code', null, summary.dir))
            : null,
          summary?.sessionFile
            ? h('div', { className: 'dtj_pathrow' },
              h('b', null, '会话文件'),
              h('code', null, summary.sessionFile),
              summary.sessionFileExists === false ? h('span', null, '（尚未落盘）') : null)
            : null,
          ...Object.entries(summary?.files ?? {}).map(([k, v]) =>
            h('div', { key: k, className: 'dtj_pathrow' },
              h('b', null, k), h('code', null, v))),
        ),

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
