import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { StdioProxyConfig } from "./config.js";

const CLIENT_INFO = { name: "dsh-control-mcp-stdio", version: "0.1.0" };

/** Connect stdio to the existing authenticated HTTP endpoint without listening on another port. */
export async function startStdioProxy(config: StdioProxyConfig): Promise<{
	close(): Promise<void>;
}> {
	const httpClient = new Client(CLIENT_INFO);
	const httpTransport = new StreamableHTTPClientTransport(config.endpoint, {
		requestInit: {
			headers: { Authorization: `Bearer ${config.token}` },
		},
	});
	const stdioServer = new Server(CLIENT_INFO, {
		capabilities: { tools: {} },
	});
	const stdioTransport = new StdioServerTransport();
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (!closing) {
			closing = (async () => {
				await stdioServer.close().catch(() => {});
				await httpClient.close().catch(() => {});
				await httpTransport.close().catch(() => {});
			})();
		}
		return closing;
	};

	stdioServer.setRequestHandler("tools/list", (request, context) =>
		httpClient.listTools(request.params, { signal: context.mcpReq.signal }),
	);
	stdioServer.setRequestHandler("tools/call", (request, context) =>
		httpClient.callTool(request.params, { signal: context.mcpReq.signal }),
	);

	try {
		// Establish the authenticated HTTP session before advertising stdio readiness.
		await httpClient.connect(httpTransport);
		await stdioServer.connect(stdioTransport);
		stdioServer.onclose = () => {
			void close();
		};
		return { close };
	} catch {
		await close();
		throw new Error("Unable to connect to the DSH MCP HTTP endpoint");
	}
}
