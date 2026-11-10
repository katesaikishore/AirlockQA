# MCP server

Run the public MCP server over stdio:

```bash
bun bin/airlock.ts mcp
```

Tools:

| Tool | Purpose |
|---|---|
| `airlock_evidence_verify` | Verify a signed run-evidence bundle (Merkle root, hash chain, signature). Use `AIRLOCK_SIGNING_KEY` for HMAC or `AIRLOCK_TRUSTED_PUBLIC_KEY` for Ed25519. |
| `airlock_verify` | Verify a signed Verified Merge verdict offline. |
| `airlock_flake` | Read Airlock reporter manifests and return flake counts, causes and optional Markdown. |

Example MCP client config:

```json
{
  "mcpServers": {
    "airlockqa": {
      "command": "npx",
      "args": ["--yes", "airlockqa@latest", "mcp"]
    }
  }
}
```

The public server has no shell execution and no cloud credentials. It only reads files under the working
directory.
