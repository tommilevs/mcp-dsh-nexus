import { vi } from "vitest";
import type { TokenPrincipal } from "../../src/index.js";

export interface FakeToolServer {
	registerTool(
		name: string,
		config: { description?: string; inputSchema?: unknown },
		handler: (
			input: Record<string, unknown>,
			extra: { signal: AbortSignal },
		) => Promise<unknown>,
	): unknown;
}

export function makeServer() {
	const handlers = new Map<
		string,
		(
			input: Record<string, unknown>,
			extra: { signal: AbortSignal },
		) => Promise<unknown>
	>();
	const server: FakeToolServer = {
		registerTool(name, _config, handler) {
			handlers.set(name, handler);
		},
	};
	return {
		server,
		handlers,
		async call(
			name: string,
			input: Record<string, unknown> = {},
			signal = new AbortController().signal,
		) {
			const handler = handlers.get(name);
			if (!handler) throw new Error(`Tool not registered: ${name}`);
			return handler(input, { signal });
		},
	};
}

export function makePrincipal(
	scopes: TokenPrincipal["scopes"],
	allowedSessionIds: TokenPrincipal["allowedSessionIds"] = "*",
): TokenPrincipal {
	return { id: "client-1", scopes, allowedSessionIds };
}

export function makeAuth() {
	const auth = {
		authorizeTool: vi.fn(
			async (
				_principal: TokenPrincipal,
				_name: string,
				_sessionId?: string,
			) => {},
		),
		recordOwnedSession: vi.fn(
			async (_principalId: string, _sessionId: string) => {},
		),
	};
	return auth;
}

export function readResult<T>(result: unknown): T {
	const content = (
		result as { content: Array<{ type: string; text?: string }> }
	).content;
	return JSON.parse(content[0]?.text ?? "null") as T;
}
