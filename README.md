# rapid-indexer-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for [Rapid Indexer](https://rapid-indexer.com). It lets Claude, Cursor, ChatGPT, Claude Code and any other MCP host submit URLs to Googlebot, check whether pages are indexed, read task results and launch traffic / CTR campaigns using your Rapid Indexer API key.

Built on the official TypeScript SDK v2 (`@modelcontextprotocol/server`). Serves over **stdio** (local, one account) or **Streamable HTTP** (hosted, multi-tenant: each request carries its own API key).

## Requirements

- Node.js 20+
- A Rapid Indexer API key: log in, open your account menu → **API Access** (`https://rapid-indexer.com/api_access`).

## Quick start (stdio)

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "rapid-indexer": {
      "command": "npx",
      "args": ["-y", "rapid-indexer-mcp"],
      "env": { "RAPID_INDEXER_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

### Claude Desktop

`~/.config/Claude/claude_desktop_config.json` on Linux:

```json
{
  "mcpServers": {
    "rapid-indexer": {
      "command": "npx",
      "args": ["-y", "rapid-indexer-mcp"],
      "env": { "RAPID_INDEXER_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add rapid-indexer -e RAPID_INDEXER_API_KEY=YOUR_API_KEY -- npx -y rapid-indexer-mcp
```

### From a local checkout (before publishing to npm)

```bash
cd mcp
npm install
npm run build
```

Then point the host at the built CLI:

```json
{
  "mcpServers": {
    "rapid-indexer": {
      "command": "node",
      "args": ["/absolute/path/to/Rapid-Indexer-main/mcp/dist/cli.js"],
      "env": { "RAPID_INDEXER_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

## Hosted mode (Streamable HTTP)

One process serves every customer; the API key travels with each request.

```bash
RAPID_INDEXER_BASE_URL=https://rapid-indexer.com \
node dist/cli.js --http --host 0.0.0.0 --port 3333 --path /mcp
```

Clients connect to `https://your-host/mcp` and send `Authorization: Bearer <api key>` (also accepted: `X-API-Key: <key>`, or `?api_key=` on the URL). `GET /healthz` returns a liveness JSON.

Cursor example for a remote server:

```json
{
  "mcpServers": {
    "rapid-indexer": {
      "url": "https://mcp.rapid-indexer.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

Put it behind TLS (nginx/Caddy) and run it with systemd or pm2. The server is stateless, so you can run several replicas. `--api-key` / `RAPID_INDEXER_API_KEY` in HTTP mode is only a fallback for requests that carry no key (single-tenant self-hosting).

## Tools

| Tool | Spends credits | What it does |
|------|:--:|------|
| `get_account` | no | Account id, email, credit balance (+ USD). |
| `get_pricing` | no | Live credits per URL (standard / VIP / checker), traffic price per 1,000 visitors, USD per credit. |
| `estimate_cost` | no | Cost of N URLs as indexer/checker (+VIP) and whether the balance covers it. |
| `submit_urls_for_indexing` | **yes** | Create an indexing task (standard or VIP queue, optional drip feed). Max 10,000 URLs. |
| `check_index_status` | **yes** (~0.1 cr/URL) | Create an index-check task: per-URL indexed / unindexed. |
| `list_tasks` | no | Paginated task list with indexed/unindexed/pending/error counts; filter by type/status. |
| `get_task` | no | Refresh and return one task's status and progress. |
| `get_task_links` | no | Per-URL results with status filter and pagination. |
| `create_traffic_campaign` | **yes** | AI visitors to a URL (geo, device, referrer, behaviour). |
| `create_ctr_campaign` | **yes** | Visitors search keywords on Google/Bing/… and click your result. |
| `list_search_engines` | no | Valid `search_engine` values for CTR campaigns. |
| `check_service_health` | no | API version, enabled features, and confirms the key works. |

Every tool returns human-readable text plus `structuredContent` validated by an output schema. Errors from the API come back as `isError` results with the API message and a hint (top-up link on insufficient credits, key location on 401).

Prompt: `index_and_verify` — guided estimate → submit → verify workflow.

## Environment / flags

| Variable | Flag | Default | Notes |
|----------|------|---------|-------|
| `RAPID_INDEXER_API_KEY` | `--api-key` | – | Required for stdio. Fallback only in HTTP mode. |
| `RAPID_INDEXER_BASE_URL` | `--base-url` | `https://rapid-indexer.com/api/v1/index.php` | Site origin is also accepted; the router path is appended. |
| `HOST` | `--host` | `127.0.0.1` | HTTP mode. |
| `PORT` | `--port` | `3333` | HTTP mode. |
| `MCP_PATH` | `--path` | `/mcp` | HTTP mode. |

## Development

```bash
npm install
npm run build          # tsc → dist/
npm run dev            # run src/cli.ts with tsx (stdio)
npm run inspect        # MCP Inspector against dist/cli.js
```

If `npm install` hangs on a machine with broken IPv6, run it with
`NODE_OPTIONS="--no-network-family-autoselection --dns-result-order=ipv4first"`.

## Publishing

```bash
npm version patch
npm publish --access public
```

`prepublishOnly` builds `dist/`. The package ships only `dist/`, `README.md` and `LICENSE`.

## API coverage

The server talks to the public REST API documented at <https://rapid-indexer.com/api-docs>. `list_tasks` and `pricing` were added to that API together with this server; hosts running an older build of the site will see those two tools fail with "Invalid action" until the API is redeployed.

## License

MIT
