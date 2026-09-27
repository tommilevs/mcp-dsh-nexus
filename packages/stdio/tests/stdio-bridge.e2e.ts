import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpRoute } from "../../host/src/http-route.js";

const testToken = "stdio-test-bearer-value";
const packageRoot = resolve(import.meta.dirname, "..");
const cliPath = resolve(packageRoot, ".test-build/cli.js");
const tscPath = resolve(packageRoot, "../../node_modules/typescript/bin/tsc");

async function waitFor(
	predicate: () => boolean,
	description: string,
): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${description}`);
		await delay(20);
	}
}

async function startHttpServer() {
	let port = 0;
	const route = createHttpRoute({
		port: () => port,
		auth: {
			resolvePrincipal: async (req) => {
				const authorization = req.headers.authorization;
				if (authorization !== `Bearer ${testToken}`)
					throw new Error("Unauthorized");
				return { id: "stdio-test-client", scopes: [], allowedSessionIds: [] };
			},
		},
		registerTools: (server) => {
			server.registerTool(
				"test_echo",
				{
					description: "Returns text and image content for proxy verification.",
				},
				async () => ({
					content: [
						{ type: "text", text: "upstream echo" },
						{
							type: "image",
							data: Buffer.from("test-image-bytes").toString("base64"),
							mimeType: "image/png",
						},
					],
				}),
			);
			server.registerTool(
				"test_error",
				{ description: "Returns an MCP tool error." },
				async () => ({
					isError: true,
					content: [{ type: "text", text: "upstream tool error" }],
				}),
			);
		},
	});
	const http = createServer(route.handler);
	http.listen(0, "127.0.0.1");
	await once(http, "listening");
	const address = http.address();
	if (!address || typeof address === "string") throw new Error("No HTTP port");
	port = address.port;
	return {
		http,
		route,
		endpoint: `http://127.0.0.1:${port}/api/dsh-control-mcp/mcp`,
		async close() {
			await route.dispose();
			http.closeAllConnections();
			await new Promise<void>((resolveClose, reject) =>
				http.close((error) => (error ? reject(error) : resolveClose())),
			);
		},
	};
}

function createClient(endpoint: string, token?: string) {
	const env: Record<string, string> = {
		...process.env,
		DSH_CONTROL_MCP_URL: endpoint,
	};
	if (token === undefined) delete env.DSH_CONTROL_MCP_TOKEN;
	else env.DSH_CONTROL_MCP_TOKEN = token;
	const args = [cliPath];
	if (token) expect(args.join(" ")).not.toContain(token);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args,
		env,
		cwd: packageRoot,
		stderr: "pipe",
	});
	let stderr = "";
	let stdout = "";
	transport.stderr?.on("data", (chunk: Buffer | string) => {
		stderr += chunk.toString();
	});
	const originalStart = transport.start.bind(transport);
	transport.start = async () => {
		await originalStart();
		const child = (
			transport as unknown as { _process?: { stdout?: NodeJS.ReadableStream } }
		)._process;
		child?.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
	};
	const client = new Client({ name: "stdio-bridge-test", version: "1.0.0" });
	return { client, transport, stderr: () => stderr, stdout: () => stdout };
}

describe("stdio compatibility process", () => {
	let service: Awaited<ReturnType<typeof startHttpServer>>;

	beforeAll(async () => {
		const build = spawnSync(
			process.execPath,
			[
				tscPath,
				"--strict",
				"--skipLibCheck",
				"--module",
				"NodeNext",
				"--moduleResolution",
				"NodeNext",
				"--target",
				"ES2022",
				"--outDir",
				resolve(packageRoot, ".test-build"),
				"--rootDir",
				resolve(packageRoot, "src"),
				resolve(packageRoot, "src/cli.ts"),
			],
			{ cwd: packageRoot, encoding: "utf8" },
		);
		if (build.status !== 0)
			throw new Error(
				`stdio test build failed: ${build.stderr || build.stdout}`,
			);
		service = await startHttpServer();
	});

	afterAll(async () => {
		if (service) await service.close();
		rmSync(resolve(packageRoot, ".test-build"), {
			recursive: true,
			force: true,
		});
	});

	it("forwards initialize, tools/list, tools/call, image content, and tool errors", async () => {
		const { client, transport, stderr, stdout } = createClient(
			service.endpoint,
			testToken,
		);
		try {
			await client.connect(transport);
			const { tools } = await client.listTools();
			expect(tools.map(({ name }) => name)).toEqual([
				"test_echo",
				"test_error",
			]);

			const result = await client.callTool({ name: "test_echo" });
			expect(result.content).toEqual([
				{ type: "text", text: "upstream echo" },
				{
					type: "image",
					data: Buffer.from("test-image-bytes").toString("base64"),
					mimeType: "image/png",
				},
			]);

			const toolError = await client.callTool({ name: "test_error" });
			expect(toolError.isError).toBe(true);
			expect(toolError.content).toEqual([
				{ type: "text", text: "upstream tool error" },
			]);
			expect(stderr()).not.toContain(testToken);
			expect(stdout()).not.toContain(testToken);
		} finally {
			await client.close().catch(() => {});
			await transport.close().catch(() => {});
		}
	});

	it.each([
		["missing", undefined, "DSH_CONTROL_MCP_TOKEN is required"],
		[
			"invalid",
			"invalid-test-bearer-value",
			"Unable to connect to the DSH MCP HTTP endpoint",
		],
	])(
		"rejects %s credentials without exposing bearer values",
		async (_label, token, message) => {
			const { client, transport, stderr, stdout } = createClient(
				service.endpoint,
				token,
			);
			try {
				await expect(client.connect(transport)).rejects.toThrow();
				await waitFor(() => transport.pid === null, "stdio child exit");
				expect(stderr()).toContain(message);
				expect(stderr()).not.toContain(token ?? testToken);
				expect(stdout()).not.toContain(token ?? testToken);
			} finally {
				await client.close().catch(() => {});
				await transport.close().catch(() => {});
			}
		},
	);

	it("closes its upstream HTTP session when the process receives SIGTERM", async () => {
		const { client, transport } = createClient(service.endpoint, testToken);
		await client.connect(transport);
		await client.listTools();
		const pid = transport.pid;
		expect(pid).toBeTypeOf("number");
		expect(service.route.registry.size).toBe(1);

		process.kill(pid as number, "SIGTERM");
		await waitFor(() => transport.pid === null, "stdio SIGTERM shutdown");
		await waitFor(
			() => service.route.registry.size === 0,
			"HTTP session cleanup",
		);
		await client.close().catch(() => {});
	});
});
