import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { admitRequest, MAX_BODY_BYTES } from "./http-policy.js";
import type { TokenPrincipal } from "./index.js";
import {
	McpSessionRegistry,
	type SessionResource,
} from "./mcp-session-registry.js";
import { RequestLimiter } from "./rate-limiter.js";

export const MCP_PATH = "/api/dsh-control-mcp/mcp";
export interface HttpRouteOptions {
	port: () => number;
	auth: { resolvePrincipal(req: IncomingMessage): Promise<TokenPrincipal> };
	registerTools?: (server: McpServer, principal: TokenPrincipal) => void;
	limiter?: RequestLimiter;
	/** Tests may shorten, but never increase, the 30-second production deadline. */
	bodyReadTimeoutMs?: number;
}
interface HttpSession extends SessionResource {
	transport: NodeStreamableHTTPServerTransport;
}
function respond(
	res: ServerResponse,
	status: number,
	req: IncomingMessage,
): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	if (!req.readableEnded) res.setHeader("connection", "close");
	res.writeHead(status, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			error: status === 500 ? "Internal server error" : "Request rejected",
		}),
	);
}
function errorStatus(error: unknown): number {
	if (!(error instanceof Error)) return 500;
	switch (error.message) {
		case "Unauthorized":
			return 401;
		case "Forbidden":
			return 403;
		case "Request body timed out":
			return 408;
		case "Request body too large":
			return 413;
		case "Too many requests":
			return 429;
		case "Invalid JSON":
		case "Invalid content length":
		case "Invalid request":
			return 400;
		case "Unsupported content type":
			return 415;
		case "Session not found":
			return 404;
		default:
			return 500;
	}
}
/** Retain at most 64 KiB. Pause on overflow rather than destroying the response socket. */
async function readBody(
	req: IncomingMessage,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	await new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			req.off("data", data);
			req.off("end", end);
			req.off("error", fail);
			req.off("aborted", aborted);
			signal.removeEventListener("abort", aborted);
			clearTimeout(timer);
		};
		const fail = (error: Error) => {
			req.pause();
			cleanup();
			reject(error);
		};
		const aborted = () => fail(new Error("Invalid request"));
		const end = () => {
			cleanup();
			resolve();
		};
		const data = (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > MAX_BODY_BYTES) {
				req.pause();
				fail(new Error("Request body too large"));
				return;
			}
			chunks.push(buffer);
		};
		if (req.aborted || req.destroyed || signal.aborted) {
			aborted();
			return;
		}
		timer = setTimeout(
			() => fail(new Error("Request body timed out")),
			timeoutMs,
		);
		timer.unref();
		signal.addEventListener("abort", aborted, { once: true });
		req.on("data", data);
		req.once("end", end);
		req.once("error", fail);
		req.once("aborted", aborted);
	});
	try {
		return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
	} catch {
		throw new Error("Invalid JSON");
	}
}
function method(body: unknown): string | undefined {
	return typeof body === "object" &&
		body !== null &&
		!Array.isArray(body) &&
		"method" in body &&
		typeof body.method === "string"
		? body.method
		: undefined;
}
export function createHttpRoute(options: HttpRouteOptions) {
	const registry = new McpSessionRegistry();
	const limiter = options.limiter ?? new RequestLimiter();
	const bodyReadTimeoutMs = options.bodyReadTimeoutMs ?? 30000;
	if (
		!Number.isSafeInteger(bodyReadTimeoutMs) ||
		bodyReadTimeoutMs < 1 ||
		bodyReadTimeoutMs > 30000
	)
		throw new Error("Invalid body read deadline");
	const shutdown = new AbortController();
	const bodyReaders = new Map<string, number>();
	let totalBodyReaders = 0;
	/** Synchronous reservation before stream collection; principal storage is bounded by 16 readers. */
	function reserveBodyReader(principalId: string): () => void {
		if (shutdown.signal.aborted) throw new Error("Invalid request");
		const count = bodyReaders.get(principalId) ?? 0;
		if (count >= 4 || totalBodyReaders >= 16)
			throw new Error("Too many requests");
		bodyReaders.set(principalId, count + 1);
		totalBodyReaders++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (bodyReaders.get(principalId) ?? 1) - 1;
			if (remaining) bodyReaders.set(principalId, remaining);
			else bodyReaders.delete(principalId);
			totalBodyReaders--;
		};
	}
	async function handler(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		let sessionId: string | undefined;
		let newlyCreated = false;
		let releaseCall: (() => void) | undefined;
		try {
			const principal = await admitRequest(
				req,
				options.port(),
				options.auth,
				limiter,
			);
			if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
				respond(res, 405, req);
				return;
			}
			const header = req.headers["mcp-session-id"];
			if (
				header !== undefined &&
				(typeof header !== "string" ||
					!header ||
					req.rawHeaders.filter(
						(value, index) =>
							index % 2 === 0 && value.toLowerCase() === "mcp-session-id",
					).length > 1)
			)
				throw new Error("Invalid request");
			sessionId = header as string | undefined;
			// Ownership is checked before even reading another client's protocol body.
			let session = sessionId
				? (registry.get(sessionId, principal.id) as HttpSession)
				: undefined;
			if (
				req.method !== "POST" &&
				(req.headers["transfer-encoding"] !== undefined ||
					Number(req.headers["content-length"] ?? 0) !== 0)
			)
				throw new Error("Invalid request");
			let parsedBody: unknown;
			if (req.method === "POST") {
				if (
					typeof req.headers["content-type"] !== "string" ||
					!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"])
				)
					throw new Error("Unsupported content type");
				const releaseBodyReader = reserveBodyReader(principal.id);
				try {
					parsedBody = await readBody(req, bodyReadTimeoutMs, shutdown.signal);
				} finally {
					releaseBodyReader();
				}
			}
			if (!session) {
				if (req.method !== "POST" || method(parsedBody) !== "initialize")
					throw new Error("Invalid request");
				const server = new McpServer({
					name: "dsh-control-mcp",
					version: "0.1.0",
				});
				const transport = new NodeStreamableHTTPServerTransport({
					sessionIdGenerator: () => sessionId as string,
					enableJsonResponse: true,
					onsessionclosed: () => registry.close(sessionId as string),
				});
				session = { transport, close: () => server.close() };
				sessionId = registry.reserve(principal.id, session);
				newlyCreated = true;
				options.registerTools?.(server, principal);
				await server.connect(transport);
				const onclose = transport.onclose;
				transport.onclose = () => {
					onclose?.();
					void registry.close(sessionId as string).catch(() => {});
				};
			}
			if (req.method === "POST" && method(parsedBody) === "tools/call")
				releaseCall = registry.reserveCall(principal.id);
			const id = sessionId as string;
			registry.touch(id);
			const timers: ReturnType<typeof setTimeout>[] = [];
			const closeSession = () => {
				void registry.close(id).catch(() => {});
				if (!res.writableEnded) res.end();
			};
			const idle = setTimeout(closeSession, 120000);
			idle.unref();
			timers.push(idle);
			const lifetime = setTimeout(closeSession, 600000);
			lifetime.unref();
			timers.push(lifetime);
			if (releaseCall) {
				const timeout = setTimeout(closeSession, 60000);
				timeout.unref();
				timers.push(timeout);
			}
			const write = res.write;
			res.write = function (
				this: ServerResponse,
				...args: Parameters<ServerResponse["write"]>
			): boolean {
				idle.refresh();
				registry.touch(id);
				return write.apply(this, args);
			} as ServerResponse["write"];
			const done = () => {
				for (const timer of timers) clearTimeout(timer);
				res.write = write;
				releaseCall?.();
				releaseCall = undefined;
				registry.touch(id);
			};
			res.once("finish", done);
			res.once("close", () => {
				done();
				if (!res.writableFinished) closeSession();
			});
			await session.transport.handleRequest(req, res, parsedBody);
			if (
				(newlyCreated && !session.transport.sessionId) ||
				(req.method === "DELETE" && res.statusCode < 300)
			)
				await registry.close(id);
		} catch (error) {
			releaseCall?.();
			if (newlyCreated && sessionId)
				await registry.close(sessionId).catch(() => {});
			respond(res, errorStatus(error), req);
		}
	}
	return {
		handler,
		registry,
		dispose: () => {
			shutdown.abort();
			return registry.dispose();
		},
	};
}
