import { EventEmitter, once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type IncomingHttpHeaders, request } from "node:http";
import { PassThrough } from "node:stream";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpRoute, MCP_PATH } from "../src/http-route.js";
import {
	apply,
	ClientTokenController,
	type DshHostContext,
} from "../src/index.js";
import { RequestLimiter } from "../src/rate-limiter.js";

const routePorts = new WeakMap<ReturnType<typeof createHttpRoute>, number>();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
const initialize = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "test", version: "1" },
	},
};
async function setup(
	authError?: string,
	limiter?: RequestLimiter,
	bodyReadTimeoutMs?: number,
) {
	let port = 0;
	const route = createHttpRoute({
		port: () => port,
		limiter,
		bodyReadTimeoutMs,
		auth: {
			resolvePrincipal: async (req) => {
				if (authError) throw new Error(authError);
				const id = req.headers.authorization?.split(" ")[1];
				if (!id) throw new Error("Unauthorized");
				return { id, scopes: [], allowedSessionIds: [] };
			},
		},
	});
	const server = createServer(route.handler);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("address");
	port = address.port;
	routePorts.set(route, port);
	cleanup.push(async () => {
		await route.dispose();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	function send(
		method = "POST",
		body: unknown = initialize,
		headers: IncomingHttpHeaders = {},
		chunks?: string[],
	) {
		return new Promise<{
			status: number;
			headers: IncomingHttpHeaders;
			text: string;
		}>((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port,
					path: MCP_PATH,
					method,
					headers: {
						authorization: "Bearer a",
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
						...headers,
					},
				},
				(res) => {
					let text = "";
					res.on("data", (chunk) => {
						text += chunk;
					});
					res.on("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							headers: res.headers,
							text,
						}),
					);
				},
			);
			req.on("error", reject);
			if (chunks) for (const chunk of chunks) req.write(chunk);
			else if (method === "POST")
				req.write(typeof body === "string" ? body : JSON.stringify(body));
			req.end();
		});
	}
	return { route, send, port };
}
function synthetic(method: string, id?: string) {
	const req = Object.assign(new PassThrough(), {
		method,
		headers: {
			host: "127.0.0.1:1234",
			authorization: "Bearer a",
			"content-type": "application/json",
			...(id ? { "mcp-session-id": id } : {}),
		},
		rawHeaders: [],
		socket: { remoteAddress: "127.0.0.1" },
	}) as unknown as IncomingMessage;
	const res = Object.assign(new EventEmitter(), {
		statusCode: 200,
		headersSent: false,
		writableEnded: false,
		writableFinished: false,
		writeHead(status: number) {
			this.statusCode = status;
			this.headersSent = true;
		},
		setHeader: vi.fn(),
		write: vi.fn(() => true),
		end(
			this: EventEmitter & {
				writableEnded: boolean;
				writableFinished: boolean;
			},
		) {
			this.writableEnded = true;
			this.writableFinished = true;
			this.emit("finish");
		},
	}) as unknown as ServerResponse;
	return { req, res };
}
async function direct(
	route: ReturnType<typeof createHttpRoute>,
	method: string,
	id?: string,
	body: unknown = {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name: "test" },
	},
) {
	const pair = synthetic(method, id);
	pair.req.headers.host = `127.0.0.1:${routePorts.get(route) ?? 1234}`;
	const result = route.handler(pair.req, pair.res);
	await new Promise<void>((resolve) => setImmediate(resolve));
	if (method === "POST") pair.req.push(JSON.stringify(body));
	pair.req.push(null);
	await result;
	return pair;
}
function bodyHarness(bodyReadTimeoutMs = 30000) {
	const route = createHttpRoute({
		port: () => 1234,
		bodyReadTimeoutMs,
		auth: {
			resolvePrincipal: async (req) => ({
				id: req.headers.authorization?.slice(7) ?? "a",
				scopes: [],
				allowedSessionIds: [],
			}),
		},
	});
	const pending: { req: IncomingMessage; handled: Promise<void> }[] = [];
	cleanup.push(async () => {
		for (const { req } of pending) if (!req.readableEnded) req.emit("aborted");
		await Promise.allSettled(pending.map((pair) => pair.handled));
		await route.dispose();
	});
	function start(id = "a") {
		const pair = synthetic("POST");
		pair.req.headers.authorization = `Bearer ${id}`;
		const handled = route.handler(pair.req, pair.res);
		pending.push({ req: pair.req, handled });
		return { ...pair, handled };
	}
	return { route, start };
}
const admissionTick = () =>
	new Promise<void>((resolve) => setImmediate(resolve));
describe("authenticated bounded Node MCP route", () => {
	it("refuses activation on a non-loopback DSH binding", () => {
		expect(() =>
			apply({ webServer: { host: "0.0.0.0" } } as DshHostContext, {}),
		).toThrow();
	});
	it("initializes without Origin and supplies the once-parsed body to the official SDK", async () => {
		const spy = vi.spyOn(
			NodeStreamableHTTPServerTransport.prototype,
			"handleRequest",
		);
		const { send } = await setup();
		const result = await send();
		expect(result.status).toBe(200);
		expect(result.headers["mcp-session-id"]).toBeTypeOf("string");
		expect(spy).toHaveBeenCalledOnce();
		expect(spy.mock.calls[0][2]).toEqual(initialize);
		expect(spy.mock.calls[0][0].readableEnded).toBe(true);
	});
	it.each([
		["Unauthorized", 401],
		["Forbidden", 403],
		["Too many requests", 429],
		["secret failure", 500],
	])("maps %s safely before parsing", async (message, status) => {
		const spy = vi.spyOn(
			NodeStreamableHTTPServerTransport.prototype,
			"handleRequest",
		);
		const { send } = await setup(String(message));
		const result = await send("POST", "invalid json");
		expect(result.status).toBe(status);
		expect(result.text).not.toContain("secret");
		expect(spy).not.toHaveBeenCalled();
	});
	it("rejects declared and actual chunked overflow before MCP parsing", async () => {
		const spy = vi.spyOn(
			NodeStreamableHTTPServerTransport.prototype,
			"handleRequest",
		);
		const { send, route } = await setup();
		expect((await send("POST", "", { "content-length": "65537" })).status).toBe(
			413,
		);
		expect(
			(
				await send("POST", null, {}, [
					" ".repeat(32768),
					" ".repeat(32768),
					"x",
				])
			).status,
		).toBe(413);
		expect(spy).not.toHaveBeenCalled();
		expect(route.registry.size).toBe(0);
	});
	it("rejects malformed JSON and unsupported content types without creating sessions", async () => {
		const { send, route } = await setup();
		expect((await send("POST", "{")).status).toBe(400);
		expect(
			(await send("POST", initialize, { "content-type": "text/plain" })).status,
		).toBe(415);
		expect(route.registry.size).toBe(0);
	});
	it("authenticates and isolates POST, GET, DELETE on every session", async () => {
		const { send, route } = await setup();
		const a = await send();
		const b = await send("POST", initialize, { authorization: "Bearer b" });
		const id = b.headers["mcp-session-id"];
		for (const method of ["POST", "GET", "DELETE"])
			expect(
				(
					await send(
						method,
						{ jsonrpc: "2.0", id: 2, method: "ping" },
						{ "mcp-session-id": id },
					)
				).status,
			).toBe(403);
		expect(
			(
				await send("DELETE", null, {
					"mcp-session-id": a.headers["mcp-session-id"],
					"mcp-protocol-version": "2025-11-25",
				})
			).status,
		).toBe(200);
		expect(route.registry.size).toBe(1);
		expect(
			(
				await send(
					"POST",
					{ jsonrpc: "2.0", id: 2, method: "ping" },
					{
						authorization: "Bearer b",
						"mcp-session-id": id,
						"mcp-protocol-version": "2025-11-25",
					},
				)
			).status,
		).toBe(200);
	});
	it("limits sessions and releases them on disposal", async () => {
		const { send, route } = await setup();
		for (let i = 0; i < 4; i++) expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(429);
		await route.dispose();
		expect(route.registry.size).toBe(0);
	});
	it("pauses the actual stream at overflow without collecting trailing bytes", async () => {
		const spy = vi.spyOn(
			NodeStreamableHTTPServerTransport.prototype,
			"handleRequest",
		);
		const route = createHttpRoute({
			port: () => 1234,
			auth: {
				resolvePrincipal: async () => ({
					id: "a",
					scopes: [],
					allowedSessionIds: [],
				}),
			},
		});
		const { req, res } = synthetic("POST");
		const handled = route.handler(req, res);
		await new Promise<void>((resolve) => setImmediate(resolve));
		req.push(Buffer.alloc(65536));
		req.push(Buffer.alloc(1));
		req.push(Buffer.alloc(1024 * 1024));
		await handled;
		expect(res.statusCode).toBe(413);
		expect(req.readableFlowing).toBe(false);
		expect(req.readableLength).toBe(1024 * 1024);
		expect(spy).not.toHaveBeenCalled();
		await route.dispose();
		req.destroy();
	});
	it("enforces call capacity until completion, and releases it on disconnect", async () => {
		const { route, send } = await setup();
		const init = await send();
		const id = init.headers["mcp-session-id"] as string;
		vi.spyOn(
			NodeStreamableHTTPServerTransport.prototype,
			"handleRequest",
		).mockResolvedValue();
		const a = await direct(route, "POST", id);
		const b = await direct(route, "POST", id);
		const denied = await direct(route, "POST", id);
		expect(denied.res.statusCode).toBe(429);
		a.res.emit("finish");
		const c = await direct(route, "POST", id);
		expect(c.res.statusCode).toBe(200);
		b.res.emit("close");
		expect(route.registry.size).toBe(0);
		c.res.emit("finish");
	});
	it("closes disconnected GET streams and expires idle streams at 120 seconds", async () => {
		const { route, send } = await setup();
		let init = await send();
		const spy = vi
			.spyOn(NodeStreamableHTTPServerTransport.prototype, "handleRequest")
			.mockResolvedValue();
		const a = await direct(
			route,
			"GET",
			init.headers["mcp-session-id"] as string,
		);
		a.res.emit("close");
		expect(route.registry.size).toBe(0);
		spy.mockRestore();
		init = await send();
		vi.spyOn(
			NodeStreamableHTTPServerTransport.prototype,
			"handleRequest",
		).mockResolvedValue();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const b = await direct(
			route,
			"GET",
			init.headers["mcp-session-id"] as string,
		);
		await vi.advanceTimersByTimeAsync(120000);
		expect(b.res.writableEnded).toBe(true);
		expect(route.registry.size).toBe(0);
		vi.useRealTimers();
	});
	it("caps busy SSE lifetime at ten minutes despite outgoing activity", async () => {
		const { route, send } = await setup();
		const init = await send();
		vi.spyOn(
			NodeStreamableHTTPServerTransport.prototype,
			"handleRequest",
		).mockResolvedValue();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const stream = await direct(
			route,
			"GET",
			init.headers["mcp-session-id"] as string,
		);
		for (let n = 0; n < 5; n++) {
			await vi.advanceTimersByTimeAsync(100000);
			stream.res.write("event");
		}
		await vi.advanceTimersByTimeAsync(100000);
		expect(stream.res.writableEnded).toBe(true);
		expect(route.registry.size).toBe(0);
		vi.useRealTimers();
	});
	it("expires unfinished calls at sixty seconds", async () => {
		const { route, send } = await setup();
		const init = await send();
		vi.spyOn(
			NodeStreamableHTTPServerTransport.prototype,
			"handleRequest",
		).mockResolvedValue();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const call = await direct(
			route,
			"POST",
			init.headers["mcp-session-id"] as string,
		);
		await vi.advanceTimersByTimeAsync(60000);
		expect(call.res.writableEnded).toBe(true);
		expect(route.registry.size).toBe(0);
		vi.useRealTimers();
	});
	it("keeps the session when a GET is rejected with a completed response", async () => {
		const { route, send } = await setup();
		const init = await send();
		vi.spyOn(
			NodeStreamableHTTPServerTransport.prototype,
			"handleRequest",
		).mockImplementation(async (_req, res) => {
			res.statusCode = 406;
			res.end();
			res.emit("close");
		});
		const rejected = await direct(
			route,
			"GET",
			init.headers["mcp-session-id"] as string,
		);
		expect(rejected.res.statusCode).toBe(406);
		expect(route.registry.size).toBe(1);
	});

	it.each(["principal", "global"])(
		"enforces the %s protocol rate before MCP parsing",
		async (limit) => {
			const limiter = new RequestLimiter();
			for (let p = 0; p < (limit === "global" ? 5 : 1); p++)
				for (let n = 0; n < 120; n++)
					limiter.admit(limit === "principal" ? "a" : String(p));
			const { route, send } = await setup(undefined, limiter);
			const spy = vi.spyOn(
				NodeStreamableHTTPServerTransport.prototype,
				"handleRequest",
			);
			expect((await send()).status).toBe(429);
			expect(spy).not.toHaveBeenCalled();
			expect(route.registry.size).toBe(0);
		},
	);
	it("rejects a native request without bearer credentials before parsing", async () => {
		const { send } = await setup();
		const spy = vi.spyOn(
			NodeStreamableHTTPServerTransport.prototype,
			"handleRequest",
		);
		expect((await send("POST", "{", { authorization: "" })).status).toBe(401);
		expect(spy).not.toHaveBeenCalled();
	});
	it("mounts the exact DSH path and unregisters through its owning Cordis effect", async () => {
		const unregister = vi.fn();
		const register = vi.fn(() => unregister);
		const plugin = vi.fn();
		let dispose: (() => Promise<void>) | undefined;
		const ctx = {
			webServer: { host: "127.0.0.1", port: 1234, register },
			plugin,
			credentials: {},
			effect: (create: () => () => Promise<void>) => {
				dispose = create();
			},
		} as unknown as DshHostContext;
		apply(ctx, {});
		expect(plugin).toHaveBeenCalledWith(ClientTokenController);
		expect(register).toHaveBeenCalledWith({
			kind: "exact",
			path: MCP_PATH,
			handler: expect.any(Function),
		});
		await dispose?.();
		expect(unregister).toHaveBeenCalledOnce();
	});
	it.each(["GET", "DELETE", "PUT"])(
		"rejects unread chunked %s bodies and closes the connection before SDK parsing",
		async (method) => {
			const { send } = await setup();
			const init = await send();
			const spy = vi.spyOn(
				NodeStreamableHTTPServerTransport.prototype,
				"handleRequest",
			);
			const result = await send(
				method,
				null,
				{
					"mcp-session-id": init.headers["mcp-session-id"],
					"transfer-encoding": "chunked",
					accept: "application/json",
				},
				["{", "}"],
			);
			expect(result.status).toBe(method === "PUT" ? 405 : 400);
			expect(result.headers.connection).toBe("close");
			expect(spy).not.toHaveBeenCalled();
		},
	);
	it("closes unread chunked non-POST bodies on authentication failure", async () => {
		const { send } = await setup();
		const result = await send(
			"GET",
			null,
			{ authorization: "", "transfer-encoding": "chunked" },
			["{}"],
		);
		expect(result.status).toBe(401);
		expect(result.headers.connection).toBe("close");
	});
	it("answers a partially uploaded stalled HTTP request with 408 and releases its reader", async () => {
		const { send, port } = await setup(undefined, undefined, 40);
		const result = await new Promise<{
			status: number | undefined;
			connection: string | undefined;
		}>((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port,
					path: MCP_PATH,
					method: "POST",
					headers: {
						authorization: "Bearer a",
						"content-type": "application/json",
						"transfer-encoding": "chunked",
					},
				},
				(res) => {
					res.resume();
					res.once("end", () =>
						resolve({
							status: res.statusCode,
							connection: res.headers.connection,
						}),
					);
				},
			);
			req.on("error", reject);
			req.write("{");
		});
		expect(result).toEqual({ status: 408, connection: "close" });
		expect((await send()).status).toBe(200);
	});
	it.each([
		"completion",
		"parse error",
		"stream error",
		"abort",
		"overflow",
		"timeout",
	])(
		"caps body readers at four per principal and releases on %s",
		async (reason) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const { start } = bodyHarness(100);
			const active = Array.from({ length: 4 }, () => start());
			await admissionTick();
			const denied = start();
			await admissionTick();
			expect(denied.res.statusCode).toBe(429);
			expect(denied.res.writableEnded).toBe(true);
			expect(denied.req.listenerCount("data")).toBe(0);
			const victim = active[0];
			if (reason === "completion") {
				victim.req.push("{}");
				victim.req.push(null);
			}
			if (reason === "parse error") {
				victim.req.push("{");
				victim.req.push(null);
			}
			if (reason === "stream error")
				victim.req.emit("error", new Error("private details"));
			if (reason === "abort") victim.req.emit("aborted");
			if (reason === "overflow") victim.req.push(Buffer.alloc(65537));
			if (reason === "timeout") await vi.advanceTimersByTimeAsync(100);
			await victim.handled;
			expect(victim.res.statusCode).toBe(
				reason === "timeout"
					? 408
					: reason === "overflow"
						? 413
						: reason === "stream error"
							? 500
							: 400,
			);
			expect(victim.req.listenerCount("data")).toBe(0);
			expect(victim.req.listenerCount("aborted")).toBe(0);
			expect(victim.req.listenerCount("end")).toBe(0);
			const next = start();
			await admissionTick();
			expect(next.res.writableEnded).toBe(false);
			expect(next.req.listenerCount("data")).toBe(1);
		},
	);
	it("caps body readers at sixteen globally across principals and releases capacity", async () => {
		const { start } = bodyHarness();
		const active = [];
		for (let p = 0; p < 4; p++)
			for (let n = 0; n < 4; n++) {
				active.push(start(String(p)));
				await admissionTick();
			}
		const denied = start("new");
		await admissionTick();
		expect(denied.res.statusCode).toBe(429);
		expect(denied.req.listenerCount("data")).toBe(0);
		active[0].req.emit("aborted");
		await active[0].handled;
		const admitted = start("new");
		await admissionTick();
		expect(admitted.req.listenerCount("data")).toBe(1);
		expect(admitted.res.writableEnded).toBe(false);
	});
	it("uses a thirty-second absolute read deadline that partial data cannot refresh", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { start } = bodyHarness();
		const pair = start();
		await admissionTick();
		await vi.advanceTimersByTimeAsync(20000);
		pair.req.push("{");
		await vi.advanceTimersByTimeAsync(10000);
		expect(pair.res.statusCode).toBe(408);
		expect(pair.req.readableFlowing).toBe(false);
		expect(pair.res.setHeader).toHaveBeenCalledWith("connection", "close");
	});
	it("disposes active body readers without leaving read timers or listeners", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { route, start } = bodyHarness();
		const pair = start();
		await admissionTick();
		await route.dispose();
		await pair.handled;
		expect(pair.res.writableEnded).toBe(true);
		expect(pair.req.listenerCount("data")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
