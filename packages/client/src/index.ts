import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { TYPERT_REMOTE } from "@tommilevs/dsh-control-mcp-host/remote";
import { TokenSection } from "./token-section.js";

export const inject = ["slots", "remote"];

/** Mount the generated namespace before contributing its settings section. */
export function apply(ctx: Context): void {
	ctx.effect(async () => {
		const unmount = await ctx.remote.$mount(TYPERT_REMOTE);
		ctx.inject(["remote.clientTokens"], (scope) => {
			const label = navigator.language.toLowerCase().startsWith("ru")
				? "Клиенты MCP"
				: "MCP clients";
			const unregister = scope.slots.register(
				{
					name: "settings.section",
					id: "dsh-control-mcp",
					order: 1000,
					label,
					inject: () => ({ remote: scope.remote.clientTokens }),
				},
				TokenSection,
			);
			scope.effect(() => unregister);
		});
		return unmount;
	});
}

export default apply;
