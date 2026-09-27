import { describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/tools/registry.js";
import { makeAuth, makePrincipal, makeServer, readResult } from "./fixtures.js";

describe("DSH session tools", () => {
	it("filters sessions to the token allowlist and returns no more than 100", async () => {
		const fake = makeServer();
		const items = Array.from({ length: 140 }, (_, index) => ({
			sessionId: `s-${index}`,
			updatedAt: index,
			running: false,
			blank: false,
			agentAvailable: false,
			projections: {
				asOfSeq: index,
				values: { sessionListMetadata: { blank: false, lastPromptAt: null } },
			},
		}));
		const ctx = {
			webServer: { host: "127.0.0.1", port: 43120 },
			sessionController: {
				list: vi.fn(async (_request: unknown, _signal: AbortSignal) => ({
					items,
				})),
				modelCatalog: async () => ({
					default: { provider: "p", model: "m" },
					routableProviders: [],
					groups: [],
					failures: [],
				}),
			},
			workspaceController: { follow: async function* () {} },
		};
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(
				["sessions:list"],
				Array.from({ length: 120 }, (_, index) => `s-${index}`),
			),
			makeAuth() as never,
		);
		const result = readResult<{
			sessions: Array<{ sessionId: string }>;
			hasMore: boolean;
		}>(await fake.call("dsh_list_sessions"));
		expect(result.sessions).toHaveLength(100);
		expect(
			result.sessions.every(
				(session) => Number(session.sessionId.slice(2)) < 120,
			),
		).toBe(true);
		expect(result.hasMore).toBe(true);
		expect(ctx.sessionController.list).toHaveBeenCalledWith(
			{},
			expect.any(AbortSignal),
		);
	});

	it("reads a bounded page at the follow snapshot cursor and closes the follower", async () => {
		const fake = makeServer();
		let returned = false;
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
					try {
						yield { type: "snapshot", cursor: 58, records: [], hasMore: false };
					} finally {
						returned = true;
					}
				} as unknown as (
					_request: unknown,
					signal: AbortSignal,
				) => AsyncIterable<unknown>,
				page: vi.fn(
					async (
						request: { throughSeq: number; maxMessages: number },
						_signal: AbortSignal,
					) => ({
						records: [
							{
								type: "event",
								event: {
									seq: request.throughSeq,
									type: "user/message",
									time: 1,
									data: { content: [{ type: "text", text: "hi" }] },
								},
							},
						],
						hasMore: false,
					}),
				),
				list: async () => ({ items: [] }),
			},
			workspaceController: { follow: async function* () {} },
		};
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(["sessions:read"], ["s-1"]),
			makeAuth() as never,
		);
		const result = readResult<{ messages: unknown[] }>(
			await fake.call("dsh_read_session", { sessionId: "s-1", limit: 200 }),
		);
		expect(result.messages).toHaveLength(1);
		expect(ctx.sessionController.page).toHaveBeenCalledWith(
			expect.objectContaining({ throughSeq: 58, maxMessages: 200 }),
			expect.any(AbortSignal),
		);
		expect(returned).toBe(true);
	});

	it("propagates caller cancellation and closes a follow iterator", async () => {
		const fake = makeServer();
		let returned = false;
		let markFollowStarted!: () => void;
		const followStarted = new Promise<void>((resolve) => {
			markFollowStarted = resolve;
		});
		const ctx = {
			webServer: { host: "127.0.0.1", port: 43120 },
			sessionController: {
				modelCatalog: async () => ({
					default: { provider: "p", model: "m" },
					routableProviders: [],
					groups: [],
					failures: [],
				}),
				follow: (_request: unknown, signal: AbortSignal) => {
					markFollowStarted();
					return {
						[Symbol.asyncIterator]() {
							return {
								next: () =>
									new Promise<IteratorResult<unknown>>((resolve) =>
										signal.addEventListener(
											"abort",
											() => resolve({ done: true, value: undefined }),
											{ once: true },
										),
									),
								return: async () => {
									returned = true;
									return { done: true, value: undefined };
								},
							};
						},
					};
				},
				list: async () => ({ items: [] }),
			},
			workspaceController: { follow: async function* () {} },
		};
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(["sessions:follow"], ["s-1"]),
			makeAuth() as never,
		);
		const controller = new AbortController();
		const response = fake.call(
			"dsh_follow_session",
			{ sessionId: "s-1", timeoutSeconds: 55 },
			controller.signal,
		);
		await followStarted;
		controller.abort();
		await response;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(returned).toBe(true);
	});

	it("returns an intentional session-follow timeout before the shared tool deadline", async () => {
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
				list: async () => ({ items: [] }),
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
			},
			workspaceController: { follow: async function* () {} },
		};
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(["sessions:follow"], ["s-1"]),
			makeAuth() as never,
		);
		const result = readResult<{ timedOut: boolean }>(
			await fake.call("dsh_follow_session", {
				sessionId: "s-1",
				timeoutSeconds: 1,
				maxMessages: 1,
			}),
		);
		expect(result.timedOut).toBe(true);
	});
});
