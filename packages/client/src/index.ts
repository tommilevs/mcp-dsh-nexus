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
		ctx.slots.inject("settings.section", () =>
			ctx.slots.register(
				{
					name: "settings.section",
					id: "dsh-control-mcp",
					order: 25,
					label: () =>
						navigator.language.toLowerCase().startsWith("ru")
							? "Клиенты MCP"
							: "MCP clients",
					inject: () => ({ remote: ctx.remote.clientTokens }),
				},
				TokenSection,
			),
		);
		return unmount;
	});
}

export default apply;
