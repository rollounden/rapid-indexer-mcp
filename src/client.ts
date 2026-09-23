/**
 * Thin typed wrapper over the Rapid Indexer public REST API
 * (https://rapid-indexer.com/api-docs).
 *
 * Every call is a plain `fetch` against `?action=<name>` on the API base URL,
 * authenticated with the `X-API-Key` header.
 */

export const DEFAULT_BASE_URL = 'https://rapid-indexer.com/api/v1/index.php';

export class RapidIndexerApiError extends Error {
  readonly status: number;
  readonly action: string;
  readonly payload: unknown;

  constructor(action: string, status: number, message: string, payload?: unknown) {
    super(message);
    this.name = 'RapidIndexerApiError';
    this.action = action;
    this.status = status;
    this.payload = payload;
  }
}

export interface ClientOptions {
  /** Plain API key from https://rapid-indexer.com/api_access. `null` means "not configured". */
  apiKey: string | null;
  /** Full URL of the API router, or just the site origin (the router path is appended). */
  baseUrl?: string;
  /** Request timeout in ms. Defaults to 60s (large URL batches can take a while). */
  timeoutMs?: number;
  /** Override for tests. */
  fetch?: typeof fetch;
  userAgent?: string;
}

export interface AccountInfo {
  id: number;
  email: string;
  credits_balance: number;
  created_at: string;
}

export interface Pricing {
  currency: string;
  price_per_credit_usd: number;
  credits_per_url: {
    indexer: number;
    indexer_vip: number;
    checker: number;
    auto_check_addon: number;
  };
  traffic: {
    credits_per_1000_visitors: number;
    min_visitors: number;
    max_visitors_per_day: number;
    orders_paused: boolean;
  };
  vip_queue_enabled: boolean;
}

export type TaskType = 'indexer' | 'checker' | 'traffic' | 'traffic_campaign' | 'ctr';
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type LinkStatus = 'pending' | 'indexed' | 'unindexed' | 'error';

export interface TaskSummary {
  id: number;
  title: string | null;
  type: TaskType | string;
  engine: string | null;
  status: TaskStatus | string;
  vip: boolean;
  links: { total: number; indexed: number; unindexed: number; pending: number; error: number };
  created_at: string;
  completed_at: string | null;
}

export interface TaskDetail {
  id: number;
  title: string | null;
  type: TaskType | string;
  engine: string | null;
  status: TaskStatus | string;
  vip: boolean;
  progress: { updated: number; pending: number };
  created_at: string;
  completed_at: string | null;
}

export interface TaskLink {
  url: string;
  status: LinkStatus | string;
  error_code: number | null;
  checked_at: string | null;
}

export interface CreateIndexTaskInput {
  urls: string[];
  type?: 'indexer' | 'checker';
  engine?: 'google' | 'bing';
  title?: string;
  vip?: boolean;
  drip_feed?: boolean;
  drip_duration_days?: number;
}

export interface CreateIndexTaskResult {
  task_id: number;
  is_drip_feed: boolean;
  message: string;
}

export interface CreateTrafficInput {
  link: string;
  quantity: number;
  title?: string;
  days?: number;
  country?: string;
  device?: 'mixed' | 'desktop' | 'mobile' | 'tablet';
  desktop_percent?: number;
  mobile_percent?: number;
  tablet_percent?: number;
  referrer?: string;
  ai_enabled?: boolean;
  ai_prompt?: string;
  click_links?: string | string[];
  click_chance?: number;
  video_chance?: number;
  delay_min?: number;
  delay_max?: number;
  pages_min?: number;
  pages_max?: number;
  bounce_rate?: number;
}

export interface CreateCtrInput extends CreateTrafficInput {
  keywords: string[];
  search_engine?: string;
  search_pages_max?: number;
  search_language?: string;
  search_only?: boolean;
}

export interface CreateTrafficResult {
  task_id: number;
  campaign_id: string | null;
  status: string;
  visitors: number;
  days: number;
  message: string;
  ctr_mode?: { search_engine: string; keywords_count: number; search_only: boolean };
}

export interface SearchEngine {
  name: string;
  domain: string;
  type: 'search' | 'ecommerce' | string;
  region?: string;
}

export interface Health {
  status: string;
  version: string;
  features: Record<string, boolean>;
}

export interface Pagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export function normalizeBaseUrl(raw: string | undefined | null): string {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_BASE_URL;
  if (/index\.php$/i.test(value)) return value;
  return value.replace(/\/+$/, '') + '/api/v1/index.php';
}

export class RapidIndexerClient {
  readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey && options.apiKey.trim() !== '' ? options.apiKey.trim() : null;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? 'rapid-indexer-mcp';
  }

  get hasApiKey(): boolean {
    return this.apiKey !== null;
  }

  // ------------------------------------------------------------------ calls

  async me(): Promise<AccountInfo> {
    const data = await this.request<{ user: AccountInfo }>('me', 'GET');
    return { ...data.user, id: Number(data.user.id), credits_balance: Number(data.user.credits_balance) };
  }

  async pricing(): Promise<Pricing> {
    const { success: _s, ...rest } = await this.request<Pricing & { success: true }>('pricing', 'GET');
    return rest;
  }

  async health(): Promise<Health> {
    return this.request<Health>('health', 'GET');
  }

  async createIndexTask(input: CreateIndexTaskInput): Promise<CreateIndexTaskResult> {
    const body: Record<string, unknown> = {
      urls: input.urls,
      type: input.type ?? 'indexer',
      engine: input.engine ?? 'google',
    };
    if (input.title) body.title = input.title;
    if (input.vip !== undefined) body.vip = input.vip;
    if (input.drip_feed !== undefined) body.drip_feed = input.drip_feed;
    if (input.drip_duration_days !== undefined) body.drip_duration_days = input.drip_duration_days;
    const data = await this.request<{ task_id: number; is_drip_feed?: boolean; message?: string }>(
      'create_task',
      'POST',
      undefined,
      body
    );
    return {
      task_id: Number(data.task_id),
      is_drip_feed: Boolean(data.is_drip_feed),
      message: data.message ?? 'Task created',
    };
  }

  async createTrafficCampaign(input: CreateTrafficInput): Promise<CreateTrafficResult> {
    return this.createTraffic({ ...input, type: 'traffic' });
  }

  async createCtrCampaign(input: CreateCtrInput): Promise<CreateTrafficResult> {
    return this.createTraffic({ ...input, type: 'ctr' });
  }

  private async createTraffic(input: (CreateTrafficInput | CreateCtrInput) & { type: 'traffic' | 'ctr' }): Promise<CreateTrafficResult> {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined && v !== null) body[k] = v;
    }
    const data = await this.request<Omit<CreateTrafficResult, 'message'> & { message?: string }>(
      'create_task',
      'POST',
      undefined,
      body
    );
    return {
      task_id: Number(data.task_id),
      campaign_id: data.campaign_id ?? null,
      status: data.status ?? 'queued',
      visitors: Number(data.visitors),
      days: Number(data.days),
      message: data.message ?? 'Campaign created',
      ...(data.ctr_mode ? { ctr_mode: data.ctr_mode } : {}),
    };
  }

  async getTask(taskId: number): Promise<TaskDetail> {
    const data = await this.request<{ task: TaskDetail }>('get_task', 'GET', { task_id: String(taskId) });
    const t = data.task;
    return {
      ...t,
      id: Number(t.id),
      vip: Boolean(t.vip),
      progress: {
        updated: Number(t.progress?.updated ?? 0),
        pending: Number(t.progress?.pending ?? 0),
      },
    };
  }

  async getTaskLinks(taskId: number): Promise<TaskLink[]> {
    const data = await this.request<{ links: TaskLink[] }>('get_task_links', 'GET', { task_id: String(taskId) });
    return (data.links ?? []).map((l) => ({
      url: l.url,
      status: l.status,
      error_code: l.error_code === null || l.error_code === undefined ? null : Number(l.error_code),
      checked_at: l.checked_at ?? null,
    }));
  }

  async listTasks(params: {
    page?: number;
    per_page?: number;
    type?: 'indexer' | 'checker' | 'traffic';
    status?: TaskStatus;
  } = {}): Promise<{ tasks: TaskSummary[]; pagination: Pagination }> {
    const query: Record<string, string> = {};
    if (params.page) query.page = String(params.page);
    if (params.per_page) query.per_page = String(params.per_page);
    if (params.type) query.type = params.type;
    if (params.status) query.status = params.status;
    const data = await this.request<{ tasks: TaskSummary[]; pagination: Pagination }>('list_tasks', 'GET', query);
    return { tasks: data.tasks ?? [], pagination: data.pagination };
  }

  async listSearchEngines(): Promise<Record<string, SearchEngine>> {
    const data = await this.request<{ search_engines: Record<string, SearchEngine> }>('list_search_engines', 'GET');
    return data.search_engines ?? {};
  }

  // --------------------------------------------------------------- plumbing

  private async request<T>(
    action: string,
    method: 'GET' | 'POST',
    query?: Record<string, string>,
    body?: unknown
  ): Promise<T> {
    if (!this.apiKey) {
      throw new RapidIndexerApiError(
        action,
        401,
        'No Rapid Indexer API key configured. Set RAPID_INDEXER_API_KEY (stdio) or send an Authorization: Bearer <key> header (HTTP). Create a key at https://rapid-indexer.com/api_access.'
      );
    }

    const url = new URL(this.baseUrl);
    url.searchParams.set('action', action);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          'X-API-Key': this.apiKey,
          Accept: 'application/json',
          'User-Agent': this.userAgent,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RapidIndexerApiError(action, 0, `Network error calling Rapid Indexer (${action}): ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new RapidIndexerApiError(
        action,
        res.status,
        `Rapid Indexer returned non-JSON (HTTP ${res.status}) for ${action}: ${text.slice(0, 300)}`,
        text
      );
    }

    const obj = (json ?? {}) as Record<string, unknown>;
    const failed = !res.ok || obj.success === false || (typeof obj.error === 'string' && obj.success !== true);
    if (failed) {
      const msg =
        (typeof obj.error === 'string' && obj.error) ||
        (typeof obj.message === 'string' && obj.message) ||
        `HTTP ${res.status}`;
      throw new RapidIndexerApiError(action, res.status, msg, json);
    }
    return json as T;
  }
}
