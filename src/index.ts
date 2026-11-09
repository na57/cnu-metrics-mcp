#!/usr/bin/env node
/**
 * cnu-metrics-mcp 入口：stdio MCP 服务器
 * 环境变量（凭证三项必填）：
 *   CNU_METRICS_APP_KEY / CNU_METRICS_APP_SECRET / CNU_METRICS_USERNAME
 * 可选：CNU_METRICS_BASE_URL（默认 https://metrics.ynu.edu.cn）
 *       CNU_METRICS_TIMEOUT_MS（默认 45000）、CNU_METRICS_PAGE_SIZE_LIMIT（默认 200）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CnuMetricsClient } from './client.js';
import { CnuApi, type FilterExpr } from './api.js';

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[cnu-metrics-mcp] 缺少环境变量 ${name}，无法启动`);
    process.exit(1);
  }
  return v;
}

const filterSchema = z
  .array(
    z.object({
      column: z.string().describe('过滤字段名（明细字段或维度名）'),
      operator: z.string().optional().describe('操作符，默认 EQ（实测可用）；其他操作符以平台支持为准'),
      value: z.string().describe('过滤值（传字符串即可）'),
    }),
  )
  .optional()
  .describe('过滤条件，多条件为 AND 关系；先了解可选值可用 get_dim_field_values');

const sceneSchema = z
  .string()
  .optional()
  .describe('场景版本 uid（32 位 hex）或场景名称关键字（如「智慧教学」，唯一命中即自动使用）；缺省时用环境变量 CNU_METRICS_DEFAULT_SCENE_UID（若已配置），未配置则报错列出全部可选场景');

const server = new McpServer({ name: 'cnu-metrics-mcp', version: '0.1.0' });

const client = new CnuMetricsClient({
  baseUrl: process.env.CNU_METRICS_BASE_URL?.trim() || 'https://metrics.ynu.edu.cn',
  timeoutMs: Number(process.env.CNU_METRICS_TIMEOUT_MS) > 0 ? Number(process.env.CNU_METRICS_TIMEOUT_MS) : 45_000,
  appKey: requiredEnv('CNU_METRICS_APP_KEY'),
  appSecret: requiredEnv('CNU_METRICS_APP_SECRET'),
  username: requiredEnv('CNU_METRICS_USERNAME'),
  logPrefix: 'CNU-MCP',
});
const api = new CnuApi(
  client,
  Number(process.env.CNU_METRICS_PAGE_SIZE_LIMIT) > 0 ? Number(process.env.CNU_METRICS_PAGE_SIZE_LIMIT) : 200,
  process.env.CNU_METRICS_DEFAULT_SCENE_UID?.trim() || undefined,
);

type ToolArgs = Record<string, unknown>;
function wrap(fn: (args: ToolArgs) => Promise<unknown>) {
  return async (args: ToolArgs) => {
    try {
      const data = await fn(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cnu-metrics-mcp] 工具调用失败: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: `查询失败：${msg}` }],
        isError: true,
      };
    }
  };
}

server.registerTool(
  'list_scenes',
  {
    title: '列出指标场景版本',
    description:
      '列出诚勤指标中枢所有已发布场景版本（uid、名称、版本、指标数量、更新周期）。' +
      '查询其他工具前可先用它确认场景；结果缓存 10 分钟。',
    inputSchema: {},
  },
  wrap(() => api.listScenes()),
);

server.registerTool(
  'list_metrics',
  {
    title: '查询指标清单',
    description:
      '按场景查询指标实例清单（编码 code、名称、维度 dims、类型、标签、责任部门、释义摘要）。' +
      'keyword：纯编码/字母数字按编码精确匹配，含中文按名称模糊匹配。先 list_metrics 找到指标 code，再取值。',
    inputSchema: {
      keyword: z.string().optional().describe('指标名称关键字（模糊）或指标编码（精确）'),
      page: z.number().int().min(1).optional().describe('页码，默认 1'),
      pageSize: z.number().int().min(1).optional().describe('每页条数，默认 20，上限 200'),
      scene: sceneSchema,
    },
  },
  wrap((a) =>
    api.listMetrics({
      scene: a.scene as string | undefined,
      keyword: a.keyword as string | undefined,
      page: a.page as number | undefined,
      pageSize: a.pageSize as number | undefined,
    }),
  ),
);

server.registerTool(
  'get_metric_values',
  {
    title: '查询指标取值',
    description:
      '查询指标数值。单指标传 instanceCode（可配 filters 过滤维度、分页翻全量）；' +
      '多指标传 instanceCodes（最多 50 个，返回各指标最新批次的全量维度组合，每指标最多展示 100 行）。' +
      '返回行结构 {dims, value, assessment}。不知道维度可选值时先调 get_dim_field_values。',
    inputSchema: {
      instanceCode: z.string().optional().describe('单个指标编码（与 instanceCodes 二选一）'),
      instanceCodes: z.array(z.string()).optional().describe('多个指标编码批量查最新值（与 instanceCode 二选一，≤50）'),
      filters: filterSchema,
      page: z.number().int().min(1).optional().describe('页码，默认 1（仅单指标模式）'),
      pageSize: z.number().int().min(1).optional().describe('每页条数，默认 20，上限 200（仅单指标模式）'),
      scene: sceneSchema,
    },
  },
  wrap((a) =>
    api.getMetricValues({
      scene: a.scene as string | undefined,
      instanceCode: a.instanceCode as string | undefined,
      instanceCodes: a.instanceCodes as string[] | undefined,
      filters: a.filters as FilterExpr[] | undefined,
      page: a.page as number | undefined,
      pageSize: a.pageSize as number | undefined,
    }),
  ),
);

server.registerTool(
  'get_metric_detail',
  {
    title: '查询指标明细数据',
    description:
      '查询指标背后的明细数据（明细行 + 字段列表 + 总数），支持 filters 过滤与分页。' +
      '仅部分指标有明细（通常带「留痕」「明细」类标签）；没有明细会返回错误。单页上限 1000。',
    inputSchema: {
      instanceCode: z.string().describe('指标编码'),
      filters: filterSchema,
      page: z.number().int().min(1).optional().describe('页码，默认 1'),
      pageSize: z.number().int().min(1).optional().describe('每页条数，默认 20，上限 1000'),
      scene: sceneSchema,
    },
  },
  wrap((a) =>
    api.getMetricDetail({
      scene: a.scene as string | undefined,
      instanceCode: a.instanceCode as string,
      filters: a.filters as FilterExpr[] | undefined,
      page: a.page as number | undefined,
      pageSize: a.pageSize as number | undefined,
    }),
  ),
);

server.registerTool(
  'get_dim_field_values',
  {
    title: '查询明细字段去重值',
    description:
      '查询某指标明细数据中指定字段（明细字段中文列名，即 get_metric_detail 返回的 columns[].alias 或行键名）的去重取值列表，用于构造 filters 的过滤值。',
    inputSchema: {
      instanceCode: z.string().describe('指标编码'),
      field: z.string().describe('明细字段中文列名（columns[].alias，如「教师工号」）'),
      scene: sceneSchema,
    },
  },
  wrap((a) =>
    api.getDimFieldValues({
      scene: a.scene as string | undefined,
      instanceCode: a.instanceCode as string,
      field: a.field as string,
    }),
  ),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[cnu-metrics-mcp] 已启动（stdio）'); // stderr 不干扰协议
}

main().catch((e) => {
  console.error(`[cnu-metrics-mcp] 启动失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
