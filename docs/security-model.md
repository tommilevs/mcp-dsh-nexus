# Security model

DSH Control MCP is a bridge into an already-running DeepSeek Harness Desktop instance. It preserves the existing loopback route and can start a dedicated HTTP listener that exposes only the MCP route.

> **Release status:** this document describes the security design and current code limits. Do not treat the repository as a ready-to-install release until the DSH token-management UI, client setup, and installation workflow have passed integration checks.

## Network boundary

- The existing DSH web-server route remains loopback-only. The dedicated listener binds to `127.0.0.1` by default or one explicitly selected private RFC1918 IPv4 address and serves only `/api/dsh-control-mcp/mcp`.
- Bearer authentication is required by default and is mandatory for a private/LAN bind. Disabling it forces the dedicated listener to loopback. The listener rejects peers outside its bind policy, unexpected `Host`/`Origin`, forwarded headers, and wildcard CORS.
- LAN mode is plain HTTP. Use only on a trusted private network, restrict inbound access with the host firewall, do not forward the port from a router, and do not expose it to the public Internet. Use a separately secured VPN/TLS tunnel on untrusted networks.
- Requests with no `Origin` are intended for native MCP clients; they still require a valid bearer token whenever bearer authentication is enabled. Browser origins must exactly match the configured listener address and port; `Origin: null` and foreign origins are rejected.

## Client identities and permissions

Each MCP client uses an independently issued bearer token. The secret is random, stored only as a SHA-256 digest in the DSH credential store, shown once when created, and never returned by metadata listing. Tokens can be revoked; the next request and tool call checks the credential again. Treat a token like a password and put it in the MCP client's secret store or environment, never in a URL, source file, or log. If bearer authentication is intentionally disabled, the listener grants local callers all configured tool scopes; only do this when loopback is appropriately trusted.

Tokens have explicit read/chat scopes and are limited to sessions they own or that the operator has explicitly allowed. A chat created by a token belongs to that token. Read, follow, send, wait, and cancel operations reject sessions outside its grant. The current tool set contains DSH status, model/workspace/session listing, bounded session reads/follow, visible chat creation, message send/wait, and cancellation. The token-management section includes English/Russian copy, explicit permissions, revocation, and retry-safe one-time token display. Desktop integration testing remains required before calling this a complete operator workflow.

Screenshot capture and settings/plugin changes are not available unless an optional, separately validated capability is installed and exposed by the running DSH Desktop version. The bridge does not grant shell access, arbitrary filesystem access, arbitrary URL fetching, arbitrary Electron access, or silent profile/plugin mutation.

## Resource limits

The current limits are 64 KiB per POST body; 4 concurrent body readers per token / 16 total with a 30-second read deadline; 4 MCP sessions per token / 16 total; 120 requests per minute per token / 600 total; 2 active tool calls per token / 8 total; a 59-second tool response deadline (with read/follow waits capped at 55 seconds); and a 120-second idle / 10-minute per-stream lifetime. Session history, model/workspace listings, and tool outputs are also bounded. These bounds protect the local DSH process from accidental or abusive overload; they do not make a compromised local account safe.

## Local trust caveat

DSH's authenticated API currently treats local clients as one operator rather than identifying a particular settings window. Token-management methods exposed through DSH therefore trust any local process that can authenticate to DSH's own API. Loopback binding limits network access, but it does not isolate hostile software already running as the same Windows user. Revoke any client token that is no longer needed.
