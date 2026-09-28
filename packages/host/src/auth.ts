import type { IncomingMessage } from "node:http";
import type { TokenPrincipal, TokenScope } from "./index.js";
import type { TokenStore } from "./token-store.js";

const toolScopes: Readonly<Record<string, TokenScope>> = {
	dsh_status: "status:read",
	dsh_list_models: "models:read",
	dsh_list_workspaces: "workspaces:read",
	dsh_list_sessions: "sessions:list",
	dsh_read_session: "sessions:read",
	dsh_follow_session: "sessions:follow",
	dsh_create_chat: "chat:create",
	dsh_send_message: "chat:send",
	dsh_wait_run: "sessions:follow",
	dsh_cancel_run: "chat:cancel",
	dsh_capture_screenshot: "screenshot:capture",
	dsh_read_settings: "settings:read",
	dsh_propose_settings: "settings:propose",
	dsh_list_plugins: "plugins:read",
	dsh_propose_plugins: "plugins:propose",
};
const sessionTools = new Set([
	"dsh_read_session",
	"dsh_follow_session",
	"dsh_send_message",
	"dsh_wait_run",
	"dsh_cancel_run",
]);
const localNoBearerPrincipal: TokenPrincipal = {
	id: "local-no-bearer",
	scopes: Object.values(toolScopes) as TokenScope[],
	allowedSessionIds: "*",
};
export class AuthService {
	constructor(private readonly store: TokenStore) {}
	async resolvePrincipal(
		req: IncomingMessage,
		requireBearer = true,
	): Promise<TokenPrincipal> {
		const header = req.headers.authorization;
		if (header === undefined && !requireBearer) return localNoBearerPrincipal;
		if (typeof header !== "string" || !/^Bearer \S+$/.test(header))
			throw new Error("Unauthorized");
		if (
			req.rawHeaders?.filter(
				(value, index) =>
					index % 2 === 0 && value.toLowerCase() === "authorization",
			).length > 1
		)
			throw new Error("Unauthorized");
		return this.store.resolveToken(header.slice(7));
	}
	async authorizeTool(
		principal: TokenPrincipal,
		toolName: string,
		targetSessionId?: string,
	): Promise<void> {
		if (principal.id === localNoBearerPrincipal.id) {
			if (!toolScopes[toolName]) throw new Error("Forbidden");
			return;
		}
		const current = await this.store.getPrincipal(principal.id);
		const scope = toolScopes[toolName];
		if (!scope || !current.scopes.includes(scope)) throw new Error("Forbidden");
		if (sessionTools.has(toolName) && !targetSessionId)
			throw new Error("Forbidden");
		if (
			targetSessionId &&
			current.allowedSessionIds !== "*" &&
			!current.allowedSessionIds.includes(targetSessionId)
		)
			throw new Error("Forbidden");
	}
	async recordOwnedSession(
		principalId: string,
		sessionId: string,
	): Promise<void> {
		return this.store.recordOwnedSession(principalId, sessionId);
	}
}
