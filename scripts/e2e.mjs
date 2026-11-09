#!/usr/bin/env node
/**
 * E2E 冒烟测试：spawn 构建产物，走 MCP stdio 协议实测全部 5 个工具。
 * 凭证通过环境变量传入（由调用方 export，本脚本不读取、不打印任何凭证）。
 * 用法：set -a; source <含凭证的 env 文件>; set +a; node scripts/e2e.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });

const rl = readline.createInterface({ input: child.stdout });
let msgId = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  }
});

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms)),
  ]);
}

const call = async (name, args) => {
  const res = await withTimeout(send('tools/call', { name, arguments: args }), 90_000, `tools/call ${name}`);
  if (res.isError) throw new Error(`${name} 返回错误: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content?.[0]?.text ?? '{}');
};

let failed = 0;
const step = async (label, fn) => {
  try {
    await fn();
    console.log(`  [PASS] ${label}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${label}: ${e.message}`);
  }
};

try {
  // ---- 握手 ----
  const init = await withTimeout(
    send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cnu-metrics-e2e', version: '0.0.0' },
    }),
    15_000,
    'initialize',
  );
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  console.log(`服务器: ${init.serverInfo?.name} v${init.serverInfo?.version}`);

  const tools = await withTimeout(send('tools/list', {}), 15_000, 'tools/list');
  const names = tools.tools.map((t) => t.name);
  console.log(`工具清单: ${names.join(', ')}`);
  if (names.length !== 5) throw new Error(`期望 5 个工具，实际 ${names.length}`);

  // ---- 1. 场景 ----
  await step('list_scenes', async () => {
    const scenes = await call('list_scenes', {});
    if (!Array.isArray(scenes) || scenes.length === 0) throw new Error('无已发布场景');
    console.log(`         ${scenes.length} 个已发布场景，首个: ${scenes[0].name} (${scenes[0].uid})`);
  });

  // ---- 2. 指标清单（按场景名称模糊匹配） ----
  const SCENE = '智慧教学';
  let firstMetric = null;
  await step(`list_metrics(scene="${SCENE}")`, async () => {
    const res = await call('list_metrics', { scene: SCENE, pageSize: 5 });
    if (!res.total || !res.list?.length) throw new Error('清单为空');
    firstMetric = res.list[0];
    console.log(`         total=${res.total}，首条 ${firstMetric.code} ${firstMetric.name}，dims=[${firstMetric.dims.join(',')}]`);
  });

  const needMetric = () => {
    if (!firstMetric) throw new Error('前置 list_metrics 未取得指标，跳过');
    return firstMetric;
  };

  await step('list_metrics(keyword 模糊)', async () => {
    const m = needMetric();
    const kw = (m.name || '').slice(0, 2);
    if (!kw) throw new Error('首条指标名称过短，无法构造关键字');
    const res = await call('list_metrics', { scene: SCENE, keyword: kw });
    console.log(`         keyword="${kw}" total=${res.total}`);
  });

  // ---- 3. 取值 ----
  await step('get_metric_values(单指标翻页)', async () => {
    const m = needMetric();
    const res = await call('get_metric_values', { scene: SCENE, instanceCode: m.code });
    console.log(`         ${m.code} total=${res.total}，首行=${JSON.stringify(res.list?.[0] ?? null)}`);
  });

  await step('get_metric_values(多指标批量最新)', async () => {
    const m = needMetric();
    const res = await call('get_metric_values', { scene: SCENE, instanceCodes: [m.code] });
    const one = res.metrics?.[m.code];
    if (!one) throw new Error('批量响应缺少该指标');
    console.log(`         rows=${one.totalRows}${one.truncated ? '(截断)' : ''}`);
  });

  // ---- 4. 明细 ----
  await step('get_metric_detail', async () => {
    const m = needMetric();
    const res = await call('get_metric_detail', { scene: SCENE, instanceCode: m.code });
    console.log(`         columns=${(res.columns || []).length} rows=${res.list?.length}`);
  });

  // ---- 5. 维度去重 ----
  await step('get_dim_field_values', async () => {
    const m = needMetric();
    const dim = m.dims?.[0];
    if (!dim) throw new Error('首条指标无维度，跳过');
    const res = await call('get_dim_field_values', { scene: SCENE, instanceCode: m.code, field: dim });
    console.log(`         ${dim} => ${res.values?.length} 个去重值`);
  });

  if (failed > 0) throw new Error(`${failed} 个用例失败`);
  console.log('E2E 全部通过');
} catch (e) {
  console.error(`E2E 失败: ${e.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
