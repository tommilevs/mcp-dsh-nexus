import { describe, expect, it } from "vitest";
import { registerTools, ToolCallGate } from "../../src/tools/registry.js";
import { makeAuth, makePrincipal, makeServer, readResult } from "./fixtures.js";

describe("DSH diagnostic tools", () => {
	it("advertises only granted read tools and reauthorizes each call", async () => {
		const fake = makeServer();
		const auth = makeAuth();
		const ctx = {
			webServer: { host: "127.0.0.1", port: 43120 },
			sessionController: {
				modelCatalog: async () => ({
					default: { provider: "local", model: "qwen" },
					routableProviders: ["local"],
					groups: [],
					failures: [],
				}),
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
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(["status:read"]),
			auth as never,
		);
		expect([...fake.handlers.keys()]).toEqual(["dsh_status"]);
		const status = readResult<{ port: number }>(await fake.call("dsh_status"));
		expect(status.port).toBe(43120);
		expect(auth.authorizeTool).toHaveBeenCalledWith(
			expect.objectContaining({ id: "client-1" }),
			"dsh_status",
			undefined,
		);
	});

	it("bounds the flattened model catalog", async () => {
		const fake = makeServer();
		const models = Array.from({ length: 400 }, (_, index) => ({
			id: `m-${index}`,
			name: `Model ${index}`,
		}));
		const ctx = {
			webServer: { host: "127.0.0.1", port: 43120 },
			sessionController: {
				modelCatalog: async () => ({
					default: { provider: "p", model: "m-0" },
					routableProviders: ["p"],
					groups: [{ id: "p", name: "P", models }],
					failures: [],
				}),
			},
			workspaceController: { follow: async function* () {} },
		};
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(["models:read"]),
			makeAuth() as never,
		);
		const result = readResult<{ models: unknown[]; hasMore: boolean }>(
			await fake.call("dsh_list_models"),
		);
		expect(result.models).toHaveLength(300);
		expect(result.hasMore).toBe(true);
	});

	it("takes and closes the initial workspace baseline and caps rows", async () => {
		const fake = makeServer();
		let returned = false;
		const rows = Array.from({ length: 120 }, (_, index) => ({
			workspaceId: `w-${index}`,
			title: `Workspace ${index}`,
			path: `C:/ws/${index}`,
			sessionIds: [],
		}));
		const ctx = {
			webServer: { host: "127.0.0.1", port: 43120 },
			sessionController: {
				modelCatalog: async () => ({
					default: { provider: "p", model: "m" },
					routableProviders: [],
					groups: [],
					failures: [],
				}),
			},
			workspaceController: {
				follow: async function* () {
					try {
						yield {
							type: "baseline",
							value: {
								items: rows,
								archivedSessionIds: [],
								pinnedSessionIds: [],
							},
						};
					} finally {
						returned = true;
					}
				} as unknown as (signal: AbortSignal) => AsyncIterable<unknown>,
			},
		};
		registerTools(
			fake.server as never,
			ctx as never,
			makePrincipal(["workspaces:read"]),
			makeAuth() as never,
		);
		const result = readResult<{ workspaces: unknown[]; hasMore: boolean }>(
			await fake.call("dsh_list_workspaces"),
		);
		expect(result.workspaces).toHaveLength(100);
		expect(result.hasMore).toBe(true);
		expect(returned).toBe(true);
	});

	it("bounds a hanging modelCatalog call and retains its token slots until settlement", async () => {
		const fake = makeServer();
		const catalog = {
			default: { provider: "p", model: "m" },
			routableProviders: [] as string[],
			groups: [] as never[],
			failures: [] as never[],
		};
		const resolvers: Array<(value: typeof catalog) => void> = [];
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let callCount = 0;
		const ctx = {
			webServer: { host: "127.0.0.1", port: 43120 },
			sessionController: {
				modelCatalog: () => {
					callCount += 1;
					if (callCount > 2) return Promise.resolve(catalog);
					if (callCount === 2) markStarted();
					return new Promise<typeof catalog>((resolve) => {
						resolvers.push(resolve);
					});
				},
			},
			workspaceController: { follow: async function* () {} },
		};
		registerTools(
			fake.server as never,
			ctx as never,
			{ ...makePrincipal(["models:read"]), id: "retained-deadline-test" },
			makeAuth() as never,
			new ToolCallGate({ responseTimeoutMs: 20 }),
		);
		const first = fake.call("dsh_list_models");
		const second = fake.call("dsh_list_models");
		await started;
		const results = await Promise.all([first, second]);
		expect(
			results.every((result) => (result as { isError?: boolean }).isError),
		).toBe(true);
		const blocked = await fake.call("dsh_list_models");
		expect((blocked as { isError?: boolean }).isError).toBe(true);
		expect(callCount).toBe(2);
		for (const resolve of resolvers) resolve(catalog);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const recovered = await fake.call("dsh_list_models");
		expect((recovered as { isError?: boolean }).isError).toBeUndefined();
		expect(callCount).toBe(3);
	});

	it("shares eight retained execution slots across token principals", async () => {
		const catalog = {
			default: { provider: "p", model: "m" },
			routableProviders: [] as string[],
			groups: [] as never[],
			failures: [] as never[],
		};
		const resolvers: Array<(value: typeof catalog) => void> = [];
		let startedCount = 0;
		const servers = Array.from({ length: 5 }, (_, index) => {
			const fake = makeServer();
			const ctx = {
				webServer: { host: "127.0.0.1", port: 43120 },
				sessionController: {
					modelCatalog: () => {
						startedCount += 1;
						return new Promise<typeof catalog>((resolve) => {
							resolvers.push(resolve);
						});
					},
				},
				workspaceController: { follow: async function* () {} },
			};
			registerTools(
				fake.server as never,
				ctx as never,
				{ ...makePrincipal(["models:read"]), id: `global-${index}` },
				makeAuth() as never,
			);
			return fake;
		});
		const calls: Promise<unknown>[] = [];
		try {
			for (const fake of servers.slice(0, 4)) {
				calls.push(fake.call("dsh_list_models"));
				calls.push(fake.call("dsh_list_models"));
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			const overflowCall = servers[4]?.call("dsh_list_models");
			if (overflowCall) calls.push(overflowCall);
			const overflow = await overflowCall;
			expect((overflow as { isError?: boolean }).isError).toBe(true);
			expect(startedCount).toBe(8);
		} finally {
			for (const resolve of resolvers) resolve(catalog);
			await Promise.allSettled(calls);
		}
	});
});
