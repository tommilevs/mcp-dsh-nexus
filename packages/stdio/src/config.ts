const MCP_PATH = "/api/dsh-control-mcp/mcp";

export interface StdioProxyConfig {
	endpoint: URL;
	token: string;
}

/** Read only the secret and endpoint from the process environment. */
export function readConfig(
	env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): StdioProxyConfig {
	const token = env.DSH_CONTROL_MCP_TOKEN;
	if (!token?.trim()) throw new Error("DSH_CONTROL_MCP_TOKEN is required");

	const configuredEndpoint = env.DSH_CONTROL_MCP_URL;
	if (!configuredEndpoint?.trim())
		throw new Error("DSH_CONTROL_MCP_URL is required");
	let endpoint: URL;
	try {
		endpoint = new URL(configuredEndpoint);
	} catch {
		throw new Error("DSH_CONTROL_MCP_URL must be a loopback HTTP MCP endpoint");
	}
	const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
		endpoint.hostname.toLowerCase(),
	);
	if (
		endpoint.protocol !== "http:" ||
		!loopback ||
		endpoint.pathname !== MCP_PATH ||
		endpoint.username !== "" ||
		endpoint.password !== "" ||
		endpoint.search !== "" ||
		endpoint.hash !== ""
	)
		throw new Error("DSH_CONTROL_MCP_URL must be a loopback HTTP MCP endpoint");

	return { endpoint, token };
}
