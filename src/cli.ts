#!/usr/bin/env node
/**
 * rapid-indexer-mcp CLI.
 *
 *   rapid-indexer-mcp                 # stdio (for Cursor, Claude Desktop, Claude Code, ...)
 *   rapid-indexer-mcp --http          # Streamable HTTP on 127.0.0.1:3333/mcp
 *
 * Env:
 *   RAPID_INDEXER_API_KEY   API key from https://rapid-indexer.com/api_access (required for stdio)
 *   RAPID_INDEXER_BASE_URL  Override API base (default https://rapid-indexer.com/api/v1/index.php)
 *   PORT / HOST / MCP_PATH  HTTP mode defaults
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { RapidIndexerClient } from './client.js';
import { startHttpServer } from './http.js';
import { createRapidIndexerServer, SERVER_VERSION } from './server.js';

interface Args {
  http: boolean;
  host: string;
  port: number;
  path: string;
  apiKey: string | null;
  baseUrl: string | undefined;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const env = process.env;
  const args: Args = {
    http: false,
    host: env.HOST ?? '127.0.0.1',
    port: env.PORT ? Number(env.PORT) : 3333,
    path: env.MCP_PATH ?? '/mcp',
    apiKey: env.RAPID_INDEXER_API_KEY ?? null,
    baseUrl: env.RAPID_INDEXER_BASE_URL,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      i++;
      return v;
    };
    switch (a) {
      case '--http':
        args.http = true;
        break;
      case '--stdio':
        args.http = false;
        break;
      case '--host':
        args.host = next();
        break;
      case '--port':
        args.port = Number(next());
        break;
      case '--path':
        args.path = next();
        break;
      case '--api-key':
        args.apiKey = next();
        break;
      case '--base-url':
        args.baseUrl = next();
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    }
  }
  return args;
}

function usage(): string {
  return `rapid-indexer-mcp ${SERVER_VERSION}

Usage:
  rapid-indexer-mcp [--stdio]                 Serve over stdio (default)
  rapid-indexer-mcp --http [--host H] [--port P] [--path /mcp]
                                              Serve over Streamable HTTP

Options:
  --api-key <key>     Rapid Indexer API key (or RAPID_INDEXER_API_KEY).
                      In HTTP mode this is only a fallback; clients normally
                      send "Authorization: Bearer <key>" per request.
  --base-url <url>    API base (default https://rapid-indexer.com/api/v1/index.php)
  -v, --version       Print version
  -h, --help          Show this help

Get an API key at https://rapid-indexer.com/api_access
`;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(usage());
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (args.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  if (args.http) {
    const { close } = await startHttpServer({
      host: args.host,
      port: args.port,
      path: args.path,
      fallbackApiKey: args.apiKey,
      baseUrl: args.baseUrl,
    });
    const shutdown = () => {
      void close().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  // stdio: one connection, one account.
  if (!args.apiKey) {
    console.error(
      'rapid-indexer-mcp: RAPID_INDEXER_API_KEY is not set. Tools will load but every call will fail until a key is configured. Get one at https://rapid-indexer.com/api_access'
    );
  }
  const client = new RapidIndexerClient({
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    userAgent: `rapid-indexer-mcp/${SERVER_VERSION} (stdio)`,
  });
  serveStdio(() => createRapidIndexerServer(client), {
    onerror: (err) => console.error(`[rapid-indexer-mcp] ${err.message}`),
  });
  console.error(`rapid-indexer-mcp ${SERVER_VERSION} running on stdio (${client.baseUrl})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
