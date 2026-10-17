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
.dtj_steps { display:flex; flex-wrap:wrap; gap:8px; }
.dtj_step {
  display:flex; align-items:center; gap:5px; font-size:12px; opacity:.55;
  border:1px solid var(--dsh-border, rgba(128,128,128,.28)); border-radius:20px;
  padding:3px 11px; background:var(--dsh-surface, rgba(128,128,128,.05));
}
.dtj_step[data-on="1"] {
  opacity:1; border-color:var(--dsh-accent, #4a7dff);
  background:color-mix(in srgb, var(--dsh-accent, #4a7dff) 14%, transparent);
}
.dtj_step b { font-weight:600; }
/* 镜像源页签：两栏。左栏固定宽、右栏自适应；窄屏时上下堆叠。 */
.dtj_two { display:flex; gap:12px; align-items:flex-start; }
.dtj_col { min-width:0; display:flex; flex-direction:column; gap:6px; }
.dtj_col_left { flex:0 0 210px; max-height:60vh; overflow:auto; }
.dtj_authbar {
  padding:6px 0 8px; border-bottom:1px solid var(--dsh-border, rgba(128,128,128,.2));
  margin-bottom:8px;
}
.dtj_col_right { flex:1 1 auto; }
.dtj_colhead {
  font-size:12px; font-weight:600; opacity:.75; padding:2px 0 4px;
  border-bottom:1px solid var(--dsh-border, rgba(128,128,128,.22));
}
@media (max-width: 720px) {
  .dtj_two { flex-direction:column; }
  .dtj_col_left { flex:1 1 auto; max-height:32vh; width:100%; }
  .dtj_col_right { width:100%; }
}
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

    /**
     * 会话修复页签：把「扫描 → 诊断 → 修复 → 复验」四步流水线做成可点的一屏。
     *
     * 设计取舍：后端的四步是**有顺序依赖**的（不扫描就没有可修的对象），
     * 所以界面按步骤显式呈现，并在每一步结束后把下一步按钮点亮——
     * 让人看得见「现在到哪一步」，而不是一个笼统的「一键修复」黑盒。
     * 修会话是有风险的动作，试运行（dry-run）是默认，落盘要再点一次。
     */
    function RepairPanel({ session, onToast }) {
      const [scan, setScan] = useState(null)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [detail, setDetail] = useState(null)
      const [verify, setVerify] = useState(null)
      const say = onToast

      const doScan = useCallback(async (force) => {
        setBusy('scan')
        try {
          const r = await api(`/repair/scan${force ? '?force=1' : ''}`)
          setScan(r)
          setErr('')
          say(`扫描完成：${r.scanned} 个会话，破损 ${r.broken} 个（${r.ms}ms）`, r.broken === 0)
        } catch (e) { setErr(e.message) }
        finally { setBusy('') }
      }, [say])

      const doFix = useCallback(async (row, apply) => {
        setBusy(apply ? `apply:${row.session}` : `dry:${row.session}`)
        try {
          const r = await api('/repair/fix', { session: row.session, apply })
          setDetail({ row, r })
          setErr('')
          if (r.applied) {
            say(`已修复 ${row.session}（改动 ${r.changed} 处）`, true)
            await doScan(true)
            const v = await api('/repair/verify')
            setVerify(v)
            say(v.ok ? '复验通过：全部会话可加载' : `复验未通过：仍有 ${v.broken} 个破损`, v.ok)
          } else if (r.error !== undefined) {
            say(r.error, false)
          } else if (r.projected) {
            say(`试运行：将改动 ${r.changed} 处，修复后${r.after?.ok ? '校验通过' : '仍有问题'}（未落盘）`, r.after?.ok === true)
          }
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setBusy('') }
      }, [doScan, say])

      const doFixAll = useCallback(async (apply) => {
        setBusy('all')
        try {
          const r = await api('/repair/fix-all', { apply, force: true })
          setVerify(r.verify ?? null)
          setErr('')
          const msg = apply
            ? `批量修复完成：${r.applied}/${r.attempted} 个${r.verify ? `，复验${r.verify.ok ? '通过' : `仍有 ${r.verify.broken} 个破损`}` : ''}`
            : `试运行：${r.attempted} 个可自动修复（未落盘）`
          say(msg, apply ? (r.verify?.ok ?? true) : true)
          await doScan(true)
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setBusy('') }
      }, [doScan, say])

      const doVerify = useCallback(async () => {
        setBusy('verify')
        try {
          const v = await api('/repair/verify')
          setVerify(v)
          setErr('')
          say(v.ok ? `复验通过：${v.scanned} 个会话全部可加载` : `复验未通过：${v.broken} 个破损`, v.ok)
        } catch (e) { setErr(e.message) }
        finally { setBusy('') }
      }, [say])

      const broken = (scan?.results ?? []).filter((r) => !r.ok)

      // 步骤条：把四步流水线的当前状态画出来。
      // 故意写成返回元素的普通函数（而不是局部组件）：局部组件每次渲染都是
      // 新类型，React 会整棵重挂载，输入框与滚动位置都会丢。
      const stepsBar = () => {
        const steps = [
          ['1', '扫描', scan !== null],
          ['2', '诊断', scan !== null],
          ['3', '修复', scan !== null && scan.broken === 0],
          ['4', '复验', verify?.ok === true],
        ]
        return h('div', { className: 'dtj_steps' }, steps.map(([n, label, done]) =>
          h('div', { key: n, className: 'dtj_step', 'data-on': done ? '1' : '0' },
            h('b', null, n), ' ', label)))
      }

      return h('div', { className: 'dtj_root' },
        h('div', { className: 'dtj_bar' },
          h('button', { className: 'dtj_btn dtj_btn_primary', onClick: () => doScan(true), disabled: busy !== '' },
            busy === 'scan' ? '扫描中…' : '① 扫描全部会话'),
          h('button', { className: 'dtj_btn', onClick: () => doFixAll(false), disabled: busy !== '' || broken.length === 0 },
            busy === 'all' ? '处理中…' : '③ 批量试运行'),
          h('button', { className: 'dtj_btn dtj_btn_primary', onClick: () => doFixAll(true), disabled: busy !== '' || (scan?.autoFixable ?? 0) === 0 },
            '③ 批量修复并复验'),
          h('button', { className: 'dtj_btn', onClick: doVerify, disabled: busy !== '' },
            busy === 'verify' ? '复验中…' : '④ 复验'),
          scan !== null ? h('span', { className: 'dtj_note' }, `上次扫描 ${scan.ms}ms${scan.cached ? '（含缓存）' : '（全量）'}`) : null,
        ),

        stepsBar(),

        h('div', { className: 'dtj_note' },
          '会话日志破损（例如历史加载报 “lacks an identified message”）通常由插件写入的消息缺少 role/id 造成，可自动修复。'
          + '修复只补 role/id，不改内容、不改历史顺序；落盘前自动备份，落盘后由宿主后端真读一次，读不过就自动回滚。'),

        err !== '' ? h('div', { className: 'dtj_err' }, err) : null,

        scan === null
          ? h('div', { className: 'dtj_empty' }, '还没扫描。点「① 扫描全部会话」体检一遍。')
          : h('div', null,
            h('div', { className: 'dtj_cards' },
              h(Card, { n: scan.scanned, k: '会话总数' }),
              h(Card, { n: scan.healthy, k: '完好', tone: 'good' }),
              h(Card, { n: scan.broken, k: '破损', tone: scan.broken > 0 ? 'bad' : undefined }),
              h(Card, { n: scan.autoFixable, k: '可自动修复', tone: scan.autoFixable > 0 ? 'warn' : undefined }),
              h(Card, { n: scan.manualOnly, k: '需人工', tone: scan.manualOnly > 0 ? 'warn' : undefined }),
            ),

            broken.length === 0
              ? h('div', { className: 'dtj_empty' }, '全部会话归档完好，无需修复。')
              : h('div', { className: 'dtj_hist' }, broken.map((r) =>
                h('div', { key: r.session, className: 'dtj_hrow' },
                  h('div', { className: 'h1' }, r.session),
                  h('div', { className: 'h2' },
                    h('span', { className: `dtj_badge${r.repairable ? ' ok' : ''}` }, r.repairable ? '可自动修复' : '需人工'),
                    h('span', null, `${r.issueCount} 处问题`),
                    h('span', null, `${r.eventCount} 事件`),
                    h('span', null, `来源：${Object.keys(r.producers ?? {}).join('、') || '未知'}`),
                  ),
                  r.issues?.slice(0, 3).map((i, k) =>
                    h('div', { key: k, className: 'dtj_meta' }, `seq ${i.seq ?? '-'}｜${i.reason}`)),
                  h('div', { className: 'dtj_sbtns' },
                    h('button', {
                      className: 'dtj_btn',
                      disabled: busy !== '' || !r.repairable,
                      onClick: () => doFix(r, false),
                    }, busy === `dry:${r.session}` ? '试运行中…' : '② 试运行（不落盘）'),
                    h('button', {
                      className: 'dtj_btn dtj_btn_primary',
                      disabled: busy !== '' || !r.repairable,
                      onClick: () => doFix(r, true),
                    }, busy === `apply:${r.session}` ? '修复中…' : '③ 修复并复验'),
                  ),
                ))),
          ),

        detail !== null
          ? h('div', { className: 'dtj_pane' },
            h('pre', { className: 'dtj_pre' },
              `${detail.row.session}\n`
              + `修复前：${detail.r.before?.issueCount ?? 0} 处问题（可自动 ${detail.r.before?.autoCount ?? 0}，需人工 ${detail.r.before?.manualCount ?? 0}）\n`
              + `改动：${detail.r.changed ?? 0} 处${detail.r.applied ? '（已落盘）' : detail.r.projected ? '（试运行，未落盘）' : ''}\n`
              + `修复后：${detail.r.after?.ok ? '校验通过' : `仍有 ${detail.r.after?.issueCount ?? '?'} 处问题`}\n`
              + (detail.r.hostVerify ? `宿主复验：${detail.r.hostVerify.ok === true ? '通过' : detail.r.hostVerify.ok === false ? '被拒（已回滚）' : detail.r.hostVerify.status === 'unavailable' ? '宿主未提供服务，已用内置校验' : '无法判定（环境问题，未回滚）'}\n` : '')
              + (detail.r.backup ? `备份：${detail.r.backup}\n` : '')
              + (detail.r.changedEvents ?? []).slice(0, 20).map((e) =>
                `  seq ${e.seq}｜${e.type}｜来源 ${e.producer}｜补 id=${e.added?.id ?? '-'} role=${e.added?.role ?? '-'}`).join('\n'),
            ))
          : null,

        verify !== null
          ? h('div', { className: verify.ok ? 'dtj_note' : 'dtj_err' },
            verify.ok
              ? `④ 复验：${verify.scanned} 个会话全部可加载。`
              : `④ 复验未通过：${verify.scanned} 个中仍有 ${verify.broken} 个破损（可自动修复 ${verify.autoFixable}，需人工 ${verify.manualOnly}）。`)
          : null,
      )
    }

    /**
     * 镜像源页签：两栏。
     *
     * 左栏是工具清单（npm / pnpm / yarn / pip / Docker / APT / GitHub），
     * 右栏是选中项的镜像列表 —— 每个镜像可测速、可一键切换，顶部有「清除镜像」。
     *
     * 设计取舍：
     *  - **看不清后果的事不做**。切换会改真实配置，所以按钮旁边直接写清
     *    要改哪个文件；改之前服务器端还会自动备份。
     *  - **改不了的要说清楚为什么**。Docker 与 APT 在 /etc 下需要 root，
     *    这里不给按钮，只给命令与原因 —— 假装能改比不能改更糟。
     *  - **测速逐条来**，且把「超时」与「失败」分开显示：超时说明可能连得上
     *    但很慢，失败说明根本不通，这两者对选择的意义完全不同。
     */
    function MirrorsPanel({ onToast }) {
      const [entries, setEntries] = useState(null)
      const [sel, setSel] = useState('')
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [probes, setProbes] = useState({})
      const [custom, setCustom] = useState('')
      const [last, setLast] = useState(null)
      // 提权：密码只放内存，用完即清；绝不写进 localStorage。
      const [auth, setAuth] = useState({ authorized: false })
      const [pw, setPw] = useState('')
      const [pre, setPre] = useState(null)
      const say = onToast

      const load = useCallback(async () => {
        setBusy('load')
        try {
          const [r, a] = await Promise.all([api('/mirrors'), api('/mirrors/auth')])
          setEntries(r.entries ?? [])
          setAuth(a)
          setSel((prev) => prev !== '' ? prev : (r.entries?.[0]?.id ?? ''))
          setErr('')
        } catch (e) { setErr(e.message) }
        finally { setBusy('') }
      }, [])

      const doAuthorize = useCallback(async () => {
        if (pw === '') return
        setBusy('auth')
        try {
          const r = await api('/mirrors/authorize', { password: pw })
          setAuth(r)
          // 输完立刻从内存里清掉，不留着。
          setPw('')
          say('已授权提权（密码未保存）', true)
          setErr('')
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setBusy('') }
      }, [pw, say])

      const doDeauthorize = useCallback(async () => {
        setBusy('deauth')
        try {
          await api('/mirrors/deauthorize', {})
          setAuth({ authorized: false })
          setPw('')
          say('已取消提权授权', true)
        } catch (e) { setErr(e.message) }
        finally { setBusy('') }
      }, [say])

      const doPreflight = useCallback(async (id) => {
        setBusy(`pre:${id}`)
        try {
          const r = await api(`/mirrors/preflight?id=${encodeURIComponent(id)}`)
          setPre(r)
          setErr('')
        } catch (e) { setErr(e.message) }
        finally { setBusy('') }
      }, [])

      const doApplyRoot = useCallback(async (entry, url) => {
        if (!window.confirm(`以 root 修改 ${entry.file}？\n\n目标：${url}\n\n会先备份该文件。`)) return
        setBusy(`root:${entry.id}`)
        try {
          const r = await api('/mirrors/apply-root', { id: entry.id, url, confirm: true })
          if (r.ok === true) {
            const parts = [`已以 root 修改：${entry.label}`]
            if (r.backup) parts.push(`备份：${r.backup}`)
            if (r.restarted) parts.push(r.restarted.ok ? '已重启服务' : `重启失败：${r.restarted.reason ?? ''}`)
            say(parts.join('\n'), true)
            await load()
          } else {
            say(r.reason ?? '没改成', false)
            if (r.needsAuth === true) setAuth({ authorized: false })
          }
          setErr('')
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setBusy('') }
      }, [load, say])

      useEffect(() => { load() }, [load])

      const current = (entries ?? []).find((x) => x.id === sel) ?? null

      const doProbe = useCallback(async (id, url) => {
        setBusy(url ? `probe-url:${url}` : `probe:${id}`)
        try {
          const r = await api('/mirrors/probe', url ? { url, id } : { id })
          if (url) {
            setLast({ kind: 'custom', url, r })
            const stat = r.ok && r.reachable ? `${r.ms}ms` : (r.timeout ? '超时' : '不可达')
            say(`${url}：${stat}`, r.ok === true && r.reachable === true)
          } else {
            setProbes((prev) => ({ ...prev, [id]: r }))
            const okCount = (r.results ?? []).filter((x) => x.ok && x.reachable).length
            say(`测速完成：${r.label}，${okCount}/${(r.results ?? []).length} 个可用`, okCount > 0)
          }
          setErr('')
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setBusy('') }
      }, [say])

      const doApply = useCallback(async (entry, url) => {
        const target = url === null ? '清除镜像（回到原源）' : `切到 ${url}`
        if (!window.confirm(`${entry.label}：${target}？\n\n将修改：${entry.file}`)) return
        setBusy(`apply:${entry.id}`)
        try {
          const r = await api('/mirrors/apply', { id: entry.id, url, confirm: true })
          if (r.ok === true) {
            const b = r.backup ? `\n备份：${r.backup}` : ''
            say(`已${r.cleared ? '清除镜像' : '切换'}：${entry.label}${b}${r.note ? `\n${r.note}` : ''}`, true)
            await load()
          } else {
            say(r.reason ?? '没改成', false)
          }
          setErr('')
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setBusy('') }
      }, [load, say])

      const fmtVal = (v) => Array.isArray(v) ? `${v.length} 个镜像` : (v ?? '（未设置）')
      const probeOf = (id, url) => {
        const p = probes[id]
        if (!p || !p.results) return null
        return p.results.find((x) => x.url === url) ?? null
      }
      const statText = (x) => {
        if (x === null || x === undefined) return ''
        if (x.ok && x.reachable) return `${x.ms}ms`
        if (x.timeout) return '超时'
        return '不可达'
      }

      return h('div', { className: 'dtj_root' },
        h('div', { className: 'dtj_bar' },
          h('button', { className: 'dtj_btn', onClick: load, disabled: busy !== '' },
            busy === 'load' ? '读取中…' : '刷新'),
          h('span', { className: 'dtj_note' }, '切换会修改真实配置文件，改前自动备份。'),
        ),

        // 提权授权条：只在需要时有意义，所以常驻但写清代价。
        h('div', { className: 'dtj_authbar' },
          auth.authorized === true
            ? h('div', { className: 'dtj_actions' },
              h('span', { className: 'dtj_badge ok' }, '已授权提权'),
              h('span', { className: 'dtj_note' },
                `密码只在内存，未写入任何文件；闲置 ${Math.round((auth.expiresInMs ?? 0) / 1000)} 秒后自动失效`),
              h('button', { className: 'dtj_btn dtj_btn_danger', onClick: doDeauthorize, disabled: busy !== '' },
                busy === 'deauth' ? '处理中…' : '取消授权'))
            : h('div', { className: 'dtj_actions' },
              h('span', { className: 'dtj_note' }, '改 Docker / APT 需要 root：'),
              h('input', {
                className: 'dtj_search',
                type: 'password',
                placeholder: 'sudo 密码（只留在内存，不保存）',
                value: pw,
                autoComplete: 'off',
                onChange: (e) => setPw(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') doAuthorize() },
              }),
              h('button', { className: 'dtj_btn dtj_btn_primary', onClick: doAuthorize, disabled: busy !== '' || pw === '' },
                busy === 'auth' ? '验证中…' : '授权'))),

        err !== '' ? h('div', { className: 'dtj_err' }, err) : null,

        entries === null
          ? h('div', { className: 'dtj_empty' }, busy === 'load' ? '读取中…' : '')
          : h('div', { className: 'dtj_two' },
            // —— 左栏：工具清单 ——
            h('div', { className: 'dtj_col dtj_col_left' },
              h('div', { className: 'dtj_colhead' }, `工具（${entries.length}）`),
              entries.map((e) => h('div', {
                key: e.id,
                className: 'dtj_hrow',
                'data-on': sel === e.id ? '1' : '0',
                onClick: () => setSel(e.id),
              },
              h('div', { className: 'h1' }, e.label),
              h('div', { className: 'h2' },
                h('span', { className: `dtj_badge${e.usingMirror ? ' ok' : ''}` },
                  e.usingMirror ? e.mirrorLabel : (e.current ? '原源' : '未设置')),
                e.needsRoot ? h('span', { className: 'dtj_tag disc' }, '需 root') : null,
              ),
              h('div', { className: 'dtj_meta' }, fmtVal(e.current)),
              ))),

            // —— 右栏：选中项的详情 ——
            h('div', { className: 'dtj_col dtj_col_right' },
              current === null
                ? h('div', { className: 'dtj_empty' }, '左边选一项。')
                : h('div', null,
                  h('div', { className: 'dtj_colhead' }, current.label),
                  h('div', { className: 'dtj_paths' },
                    h('div', { className: 'dtj_pathrow' },
                      h('b', null, '当前'),
                      h('code', null, fmtVal(current.current))),
                    h('div', { className: 'dtj_pathrow' },
                      h('b', null, '文件'),
                      h('code', null, current.file)),
                  ),

                  current.applyHint
                    ? h('div', { className: 'dtj_meta' }, `⚠ ${current.applyHint}`)
                    : null,

                  h('div', { className: 'dtj_actions' },
                    h('button', {
                      className: 'dtj_btn',
                      disabled: busy !== '' || !current.mirrors.length,
                      onClick: () => doProbe(current.id),
                    }, busy === `probe:${current.id}` ? '测速中…' : '全部测速'),
                    current.requiresAuth === true
                      ? h('button', {
                        className: 'dtj_btn',
                        disabled: busy !== '',
                        onClick: () => doPreflight(current.id),
                      }, busy === `pre:${current.id}` ? '检查中…' : '环境预检')
                      : null,
                    current.canApply && current.official !== null && current.usingMirror
                      ? h('button', {
                        className: 'dtj_btn dtj_btn_danger',
                        disabled: busy !== '',
                        onClick: () => doApply(current, null),
                      }, busy === `apply:${current.id}` ? '处理中…' : '清除镜像（回原源）')
                      : null,
                  ),

                  h('div', { className: 'dtj_note' }, '镜像地址：'),
                  (current.mirrors ?? []).map((m) => {
                    const pr = probeOf(current.id, m.url)
                    const isCur = (() => {
                      const norm = (x) => String(x ?? '').replace(/\/+$/, '').toLowerCase()
                      return norm(current.current) === norm(m.url)
                    })()
                    return h('div', { key: m.url, className: 'dtj_sitem' },
                      h('div', { className: 'top' },
                        h('span', { className: 'nm' }, m.label),
                        isCur ? h('span', { className: 'dtj_tag avail' }, '当前在用') : null,
                        pr !== null ? h('span', {
                          className: `dtj_tag${pr.ok && pr.reachable ? ' avail' : ''}`,
                        }, statText(pr)) : null,
                      ),
                      h('div', { className: 'dtj_meta' }, h('code', null, m.url)),
                      h('div', { className: 'dtj_sbtns' },
                        h('button', {
                          className: 'dtj_btn',
                          disabled: busy !== '',
                          onClick: () => doProbe(current.id, m.url),
                        }, busy === `probe-url:${m.url}` ? '测中…' : '测速'),
                        current.canApply && !isCur
                          ? h('button', {
                            className: 'dtj_btn dtj_btn_primary',
                            disabled: busy !== '',
                            onClick: () => doApply(current, m.url),
                          }, busy === `apply:${current.id}` ? '切换中…' : '用这个')
                          : null,
                        // 需要提权的项：先预检（只读，不要密码），再以 root 应用。
                        current.requiresAuth === true && !isCur
                          ? h('button', {
                            className: 'dtj_btn dtj_btn_primary',
                            disabled: busy !== '' || auth.authorized !== true,
                            title: auth.authorized === true ? '' : '需要先在上方输入密码授权',
                            onClick: () => doApplyRoot(current, m.url),
                          }, busy === `root:${current.id}` ? '应用中…' : (auth.authorized === true ? '以 root 应用' : '需先授权'))
                          : null,
                      ),
                    )
                  }),

                  pre !== null && pre.id === current.id
                    ? h('div', { className: `dtj_sitem` },
                      h('div', { className: 'top' },
                        h('span', { className: 'nm' }, '环境预检'),
                        h('span', { className: `dtj_tag${pre.ok ? ' avail' : ' disc'}` }, pre.ok ? '可以继续' : '有前置条件不满足'),
                      ),
                      (pre.checks ?? []).map((c) =>
                        h('div', { key: c.id, className: 'dtj_meta' },
                          `${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? `：${c.detail}` : ''}`)))
                    : null,

                  // 新加镜像地址 + 测速
                  h('div', { className: 'dtj_note' }, '添加并测速一个新地址：'),
                  h('div', { className: 'dtj_actions' },
                    h('input', {
                      className: 'dtj_search',
                      placeholder: 'https://example.com/…',
                      value: custom,
                      onChange: (e) => setCustom(e.target.value),
                      onKeyDown: (e) => { if (e.key === 'Enter' && custom.trim() !== '') doProbe(current.id, custom.trim()) },
                    }),
                    h('button', {
                      className: 'dtj_btn dtj_btn_primary',
                      disabled: busy !== '' || custom.trim() === '',
                      onClick: () => doProbe(current.id, custom.trim()),
                    }, busy === `probe-url:${custom.trim()}` ? '测中…' : '测速'),
                  ),
                  last !== null && last.kind === 'custom'
                    ? h('div', { className: 'dtj_sitem' },
                      h('div', { className: 'top' },
                        h('span', { className: 'nm' }, last.url),
                        h('span', { className: `dtj_tag${last.r.ok && last.r.reachable ? ' avail' : ''}` },
                          last.r.ok && last.r.reachable ? `${last.r.ms}ms` : (last.r.timeout ? '超时' : '不可达')),
                      ),
                      h('div', { className: 'dtj_meta' }, `HTTP ${last.r.status ?? '-'}｜探测 ${last.r.probeUrl ?? last.url}`),
                      last.r.reason ? h('div', { className: 'dtj_meta' }, last.r.reason) : null,
                    )
                    : null,
                ),
            ),
          ),
      )
    }

    /**
     * 后台日志页签：读 DSH 的启动诊断日志，出错时弹提醒，并能生成修复方案。
     *
     * 设计取舍：
     *  - **主动提醒**：进页面就读一次，发现最近一次启动失败就弹出来 ——
     *    后台出过事而用户不知道，是这类日志最常见的浪费。
     *  - **诊断与修复分离**：先把「什么毛病、打算怎么修」摆出来，
     *    按钮才出现。修系统状态不该是一个看不清后果的点击。
     *  - 只读的探查（看谁占着端口）和会改状态的（重装依赖）在文案上分开，
     *    不让人误点。
     */
    function LogsPanel({ onToast }) {
      const [data, setData] = useState(null)
      const [detail, setDetail] = useState(null)
      const [plan, setPlan] = useState(null)
      const [fixing, setFixing] = useState('')
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const say = onToast
      // 只在本次挂载里提醒一次，避免每次重渲染都弹。
      const alerted = React.useRef(false)

      const load = useCallback(async (silent) => {
        if (silent !== true) setBusy('load')
        try {
          const r = await api('/logs?limit=30')
          setData(r)
          setErr('')
          // 发现错误就弹：这是这个页签存在的意义。
          if (alerted.current !== true && r.alert !== null && r.alert !== undefined) {
            alerted.current = true
            say(`${r.alert.level === 'error' ? '⚠ ' : ''}${r.alert.text}`, r.alert.level !== 'error')
          }
        } catch (e) { setErr(e.message) }
        finally { setBusy('') }
      }, [say])

      // 进页面自动查一次：后台出过事要主动说，不能等人来点。
      useEffect(() => { load(true) }, [load])

      const open = useCallback(async (name) => {
        setBusy(`open:${name}`)
        try {
          const [r, p] = await Promise.all([
            api(`/logs/read?name=${encodeURIComponent(name)}`),
            api(`/logs/plan?name=${encodeURIComponent(name)}`),
          ])
          setDetail(r)
          setPlan(p)
          setErr('')
        } catch (e) { setErr(e.message); setDetail(null); setPlan(null) }
        finally { setBusy('') }
      }, [])

      const doFix = useCallback(async (step) => {
        if (detail === null) return
        const ask = step.command
          ? `执行这一步？\n\n${step.label}\n\n将会运行：\n${step.command}`
          : `执行这一步？\n\n${step.label}`
        if (!window.confirm(ask)) return
        setFixing(step.action)
        try {
          const r = await api('/logs/fix', {
            name: detail.name, action: step.action, confirm: true,
          })
          setPlan({ ...plan, verification: r.verification, lastResult: r })
          const v = r.verification
          if (v?.verdict === 'fixed') say(`修好了：${v.checks.filter((c) => c.ok).map((c) => c.label).join('、')}`, true)
          else if (v?.verdict === 'still-broken') say(`还没修好：${v.checks.filter((c) => !c.ok).map((c) => c.detail).join('；')}`, false)
          else say(r.result?.ok === true ? '这一步执行完了' : `没成功：${r.result?.reason ?? '未知原因'}`, r.result?.ok === true)
          await load(true)
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setFixing('') }
      }, [detail, plan, load, say])

      const files = data?.files ?? []
      const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)
      const fmtTime = (iso) => {
        if (!iso) return ''
        const d = new Date(iso)
        return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN')
      }

      return h('div', { className: 'dtj_root' },
        h('div', { className: 'dtj_bar' },
          h('button', { className: 'dtj_btn dtj_btn_primary', onClick: () => load(false), disabled: busy !== '' },
            busy === 'load' ? '读取中…' : '重新检查'),
          data?.exists === true
            ? h('span', { className: 'dtj_note' }, `共 ${data.total} 份日志｜${data.dir}`)
            : null,
        ),

        h('div', { className: 'dtj_note' },
          '这些是 DSH 启动失败时落盘的诊断快照（$DSH_HOME/logs）。'
          + '后台出过事而没人知道，是这类文件最常见的浪费 —— 所以进页面会主动检查一次。'),

        err !== '' ? h('div', { className: 'dtj_err' }, err) : null,

        data === null
          ? h('div', { className: 'dtj_empty' }, busy === 'load' ? '读取中…' : '还没读取。')
          : data.exists !== true
            ? h('div', { className: 'dtj_empty' }, `日志目录不存在：${data.dir}\n（DSH 只在启动失败时写这些文件）`)
            : h('div', null,
              // 最近一次的状态单独摆出来：这是最该被看见的一条信息。
              data.latest !== null && data.latest !== undefined
                ? h('div', { className: data.latest.broken ? 'dtj_err' : 'dtj_note' },
                  data.latest.broken
                    ? `⚠ 最近一次启动失败：${data.latest.startupError?.message ?? '原因见日志'}（${fmtTime(data.latest.name.slice(8, 31))}）`
                    : '最近一次启动没有失败记录。',
                )
                : null,

              data.latest?.issues?.length > 0
                ? h('div', { className: 'dtj_meta' },
                  '诊断：' + data.latest.issues.map((i) => i.title).join('、'),
                  '　（点下面那份日志看详情与修复方案）')
                : null,

              h('div', { className: 'dtj_hist' }, files.map((f) =>
                h('div', {
                  key: f.name,
                  className: 'dtj_hrow',
                  'data-on': detail?.name === f.name ? '1' : '0',
                  onClick: () => open(f.name),
                },
                h('div', { className: 'h1' }, f.name),
                h('div', { className: 'h2' },
                  h('span', null, fmtTime(f.at)),
                  h('span', null, fmtSize(f.bytes)),
                  detail?.name === f.name ? h('span', { className: 'dtj_badge' }, '已选中') : null,
                )))),
            ),

        detail !== null
          ? h('div', { className: 'dtj_pane' },
            h('div', { className: 'dtj_steps' },
              h('span', { className: 'dtj_step', 'data-on': '1' }, `DSH ${detail.header.dshVersion ?? '未知'}`),
              h('span', { className: 'dtj_step', 'data-on': detail.broken ? '1' : '0' }, detail.broken ? '启动失败' : '无失败'),
              h('span', { className: 'dtj_step' }, `告警 ${detail.warnCount}`),
              h('span', { className: 'dtj_step', 'data-on': detail.errorCount > 0 ? '1' : '0' }, `错误 ${detail.errorCount}`),
            ),

            detail.failedPlugins.length > 0
              ? h('div', { className: 'dtj_sgrow' }, detail.failedPlugins.map((p) =>
                h('div', { key: p.id, className: 'dtj_sgroup' },
                  h('div', { className: 'dtj_sghead' },
                    h('span', { className: 't' }, p.id),
                    p.required ? h('span', { className: 'dtj_tag' }, '必装') : null,
                    h('span', { className: 'd' }, p.packages.join('、') || '包名未记录'),
                  ),
                  p.errors.slice(0, 5).map((e, k) =>
                    h('div', { key: k, className: 'dtj_sitem' }, h('div', { className: 'sm' }, e))),
                )))
              : null,

            (detail.issues ?? []).length > 0
              ? h('div', null,
                h('div', { className: 'dtj_note' }, '诊断结论：'),
                detail.issues.map((i) =>
                  h('div', { key: i.id, className: 'dtj_sitem' },
                    h('div', { className: 'nm' }, i.title),
                    h('div', { className: 'sm' }, i.explain))))
              : h('div', { className: 'dtj_note' }, '没有认得出的故障（可能只是告警，或日志里没记下原因）。'),

            plan !== null && (plan.steps ?? []).length > 0
              ? h('div', null,
                h('div', { className: 'dtj_note' }, '修复方案（勾选执行，每一步都会再问一次）：'),
                plan.steps.map((step) => h('div', { key: step.action, className: 'dtj_sitem' },
                  h('div', { className: 'top' },
                    h('span', { className: 'nm' }, step.label),
                    h('span', { className: 'dtj_tag' }, step.action),
                  ),
                  step.command ? h('div', { className: 'dtj_meta' }, `$ ${step.command}`) : null,
                  step.why ? h('div', { className: 'use' }, step.why) : null,
                  h('div', { className: 'dtj_sbtns' },
                    h('button', {
                      className: 'dtj_btn dtj_btn_primary',
                      disabled: fixing !== '',
                      onClick: () => doFix(step),
                    }, fixing === step.action ? '执行中…' : '执行这一步')),
                )))
              : null,

            (detail.issues ?? []).some((i) => i.fixes.some((f) => f.kind === 'manual'))
              ? h('div', null,
                h('div', { className: 'dtj_note' }, '需要人做的：'),
                detail.issues.flatMap((i) => i.fixes.filter((f) => f.kind === 'manual')).map((f, k) =>
                  h('div', { key: k, className: 'dtj_meta' }, `· ${f.label}${f.why ? ` —— ${f.why}` : ''}`)))
              : null,

            plan?.verification !== undefined
              ? h('div', { className: plan.verification.verdict === 'fixed' ? 'dtj_note' : 'dtj_err' },
                plan.verification.verdict === 'fixed'
                  ? '复查：已修好（以实时证据为准）。'
                  : plan.verification.verdict === 'still-broken'
                    ? '复查：还没修好。'
                    : '复查：无法判定（这份日志没有可验证的实时证据）。',
                plan.verification.checks.map((c) =>
                  h('div', { key: c.id, className: 'dtj_meta' }, `${c.ok ? '✓' : '✗'} ${c.label}：${c.detail ?? ''}`)))
              : null,
          )
          : null,
      )
    }

    /**
     * 插件更新页签：看已安装插件有没有新版本，需要时一键升级。
     *
     * 设计取舍：DSH 的插件市场只**报告** update-available，升级要自己
     * 「先移除、再安装」。移除之后没有回退，所以这里：
     *  - 把「当前版本 → 目标版本」摆在按钮前面，不做黑盒一键；
     *  - 兼容性不过的包单独标出来并禁用按钮，不让它走到移除那一步；
     *  - 本机链接/仓库来源的包不参与（它们没有 registry 版本可升）。
     */
    function UpdatesPanel({ onToast }) {
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [log, setLog] = useState(null)
      const say = onToast

      const load = useCallback(async () => {
        setBusy('load')
        try {
          const r = await api('/updates')
          setData(r)
          setErr(r.ok === true ? '' : (r.reason ?? '插件更新不可用'))
        } catch (e) { setErr(e.message) }
        finally { setBusy('') }
      }, [])

      useEffect(() => { load() }, [load])

      const doUpdate = useCallback(async (row) => {
        const target = row.target?.version ?? ''
        if (!window.confirm(`升级 ${row.name}\n\n${row.version ?? '未知'} → ${target}\n\n会先移除旧版，再安装新版本。确定继续？`)) return
        setBusy(`up:${row.name}`)
        try {
          const r = await api('/updates/apply', { name: row.name, confirm: true })
          setLog({ row, r })
          if (r.ok === true) {
            const note = r.application === 'restart-required' ? '（需要重启 DSH 才生效）' : ''
            say(`已把 ${r.name} 从 ${r.from ?? '未知'} 升到 ${r.to ?? '未知'}${note}`, true)
            await load()
          } else {
            say(r.reason ?? '升级未完成', false)
          }
          setErr('')
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setBusy('') }
      }, [load, say])

      const statusTag = (row) => {
        if (row.updatable) return '可更新'
        const s = row.market?.status
        if (s === 'installed') return '已是最新'
        if (s === 'local') return '本地来源'
        if (s === 'different-version') return '版本不同'
        if (s === 'provided') return '随安装提供'
        return '未知'
      }

      const counts = data?.counts ?? {}

      return h('div', { className: 'dtj_root' },
        h('div', { className: 'dtj_bar' },
          h('button', { className: 'dtj_btn dtj_btn_primary', onClick: load, disabled: busy !== '' },
            busy === 'load' ? '检查中…' : '检查更新'),
          data !== null && data.ok === true
            ? h('span', { className: 'dtj_note' },
              `版本来源：${data.source === 'market' ? '插件市场' : `npm registry（${data.registry ?? ''}）`}`
              + (data.runtime ? `｜DSH 运行时 ${data.runtime}` : ''))
            : null,
        ),

        h('div', { className: 'dtj_note' },
          'DSH 的插件市场只报告「有更新」，升级要自己「先移除、再安装」。这一步在这里做掉。'
          + '装哪个版本由版本来源决定；新版本声明了 engines.dsh 而当前运行时不满足时，这里会拦下不升 —— '
          + '因为移除之后没有回退，装不上就把插件弄丢了。'),

        err !== '' ? h('div', { className: 'dtj_err' }, err) : null,

        data === null
          ? h('div', { className: 'dtj_empty' }, busy === 'load' ? '检查中…' : '还没检查。点「检查更新」。')
          : data.ok !== true
            ? h('div', { className: 'dtj_empty' }, `插件更新不可用：${data.reason ?? '未知原因'}`)
            : h('div', null,
              h('div', { className: 'dtj_cards' },
                h(Card, { n: counts.installed, k: '已安装插件' }),
                h(Card, { n: counts.updatable, k: '可更新', tone: counts.updatable > 0 ? 'warn' : undefined }),
                h(Card, { n: counts.appliable, k: '可一键升级', tone: counts.appliable > 0 ? 'good' : undefined }),
                h(Card, { n: counts.blocked, k: '被兼容性拦下', tone: counts.blocked > 0 ? 'bad' : undefined }),
              ),

              data.market !== true
                ? h('div', { className: 'dtj_note' },
                  `插件市场未装配（${data.marketReason ?? ''}），已改用 npm registry 比对版本。`)
                : null,

              h('div', { className: 'dtj_hist' }, (data.plugins ?? []).map((p) =>
                h('div', { key: p.name, className: 'dtj_hrow', style: { cursor: 'default' } },
                  h('div', { className: 'h1' }, p.name),
                  h('div', { className: 'h2' },
                    h('span', { className: `dtj_badge${p.updatable ? '' : ' ok'}` }, statusTag(p)),
                    h('span', null, `当前 ${p.version ?? '未知'}`),
                    p.updatable ? h('span', null, `→ ${p.market.latestVersion}`) : null,
                    h('span', null, p.enabled ? '已启用' : '未启用'),
                    p.removable ? null : h('span', null, '不可移除'),
                  ),
                  p.blocked !== null && p.blocked !== undefined
                    ? h('div', { className: 'dtj_meta' }, `⚠ 未升级：${p.blocked}`)
                    : null,
                  p.market?.note !== undefined
                    ? h('div', { className: 'dtj_meta' }, p.market.note)
                    : null,
                  p.updatable
                    ? h('div', { className: 'dtj_sbtns' },
                      h('button', {
                        className: 'dtj_btn dtj_btn_primary',
                        disabled: busy !== '' || !p.removable,
                        onClick: () => doUpdate(p),
                      }, busy === `up:${p.name}` ? '升级中…' : `升级到 ${p.market.latestVersion}`))
                    : null,
                ))),
            ),

        log !== null
          ? h('div', { className: 'dtj_pane' },
            h('pre', { className: 'dtj_pre' },
              `${log.row.name}\n`
              + `${log.row.version ?? '未知'} → ${log.row.target?.version ?? '未知'}\n`
              + (log.r.ok === true
                ? `结果：已升级${log.r.application === 'restart-required' ? '（需要重启 DSH 才生效）' : ''}\n`
                : `结果：未完成 —— ${log.r.reason ?? '未知原因'}\n`)
              + (log.r.spec ? `安装方式：${log.r.spec}\n` : '')
              + (log.r.steps ?? []).map((s) =>
                `- ${s.step}：${s.result?.application ?? '?'}${s.result?.version ? `（${s.result.version}）` : ''}${s.result?.error?.code ? `｜${s.result.error.code}` : ''}`).join('\n')))
          : null,
      )
    }

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
        ['repair', '会话修复'],
        ['updates', '插件更新'],
        ['logs', '后台日志'],
        ['mirrors', '镜像源'],
      ]

      const body = useMemo(() => {
        // 会话修复页签：把「扫描 → 诊断 → 修复 → 复验」做成可点的一屏。
        if (tab === 'repair') {
          return h(RepairPanel, { session, onToast: say })
        }
        // 插件更新页签：面向整个 profile，与当前选中的会话无关。
        if (tab === 'updates') {
          return h(UpdatesPanel, { onToast: say })
        }
        // 后台日志页签：读 $DSH_HOME/logs，发现故障就弹提醒。
        if (tab === 'logs') {
          return h(LogsPanel, { onToast: say })
        }
        // 镜像源页签：左右两栏 —— 左边是工具清单，右边是选中项的镜像与测速。
        if (tab === 'mirrors') {
          return h(MirrorsPanel, { onToast: say })
        }
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

      // 会话修复与插件更新都是跨会话的操作（前者面向整库，后者面向整个 profile，
      // 都与当前选中的那个会话无关），所以它们不套用上面的会话工具条与统计卡，
      // 只保留页签导航。
      if (tab === 'repair' || tab === 'updates' || tab === 'logs' || tab === 'mirrors') {
        return h('div', { className: 'dtj_root' },
          h('div', { className: 'dtj_tabs' },
            tabs.map(([id, label]) => h('button', {
              key: id, className: 'dtj_tab', 'data-on': tab === id ? '1' : '0',
              onClick: () => setTab(id),
            }, label))),
          body,
          h(Toast, { toast, onDone: () => setToast(null) }),
        )
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
