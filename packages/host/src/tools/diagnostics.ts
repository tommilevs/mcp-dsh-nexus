import type { ToolServices } from "./registry.js";
import { boundedSignal, type JsonSchema, nextWithSignal } from "./registry.js";

const emptyInput: JsonSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
};
const MAX_WORKSPACES = 100;
const MAX_MODELS = 300;
const MAX_TEXT = 240;

/** Register read-only Host health, model catalog, and workspace baseline tools. */
export function registerDiagnosticTools(services: ToolServices): void {
	const startedAt = Date.now();
	services.register(
		"dsh_status",
		"status:read",
		"Report the local DSH control endpoint and host process uptime.",
		emptyInput,
		async () => ({
			status: "ok",
			endpoint: "/api/dsh-control-mcp/mcp",
			host: services.ctx.webServer.host,
			port: services.ctx.webServer.port,
			uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
		}),
	);

	services.register(
		"dsh_list_models",
		"models:read",
		"List the routable provider/model pairs currently reported by DSH. This is read-only; it does not change the selected model.",
		emptyInput,
		async (_input, signal) => {
			signal.throwIfAborted();
			const catalog = await services.ctx.sessionController.modelCatalog();
			signal.throwIfAborted();
			const models: Array<{
				provider: string;
				providerName: string;
				model: string;
				name: string;
				description?: string;
			}> = [];
			let hasMore = false;
			for (const group of catalog.groups) {
				for (const model of group.models) {
					if (models.length >= MAX_MODELS) {
						hasMore = true;
						break;
					}
					models.push({
						provider: group.id.slice(0, MAX_TEXT),
						providerName: group.name.slice(0, MAX_TEXT),
						model: model.id.slice(0, MAX_TEXT),
						name: model.name.slice(0, MAX_TEXT),
						...(model.description === undefined
							? {}
							: { description: model.description.slice(0, MAX_TEXT) }),
					});
				}
				if (hasMore) break;
			}
			return {
				default: catalog.default,
				models,
				failures: catalog.failures.slice(0, 100).map((failure) => ({
					provider: failure.id.slice(0, MAX_TEXT),
					name: failure.name.slice(0, MAX_TEXT),
					message: "Provider unavailable",
				})),
				hasMore,
			};
		},
	);

	services.register(
		"dsh_list_workspaces",
		"workspaces:read",
		"List the current DSH workspace baseline, capped at 100 entries.",
		emptyInput,
		async (_input, callerSignal) => {
			const deadline = boundedSignal(callerSignal, 60000);
			const iterator = services.ctx.workspaceController
				.follow(deadline.signal)
				[Symbol.asyncIterator]();
			try {
				const first = await nextWithSignal(iterator, deadline.signal);
				if (first === undefined) {
					if (deadline.timedOut()) throw new Error("Tool deadline reached");
					callerSignal.throwIfAborted();
					throw new Error("Workspace stream unavailable");
				}
				if (first.done || first.value.type !== "baseline")
					throw new Error("Workspace baseline unavailable");
				const value = first.value.value;
				const items = value.items.slice(0, MAX_WORKSPACES).map((item) => ({
					workspaceId: String(item.workspaceId).slice(0, 256),
					title: item.title.slice(0, 160),
					path: item.path.slice(0, 1024),
					sessionCount: item.sessionIds.length,
				}));
				return {
					workspaces: items,
					hasMore: value.items.length > MAX_WORKSPACES,
				};
			} finally {
				deadline.dispose();
				await iterator.return?.();
			}
		},
	);
}
