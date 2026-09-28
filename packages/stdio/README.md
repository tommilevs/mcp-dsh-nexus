# DSH Control MCP stdio adapter

This optional adapter gives stdio-only MCP clients access to the same scoped tools exposed by the DSH Host's authenticated Streamable HTTP endpoint. It starts no listener of its own: each adapter process creates one authenticated HTTP MCP session to the running DSH Host and forwards `tools/list` and `tools/call` over its stdio connection. Image content is passed through as MCP content blocks.

Set `DSH_CONTROL_MCP_URL` to `http://127.0.0.1:<port>/api/dsh-control-mcp/mcp` using the dedicated listener URL shown in the DSH MCP settings panel. The adapter requires an explicit URL instead of guessing. Only loopback HTTP URLs with the exact MCP path are accepted; use a native Streamable HTTP MCP client for the dedicated LAN endpoint. The bearer credential must be provided as `DSH_CONTROL_MCP_TOKEN`; it is sent only in the HTTP `Authorization` header. Do not put it in command arguments, endpoint URLs, or a checked-in configuration file.

Build from this repository with:

```sh
pnpm --filter @tommilevs/dsh-control-mcp-stdio build
```

Until this package is distributed, point client configs at the built `lib/cli.js` in this checkout. The examples use `node` as the command; replace `/absolute/path/to/dsh-control-mcp` with the checkout location. The token placeholder is an environment-variable reference, not a credential. Set `DSH_CONTROL_MCP_TOKEN` in the environment before starting the MCP client, using your local secret manager or OS credential store.

## Claude Code

Add this entry to `.mcp.json` at the project root, or to the user MCP configuration:

```json
{
  "mcpServers": {
    "dsh-control": {
      "command": "node",
      "args": [
        "/absolute/path/to/dsh-control-mcp/packages/stdio/lib/cli.js"
      ],
      "env": {
        "DSH_CONTROL_MCP_TOKEN": "${DSH_CONTROL_MCP_TOKEN}",
        "DSH_CONTROL_MCP_URL": "${DSH_CONTROL_MCP_URL}"
      }
    }
  }
}
```

Claude Code expands environment-variable references in stdio server configuration. See [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

## Codex

Add this to `~/.codex/config.toml` (or the equivalent Codex config file):

```toml
[mcp_servers.dsh-control]
command = "node"
args = ["/absolute/path/to/dsh-control-mcp/packages/stdio/lib/cli.js"]
env_vars = ["DSH_CONTROL_MCP_TOKEN", "DSH_CONTROL_MCP_URL"]
```

`env_vars` passes the user-managed token and endpoint variables through to the child process without saving their values in Codex config. Set both variables in the environment used to start Codex. See the [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Security and lifecycle

- The adapter requires a non-empty `DSH_CONTROL_MCP_TOKEN` and never prints configuration or upstream transport errors that might contain credentials.
- `DSH_CONTROL_MCP_URL` cannot include credentials, query parameters, or fragments, and cannot target a non-loopback host. This stdio restriction is intentional and does not apply to native HTTP MCP clients using the dedicated listener.
- Closing stdio or sending SIGINT/SIGTERM closes the SDK transports so the authenticated HTTP session is released.
- The HTTP Host remains authoritative for token scopes and tool permissions. The adapter does not broaden the upstream tool list or provide an alternate authentication path.
