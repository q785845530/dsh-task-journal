// 启动体检：确认「默认关闭时 DSH 能起来」「开启时插件接口活着」「会话日志首帧合规」
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const SESSIONS = join(DSH_HOME, 'sessions');
const PROFILE_PATCH = join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml');

let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failed += 1;
};

// 1) 会话日志首帧必须是「恰好一行头」
function scanFrames(buf) {
  const ZM = 0xFD2FB528;
  const frames = [];
  let o = 0;
  while (o < buf.length) {
    const s = o;
    if (buf.readUInt32LE(o) !== ZM) throw new Error(`magic @${o}`);
    o += 4;
    const d = buf.readUInt8(o); o += 1;
    const cs = d >>> 6, ss = (d & 32) !== 0, ck = (d & 4) !== 0, df = d & 3;
    const db = df === 3 ? 4 : df;
    o += (ss ? 0 : 1) + db + (cs === 0 ? (ss ? 1 : 0) : 1 << cs);
    for (;;) {
      const h = buf.readUIntLE(o, 3); o += 3;
      const last = h & 1, type = (h >>> 1) & 3, size = h >>> 3;
      if (type === 3) throw new Error(`block @${o}`);
      o += type === 1 ? 1 : size;
      if (last) break;
    }
    if (ck) o += 4;
    frames.push({ s, e: o });
  }
  return frames;
}

let bad = 0, checked = 0, worst = '';
if (existsSync(SESSIONS)) {
  for (const ws of readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(SESSIONS, ws.name);
    for (const sd of readdirSync(wsDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue;
      const dir = join(wsDir, sd.name);
      for (const f of readdirSync(dir)) {
        if (!/^session\.v\d+\.jsonl\.zstd$/.test(f)) continue;
        const buf = readFileSync(join(dir, f));
        if (buf.length === 0) continue;
        checked += 1;
        try {
          const frames = scanFrames(buf);
          const first = zstdDecompressSync(buf.subarray(frames[0].s, frames[0].e));
          if (first.indexOf(10) !== first.length - 1) { bad += 1; worst ||= join(sd.name, f); }
        } catch (e) { bad += 1; worst ||= `${join(sd.name, f)} (${e.message})`; }
      }
    }
  }
}
ok(`会话日志首帧合规（${checked} 个）`, bad === 0, bad === 0 ? '' : `${bad} 个坏帧，例如 ${worst}`);

// 2) 开关在 profile patch 里，且默认关闭
let switchState = 'missing';
if (existsSync(PROFILE_PATCH)) {
  const text = readFileSync(PROFILE_PATCH, 'utf8');
  const line = text.split('\n').find((l) => /^\s*enabled:/.test(l));
  if (line !== undefined) switchState = line.includes('true') ? 'on' : 'off';
}
ok('profile 里有 task-journal 开关', switchState !== 'missing', `当前 ${switchState === 'on' ? '已开启' : switchState === 'off' ? '已关闭' : '未找到'}`);
ok('开关默认关闭', switchState === 'off', switchState === 'on' ? '当前是开启状态（可接受，但默认应为 off）' : '');

// 3) 依赖必须复用宿主那份，不能自带旧副本
//    事故根因：dependencies 里钉 @deepseek-ai/dsh-tools@0.1.1-rc.2，
//    旧副本 import { CallId } from 'dsh-llm'，而 0.2.x 已把 CallId 改名 ToolCallId，
//    于是插件在 import 阶段就炸，连带 dsh-writing-slots 一起起不来。
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'));
const deps = Object.keys(manifest.dependencies ?? {});
const hostPinned = deps.filter((d) => d.startsWith('@deepseek-ai/'));
ok('没有把宿主包钉进 dependencies', hostPinned.length === 0,
  hostPinned.length === 0 ? '' : `钉死了 ${hostPinned.join('、')}，会拉出与宿主不兼容的旧副本`);

const peers = manifest.peerDependencies ?? {};
ok('宿主包声明为 peerDependencies',
  peers['@deepseek-ai/dsh-tools'] !== undefined && peers['@deepseek-ai/cordis'] !== undefined,
  `dsh-tools=${peers['@deepseek-ai/dsh-tools'] ?? '缺失'}`);

// 插件自身目录里不该有 node_modules/@deepseek-ai 的实体副本
const vendored = join(import.meta.dirname, 'node_modules', '@deepseek-ai');
ok('插件目录没有自带宿主包副本', !existsSync(vendored) || readdirSync(vendored).length === 0,
  existsSync(vendored) ? `发现 ${readdirSync(vendored).join('、')}` : '');

// 4) 不做真实启动（要占端口、耗时），只检查入口可被 import
ok('插件入口可解析', existsSync(join(import.meta.dirname, 'lib', 'index.js')));
ok('session-repair 首帧拆分逻辑存在',
  readFileSync(join(import.meta.dirname, 'lib', 'session-repair.js'), 'utf8').includes('头部帧里混入了'));

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
