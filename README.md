# cnu-metrics-mcp

诚勤指标中枢（metrics.ynu.edu.cn）的只读 MCP 服务器。让 AI 助手一次调用即可完成「场景 → 指标 → 取值 / 明细」查询，替代手工跑探针脚本。

仅使用平台 OpenAPI 的只读接口（场景/指标/取值/明细），不包含任何写操作；凭证只走环境变量，不落日志。

## 工具列表

| 工具 | 说明 |
|------|------|
| `list_scenes` | 列出全部已发布场景版本（uid、名称、指标数量），结果缓存 10 分钟 |
| `list_metrics` | 按场景查指标清单；keyword 纯英数按编码精确匹配，含中文按名称模糊匹配 |
| `get_metric_values` | 指标取值：单指标（支持 filters 过滤 + 翻页）或多指标批量查最新（≤50 个，每指标最多 100 行） |
| `get_metric_detail` | 指标明细数据（columns + 行 + total），支持 filters 过滤与分页，单页上限 1000 |
| `get_dim_field_values` | 明细某字段的去重取值列表（用于构造 filters 的过滤值） |

典型工作流：`list_scenes` → `list_metrics` 找到指标 code → `get_metric_values` 取值（维度值不确定时先用 `get_metric_detail` + `get_dim_field_values`）。

`scene` 参数支持 32 位 hex uid 直接使用、场景名称模糊匹配（唯一命中自动使用），缺省时读环境变量 `CNU_METRICS_DEFAULT_SCENE_UID`。

## 环境变量

| 变量 | 必填 | 说明 |
|------|:--:|------|
| `CNU_METRICS_APP_KEY` | ✅ | 平台 appKey |
| `CNU_METRICS_APP_SECRET` | ✅ | 平台 appSecret |
| `CNU_METRICS_USERNAME` | ✅ | 平台分配的用户名（目录统计类接口需管理员账号） |
| `CNU_METRICS_BASE_URL` | | 默认 `https://metrics.ynu.edu.cn` |
| `CNU_METRICS_TIMEOUT_MS` | | 请求超时，默认 45000 |
| `CNU_METRICS_PAGE_SIZE_LIMIT` | | 翻页单页上限，默认 200 |
| `CNU_METRICS_DEFAULT_SCENE_UID` | | 缺省场景版本 uid，配置后 `scene` 可省略 |

## 客户端注册

Trae / Claude Desktop 等支持 MCP stdio 的客户端，配置如下（`env` 三项填自己的凭证）：

```json
{
  "mcpServers": {
    "cnu-metrics": {
      "command": "node",
      "args": ["/path/to/cnu-metrics-mcp/dist/index.js"],
      "env": {
        "CNU_METRICS_APP_KEY": "<你的 appKey>",
        "CNU_METRICS_APP_SECRET": "<你的 appSecret>",
        "CNU_METRICS_USERNAME": "<你的用户名>"
      }
    }
  }
}
```

## 本地开发

```bash
npm install
npm run build   # tsc 编译到 dist/
npm run e2e     # 连真实平台冒烟测试（需先 export 三个凭证变量）
```

E2E 用 `scripts/e2e.mjs` 直接 spawn `dist/index.js` 走 stdio JSON-RPC，覆盖 5 个工具共 7 个用例。

## 实现说明

- 认证：sha1 签名换 token（`sha1(username+secret+nonce+curTime)`），token 缓存并提前 60s 失效；业务请求 401 时强制重取并重试一次。
- 网络：瞬时连接错误（ECONNRESET 等）按 200/600/1500/3000ms 退避重试；超时不重试。
- 输出裁剪（省对话 token）：批量取值每指标截断 100 行、指标释义截断 160 字符、去重值上限 200。
- 接口口径均经真实平台实测；指标中枢 OpenAPI 手册与实现不一致处以实测为准（如 detail-distinct-field 的参数名为 `columnAlias`）。
