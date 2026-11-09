/**
 * 诚勤指标中枢 OpenAPI 客户端
 * 移植自 pioc 仓库 src/lib/metrics/cnu-client.ts（实测成熟逻辑）：
 * sha1 签名、token 缓存（提前 60s 失效）、业务请求 401 强制重取并重试一次、
 * 网络瞬时失败退避重试。本文件不打印任何凭证值。
 */

import crypto from 'crypto';

export interface CnuMetricsClientOptions {
  baseUrl: string;
  timeoutMs: number;
  appKey: string;
  appSecret: string;
  username: string;
  /** 错误信息中的日志前缀，默认 'CNU' */
  logPrefix?: string;
}

export interface CnuEnvelope {
  code: number;
  data: unknown;
  msg?: string;
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function asStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

const TOKEN_TTL_SAFETY_MS = 60_000;

/** 网络层瞬时失败的重试退避（毫秒）。平台偶发 ECONNRESET / TLS 抖动，超时不重试。 */
const NETWORK_RETRY_DELAYS_MS = [200, 600, 1500, 3000];

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'AbortError') return false;
  const cause = (e as Error & { cause?: { code?: string } }).cause;
  const code = cause?.code || '';
  if (code) return RETRYABLE_ERROR_CODES.has(code);
  return e.name === 'TypeError'; // fetch failed（无 cause 时）也按瞬时失败处理
}

/** 把 fetch 的嵌套错误压成一句可读文案（不含凭证） */
function describeNetworkError(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const detail = [cause?.code, cause?.message].filter(Boolean).join(' ');
  const msg = e instanceof Error ? e.message : String(e);
  return detail ? `${msg} (${detail})` : msg;
}

export class CnuMetricsClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly opts: CnuMetricsClientOptions) {}

  private get logPrefix(): string {
    return this.opts.logPrefix || 'CNU';
  }

  // ---------- token ----------

  private async fetchToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const { appKey, appSecret, username } = this.opts;
    const nonce = String(Math.floor(1e9 + Math.random() * 9e9)); // 10 位随机数
    const curTime = String(Math.floor(Date.now() / 1000));
    const checkSum = crypto
      .createHash('sha1')
      .update(`${username}${appSecret}${nonce}${curTime}`, 'utf8')
      .digest('hex');

    const res = await this.rawRequest(
      '/open-api/system/oauth2-openapi/token',
      {
        method: 'POST',
        headers: { appKey, nonce, curTime, username, checkSum },
      },
      false,
    );
    if (res.code !== 0) {
      throw new Error(`[${this.logPrefix}] 获取 token 失败 code=${res.code}`);
    }
    const data = asRecord(res.data);
    const accessToken = asStr(data.access_token);
    if (!accessToken) throw new Error(`[${this.logPrefix}] token 响应缺少 access_token`);
    const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 1800;
    this.token = accessToken;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000 - TOKEN_TTL_SAFETY_MS;
    return accessToken;
  }

  invalidateToken(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  // ---------- HTTP ----------

  async rawRequest(
    path: string,
    init: RequestInit,
    withAuth: boolean,
    retryOn401 = true,
  ): Promise<CnuEnvelope> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) || {}),
    };
    if (withAuth) {
      const token = await this.fetchToken();
      headers.authorization = `Bearer ${token}`;
    }

    const doFetch = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        return await fetch(`${this.opts.baseUrl}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let res: Response | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt++) {
      try {
        res = await doFetch();
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        const canRetry = isRetryableNetworkError(e) && attempt < NETWORK_RETRY_DELAYS_MS.length;
        if (!canRetry) break;
        console.error(
          `[${this.logPrefix}] 网络抖动，${NETWORK_RETRY_DELAYS_MS[attempt]}ms 后重试 ${path}（第 ${attempt + 1} 次）: ${describeNetworkError(e)}`,
        );
        await sleep(NETWORK_RETRY_DELAYS_MS[attempt]);
      }
    }
    if (!res) {
      throw new Error(`[${this.logPrefix}] 网络请求失败 ${path}: ${describeNetworkError(lastError)}`);
    }
    if (!res.ok) {
      throw new Error(`[${this.logPrefix}] HTTP ${res.status} ${path}`);
    }
    const body = (await res.json()) as CnuEnvelope;
    if (body.code === 401 && withAuth && retryOn401) {
      this.invalidateToken();
      return this.rawRequest(path, init, withAuth, false);
    }
    return body;
  }

  async get(path: string): Promise<unknown> {
    const res = await this.rawRequest(path, { method: 'GET' }, true);
    if (res.code !== 0) {
      throw new Error(`[${this.logPrefix}] ${path} code=${res.code} msg=${res.msg || ''}`);
    }
    return res.data;
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.rawRequest(path, { method: 'POST', body: JSON.stringify(body) }, true);
    if (res.code !== 0) {
      throw new Error(`[${this.logPrefix}] ${path} code=${res.code} msg=${res.msg || ''}`);
    }
    return res.data;
  }
}
