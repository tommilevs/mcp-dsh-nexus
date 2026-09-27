import { describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/tools/registry.js";
import { makeAuth, makePrincipal, makeServer, readResult } from "./fixtures.js";

describe("DSH chat tools", () => {
	it("records ownership before returning a created chat and does not mutate the model default", async () => {
		const fake = makeServer();
		const auth = makeAuth();
		const order: string[] = [];
		const selectModel = vi.fn();
		const ctx = {
			webServer: { host: "127.0.0.1", port: 43120 },
			sessionController: {
				modelCatalog: async () => ({
					default: { provider: "p", model: "default" },
					routableProviders: ["p"],
					groups: [
						{
							id: "p",
							name: "P",
							models: [{ id: "default", name: "Default" }],
						},
					],
					failures: [],
				}),
				create: vi.fn(async (_request: unknown) => {
					order.push("create");
					return { sessionId: "s-new" };
				}),
				selectModel,
			},
			workspaceController: {
				follow: async function* () {
					yield {
						type: "baseline",
						value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] },
					};
				},
			},
		};
		auth.recordOwnedSession.mockImplementation(async () => {
			order.push("own");
		});
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(["chat:create"]),
			auth as never,
		);
		const result = readResult<{ sessionId: string }>(
			await fake.call("dsh_create_chat"),
		);
		expect(result.sessionId).toBe("s-new");
		expect(order).toEqual(["create", "own"]);
		expect(selectModel).not.toHaveBeenCalled();
	});

	it("sends only non-empty text to an allowed session with a durable request id", async () => {
		const fake = makeServer();
		const auth = makeAuth();
		const ctx = {
			webServer: { host: "127.0.0.1", port: 43120 },
			sessionController: {
				modelCatalog: async () => ({
					default: { provider: "p", model: "m" },
					routableProviders: [],
					groups: [],
					failures: [],
				}),
				prompt: vi.fn(
					async (
						_request: {
							requestId: string;
							sessionId: string;
							mode: string;
							content: unknown[];
						},
						_signal: AbortSignal,
					) => ({ accepted: true }),
				),
				create: async () => ({ sessionId: "s-new" }),
			},
			workspaceController: { follow: async function* () {} },
		};
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(["chat:send"], ["s-allowed"]),
			auth as never,
		);
		const result = readResult<{ requestId: string; accepted: boolean }>(
			await fake.call("dsh_send_message", {
				sessionId: "s-allowed",
				text: "hello",
			}),
		);
		expect(result.accepted).toBe(true);
		expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/i);
		expect(ctx.sessionController.prompt).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "s-allowed",
				mode: "queue",
				content: [{ type: "text", text: "hello" }],
			}),
			expect.any(AbortSignal),
		);
		expect(auth.authorizeTool).toHaveBeenCalledWith(
			expect.any(Object),
			"dsh_send_message",
			"s-allowed",
		);
	});

	it("waits for the request-correlated turn/end, not assistant stream end", async () => {
		const fake = makeServer();
		const requestId = "request-target";
		const event = (
			type: string,
			seq: number,
			data: Record<string, unknown>,
		) => ({ type: "event", event: { type, seq, time: seq, data } });
		const records = [
			event("turn/start", 2, { turn: 7 }),
			event("user/message", 3, {
				source: { kind: "user", rpcId: "other-request" },
				content: [{ type: "text", text: "other" }],
			}),
			event("turn/end", 4, { turn: 7, reason: { kind: "completed" } }),
			event("turn/start", 6, { turn: 8 }),
			event("user/message", 7, {
				source: { kind: "user", rpcId: requestId },
				content: [{ type: "text", text: "target" }],
			}),
		];
		const ctx = {
			webServer: { host: "127.0.0.1", port: 43120 },
			sessionController: {
				modelCatalog: async () => ({
					default: { provider: "p", model: "m" },
					routableProviders: [],
					groups: [],
					failures: [],
				}),
				follow: async function* () {
					yield { type: "snapshot", cursor: 7, records, hasMore: false };
					yield { type: "assistant-stream", frame: { kind: "end" } };
					yield {
						type: "event",
						event: {
							type: "turn/end",
							seq: 8,
							time: 8,
							data: { turn: 8, reason: { kind: "completed" } },
						},
					};
				},
				page: vi.fn(async () => ({ records, hasMore: false })),
				create: async () => ({ sessionId: "s-new" }),
			},
			workspaceController: { follow: async function* () {} },
		};
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(["sessions:follow"], ["s-1"]),
			makeAuth() as never,
		);
		const result = readResult<{ status: string; turn: number }>(
			await fake.call("dsh_wait_run", {
				sessionId: "s-1",
				requestId,
				timeoutSeconds: 1,
			}),
		);
		expect(result).toEqual(
			expect.objectContaining({ status: "completed", turn: 8 }),
		);
	});

	it("returns an intentional wait timeout before the shared tool deadline", async () => {
		const fake = makeServer();
		const ctx = {
			webServer: { host: "127.0.0.1", port: 43120 },
			sessionController: {
				modelCatalog: async () => ({
					default: { provider: "p", model: "m" },
					routableProviders: [],
					groups: [],
					failures: [],
				}),
				follow: (_request: unknown, signal: AbortSignal) => ({
					[Symbol.asyncIterator]() {
						let snapshot = true;
						return {
							next: () => {
								if (snapshot) {
									snapshot = false;
									return Promise.resolve({
										done: false as const,
										value: {
											type: "snapshot",
											cursor: 0,
											records: [],
											hasMore: false,
										},
									});
								}
								return new Promise<IteratorResult<unknown>>((resolve) =>
									signal.addEventListener(
										"abort",
										() => resolve({ done: true, value: undefined }),
										{ once: true },
									),
								);
							},
							return: async () => ({
								done: true as const,
								value: undefined,
							}),
						};
					},
				}),
				page: async () => ({ records: [], hasMore: false }),
			},
			workspaceController: { follow: async function* () {} },
		};
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(["sessions:follow"], ["s-1"]),
			makeAuth() as never,
		);
		const result = readResult<{ status: string }>(
			await fake.call("dsh_wait_run", {
				sessionId: "s-1",
				requestId: "not-yet-recorded",
				timeoutSeconds: 1,
			}),
		);
		expect(result.status).toBe("timeout");
	});

	it("cancels only an authorized session", async () => {
		const fake = makeServer();
		const auth = makeAuth();
		const cancel = vi.fn(async () => ({ accepted: true as const }));
		const ctx = {
			webServer: { host: "127.0.0.1", port: 43120 },
			sessionController: {
				modelCatalog: async () => ({
					default: { provider: "p", model: "m" },
					routableProviders: [],
					groups: [],
					failures: [],
				}),
				cancel,
			},
			workspaceController: { follow: async function* () {} },
		};
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(["chat:cancel"], ["s-1"]),
			auth as never,
		);
		await fake.call("dsh_cancel_run", { sessionId: "s-1" });
		expect(cancel).toHaveBeenCalledWith({ sessionId: "s-1" });
		expect(auth.authorizeTool).toHaveBeenCalledWith(
			expect.any(Object),
			"dsh_cancel_run",
			"s-1",
		);
	});
});
