import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { RapidIndexerApiError, type RapidIndexerClient, type TaskLink } from './client.js';

export const SERVER_NAME = 'rapid-indexer';
export const SERVER_VERSION = '0.1.0';

const TRAFFIC_COUNTRIES = [
  'WW', 'US', 'GB', 'DE', 'JP', 'FR', 'CA', 'AU', 'BR', 'IN', 'MX',
  'IT', 'NL', 'KR', 'ID', 'TR', 'PL', 'TH', 'VN', 'PH', 'ES',
] as const;

const MAX_URLS_PER_TASK = 10_000;

// ------------------------------------------------------------------ helpers

function ok(structured: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function fail(err: unknown): CallToolResult {
  let message: string;
  if (err instanceof RapidIndexerApiError) {
    message = `Rapid Indexer API error (${err.action}${err.status ? `, HTTP ${err.status}` : ''}): ${err.message}`;
    if (err.status === 401) {
      message += '\nCheck the API key: it must be an active key from https://rapid-indexer.com/api_access.';
    } else if (err.status === 403) {
      message += '\nThe account is suspended. Contact support via the dashboard.';
    } else if (/insufficient credits/i.test(err.message)) {
      message += '\nTop up at https://rapid-indexer.com/payments ($1 = 100 credits, PayPal or crypto).';
    }
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}

function cleanUrls(urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const u = raw.trim();
    if (u === '') continue;
    const withScheme = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    if (seen.has(withScheme)) continue;
    seen.add(withScheme);
    out.push(withScheme);
  }
  return out;
}

function summarizeLinks(links: TaskLink[]): Record<string, number> {
  const counts: Record<string, number> = { total: links.length, indexed: 0, unindexed: 0, pending: 0, error: 0 };
  for (const l of links) {
    counts[l.status] = (counts[l.status] ?? 0) + 1;
  }
  return counts;
}

const urlsSchema = z
  .array(z.string().min(4).max(2048))
  .min(1)
  .max(MAX_URLS_PER_TASK)
  .describe(`Absolute URLs (https://...). Scheme is added when missing. Max ${MAX_URLS_PER_TASK} per task.`);

const taskIdSchema = z.number().int().positive().describe('Rapid Indexer task id (from list_tasks or a create_* result).');

// ------------------------------------------------------------------- server

/**
 * Build a Rapid Indexer MCP server bound to one API client (i.e. one account).
 * Called once per stdio connection, or once per HTTP request.
 */
export function createRapidIndexerServer(client: RapidIndexerClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'Rapid Indexer' },
    {
      instructions: [
        'Rapid Indexer sends Googlebot to URLs so Google discovers and (usually) indexes them within minutes to hours, and can verify which URLs are in the index.',
        'Typical flow: get_account (check credits) -> estimate_cost -> submit_urls_for_indexing -> later get_task / get_task_links. Use check_index_status for a cheap index check without submitting.',
        'Credits are spent when a task is created. Standard indexing costs ~2 credits/URL, VIP ~10 credits/URL, an index check ~0.1 credit/URL ($1 = 100 credits). Always confirm with the user before submitting large batches or traffic campaigns.',
        'Rapid Indexer sends the crawler; Google decides what appears in search. "completed" means crawled/processed, not guaranteed indexed. Use check_index_status a day or two later to verify.',
      ].join(' '),
    }
  );

  // ---------------------------------------------------------------- account

  server.registerTool(
    'get_account',
    {
      title: 'Get account & credit balance',
      description: 'Return the authenticated Rapid Indexer account (id, email, credits balance, created date). Use it to check credits before creating tasks.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        id: z.number(),
        email: z.string(),
        credits_balance: z.number(),
        credits_balance_usd: z.number(),
        created_at: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const [me, pricing] = await Promise.all([client.me(), client.pricing().catch(() => null)]);
        const perCredit = pricing?.price_per_credit_usd ?? 0.01;
        const out = {
          id: me.id,
          email: me.email,
          credits_balance: me.credits_balance,
          credits_balance_usd: Math.round(me.credits_balance * perCredit * 100) / 100,
          created_at: me.created_at,
        };
        return ok(out, `Account ${me.email} (#${me.id}): ${me.credits_balance} credits (~$${out.credits_balance_usd}).`);
      })
  );

  server.registerTool(
    'get_pricing',
    {
      title: 'Get current pricing',
      description: 'Return live credit costs: credits per URL for standard/VIP indexing and index checking, traffic price per 1,000 visitors, USD per credit, and whether VIP/traffic are currently enabled.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        currency: z.string(),
        price_per_credit_usd: z.number(),
        credits_per_url: z.object({
          indexer: z.number(),
          indexer_vip: z.number(),
          checker: z.number(),
          auto_check_addon: z.number(),
        }),
        usd_per_url: z.object({ indexer: z.number(), indexer_vip: z.number(), checker: z.number() }),
        traffic: z.object({
          credits_per_1000_visitors: z.number(),
          min_visitors: z.number(),
          max_visitors_per_day: z.number(),
          orders_paused: z.boolean(),
        }),
        vip_queue_enabled: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const p = await client.pricing();
        const usd = (credits: number) => Math.round(credits * p.price_per_credit_usd * 10_000) / 10_000;
        const out = {
          ...p,
          usd_per_url: {
            indexer: usd(p.credits_per_url.indexer),
            indexer_vip: usd(p.credits_per_url.indexer_vip),
            checker: usd(p.credits_per_url.checker),
          },
        };
        return ok(
          out,
          `1 credit = $${p.price_per_credit_usd}. Standard indexing ${p.credits_per_url.indexer} cr/URL ($${out.usd_per_url.indexer}), VIP ${p.credits_per_url.indexer_vip} cr/URL ($${out.usd_per_url.indexer_vip}), index check ${p.credits_per_url.checker} cr/URL. Traffic ${p.traffic.credits_per_1000_visitors} cr per 1,000 visitors (min ${p.traffic.min_visitors}). VIP queue ${p.vip_queue_enabled ? 'enabled' : 'disabled'}; traffic orders ${p.traffic.orders_paused ? 'PAUSED' : 'open'}.`
        );
      })
  );

  server.registerTool(
    'estimate_cost',
    {
      title: 'Estimate task cost',
      description: 'Estimate the credit and USD cost of an indexing or index-check task before submitting it, and whether the account balance covers it. Does not create anything.',
      inputSchema: z.object({
        url_count: z.number().int().min(1).max(MAX_URLS_PER_TASK).describe('Number of URLs in the planned task.'),
        type: z.enum(['indexer', 'checker']).default('indexer').describe('"indexer" submits URLs to Googlebot; "checker" only checks whether they are indexed.'),
        vip: z.boolean().default(false).describe('VIP priority queue (indexer only): starts immediately, costs more.'),
      }),
      outputSchema: z.object({
        url_count: z.number(),
        type: z.string(),
        vip: z.boolean(),
        credits_per_url: z.number(),
        total_credits: z.number(),
        total_usd: z.number(),
        credits_balance: z.number(),
        sufficient_balance: z.boolean(),
        shortfall_credits: z.number(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url_count, type, vip }) =>
      run(async () => {
        const [p, me] = await Promise.all([client.pricing(), client.me()]);
        const perUrl =
          type === 'checker'
            ? p.credits_per_url.checker
            : vip && p.vip_queue_enabled
              ? p.credits_per_url.indexer_vip
              : p.credits_per_url.indexer;
        const total = Math.ceil(perUrl * url_count * 100) / 100;
        const out = {
          url_count,
          type,
          vip: type === 'indexer' && vip && p.vip_queue_enabled,
          credits_per_url: perUrl,
          total_credits: total,
          total_usd: Math.round(total * p.price_per_credit_usd * 100) / 100,
          credits_balance: me.credits_balance,
          sufficient_balance: me.credits_balance >= total,
          shortfall_credits: Math.max(0, Math.ceil((total - me.credits_balance) * 100) / 100),
        };
        const note = out.sufficient_balance
          ? 'Balance is sufficient.'
          : `Balance is short by ${out.shortfall_credits} credits (~$${Math.ceil(out.shortfall_credits * p.price_per_credit_usd * 100) / 100}). Top up at https://rapid-indexer.com/payments.`;
        return ok(out, `${url_count} URL(s) as ${type}${out.vip ? ' (VIP)' : ''}: ${total} credits (~$${out.total_usd}). You have ${me.credits_balance}. ${note}`);
      })
  );

  // ------------------------------------------------------------ indexing

  server.registerTool(
    'submit_urls_for_indexing',
    {
      title: 'Submit URLs for Google indexing',
      description: [
        'Create an indexing task: Rapid Indexer signals Googlebot to crawl each URL so Google discovers it fast.',
        'SPENDS CREDITS immediately (standard ~2 credits/URL, VIP ~10 credits/URL). Run estimate_cost first and confirm with the user for large batches.',
        'Standard queue starts within minutes; VIP starts immediately with priority. drip_feed spreads submissions over several days for a natural pattern.',
        'Returns the task id; poll get_task for progress and get_task_links for per-URL status. Google makes the final indexing decision.',
      ].join(' '),
      inputSchema: z.object({
        urls: urlsSchema,
        title: z.string().max(255).optional().describe('Optional label shown in the dashboard.'),
        vip: z.boolean().default(false).describe('Use the VIP priority queue (faster, higher cost).'),
        drip_feed: z.boolean().default(false).describe('Spread the URLs over drip_duration_days instead of submitting all at once.'),
        drip_duration_days: z.number().int().min(1).max(30).default(3).describe('Days to spread a drip-feed task over (only when drip_feed is true).'),
        engine: z.enum(['google', 'bing']).default('google').describe('google (default) or bing (Bing Indexing only, no Google).'),
      }),
      outputSchema: z.object({
        task_id: z.number(),
        url_count: z.number(),
        vip: z.boolean(),
        is_drip_feed: z.boolean(),
        message: z.string(),
        dashboard_url: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ urls, title, vip, drip_feed, drip_duration_days, engine }) =>
      run(async () => {
        const list = cleanUrls(urls);
        if (list.length === 0) throw new Error('No usable URLs after trimming/deduplication.');
        const res = await client.createIndexTask({
          urls: list,
          type: 'indexer',
          engine,
          title,
          vip,
          drip_feed,
          drip_duration_days: drip_feed ? drip_duration_days : undefined,
        });
        const out = {
          task_id: res.task_id,
          url_count: list.length,
          vip,
          is_drip_feed: res.is_drip_feed,
          message: res.message,
          dashboard_url: `https://rapid-indexer.com/task_details?id=${res.task_id}`,
        };
        return ok(out, `Indexing task #${res.task_id} created for ${list.length} URL(s)${vip ? ' on the VIP queue' : ''}${res.is_drip_feed ? ` (drip feed over ${drip_duration_days} days)` : ''}. Check progress with get_task.`);
      })
  );

  server.registerTool(
    'check_index_status',
    {
      title: 'Check whether URLs are indexed by Google',
      description: [
        'Create an index-check task that reports, per URL, whether Google currently has it in the index (indexed / unindexed).',
        'Cheap (~0.1 credit per URL) but still SPENDS CREDITS. Results arrive within a few minutes: poll get_task, then read get_task_links.',
        'Does not submit anything to Google; use submit_urls_for_indexing for that.',
      ].join(' '),
      inputSchema: z.object({
        urls: urlsSchema,
        title: z.string().max(255).optional().describe('Optional label shown in the dashboard.'),
      }),
      outputSchema: z.object({
        task_id: z.number(),
        url_count: z.number(),
        message: z.string(),
        dashboard_url: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ urls, title }) =>
      run(async () => {
        const list = cleanUrls(urls);
        if (list.length === 0) throw new Error('No usable URLs after trimming/deduplication.');
        const res = await client.createIndexTask({ urls: list, type: 'checker', engine: 'google', title });
        const out = {
          task_id: res.task_id,
          url_count: list.length,
          message: res.message,
          dashboard_url: `https://rapid-indexer.com/task_details?id=${res.task_id}`,
        };
        return ok(out, `Index-check task #${res.task_id} created for ${list.length} URL(s). Poll get_task until status is "completed", then call get_task_links.`);
      })
  );

  // ---------------------------------------------------------------- tasks

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description: 'List the account\'s tasks, newest first, with per-link counts (indexed / unindexed / pending / error). Filter by type or status. Use it to find task ids.',
      inputSchema: z.object({
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(20),
        type: z.enum(['indexer', 'checker', 'traffic']).optional().describe('Only tasks of this type.'),
        status: z.enum(['pending', 'processing', 'completed', 'failed']).optional().describe('Only tasks in this status.'),
      }),
      outputSchema: z.object({
        tasks: z.array(
          z.object({
            id: z.number(),
            title: z.string().nullable(),
            type: z.string(),
            engine: z.string().nullable(),
            status: z.string(),
            vip: z.boolean(),
            links: z.object({ total: z.number(), indexed: z.number(), unindexed: z.number(), pending: z.number(), error: z.number() }),
            created_at: z.string(),
            completed_at: z.string().nullable(),
          })
        ),
        pagination: z.object({ page: z.number(), per_page: z.number(), total: z.number(), total_pages: z.number() }),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ page, per_page, type, status }) =>
      run(async () => {
        const res = await client.listTasks({ page, per_page, type, status });
        const lines = res.tasks.map(
          (t) =>
            `#${t.id} [${t.type}${t.vip ? '/VIP' : ''}] ${t.status} · ${t.links.total} URLs (indexed ${t.links.indexed}, unindexed ${t.links.unindexed}, pending ${t.links.pending}, error ${t.links.error}) · ${t.created_at}${t.title ? ` · "${t.title}"` : ''}`
        );
        const header = `${res.pagination.total} task(s) total, page ${res.pagination.page}/${res.pagination.total_pages}.`;
        return ok(res as unknown as Record<string, unknown>, [header, ...lines].join('\n'));
      })
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get task status',
      description: 'Fetch one task, refreshing its status from the provider first. Returns status (pending/processing/completed/failed) and progress counts. Poll this after creating a task.',
      inputSchema: z.object({ task_id: taskIdSchema }),
      outputSchema: z.object({
        id: z.number(),
        title: z.string().nullable(),
        type: z.string(),
        engine: z.string().nullable(),
        status: z.string(),
        vip: z.boolean(),
        progress: z.object({ updated: z.number(), pending: z.number() }),
        created_at: z.string(),
        completed_at: z.string().nullable(),
        dashboard_url: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task_id }) =>
      run(async () => {
        const t = await client.getTask(task_id);
        const out = { ...t, dashboard_url: `https://rapid-indexer.com/task_details?id=${t.id}` };
        return ok(
          out,
          `Task #${t.id} (${t.type}${t.vip ? '/VIP' : ''}) is ${t.status}; ${t.progress.pending} URL(s) still pending, ${t.progress.updated} updated in this sync. Created ${t.created_at}${t.completed_at ? `, completed ${t.completed_at}` : ''}.`
        );
      })
  );

  server.registerTool(
    'get_task_links',
    {
      title: 'Get per-URL results for a task',
      description: 'Return each URL in an indexing or index-check task with its status (indexed / unindexed / pending / error). Filter by status and paginate with limit/offset for big tasks. Always includes a summary count.',
      inputSchema: z.object({
        task_id: taskIdSchema,
        status: z.enum(['indexed', 'unindexed', 'pending', 'error']).optional().describe('Only return links with this status.'),
        limit: z.number().int().min(1).max(2000).default(200).describe('Max links to return.'),
        offset: z.number().int().min(0).default(0),
      }),
      outputSchema: z.object({
        task_id: z.number(),
        summary: z.record(z.string(), z.number()),
        returned: z.number(),
        offset: z.number(),
        has_more: z.boolean(),
        links: z.array(
          z.object({
            url: z.string(),
            status: z.string(),
            error_code: z.number().nullable(),
            checked_at: z.string().nullable(),
          })
        ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task_id, status, limit, offset }) =>
      run(async () => {
        const all = await client.getTaskLinks(task_id);
        const summary = summarizeLinks(all);
        const filtered = status ? all.filter((l) => l.status === status) : all;
        const slice = filtered.slice(offset, offset + limit);
        const out = {
          task_id,
          summary,
          returned: slice.length,
          offset,
          has_more: offset + slice.length < filtered.length,
          links: slice,
        };
        const text = [
          `Task #${task_id}: ${summary.total} URL(s) — indexed ${summary.indexed}, unindexed ${summary.unindexed}, pending ${summary.pending}, error ${summary.error}.`,
          status ? `Showing ${slice.length} of ${filtered.length} "${status}" link(s) from offset ${offset}.` : `Showing ${slice.length} link(s) from offset ${offset}.`,
          ...slice.map((l) => `${l.status.padEnd(9)} ${l.url}${l.error_code ? ` (error ${l.error_code})` : ''}`),
        ].join('\n');
        return ok(out, text);
      })
  );

  // -------------------------------------------------------------- traffic

  const trafficCommon = {
    link: z.string().url().describe('Target page the visitors should land on.'),
    visitors: z.number().int().min(30).max(30_000).describe('Total visitors to send (min 30, max 1,000 per scheduled day).'),
    days: z.number().int().min(1).max(30).default(1).describe('Spread the visitors over this many days.'),
    title: z.string().max(255).optional().describe('Campaign name shown in the dashboard.'),
    country: z.enum(TRAFFIC_COUNTRIES).default('WW').describe('Visitor geo. WW = worldwide mix.'),
    device: z.enum(['mixed', 'desktop', 'mobile', 'tablet']).default('mixed'),
    referrer: z.string().max(255).optional().describe('Apparent traffic source, e.g. "facebook.com" or a full URL. Empty = direct.'),
    ai_enabled: z.boolean().default(true).describe('Human-like AI browsing (scrolling, reading, internal clicks).'),
    click_links: z.array(z.string()).max(50).optional().describe('Paths or CSS selectors the visitor may click, e.g. ["/pricing", "button.cta"].'),
    click_chance: z.number().int().min(0).max(100).default(30).describe('Percent of visitors who click one of click_links.'),
    video_chance: z.number().int().min(0).max(100).default(20),
    delay_min: z.number().int().min(5).max(600).default(30).describe('Min seconds on page.'),
    delay_max: z.number().int().min(5).max(900).default(90).describe('Max seconds on page.'),
    pages_min: z.number().int().min(1).max(20).default(2).describe('Min internal pages per visit.'),
    pages_max: z.number().int().min(1).max(20).default(5).describe('Max internal pages per visit.'),
    bounce_rate: z.number().int().min(0).max(100).default(15).describe('Percent of single-page visits.'),
  };

  const trafficOutput = z.object({
    task_id: z.number(),
    campaign_id: z.string().nullable(),
    status: z.string(),
    visitors: z.number(),
    days: z.number(),
    message: z.string(),
    dashboard_url: z.string(),
    ctr_mode: z.object({ search_engine: z.string(), keywords_count: z.number(), search_only: z.boolean() }).optional(),
  });

  server.registerTool(
    'create_traffic_campaign',
    {
      title: 'Create AI traffic campaign',
      description: [
        'Send AI-driven, human-like visitors to a URL (geo, device, referrer and on-page behaviour are configurable).',
        'SPENDS CREDITS immediately: see get_pricing (credits per 1,000 visitors). visitors/days must not exceed 1,000 per day. Confirm with the user before creating.',
        'Returns the task id; poll get_task for status.',
      ].join(' '),
      inputSchema: z.object(trafficCommon).refine((v) => v.delay_min <= v.delay_max, { message: 'delay_min must be <= delay_max' })
        .refine((v) => v.pages_min <= v.pages_max, { message: 'pages_min must be <= pages_max' })
        .refine((v) => v.visitors <= v.days * 1000, { message: 'visitors may not exceed 1,000 per scheduled day; increase days' }),
      outputSchema: trafficOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) =>
      run(async () => {
        const res = await client.createTrafficCampaign({
          link: input.link,
          quantity: input.visitors,
          days: input.days,
          title: input.title,
          country: input.country,
          device: input.device,
          referrer: input.referrer,
          ai_enabled: input.ai_enabled,
          click_links: input.click_links?.join(', '),
          click_chance: input.click_chance,
          video_chance: input.video_chance,
          delay_min: input.delay_min,
          delay_max: input.delay_max,
          pages_min: input.pages_min,
          pages_max: input.pages_max,
          bounce_rate: input.bounce_rate,
        });
        const out = { ...res, dashboard_url: `https://rapid-indexer.com/task_details?id=${res.task_id}` };
        return ok(out, `Traffic campaign #${res.task_id} created: ${res.visitors} visitors over ${res.days} day(s) to ${input.link} (${res.status}).`);
      })
  );

  server.registerTool(
    'create_ctr_campaign',
    {
      title: 'Create CTR (search-and-click) campaign',
      description: [
        'Send visitors who search the given keywords on a search engine (Google by default), find the target URL in the results and click it, then browse like a human.',
        'SPENDS CREDITS immediately (same rate as traffic, per visitor). Confirm with the user before creating. Use list_search_engines for valid search_engine values.',
      ].join(' '),
      inputSchema: z.object({
        ...trafficCommon,
        keywords: z.array(z.string().min(1).max(200)).min(1).max(100).describe('Search queries the visitors will type.'),
        search_engine: z.string().default('GOOGLE').describe('Engine key from list_search_engines (GOOGLE, BING, YAHOO, DUCKDUCKGO, YANDEX, BAIDU, NAVER, AMAZON, ...).'),
        search_pages_max: z.number().int().min(1).max(10).default(3).describe('How many result pages to scan for the target URL.'),
        search_language: z.string().min(2).max(5).default('en').describe('Search UI language code.'),
        search_only: z.boolean().default(false).describe('Search without clicking the result (search-volume boost only).'),
      })
        .refine((v) => v.delay_min <= v.delay_max, { message: 'delay_min must be <= delay_max' })
        .refine((v) => v.pages_min <= v.pages_max, { message: 'pages_min must be <= pages_max' })
        .refine((v) => v.visitors <= v.days * 1000, { message: 'visitors may not exceed 1,000 per scheduled day; increase days' }),
      outputSchema: trafficOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) =>
      run(async () => {
        const res = await client.createCtrCampaign({
          link: input.link,
          quantity: input.visitors,
          days: input.days,
          title: input.title,
          country: input.country,
          device: input.device,
          referrer: input.referrer,
          ai_enabled: input.ai_enabled,
          click_links: input.click_links?.join(', '),
          click_chance: input.click_chance,
          video_chance: input.video_chance,
          delay_min: input.delay_min,
          delay_max: input.delay_max,
          pages_min: input.pages_min,
          pages_max: input.pages_max,
          bounce_rate: input.bounce_rate,
          keywords: input.keywords,
          search_engine: input.search_engine.toUpperCase(),
          search_pages_max: input.search_pages_max,
          search_language: input.search_language,
          search_only: input.search_only,
        });
        const out = { ...res, dashboard_url: `https://rapid-indexer.com/task_details?id=${res.task_id}` };
        return ok(out, `CTR campaign #${res.task_id} created: ${res.visitors} visitors over ${res.days} day(s), ${input.keywords.length} keyword(s) on ${input.search_engine.toUpperCase()} → ${input.link} (${res.status}).`);
      })
  );

  server.registerTool(
    'list_search_engines',
    {
      title: 'List search engines for CTR campaigns',
      description: 'Return the search engines and marketplaces accepted by create_ctr_campaign.search_engine.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        search_engines: z.record(
          z.string(),
          z.object({ name: z.string(), domain: z.string(), type: z.string(), region: z.string().optional() })
        ),
        total: z.number(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const engines = await client.listSearchEngines();
        const out = { search_engines: engines, total: Object.keys(engines).length };
        const lines = Object.entries(engines).map(([k, e]) => `${k}: ${e.name} (${e.domain}, ${e.type}${e.region ? `, ${e.region}` : ''})`);
        return ok(out, lines.join('\n'));
      })
  );

  // --------------------------------------------------------------- service

  server.registerTool(
    'check_service_health',
    {
      title: 'Check Rapid Indexer service health',
      description: 'Ping the Rapid Indexer API and report version and enabled features (indexer, checker, traffic, ctr). Also validates that the configured API key works.',
      inputSchema: z.object({}),
      outputSchema: z.object({ status: z.string(), version: z.string(), features: z.record(z.string(), z.boolean()), api_base_url: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const h = await client.health();
        const out = { ...h, api_base_url: client.baseUrl };
        const enabled = Object.entries(h.features).filter(([, v]) => v).map(([k]) => k);
        return ok(out, `Rapid Indexer API ${h.version} is ${h.status}. Enabled: ${enabled.join(', ')}.`);
      })
  );

  // --------------------------------------------------------------- prompts

  server.registerPrompt(
    'index_and_verify',
    {
      title: 'Index URLs and verify later',
      description: 'Guided workflow: estimate cost, submit URLs for indexing, and explain how to verify results.',
      argsSchema: z.object({
        urls: z.string().describe('URLs to index, one per line or comma-separated.'),
        vip: z.string().optional().describe('"yes" to use the VIP queue.'),
      }),
    },
    ({ urls, vip }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Use the Rapid Indexer tools to index these URLs:',
              urls,
              '',
              `Steps: 1) call get_account and estimate_cost for ${vip === 'yes' ? 'VIP' : 'standard'} indexing and tell me the cost; 2) if I have enough credits, call submit_urls_for_indexing${vip === 'yes' ? ' with vip=true' : ''}; 3) report the task id and tell me to run check_index_status on the same URLs in 24-48h to verify. Do not submit if the balance is insufficient; tell me how much to top up instead.`,
            ].join('\n'),
          },
        },
      ],
    })
  );

  return server;
}
