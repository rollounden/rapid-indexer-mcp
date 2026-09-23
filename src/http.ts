import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

import { RapidIndexerClient } from './client.js';
import { createRapidIndexerServer, SERVER_VERSION } from './server.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** Path the MCP endpoint is served on. */
  path: string;
  /** Optional fixed API key used when the request carries none (single-tenant self-hosting). */
  fallbackApiKey: string | null;
  baseUrl?: string;
  log?: (msg: string) => void;
}

/** Pull the Rapid Indexer API key out of an incoming MCP HTTP request. */
export function apiKeyFromRequest(req: Request | undefined): string | null {
  if (!req) return null;
  const auth = req.headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const direct = req.headers.get('x-api-key');
  if (direct && direct.trim() !== '') return direct.trim();
  try {
    const q = new URL(req.url).searchParams.get('api_key');
    if (q && q.trim() !== '') return q.trim();
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Serve the MCP server over Streamable HTTP. Stateless and multi-tenant:
 * every request builds a server bound to the API key found in that request
 * (`Authorization: Bearer <key>` or `X-API-Key`), so one deployment can serve
 * every Rapid Indexer customer.
 */
export function startHttpServer(opts: HttpOptions): Promise<{ close: () => Promise<void>; url: string }> {
  const log = opts.log ?? ((m: string) => console.error(m));

  const handler = createMcpHandler(
    (ctx) => {
      const apiKey = apiKeyFromRequest(ctx.requestInfo) ?? opts.fallbackApiKey;
      const client = new RapidIndexerClient({
        apiKey,
        baseUrl: opts.baseUrl,
        userAgent: `rapid-indexer-mcp/${SERVER_VERSION} (http)`,
      });
      return createRapidIndexerServer(client);
    },
    {
      onerror: (err) => log(`[mcp] ${err.message}`),
    }
  );
  const nodeHandler = toNodeHandler(handler, { onerror: (err) => log(`[http] ${err.message}`) });

  const endpointPath = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz' || url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'rapid-indexer-mcp', version: SERVER_VERSION }));
      return;
    }

    if (url.pathname !== endpointPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', mcp_endpoint: endpointPath }));
      return;
    }

    void nodeHandler(req, res);
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.host, () => {
      const url = `http://${opts.host}:${opts.port}${endpointPath}`;
      log(`rapid-indexer-mcp ${SERVER_VERSION} listening on ${url} (Streamable HTTP)`);
      resolve({
        url,
        close: async () => {
          await handler.close();
          await new Promise<void>((done) => httpServer.close(() => done()));
        },
      });
    });
  });
}
