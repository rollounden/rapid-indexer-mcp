# Installing Rapid Indexer MCP

1. Ask the user for their Rapid Indexer API key. It is on https://rapid-indexer.com/api_access (account menu, API Access).
2. Add this server to the MCP settings file:

```json
{
  "mcpServers": {
    "rapid-indexer": {
      "command": "npx",
      "args": ["-y", "rapid-indexer-mcp"],
      "env": { "RAPID_INDEXER_API_KEY": "<the user's key>" }
    }
  }
}
```

Hosted alternative (no Node needed):

```json
{
  "mcpServers": {
    "rapid-indexer": {
      "type": "streamableHttp",
      "url": "https://mcp.rapid-indexer.com/mcp",
      "headers": { "Authorization": "Bearer <the user's key>" }
    }
  }
}
```

3. Check it works by calling `check_service_health`, then `get_account` to show the credit balance.
4. Before submitting URLs, call `estimate_cost` and confirm the cost with the user. `submit_urls_for_indexing`, `check_index_status` and the campaign tools spend credits.
