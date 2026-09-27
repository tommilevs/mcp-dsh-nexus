import { fromJsonSchema, type McpServer } from "@modelcontextprotocol/server";
import type { AuthService } from "../auth.js";
import type { DshHostContext, TokenPrincipal, TokenScope } from "../index.js";
import { registerChatTools } from "./chat.js";
import { registerDiagnosticTools } from "./diagnostics.js";
import { registerSessionTools } from "./sessions.js";

export interface JsonSchema {
	type: "object";
	properties: Record<string, Record<string, unknown>>;
	required?: string[];
	additionalProperties: false;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export interface ToolExtra {
	signal: AbortSignal;
}

export interface ToolServer {
	registerTool(
		name: string,
		config: { title?: string; description: string; inputSchema: unknown },
		handler: (input: unknown, extra: ToolExtra) => Promise<ToolResult>,
	): unknown;
}

export type ToolHandler = (
	input: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<unknown>;

export interface ToolServices {
	ctx: DshHostContext;
	principal: TokenPrincipal;
	auth: Pick<AuthService, "authorizeTool" | "recordOwnedSession">;
	register: (
		name: string,
		scope: TokenScope,
		description: string,
		schema: JsonSchema,
		handler: ToolHandler,
		targetSessionId?: (input: Record<string, unknown>) => string | undefined,
	) => void;
	localOwnedSessions: Set<string>;
}

export interface ToolCallGateOptions {
	maxPerPrincipal?: number;
	maxTotal?: number;
	responseTimeoutMs?: number;
}

/** Shared admission gate for asynchronous work started by MCP tool calls. */
export class ToolCallGate {
	readonly maxPerPrincipal: number;
	readonly maxTotal: number;
	readonly responseTimeoutMs: number;
	private readonly activeByPrincipal = new Map<string, number>();
	private activeTotal = 0;

	constructor(options: ToolCallGateOptions = {}) {
		this.maxPerPrincipal = options.maxPerPrincipal ?? 2;
		this.maxTotal = options.maxTotal ?? 8;
		this.responseTimeoutMs = options.responseTimeoutMs ?? 59_000;
		if (
			!Number.isSafeInteger(this.maxPerPrincipal) ||
			this.maxPerPrincipal < 1 ||
			!Number.isSafeInteger(this.maxTotal) ||
			this.maxTotal < 1 ||
			!Number.isSafeInteger(this.responseTimeoutMs) ||
			this.responseTimeoutMs < 1 ||
			this.responseTimeoutMs > 2_147_483_647
		)
			throw new RangeError("Invalid tool call gate bounds");
	}

	reserve(principalId: string): (() => void) | undefined {
		const activeForPrincipal = this.activeByPrincipal.get(principalId) ?? 0;
		if (
			activeForPrincipal >= this.maxPerPrincipal ||
			this.activeTotal >= this.maxTotal
		)
			return undefined;

		this.activeByPrincipal.set(principalId, activeForPrincipal + 1);
		this.activeTotal += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeTotal -= 1;
			const remaining = (this.activeByPrincipal.get(principalId) ?? 1) - 1;
			if (remaining === 0) this.activeByPrincipal.delete(principalId);
			else this.activeByPrincipal.set(principalId, remaining);
		};
	}
}

const defaultToolCallGate = new ToolCallGate();

export function textResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function errorResult(): ToolResult {
	return {
		isError: true,
		content: [{ type: "text", text: "Request rejected or unavailable" }],
	};
}

/** Registration-time scope filtering plus fresh token/session checks per invocation. */
export function registerTools(
	server: McpServer,
	ctx: DshHostContext,
	principal: TokenPrincipal,
	auth: Pick<AuthService, "authorizeTool" | "recordOwnedSession">,
	gate: ToolCallGate = defaultToolCallGate,
): void {
	const toolServer = server as unknown as ToolServer;
	const localOwnedSessions = new Set<string>();
	const register: ToolServices["register"] = (
		name,
		scope,
		description,
		schema,
		handler,
		targetSessionId,
	) => {
		if (!principal.scopes.includes(scope)) return;
		toolServer.registerTool(
			name,
			{
				title: name,
				description,
				inputSchema: fromJsonSchema(schema),
			},
			async (untrustedInput, extra) => {
				try {
					const input = asRecord(untrustedInput);
					const target = targetSessionId?.(input);
					if (target !== undefined && !validSessionId(target))
						return errorResult();
					const release = gate.reserve(principal.id);
					if (!release) return errorResult();
					const deadline = boundedSignal(
						extra.signal ?? new AbortController().signal,
						gate.responseTimeoutMs,
					);
					const pending = Promise.resolve()
						.then(async () => {
							deadline.signal.throwIfAborted();
							await auth.authorizeTool(principal, name, target);
							deadline.signal.throwIfAborted();
							return handler(input, deadline.signal);
						})
						.then(
							(value) => ({ kind: "settled" as const, value }),
							() => ({ kind: "failed" as const }),
						)
						.finally(release);
					let removeAbortListener: (() => void) | undefined;
					const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
						const onAbort = () => resolve({ kind: "aborted" });
						if (deadline.signal.aborted) onAbort();
						else {
							deadline.signal.addEventListener("abort", onAbort, {
								once: true,
							});
							removeAbortListener = () =>
								deadline.signal.removeEventListener("abort", onAbort);
						}
					});
					try {
						const result = await Promise.race([pending, aborted]);
						return result.kind === "settled"
							? textResult(result.value)
							: errorResult();
					} finally {
						removeAbortListener?.();
						deadline.dispose();
					}
				} catch {
					return errorResult();
				}
			},
		);
	};
	const services: ToolServices = {
		ctx,
		principal,
		auth,
		register,
		localOwnedSessions,
	};
	registerDiagnosticTools(services);
	registerSessionTools(services);
	registerChatTools(services);
}

export function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid input");
	return value as Record<string, unknown>;
}

export function stringInput(
	input: Record<string, unknown>,
	key: string,
	maximum = 512,
): string {
	const value = input[key];
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maximum
	)
		throw new Error("Invalid input");
	return value;
}

export function boundedInteger(
	input: Record<string, unknown>,
	key: string,
	defaultValue: number,
	maximum: number,
): number {
	const value = input[key] ?? defaultValue;
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < 1 ||
		(value as number) > maximum
	)
		throw new Error("Invalid input");
	return value as number;
}

export function validSessionId(value: string): boolean {
	return value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
}

export function canAccessSession(
	principal: TokenPrincipal,
	localOwned: ReadonlySet<string>,
	sessionId: string,
): boolean {
	return (
		principal.allowedSessionIds === "*" ||
		principal.allowedSessionIds.includes(sessionId) ||
		localOwned.has(sessionId)
	);
}

export interface BoundedSignal {
	signal: AbortSignal;
	timedOut: () => boolean;
	dispose: () => void;
}

export function boundedSignal(
	parent: AbortSignal,
	timeoutMs: number,
): BoundedSignal {
	const controller = new AbortController();
	let didTimeout = false;
	const onParentAbort = () => controller.abort(parent.reason);
	if (parent.aborted) onParentAbort();
	else parent.addEventListener("abort", onParentAbort, { once: true });
	const timer = setTimeout(() => {
		didTimeout = true;
		controller.abort(new Error("Tool deadline reached"));
	}, timeoutMs);
	return {
		signal: controller.signal,
		timedOut: () => didTimeout,
		dispose: () => {
			clearTimeout(timer);
			parent.removeEventListener("abort", onParentAbort);
		},
	};
}

/** Avoid waiting forever when a host iterable has not yet observed its signal. */
export async function nextWithSignal<T>(
	iterator: AsyncIterator<T>,
	signal: AbortSignal,
): Promise<IteratorResult<T> | undefined> {
	if (signal.aborted) return undefined;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<undefined>((resolve) => {
		onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([iterator.next(), aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
