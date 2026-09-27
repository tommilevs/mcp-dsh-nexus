# Security model

DSH Control MCP is a local bridge into an already-running DeepSeek Harness Desktop instance. Its HTTP endpoint is mounted on DSH's existing listener; it does not open a second port.

> **Release status:** this document describes the security design and current code limits. Do not treat the repository as a ready-to-install release until the DSH token-management UI, client setup, and installation workflow have passed integration checks.

## Network boundary

- The Host plugin refuses to start unless DSH binds to `127.0.0.1`.
- Requests must come from a loopback peer and use the exact local `Host`; forwarded headers are rejected.
- Requests with no `Origin` are intended for native MCP clients and still require a valid bearer token. Browser origins are restricted to loopback; `Origin: null`, foreign origins, cookies, and wildcard CORS are rejected.
- Do not expose this endpoint on a LAN, through a reverse proxy, or to the public Internet. Remote access needs a separately designed authenticated TLS or tunnel boundary.

## Client identities and permissions

Each MCP client uses an independently issued bearer token. The secret is random, stored only as a SHA-256 digest in the DSH credential store, shown once when created, and never returned by metadata listing. Tokens can be revoked; the next request and tool call checks the credential again. Treat a token like a password and put it in the MCP client's secret store or environment, never in a URL, source file, or log.

Tokens have explicit read/chat scopes and are limited to sessions they own or that the operator has explicitly allowed. A chat created by a token belongs to that token. Read, follow, send, wait, and cancel operations reject sessions outside its grant. The current tool set contains DSH status, model/workspace/session listing, bounded session reads/follow, visible chat creation, message send/wait, and cancellation. The token-management section includes English/Russian copy, explicit permissions, revocation, and retry-safe one-time token display. Desktop integration testing remains required before calling this a complete operator workflow.

Screenshot capture and settings/plugin changes are not available unless an optional, separately validated capability is installed and exposed by the running DSH Desktop version. The bridge does not grant shell access, arbitrary filesystem access, arbitrary URL fetching, arbitrary Electron access, or silent profile/plugin mutation.

## Resource limits

The current limits are 64 KiB per POST body; 4 concurrent body readers per token / 16 total with a 30-second read deadline; 4 MCP sessions per token / 16 total; 120 requests per minute per token / 600 total; 2 active tool calls per token / 8 total; a 59-second tool response deadline (with read/follow waits capped at 55 seconds); and a 120-second idle / 10-minute per-stream lifetime. Session history, model/workspace listings, and tool outputs are also bounded. These bounds protect the local DSH process from accidental or abusive overload; they do not make a compromised local account safe.

## Local trust caveat

DSH's authenticated API currently treats local clients as one operator rather than identifying a particular settings window. Token-management methods exposed through DSH therefore trust any local process that can authenticate to DSH's own API. Loopback binding limits network access, but it does not isolate hostile software already running as the same Windows user. Revoke any client token that is no longer needed.
