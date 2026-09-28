import type { Context } from "@deepseek-ai/cordis";
import type { SessionController } from "@deepseek-ai/dsh-api-session-controller";
import type { WorkspaceController } from "@deepseek-ai/dsh-api-workspace-controller";
import type { CredentialProvider } from "@deepseek-ai/dsh-credentials";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
import { AuthService } from "./auth.js";
import { createHttpRoute, MCP_PATH } from "./http-route.js";
import { LanMcpListener } from "./lan-listener.js";
import type { DshControlMcpListener } from "./listener-contract.js";
import { ClientTokenController } from "./token-controller.js";
import { TokenStore } from "./token-store.js";
import { registerTools, ToolCallGate } from "./tools/registry.js";

export { ClientTokenController };
export type { ListenerPreferences } from "./listener-config.js";
export type { ListenerStatus } from "./listener-contract.js";
export type { CreateClientTokenInput } from "./token-controller.js";
export type { IssuedToken, TokenMetadata } from "./token-store.js";

export const inject = [
	"webServer",
	"credentials",
	"sessionController",
	"workspaceController",
];

export type DshHostContext = Context & {
	webServer: WebServer;
	credentials: CredentialProvider;
	sessionController: SessionController;
	workspaceController: WorkspaceController;
};
export type Config = Record<string, never>;

declare module "@deepseek-ai/cordis" {
	interface Context {
		dshControlMcpListener: DshControlMcpListener;
	}
}

export type TokenScope =
	| "status:read"
	| "models:read"
	| "workspaces:read"
	| "sessions:list"
	| "sessions:read"
	| "sessions:follow"
	| "chat:create"
	| "chat:send"
	| "chat:cancel"
	| "screenshot:capture"
	| "settings:read"
	| "settings:propose"
	| "plugins:read"
	| "plugins:propose";

export interface TokenPrincipal {
	id: string;
	scopes: readonly TokenScope[];
	allowedSessionIds: readonly string[] | "*";
}

/** Mount on the existing DSH listener and tie transport cleanup to this effect. */
export function apply(ctx: DshHostContext, config: Config): void {
	void config;
	if (ctx.webServer.host !== "127.0.0.1")
		throw new Error("Loopback binding required");
	const auth = new AuthService(new TokenStore(ctx.credentials));
	const toolCallGate = new ToolCallGate();
	const listener = new LanMcpListener(ctx, auth, toolCallGate);
	const unprovide = ctx.provide("dshControlMcpListener", listener);
	ctx.plugin(ClientTokenController);
	ctx.effect(async () => {
		await listener.start();
		const route = createHttpRoute({
			port: () => ctx.webServer.port,
			auth,
			registerTools: (server, principal) =>
				registerTools(server, ctx, principal, auth, toolCallGate),
		});
		const unregister = ctx.webServer.register({
			kind: "exact",
			path: MCP_PATH,
			handler: route.handler,
		});
		return async () => {
			unregister();
			await Promise.all([route.dispose(), listener.close()]);
			unprovide();
		};
	});
}
