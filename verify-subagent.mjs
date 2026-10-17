#!/usr/bin/env node
/**
 * dsh-task-journal 子智能体功能自测。
 *
 *   node verify-subagent.mjs
 *
 * 覆盖：
 *   ① 目录模块本身（分类标签、归一化、自动发现、分组、HOME 遮蔽）
 *   ② 归档产物（catalog / entries / presets / src）与源码定位
 *   ③ host 半的 subagents-<sid>.md 记录（lifecycle 事件 + 委派工具调用）
 *   ④ 工具 subagent_catalog / subagent_save / subagent_run
 *   ⑤ HTTP 接口 /subagents/*
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

const HOME = homedir()
const CAT = await import('./lib/subagent-catalog.js')
const { apply } = await import('./lib/index.js')

// ————————————————————————— 假宿主 —————————————————————————

/** 假 ctx：收集 session/event 与 subagent 生命周期处理器、工具与 webServer。 */
function fakeCtx({ providers = [], tools = [] } = {}) {
  const handlers = []
  const lifecycle = []
  const registered = []
  const registrations = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(type, fn) {
      if (type === 'subagent/start' || type === 'subagent/end') lifecycle.push([type, fn])
      else handlers.push([type, fn])
      return () => {}
    },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'subagents') return { list: () => providers }
      if (name === 'tools') return { list: () => tools }
      return undefined
    },
    inject(services, cb) {
      if (services.includes('tools')) {
        cb({ tools: { register: (t) => { registered.push(t) } } })
      }
      if (services.includes('webServer')) {
        cb({
          effect: (f) => f(),
          webServer: {
            register({ kind, path, handler }) { registrations.push({ kind, path }); return () => {} },
            _handler: null,
          },
        })
      }
      if (services.includes('agents')) cb({ on: () => () => {} })
    },
    agents: { get: () => undefined, list: () => [] },
    _emit(session, event) { for (const [t, fn] of handlers) if (t === 'session/event') fn(session, event) },
    _life(type, info) { for (const [t, fn] of lifecycle) if (t === type) fn(info) },
    _tools: registered,
    _registrations: registrations,
  }
  return ctx
}

function fakeSession(cwd, id = 'sg-session-1') {
  return { id, header: { cwd, origin: undefined }, append() {} }
}

const userMsg = (text) => ({
  type: 'user/message', seq: 1, time: Date.now(),
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

const toolCall = (name, callId = 'c1') => ({
  type: 'tool/call', seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId, name, arguments: '{}' },
})

const settle = (ms = 320) => new Promise((r) => setTimeout(r, ms))

// ————————————————————————— 主流程 —————————————————————————

const main = async () => {
  // ————— 一、目录模块 —————
  console.log('一、目录模块：分类与标签')

  const all = CAT.builtinEntries()
  ok(all.length >= 8, `内置目录有 ${all.length} 个条目`)

  const everyHasCategory = all.every((e) => CAT.CATEGORIES[e.category] !== undefined)
  ok(everyHasCategory, '每个条目都有合法分类')

  const everyHasTag = all.every((e) => Array.isArray(e.tags) && e.tags.length > 0)
  ok(everyHasTag, '每个条目都带标签')

  const ids = new Set(all.map((e) => e.id))
  ok(ids.size === all.length, '条目 id 唯一')

  ok(CAT.normalizeCategory('前端') === 'frontend', '中文分类名可归一化')
  ok(CAT.normalizeCategory('testing') === 'testing', '分类 id 原样通过')
  ok(CAT.normalizeCategory('测试与质量') === 'testing', '分类中文全称可归一化')
  ok(CAT.normalizeCategory('完全没见过的词') === CAT.DEFAULT_CATEGORY, '未知分类落到默认值而不是丢弃')
  ok(CAT.normalizeCategory('这件事要写很多小说') === 'writing', '关键词能猜出写作分类')

  const groups = CAT.groupByCategory(all)
  ok(groups.length > 1, `按分类分成 ${groups.length} 组`)
  ok(groups.every((g) => g.entries.length > 0), '没有空分组')
  const sum = groups.reduce((n, g) => n + g.entries.length, 0)
  ok(sum === all.length, '分组后条目不丢不重')

  console.log('\n二、运行期自动发现')
  const merged = CAT.mergeObserved({ providers: ['spawn', 'my-custom-backend'], tools: ['subagent', 'my_tool'] }, all)
  ok(merged.some((e) => e.id === 'subagent-spawn' && e.availability === 'available'),
    '已知 provider 被标记为可用')
  ok(merged.some((e) => e.id === 'provider:my-custom-backend'),
    '未知 provider 新建条目而不是丢弃')
  ok(merged.some((e) => e.id === 'tool:my_tool'), '未知工具新建条目')
  ok(merged.find((e) => e.id === 'provider:my-custom-backend')?.source === 'discovered',
    '新条目标记为运行期发现')
  const noEvidence = CAT.mergeObserved({}, all)
  ok(noEvidence.every((e) => e.availability === undefined),
    '没有观察到的事实时不臆造可用性')

  console.log('\n三、HOME 路径遮蔽')
  const home = '/home/someuser'
  ok(CAT.redactHome('/home/someuser/a/b.md', home) === '~/a/b.md', '前缀替换成 ~')
  ok(CAT.redactHome('/home/someuser', home) === '~', 'HOME 自身替换成 ~')
  ok(CAT.redactHome('/other/x', home) === '/other/x', '非 HOME 路径不动')
  const embedded = CAT.redactHome('/opt/home/someuser/x', home)
  ok(!embedded.includes(home) && embedded.includes('~'), '嵌在更长路径里的 HOME 也被遮蔽')
  const deep = CAT.redactDeep({ a: '/home/someuser/x', b: ['/home/someuser/y'], c: 1, d: null }, home)
  ok(deep.a === '~/x' && deep.b[0] === '~/y' && deep.c === 1 && deep.d === null, '递归遮蔽且不破坏非字符串')

  // ————— 三点五、凭据遮蔽 —————
  console.log('\n三点五、凭据遮蔽')
  // 测试用假凭据：拼出来，免得这段源码本身被扫描器当成真凭据。
  const fakePat = 'ghp' + '_' + 'a'.repeat(36)
  const fakeFine = 'github_pat' + '_' + 'b'.repeat(30)
  const fakeAws = 'AKIA' + 'Q'.repeat(16)
  const fakeOpenAi = 'sk-' + 'c'.repeat(32)
  const scrubbed = CAT.redactSecrets(`token=${fakePat} end`)
  ok(!scrubbed.includes(fakePat), '经典 PAT 被遮蔽')
  ok(scrubbed.includes('<redacted:github-pat>'), '遮蔽处留下标签')
  ok(scrubbed.startsWith('token=') && scrubbed.endsWith(' end'), '遮蔽只换密钥，不动周边文本')
  ok(!CAT.redactSecrets(fakeFine).includes(fakeFine), '细粒度 PAT 被遮蔽')
  ok(!CAT.redactSecrets(fakeAws).includes(fakeAws), 'AWS key 被遮蔽')
  ok(!CAT.redactSecrets(fakeOpenAi).includes(fakeOpenAi), 'sk- 风格 key 被遮蔽')
  const pem = `-----BEGIN ${'RSA '}PRIVATE KEY-----\nMIIabc\n-----END ${'RSA '}PRIVATE KEY-----`
  const pemOut = CAT.redactSecrets(pem)
  ok(!pemOut.includes('MIIabc'), 'PEM 私钥正文被整块遮蔽')
  const plainHex = '49151d784b5f0a1b2c3d4e5f6a7b8c9d0e1f2a3b'
  ok(CAT.redactSecrets(`commit ${plainHex}`) === `commit ${plainHex}`,
    '无前缀十六进制串不动（不误伤提交哈希）')
  ok(CAT.redactSecrets('') === '' && CAT.redactSecrets(null) === '', '空输入安全')
  const twice = CAT.redactSecrets(`a=${fakePat} b=${fakePat}`)
  ok(twice === 'a=<redacted:github-pat> b=<redacted:github-pat>', '同段文本里的多个密钥都被遮蔽')
  ok(CAT.redactSecrets(twice) === twice, '遮蔽幂等，重复过闸不叠加')
  const deepScrub = CAT.redactSecretsDeep({ k: fakePat, arr: [fakeAws], n: 7, nil: null })
  ok(deepScrub.k === '<redacted:github-pat>' && deepScrub.arr[0] === '<redacted:aws-key>',
    '递归遮蔽对象/数组')
  ok(deepScrub.n === 7 && deepScrub.nil === null, '递归遮蔽不破坏非字符串')

  // ————— 四、归档产物 —————
  console.log('\n四、归档产物')
  const root = await mkdtemp(join(tmpdir(), 'dtj-sub-'))
  const logDir = join(root, '.dsh-journal')
  await mkdir(logDir, { recursive: true })

  const r = await CAT.writeCatalog(logDir, merged, { home })
  ok(existsSync(join(r.dir, 'catalog.json')), '写出 catalog.json')
  ok(existsSync(join(r.dir, 'catalog.md')), '写出 catalog.md')
  const catJson = JSON.parse(await readFile(join(r.dir, 'catalog.json'), 'utf8'))
  ok(catJson.count === merged.length, 'catalog.json 条目数与输入一致')
  ok(catJson.entries.every((e) => e.category !== undefined), 'catalog.json 每条都带分类')

  const entDir = join(r.dir, 'entries')
  const entFiles = await readdir(entDir)
  ok(entFiles.filter((n) => n.endsWith('.md')).length === merged.length, '每个条目一份 Markdown')
  ok(entFiles.filter((n) => n.endsWith('.json')).length === merged.length, '每个条目一份 JSON')

  const mdFiles = entFiles.filter((n) => n.endsWith('.md'))
  const sample = await readFile(join(entDir, mdFiles[0]), 'utf8')
  ok(sample.includes('## 功能') && sample.includes('## 怎么用'), '条目 Markdown 有功能与用法小节')
  ok(sample.includes('## 什么时候用'), '条目 Markdown 有使用场景')

  const preDir = join(r.dir, 'presets')
  const presetIds = await readdir(preDir)
  ok(presetIds.length === merged.length, '每个条目一个预设目录')
  const onePreset = join(preDir, presetIds[0])
  ok(existsSync(join(onePreset, 'preset.yml')), '预设含 preset.yml')
  ok(existsSync(join(onePreset, 'agent.cordis.yml')), '预设含 agent.cordis.yml')
  const py = await readFile(join(onePreset, 'preset.yml'), 'utf8')
  ok(/^name: /m.test(py) && /^description: /m.test(py) && /^category: /m.test(py), 'preset.yml 字段完整')
  const cy = await readFile(join(onePreset, 'agent.cordis.yml'), 'utf8')
  ok(cy.includes('provider') || cy.includes('name:'), 'agent.cordis.yml 给出组装方式')

  // 归档里不得泄露 HOME
  const catMd = await readFile(join(r.dir, 'catalog.md'), 'utf8')
  ok(!catMd.includes(home), 'catalog.md 不含传入的 HOME 前缀')

  console.log('\n五、源码归档：找得到就归档，找不到就如实说')
  const srcDir = join(root, 'fake-src')
  await mkdir(join(srcDir, 'pkg', 'src'), { recursive: true })
  await writeFile(join(srcDir, 'pkg', 'package.json'), JSON.stringify({ name: '@x/demo-sub' }), 'utf8')
  await writeFile(join(srcDir, 'pkg', 'src', 'index.ts'), 'export const a = 1\n', 'utf8')
  await writeFile(join(srcDir, 'pkg', 'src', 'note.md'), '# note\n', 'utf8')
  await mkdir(join(srcDir, 'pkg', 'src', 'node_modules'), { recursive: true })
  await writeFile(join(srcDir, 'pkg', 'src', 'node_modules', 'skip.ts'), 'nope\n', 'utf8')

  const fakeEntries = [
    { id: 'demo', package: '@x/demo-sub' },
    { id: 'missing', package: '@x/not-here' },
    { id: 'builtinish', package: 'DSH workflow' },
  ]
  const sr = await CAT.archiveSources(logDir, fakeEntries, { roots: [srcDir], home })
  ok(sr.ok === 1 && sr.total === 3, `1 个归档成功、2 个如实失败（${sr.ok}/${sr.total}）`)
  ok(existsSync(join(sr.dir, 'demo', 'index.ts')), '归档到了真实源码文件')
  ok(existsSync(join(sr.dir, 'demo', 'note.md')), 'source 目录里的 md 也归档')
  ok(!existsSync(join(sr.dir, 'demo', 'node_modules')), '跳过 node_modules')
  const srcNote = await readFile(join(sr.dir, 'SOURCE.md'), 'utf8')
  ok(srcNote.includes('未归档'), 'SOURCE.md 记录了未归档的条目')
  ok(srcNote.includes('不是 npm 包名'), '对非 npm 包名给出准确原因')
  const missResult = sr.results.find((x) => x.id === 'missing')
  ok(!missResult.ok && Array.isArray(missResult.searched), '找不到时列出找过的位置')

  // 回归：宽根目录 + 深层目标包。深度优先会在钻进第一个子目录深处时耗尽预算，
  // 从而漏掉旁边就有的目标；必须用逐层扫描才能找到。
  const wideRoot = join(root, 'wide-src')
  await mkdir(join(wideRoot, 'a', 'b1', 'c1', 'd1'), { recursive: true })
  await mkdir(join(wideRoot, 'a', 'b2', 'c2', 'd2'), { recursive: true })
  await mkdir(join(wideRoot, 'zz-target', 'src'), { recursive: true })
  await writeFile(join(wideRoot, 'zz-target', 'package.json'), JSON.stringify({ name: '@x/deep-target' }), 'utf8')
  await writeFile(join(wideRoot, 'zz-target', 'src', 'index.ts'), 'export const deep = 1\n', 'utf8')
  const deepRes = await CAT.archiveSources(logDir, [{ id: 'deep', package: '@x/deep-target' }],
    { roots: [wideRoot], home })
  ok(deepRes.ok === 1 && existsSync(join(deepRes.dir, 'deep', 'index.ts')),
    '宽根目录里也能找到目标包（逐层扫描，不被深处子目录吃掉预算）')

  // ————— 六、host 半：使用记录 —————
  console.log('\n六、host 半：子智能体使用记录')
  const ctx = fakeCtx({ providers: ['spawn'], tools: ['subagent'] })
  apply(ctx, { enabled: true, notify: false, notifyOnFailure: false })
  const s = fakeSession(root)

  ctx._emit(s, userMsg('把审计任务派给子智能体'))
  ctx._life('subagent/start', { runId: 'run-1', provider: 'spawn', id: 'child-1', local: true })
  await settle(60)
  ctx._life('subagent/end', { runId: 'run-1', provider: 'spawn', id: 'child-1', local: true, stopReason: 'completed' })
  ctx._emit(s, toolCall('spawn_teammate', 'call-9'))
  await settle()

  const hostLogDir = join(root, '.dsh-journal')
  const subPath = join(hostLogDir, 'subagents-sg-session-1.md')
  ok(existsSync(subPath), '生成了 subagents-<sid>.md')
  const subText = existsSync(subPath) ? await readFile(subPath, 'utf8') : ''
  ok(subText.includes('## S1'), '记录了第 1 次委派')
  ok(subText.includes('分类：**后端**'), '记录里带分类标签')
  ok(subText.includes('spawn'), '记录里带 provider')
  ok(subText.includes('child-1'), '记录里带子会话 id')
  ok(subText.includes('completed'), '记录里带结束结果')
  ok(!subText.includes(home), '使用记录里不含 HOME 前缀')
  ok(subText.includes('推断：事件未带父会话 id'),
    '事件没带父会话 id 时，明确标注归属是推断的')

  const jl = join(hostLogDir, 'events-sg-session-1.jsonl')
  const jlText = existsSync(jl) ? await readFile(jl, 'utf8') : ''
  const evs = jlText.split('\n').filter((l) => l.trim() !== '').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  ok(evs.some((e) => e.type === 'subagent_start'), 'jsonl 里有 subagent_start')
  const startEv = evs.find((e) => e.type === 'subagent_start')
  ok(startEv?.attributed === false, '推断的归属在 jsonl 里标为 attributed=false')
  ok(typeof startEv?.session === 'string', 'jsonl 记录归属到的会话')
  ok(evs.some((e) => e.type === 'subagent_end' && e.stopReason === 'completed'), 'jsonl 里有 subagent_end 及结果')
  ok(evs.some((e) => e.type === 'subagent_tool' && e.tool === 'spawn_teammate'),
    '委派工具调用也被记下（即使没有 lifecycle 事件）')
  const teammate = evs.find((e) => e.type === 'subagent_tool' && e.tool === 'spawn_teammate')
  ok(teammate?.category === 'devops', '工具调用带上它的分类标签')

  const taskMd = join(hostLogDir, 'journal-sg-session-1.md')
  const taskText = existsSync(taskMd) ? await readFile(taskMd, 'utf8') : ''
  ok(taskText.includes('子智能体'), '主日志里也有子智能体痕迹')

  // 任务记录里也要写上子智能体的使用情况：任务清单该行带 🤖 标记。
  const taskListPath = join(hostLogDir, 'tasks-sg-session-1.md')
  const taskList = existsSync(taskListPath) ? await readFile(taskListPath, 'utf8') : ''
  const t1 = taskList.split('\n').find((l) => l.includes('[`T1`]')) ?? ''
  ok(t1.includes('🤖'), '任务清单的任务行标注了子智能体使用')
  ok(t1.includes('spawn 子智能体'), '标注里带子智能体名字')

  // 重复派同一个子智能体：只累加计数，不重复追加名字。
  ctx._emit(s, userMsg('再来一轮同样的委派'))
  ctx._life('subagent/start', { runId: 'run-2', provider: 'spawn', id: 'child-2', local: true })
  await settle()
  const taskList2 = existsSync(taskListPath) ? await readFile(taskListPath, 'utf8') : ''
  const t2 = taskList2.split('\n').find((l) => l.includes('[`T2`]')) ?? ''
  ok(t2.includes('🤖 spawn 子智能体'), '第二条任务也标注了')

  // 子智能体种类不同就并列写，不互相覆盖。
  ctx._emit(s, userMsg('换个类型再派一次'))
  ctx._life('subagent/start', { runId: 'run-3', provider: 'spawn', id: 'child-3', local: true })
  ctx._life('subagent/start', { runId: 'run-4', provider: 'acp', id: 'child-4', local: true })
  await settle()
  const taskList3 = existsSync(taskListPath) ? await readFile(taskListPath, 'utf8') : ''
  const t3 = taskList3.split('\n').find((l) => l.includes('[`T3`]')) ?? ''
  ok(t3.includes('spawn 子智能体') && t3.includes('ACP 子智能体'),
    '同一条任务用两类子智能体时都记下来')

  // 同一任务里再派一次同一个（含正则元字符的名字）：只累加计数，不写第二遍。
  ctx._emit(s, userMsg('同一任务里重复派'))
  ctx._life('subagent/start', { runId: 'run-5', provider: 'subagent', id: 'c5', local: true })
  await settle()
  const list4 = existsSync(taskListPath) ? await readFile(taskListPath, 'utf8') : ''
  const t4a = list4.split('\n').find((l) => l.includes('[`T4`]')) ?? ''
  ok(t4a.includes('🤖'), '第四条任务标注了')

  console.log('\n七、关闭开关时不记录')
  const ctxOff = fakeCtx()
  apply(ctxOff, { enabled: true, recordSubagents: false, notify: false, notifyOnFailure: false })
  const sOff = fakeSession(root, 'sg-session-off')
  ctxOff._life('subagent/start', { runId: 'r', provider: 'spawn', id: 'c', local: true })
  await settle(120)
  ok(!existsSync(join(root, '.dsh-journal', 'subagents-sg-session-off.md')),
    'recordSubagents=false 时不写使用记录')

  // ————— 八、工具 —————
  console.log('\n八、模型工具')
  const toolNames = ctx._tools.map((t) => t.name)
  ok(toolNames.includes('subagent_catalog'), '注册了 subagent_catalog')
  ok(toolNames.includes('subagent_save'), '注册了 subagent_save')
  ok(toolNames.includes('subagent_run'), '注册了 subagent_run')

  const catTool = ctx._tools.find((t) => t.name === 'subagent_catalog')
  const catRes = await catTool.execute({}, { agent: { session: s }, signal: undefined })
  ok(catRes.count > 0, `subagent_catalog 返回 ${catRes.count} 个条目`)
  ok(Array.isArray(catRes.categories) && catRes.categories.includes('frontend'), '返回分类清单')
  ok(catRes.groups.length > 0 && catRes.groups[0].entries.length > 0, '按分类分组返回')

  const catFront = await catTool.execute({ category: '前端' }, { agent: { session: s }, signal: undefined })
  const isFrontOnly = catFront.groups.every((g) => g.id === 'frontend')
  ok(catFront.count === 0 || isFrontOnly, '按中文分类名过滤生效')
  ok(catFront.count === 0 ? catFront.groups.length === 0 : true, '前端暂无条目时返回空分组')

  const saveTool = ctx._tools.find((t) => t.name === 'subagent_save')
  const saveRes = await saveTool.execute({}, { agent: { session: s }, signal: undefined })
  ok(saveRes.count > 0, `subagent_save 归档了 ${saveRes.count} 个条目`)
  ok(!saveRes.dir.includes(home), '工具返回的目录已遮蔽 HOME')
  const saveSrc = await saveTool.execute({ sources: true }, { agent: { session: s }, signal: undefined })
  ok(typeof saveSrc.sources === 'string', 'subagent_save sources=true 时回报源码归档结果')

  const runTool = ctx._tools.find((t) => t.name === 'subagent_run')
  const runRes = await runTool.execute(
    { id: 'subagent-fork', prompt: '审查这段实现', description: '审阅改动' },
    { agent: { session: s }, signal: undefined },
  )
  ok(runRes.ok === true, 'subagent_run 按规格登记成功')
  ok(typeof runRes.how === 'string' && runRes.how.includes('subagent_fork'), '返回可直接复制的调用单')
  const runBad = await runTool.execute({ id: '不存在', prompt: 'x' }, { agent: { session: s }, signal: undefined })
  ok(runBad.ok === false && runBad.message.includes('subagent_catalog'), '未知 id 时给出可行做法')

  await settle()
  const subText2 = await readFile(subPath, 'utf8')
  ok(subText2.includes('按规格调用'), 'subagent_run 也写进使用记录')

  // ————— 八点五、写入即脱敏（端到端） —————
  console.log('\n八点五、写入即脱敏')
  // 这是真实事故的回归：用户在对话里贴了一个 PAT，日志把它原样写进了
  // journal/tasks/events 三类文件，导出还再打包一份。凭据绝不能落盘。
  const ctxSec = fakeCtx()
  apply(ctxSec, { enabled: true, notify: false, notifyOnFailure: false })
  const sSec = fakeSession(root, 'sg-session-secret')
  const leaked = 'ghp' + '_' + 'd'.repeat(36)
  ctxSec._emit(sSec, userMsg(`我的 token 是 ${leaked} ，帮我配一下`))
  await settle()
  const secDir = join(root, '.dsh-journal')
  const secFiles = ['journal-sg-session-secret.md', 'tasks-sg-session-secret.md',
    'events-sg-session-secret.jsonl']
  for (const f of secFiles) {
    const p = join(secDir, f)
    const body = existsSync(p) ? await readFile(p, 'utf8') : ''
    ok(body.includes('<redacted:github-pat>'), `${f} 里留下了遮蔽标记`)
    ok(!body.includes(leaked), `${f} 里没有明文凭据`)
    ok(body.includes('帮我配一下'), `${f} 里保留其余原文`)
  }
  // 工具输出也走同一条路：失败原因、stdout 里同样可能带密钥。
  ctxSec._emit(sSec, {
    type: 'tool/result', seq: 3, time: Date.now(),
    data: { message: { content: [{ type: 'text', text: `export TOKEN=${leaked}` }], isError: true, source: { name: 'bash' } } },
  })
  await settle()
  const jlSec = await readFile(join(secDir, 'events-sg-session-secret.jsonl'), 'utf8')
  ok(!jlSec.includes(leaked), '工具输出里的凭据也没落盘')
  ok(jlSec.includes('<redacted:github-pat>'), '工具输出也留下遮蔽标记')
  // 导出是二次泄漏点：老文件没洗干净时，导出等于重新打包一份。
  const expTool = ctxSec._tools.find((t) => t.name === 'journal_export')
  const expRes = await expTool.execute({}, { agent: { session: sSec }, signal: undefined })
  const expPath = expRes.files[0]
  const expBody = await readFile(expPath, 'utf8')
  ok(!expBody.includes(leaked), '导出文件里没有明文凭据')

  // ————— 九、HTTP 接口 —————
  console.log('\n九、HTTP 接口')
  const { handler: realHandler, emit: apiEmit } = await loadApiHandler(root)
  // 先跑一轮事件，让 host 半为该会话建立 writer（真实环境里也是这样）。
  apiEmit('api-sub-1', userMsg('把审计派给子智能体'))
  apiEmit('api-sub-1', toolCall('subagent', 'api-call-1'))
  await settle()
  const server = createServer((req, res) => realHandler(req, res))
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const port = server.address().port
  const url = (p) => `http://127.0.0.1:${port}/api/dsh-journal${p}`
  const getJson = async (p) => (await fetch(url(p))).json()
  const postJson = async (p, body) => (await fetch(url(p), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json()

  const c1 = await getJson('/subagents/catalog')
  ok(c1.count > 0, `GET /subagents/catalog 返回 ${c1.count} 个条目`)
  ok(Array.isArray(c1.groups) && c1.groups.length > 0, '接口返回分组')
  ok(Array.isArray(c1.categories) && c1.categories.some((x) => x.id === 'testing'), '接口返回分类清单')

  const c2 = await getJson('/subagents/catalog?category=backend')
  const onlyBackend = c2.groups.every((g) => g.id === 'backend')
  ok(onlyBackend || c2.count === 0, '分类参数生效')

  const e1 = await getJson('/subagents/entry?id=subagent-fork')
  ok(typeof e1.markdown === 'string' && e1.markdown.includes('## 怎么用'), 'GET /subagents/entry 返回条目规格')
  const e2r = await fetch(url('/subagents/entry?id=nope'))
  ok(e2r.status === 404, '未知条目返回 404')

  const a1 = await getJson('/subagents/archive')
  // 本用例的工作目录在 /tmp 下，不在 HOME 里，所以路径应保持原样；
  // 「HOME 前缀被换成 ~」由第三节的 redactHome 单测覆盖。
  ok(typeof a1.dir === 'string' && !a1.dir.includes(HOME), `归档目录不含 HOME 前缀（${a1.dir}）`)
  ok(a1.exists === true, '归档状态报告已存在')

  const sv = await postJson('/subagents/save', { sources: false })
  ok(sv.ok === true && sv.count > 0, `POST /subagents/save 归档 ${sv.count} 个条目`)
  ok(Array.isArray(sv.files) && sv.files.every((f) => !f.includes(home)), '返回的文件路径都不含 HOME')

  const sys = await postJson('/subagents/sources', {})
  ok(sys.ok === true && typeof sys.total === 'number', 'POST /subagents/sources 返回归档结果')
  ok(Array.isArray(sys.results) && sys.results.every((x) => x.ok === false || !String(x.from).includes(home)),
    '源码归档结果里不含 HOME')

  const sumRes = await getJson('/summary')
  ok(sumRes.counts.subagents !== undefined, 'summary 增加子智能体计数')
  ok(!JSON.stringify(sumRes).includes(home), 'summary 响应不含 HOME 前缀')

  const subTxt = await getJson('/subagents')
  ok(typeof subTxt.text === 'string', 'GET /subagents 返回使用记录文本')

  server.close()

  await rm(root, { recursive: true, force: true })
  console.log(`\n结果：${pass} passed / ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

/** 起插件并取出它注册的 API handler（走真实的 inject 流程）。 */
async function loadApiHandler(cwd) {
  const mod = await import('./lib/index.js')
  const handlers = []
  const eventHandlers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on: (type, fn) => { if (type === 'session/event') eventHandlers.push(fn); return () => {} },
    effect: (f) => f(),
    get: () => undefined,
    inject: (services, cb) => {
      if (services.includes('webServer')) {
        cb({
          effect: (f) => f(),
          webServer: { register({ handler }) { handlers.push(handler); return () => {} } },
        })
      }
      if (services.includes('tools')) cb({ tools: { register() {} } })
      if (services.includes('agents')) cb({ on: () => () => {} })
    },
    agents: { get: () => undefined, list: () => [] },
  }
  mod.apply(ctx, { enabled: true, dir: join(cwd, '.dsh-journal'), notify: false, notifyOnFailure: false })
  const emit = (sid, event) => {
    const session = { id: sid, header: { cwd, origin: undefined }, append() {} }
    for (const fn of eventHandlers) fn(session, event)
  }
  return { handler: handlers[0], emit, mod }
}

main().catch((e) => {
  console.error(`\n❌ 自测异常：${e?.stack ?? e}`)
  process.exit(1)
})
