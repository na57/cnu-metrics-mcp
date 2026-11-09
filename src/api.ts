/**
 * 诚勤指标中枢业务操作层（只读）
 * 对应 pioc 仓库 CnuDataProvider 中实测过的 5 个高频接口：
 *   #3  POST /open-api/metric/scene/versions                     场景版本列表
 *   #5  POST /open-api/metric/scene/version/metric-instances     指标实例+定义
 *   #7  POST /open-api/metric/instance/codes/measure             批量最新取值
 *   #9  POST /open-api/metric/instance/code/measure/page         单实例取值翻页
 *   #11 POST /open-api/metric/instance/detail                    明细数据
 *   #12 POST /open-api/metric/instance/detail-distinct-field     明细去重
 *
 * 与 provider 的差异：面向 AI 工具调用做了输出裁剪（省 token），
 * 并支持 scene 参数传 uid 或场景名称模糊匹配。
 */

import { CnuMetricsClient, asRecord, asArray, asStr } from './client.js';

const SCENES_CACHE_TTL_MS = 10 * 60 * 1000;
/** 批量最新取值：单指标最多返回的维度组合行数（超过则截断并标注） */
const BATCH_ROWS_CAP = 100;

// ---------------- 类型 ----------------

export interface SceneInfo {
  uid: string;
  name: string;
  versionName: string;
  instanceCount: number;
  cronExpression: string;
  constructionCycle: string | null;
}

export interface FilterExpr {
  column: string;
  operator?: string;
  value: string;
}

export interface MetricBrief {
  code: string;
  name: string;
  dims: string[];
  type: string;
  tags: string[];
  owner: string | null;
  state: number;
  lastTime: string | null;
  paraphrase: string | null;
}

export interface MeasureRow {
  dims: Record<string, string>;
  value: number | string | null;
  assessment: string | null;
}

// ---------------- 工具函数 ----------------

const METRIC_TYPE_NAMES: Record<number, string> = {
  1: '原子指标',
  2: '派生指标',
  3: '复合指标',
  4: '自定义指标',
};

/** 手册 filter 结构 {op:'AND', exprs:[{field,value,op}]}（op 实测 EQ 可用） */
function buildFilter(filters?: FilterExpr[]) {
  if (!filters || filters.length === 0) return undefined;
  return {
    op: 'AND',
    exprs: filters.map((f) => ({
      field: f.column,
      value: f.value,
      op: (f.operator || 'EQ').toUpperCase(),
    })),
  };
}

/** 维度对象 → { 中文维度名: 取值 }（平台 dimsDesc 恒为空，dims 是唯一可靠来源） */
function normalizeDims(obj: unknown): Record<string, string> {
  const rec = asRecord(obj);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    const s = asStr(v);
    if (s) out[k] = s;
  }
  return out;
}

function measureValue(v: unknown): number | string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : asStr(v);
}

function normalizeMeasure(row: Record<string, unknown>): MeasureRow {
  const assessment = asArray(row.assessments)
    .map((a) => asStr(asRecord(a).name))
    .filter(Boolean)
    .join('、');
  return {
    dims: normalizeDims(row.dims),
    value: measureValue(row.measure),
    assessment: assessment || null,
  };
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(Math.trunc(Number(value) || fallback), 1), max);
}

function truncate(v: unknown, max: number): string | null {
  const s = asStr(v);
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------- API ----------------

export class CnuApi {
  private scenesCache: { list: SceneInfo[]; at: number } | null = null;

  constructor(
    private readonly client: CnuMetricsClient,
    private readonly pageSizeLimit = 200,
    private readonly defaultSceneUid?: string,
  ) {}

  /** 翻页拉全（页大小用 pageSizeLimit，最多 100 页防御） */
  private async postPagedAll(
    path: string,
    baseBody: Record<string, unknown>,
  ): Promise<unknown[]> {
    const all: unknown[] = [];
    const pageSize = this.pageSizeLimit;
    for (let pageNo = 1; pageNo <= 100; pageNo++) {
      const data = asRecord(await this.client.post(path, { ...baseBody, pageNo, pageSize }));
      const list = asArray(data.list);
      all.push(...list);
      const total = Number(data.total ?? 0);
      if (list.length < pageSize || (total > 0 && all.length >= total)) break;
    }
    return all;
  }

  // ---------- 场景 ----------

  async listScenes(force = false): Promise<SceneInfo[]> {
    if (!force && this.scenesCache && Date.now() - this.scenesCache.at < SCENES_CACHE_TTL_MS) {
      return this.scenesCache.list;
    }
    const raw = await this.postPagedAll('/open-api/metric/scene/versions', { sceneVersionStatus: 1 });
    const list = raw.map((item) => {
      const r = asRecord(item);
      return {
        uid: asStr(r.uid),
        name: asStr(r.name),
        versionName: asStr(r.versionName),
        instanceCount: Number(r.instanceCount ?? 0),
        cronExpression: asStr(r.cronExpression),
        constructionCycle: r.constructionCycle ? asStr(r.constructionCycle) : null,
      };
    });
    this.scenesCache = { list, at: Date.now() };
    return list;
  }

  /**
   * 解析场景版本标识：显式传 uid（32 位 hex）直接用；
   * 传名称关键字则模糊匹配已发布场景，恰好 1 个命中自动使用，否则报错列出候选；
   * 缺省时用 CNU_METRICS_DEFAULT_SCENE_UID（若配置），否则报错列出全部场景。
   */
  async resolveSceneUid(scene?: string): Promise<string> {
    const scenes = await this.listScenes();
    if (!scenes.length) throw new Error('平台当前没有已发布的场景版本');
    if (scene) {
      if (/^[0-9a-f]{32}$/i.test(scene)) return scene;
      const hits = scenes.filter(
        (s) => s.name.includes(scene) || s.versionName.includes(scene),
      );
      if (hits.length === 1) return hits[0].uid;
      throw new Error(this.sceneListError(scene, hits.length ? hits : scenes, hits.length > 1));
    }
    if (this.defaultSceneUid) return this.defaultSceneUid;
    throw new Error(this.sceneListError(undefined, scenes, false));
  }

  private sceneListError(input: string | undefined, scenes: SceneInfo[], ambiguous: boolean): string {
    const list = scenes
      .map((s) => `  - ${s.uid}  ${s.name}（${s.versionName}，${s.instanceCount} 个指标）`)
      .join('\n');
    const head = ambiguous
      ? `场景名「${input}」匹配到 ${scenes.length} 个场景，请用更精确的名称或直接传 uid`
      : input === undefined
        ? '存在多个已发布场景：请传 scene 参数（场景名称关键字或 uid），或配置环境变量 CNU_METRICS_DEFAULT_SCENE_UID'
        : `场景「${input}」未匹配到任何已发布场景，可选：`;
    return `${head}\n${list}`;
  }

  // ---------- 指标实例 ----------

  private normalizeInstance(r: Record<string, unknown>): MetricBrief {
    const def = asRecord(r.definition);
    const metadata = asRecord(def.metadata);
    const departments = asArray(r.departments).map((d) => asStr(asRecord(d).name || d));
    const typeNum = Number(def.type ?? 0);
    return {
      code: asStr(r.code),
      name: asStr(r.name),
      dims: asArray(r.dims).map((d) => asStr(d)),
      type: METRIC_TYPE_NAMES[Number(def.type ?? 0)] || '未分类',
      tags: asArray(r.tags).map((t) => asStr(asRecord(t).name || t)).filter(Boolean),
      owner: departments.length ? departments.join('、') : null,
      state: Number(r.state ?? 0),
      lastTime: r.lastTime ? asStr(r.lastTime) : null,
      paraphrase: truncate(metadata.metric_paraphrase, 160),
    };
  }

  async listMetrics(opts: {
    scene?: string;
    keyword?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ total: number; list: MetricBrief[] }> {
    const sceneUid = await this.resolveSceneUid(opts.scene);
    const pageSize = clamp(opts.pageSize, 20, this.pageSizeLimit);
    const page = clamp(opts.page, 1, 1e9);

    const request = async (extra: Record<string, unknown>) => {
      const data = asRecord(
        await this.client.post('/open-api/metric/scene/version/metric-instances', {
          sceneVersionUid: sceneUid,
          ...extra,
          pageNo: page,
          pageSize,
        }),
      );
      const list = asArray(data.list).map((item) => this.normalizeInstance(asRecord(item)));
      return { total: Number(data.total ?? list.length), list };
    };

    // 平台仅支持「名称模糊」与「编码精确」两种过滤：关键字形似编码时先精确查编码，未命中退回名称模糊
    const kw = opts.keyword?.trim();
    if (!kw) return request({});
    if (!/[^\w.-]/.test(kw)) {
      const byCode = await request({ instanceCodes: [kw] });
      if (byCode.total > 0 || byCode.list.length > 0) return byCode;
    }
    return request({ metricInstanceName: kw });
  }

  // ---------- 取值 ----------

  async getMetricValues(opts: {
    scene?: string;
    instanceCode?: string;
    instanceCodes?: string[];
    filters?: FilterExpr[];
    page?: number;
    pageSize?: number;
  }): Promise<unknown> {
    const sceneUid = await this.resolveSceneUid(opts.scene);
    const filter = buildFilter(opts.filters);

    // 多指标：批量最新取值（#7），平台返回全部维度组合行，这里截断到 BATCH_ROWS_CAP
    const codes = opts.instanceCodes?.filter(Boolean) ?? [];
    if (codes.length > 0) {
      const data = asRecord(
        await this.client.post('/open-api/metric/instance/codes/measure', {
          sceneVersionUid: sceneUid,
          instanceCodes: codes.slice(0, 50),
        }),
      );
      const out: Record<string, unknown> = {};
      for (const [code, rows] of Object.entries(data)) {
        const all = asArray(rows).map((row) => normalizeMeasure(asRecord(row)));
        out[code] = {
          totalRows: all.length,
          truncated: all.length > BATCH_ROWS_CAP,
          list: all.slice(0, BATCH_ROWS_CAP),
        };
      }
      return {
        mode: 'batch-latest',
        note: `多指标返回各指标最新批次的全量维度组合，每指标最多展示 ${BATCH_ROWS_CAP} 行；单指标翻页请用 instanceCode 参数`,
        metrics: out,
      };
    }

    // 单指标：翻页取值（#9）
    const instanceCode = opts.instanceCode;
    if (!instanceCode) {
      throw new Error('请提供 instanceCode（单指标翻页）或 instanceCodes（多指标批量最新值）');
    }
    const data = asRecord(
      await this.client.post('/open-api/metric/instance/code/measure/page', {
        sceneVersionUid: sceneUid,
        instanceCode,
        ...(filter ? { filter } : {}),
        pageNo: clamp(opts.page, 1, 1e9),
        pageSize: clamp(opts.pageSize, 20, this.pageSizeLimit),
      }),
    );
    const list = asArray(data.list).map((row) => normalizeMeasure(asRecord(row)));
    return { total: Number(data.total ?? list.length), list };
  }

  // ---------- 明细 ----------

  async getMetricDetail(opts: {
    scene?: string;
    instanceCode: string;
    filters?: FilterExpr[];
    page?: number;
    pageSize?: number;
  }): Promise<unknown> {
    const sceneUid = await this.resolveSceneUid(opts.scene);
    const filter = buildFilter(opts.filters);
    const data = asRecord(
      await this.client.post('/open-api/metric/instance/detail', {
        sceneVersionUid: sceneUid,
        instanceCode: opts.instanceCode,
        ...(filter ? { filter } : {}),
        pageNo: clamp(opts.page, 1, 1e9),
        pageSize: clamp(opts.pageSize, 20, 1000),
      }),
    );
    const list = asArray(data.list).map((row) => asRecord(row));
    const columns = asArray(data.columns)
      .map((c) => (typeof c === 'object' ? asStr(asRecord(c).name) : asStr(c)))
      .filter(Boolean);
    return {
      total: Number(data.total ?? list.length),
      columns: columns.length ? columns : list.length ? Object.keys(list[0]) : [],
      list,
    };
  }

  // ---------- 维度/明细字段去重 ----------

  async getDimFieldValues(opts: {
    scene?: string;
    instanceCode: string;
    field: string;
  }): Promise<unknown> {
    const sceneUid = await this.resolveSceneUid(opts.scene);
    // 手册实测：参数名为 columnAlias（明细字段的中文列名）；
    // 返回 data 直接是去重值数组（如 ["2017-2018-2", ...]），防御兼容 {list:[...]} 包装
    const raw = await this.client.post('/open-api/metric/instance/detail-distinct-field', {
      sceneVersionUid: sceneUid,
      instanceCode: opts.instanceCode,
      columnAlias: opts.field,
      pageNo: 1,
      pageSize: 1000,
    });
    const arr = Array.isArray(raw) ? raw : asRecord(raw).list;
    const values = asArray(arr)
      .map((v) => asStr(v))
      .filter((v) => v.trim() !== '');
    return { field: opts.field, values: Array.from(new Set(values)).slice(0, 200) };
  }
}
