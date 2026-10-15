/**
 * dsh-task-journal 自测。
 *
 * 不依赖 DSH 宿主：用假的 ctx / session 事件驱动插件，
 * 验证落盘内容、追加语义、任务清单与 journal 工具。
 *
 *   node verify.mjs
 */
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

/** 最小假 ctx：收集订阅、支持 effect 与 inject。 */
function fakeCtx() {
  const handlers = []
  const tools = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(type, fn) { handlers.push([type, fn]); return () => {} },
    effect(fn) { return fn() },
    inject(services, cb) {
      if (!services.includes('tools')) return
      cb({ tools: { register: (t) => tools.push(t) } })
    },
    _emit(session, event) { for (const [t, fn] of handlers) if (t === 'session/event') fn(session, event) },
    _tools: tools,
  }
  return ctx
}

function fakeSession(cwd, id = 'session-test-1') {
  const appended = []
  return {
    id,
    header: { cwd, origin: undefined },
    append(...a) { appended.push(a) },
    _appended: appended,
  }
}

const userMsg = (text, kind = 'user') => ({
  type: 'user/message',
  seq: 1,
  time: Date.now(),
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind } },
})

const assistantMsg = (text) => ({
  type: 'assistant/message',
  seq: 2,
  time: Date.now(),
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } },
})

const toolResult = (tool, text, isError = false) => ({
  type: 'tool/result',
  seq: 3,
  time: Date.now(),
  data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', toolName: tool }, isError } },
})


const toolCall = (name, callId) => ({
  type: 'tool/call', seq: 5, time: Date.now(), data: { turn: 1, step: 1, callId, name, arguments: '{}' },
})

const toolResultWithCallId = (callId, text, isError = false) => ({
  type: 'tool/result', seq: 6, time: Date.now(),
  data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId }, toolCallId: callId, isError } },
})

const turnEnd = (kind = 'completed') => ({
  type: 'turn/end', seq: 4, time: Date.now(), data: { turn: 1, reason: { kind } },
})

const main = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
  console.log(`临时目录：${dir}\n`)

  // —— 用例 1：自动落盘（默认配置，写到 cwd/.dsh-journal）——
  console.log('用例 1：自动落盘')
  const ctx = fakeCtx()
  apply(ctx, { enabled: true, markdown: true, jsonl: true, recordAssistant: true })
  const s = fakeSession(dir)
  ctx._emit(s, userMsg('写一个把任务写到本地文件的插件'))
  ctx._emit(s, assistantMsg('我先建包定义，再写实现。'))
  ctx._emit(s, toolResult('bash', 'ok: created package.json'))
  ctx._emit(s, turnEnd('completed'))

  const outDir = join(dir, '.dsh-journal')
  // 等写队列排空（队列是 fire-and-forget，给事件循环几拍）
  await new Promise((r) => setTimeout(r, 300))

  ok(existsSync(outDir), '创建了 .dsh-journal 目录')
  const files = existsSync(outDir) ? await readdir(outDir) : []
  ok(files.some((f) => f.startsWith('journal-') && f.endsWith('.md')), '生成了 journal-*.md')
  ok(files.some((f) => f.startsWith('events-') && f.endsWith('.jsonl')), '生成了 events-*.jsonl')
  ok(files.some((f) => f.startsWith('tasks-') && f.endsWith('.md')), '生成了 tasks-*.md')

  const mdName = files.find((f) => f.startsWith('journal-') && f.endsWith('.md'))
  const md = mdName ? await readFile(join(outDir, mdName), 'utf8') : ''
  ok(md.includes('写一个把任务写到本地文件的插件'), 'Markdown 里有任务原文')
  ok(md.includes('我先建包定义，再写实现'), 'Markdown 里有助手产出')
  ok(md.includes('bash'), 'Markdown 里有工具名')
  ok(md.includes('轮次结束'), 'Markdown 里有轮次分隔')

  const taskName = files.find((f) => f.startsWith('tasks-') && f.endsWith('.md'))
  const tasks = taskName ? await readFile(join(outDir, taskName), 'utf8') : ''
  ok(tasks.includes('- [ ]'), '任务清单有未完成条目')
  ok(tasks.includes('写一个把任务写到本地文件的插件'), '任务清单有任务标题')

  const jsonlName = files.find((f) => f.startsWith('events-') && f.endsWith('.jsonl'))
  const jsonl = jsonlName ? await readFile(join(outDir, jsonlName), 'utf8') : ''
  const lines = jsonl.trim().split('\n').filter(Boolean)
  ok(lines.length >= 4, `JSONL 有 ${lines.length} 行事件`)
  ok(lines.every((l) => { try { JSON.parse(l); return true } catch { return false } }), 'JSONL 每行都是合法 JSON')
  ok(lines.some((l) => JSON.parse(l).type === 'task'), 'JSONL 含 task 事件')
  ok(lines.some((l) => JSON.parse(l).type === 'tool'), 'JSONL 含 tool 事件')

  // —— 用例 2：排除注入上下文，只记真人输入 ——
  console.log('\n用例 2：注入上下文不入任务清单')
  const before = tasks.length
  ctx._emit(s, userMsg('这是系统注入的上下文，不该算任务', 'system-prompt'))
  await new Promise((r) => setTimeout(r, 200))
  const afterTasks = taskName ? await readFile(join(outDir, taskName), 'utf8') : ''
  ok(afterTasks.length === before, '注入上下文没有被记成任务')

  // —— 用例 3：追加语义（不覆盖旧内容）——
  console.log('\n用例 3：追加不覆盖')
  const ctx2 = fakeCtx()
  apply(ctx2, { enabled: true, dir: join(dir, 'custom') })
  const s2 = fakeSession(join(dir, 'custom-cwd'), 'session-test-2')
  ctx2._emit(s2, userMsg('第一条'))
  await new Promise((r) => setTimeout(r, 150))
  ctx2._emit(s2, userMsg('第二条'))
  await new Promise((r) => setTimeout(r, 250))
  const cDir = join(dir, 'custom')
  const cFiles = existsSync(cDir) ? await readdir(cDir) : []
  const cMdName = cFiles.find((f) => f.startsWith('journal-') && f.endsWith('.md'))
  const cMd = cMdName ? await readFile(join(cDir, cMdName), 'utf8') : ''
  ok(cMd.includes('第一条') && cMd.includes('第二条'), '两次写入都保留（追加语义）')

  // —— 用例 4：自定义 dir（绝对路径）——
  console.log('\n用例 4：自定义输出目录')
  ok(cFiles.length > 0, '自定义 dir 生效（未写到默认位置）')
  ok(!existsSync(join(dir, 'custom-cwd', '.dsh-journal')), '自定义 dir 时不写默认位置')

  // —— 用例 5：journal 工具已注册且可执行 ——
  console.log('\n用例 5：journal 工具')
  const tool = ctx._tools.find((t) => t.name === 'journal')
  ok(tool !== undefined, 'journal 工具已注册')
  // defineTool 把 parameters 规范化为 JSON Schema（properties/required）。
  ok(tool?.parameters?.properties?.kind?.enum?.includes('task'), 'kind 参数含 task 枚举')
  ok(tool?.parameters?.required?.includes('text'), 'text 为必填参数')
  if (tool) {
    const s3 = fakeSession(dir, 'session-test-1') // 复用 writer
    const res = await tool.execute({ kind: 'result', text: '插件主体写完，等待安装。' }, { agent: { session: s3 }, signal: undefined })
    ok(typeof res.path === 'string' && res.bytes > 0, 'journal 工具返回 path 与 bytes')
    await new Promise((r) => setTimeout(r, 200))
    const md2 = mdName ? await readFile(join(outDir, mdName), 'utf8') : ''
    ok(md2.includes('插件主体写完，等待安装'), 'journal 工具的内容已落盘')
  }

  // —— 用例 6：子代理会话被排除 ——
  console.log('\n用例 6：子代理会话排除')
  const ctx3 = fakeCtx()
  apply(ctx3, { enabled: true, dir: join(dir, 'sub') })
  const sSub = { id: 'sub-1', header: { cwd: dir, origin: 'subagent' }, append() {} }
  ctx3._emit(sSub, userMsg('子代理的任务'))
  await new Promise((r) => setTimeout(r, 200))
  ok(!existsSync(join(dir, 'sub')), '子代理会话未产生日志')

  // —— 用例 7：禁用开关 ——
  console.log('\n用例 7：enabled=false')
  const ctx4 = fakeCtx()
  apply(ctx4, { enabled: false, dir: join(dir, 'off') })
  ctx4._emit(fakeSession(dir, 'off-1'), userMsg('不该被记录'))
  await new Promise((r) => setTimeout(r, 200))
  ok(!existsSync(join(dir, 'off')), '禁用时不落盘')

  // —— 用例 8：超长文本截断 ——
  console.log('\n用例 8：超长截断')
  const ctx5 = fakeCtx()
  apply(ctx5, { enabled: true, dir: join(dir, 'clip'), maxChars: 50 })
  const s5 = fakeSession(dir, 'clip-1')
  ctx5._emit(s5, userMsg('甲'.repeat(300)))
  await new Promise((r) => setTimeout(r, 250))
  const clipDir = join(dir, 'clip')
  const clFiles = existsSync(clipDir) ? await readdir(clipDir) : []
  const clName = clFiles.find((f) => f.startsWith('journal-') && f.endsWith('.md'))
  const clMd = clName ? await readFile(join(clipDir, clName), 'utf8') : ''
  ok(clMd.includes('已截断'), '超长文本被截断并标注')

  // —— 用例 9：工具名从 tool/call 映射（真实结构里 result 只带 callId）——
  console.log('\n用例 9：tool/call → tool/result 名字映射')
  const ctx9 = fakeCtx()
  apply(ctx9, { enabled: true, dir: join(dir, 'map') })
  const s9 = fakeSession(dir, 'map-1')
  ctx9._emit(s9, toolCall('read', 'call-abc'))
  ctx9._emit(s9, toolResultWithCallId('call-abc', 'file content'))
  await new Promise((r) => setTimeout(r, 300))
  const mapDir = join(dir, 'map')
  const mapFiles = existsSync(mapDir) ? await readdir(mapDir) : []
  const mapJsonl = mapFiles.find((f) => f.endsWith('.jsonl'))
  const mapTxt = mapJsonl ? await readFile(join(mapDir, mapJsonl), 'utf8') : ''
  const toolLine = mapTxt.trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).find((e) => e.type === 'tool')
  ok(toolLine?.tool === 'read', '工具名解析为 read（非 unknown）')

  // —— 用例 10：dsh-continue 也算任务，runtime-context 不算 ——
  console.log('\n用例 10：dsh-continue 计入任务、注入上下文排除')
  const ctx10 = fakeCtx()
  apply(ctx10, { enabled: true, dir: join(dir, 'kind') })
  const s10 = fakeSession(dir, 'kind-1')
  ctx10._emit(s10, userMsg('继续', 'dsh-continue'))
  ctx10._emit(s10, userMsg('【项目记忆】…', 'runtime-context'))
  ctx10._emit(s10, userMsg('真正的人话', 'user'))
  await new Promise((r) => setTimeout(r, 350))
  const kindDir = join(dir, 'kind')
  const kFiles = existsSync(kindDir) ? await readdir(kindDir) : []
  const kTask = kFiles.find((f) => f.startsWith('tasks-'))
  const kTxt = kTask ? await readFile(join(kindDir, kTask), 'utf8') : ''
  ok(kTxt.includes('继续'), 'dsh-continue 计入任务')
  ok(kTxt.includes('真正的人话'), '真人输入计入任务')
  ok(!kTxt.includes('项目记忆'), 'runtime-context 注入被排除')

  await rm(dir, { recursive: true, force: true })
  console.log(`\n结果：${pass} passed / ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('自测崩了：', e)
  process.exit(1)
})
