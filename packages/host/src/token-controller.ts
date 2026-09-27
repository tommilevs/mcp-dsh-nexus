import type { Context } from "@deepseek-ai/cordis";
import type {
	CredentialProvider,
	CredentialRecord,
} from "@deepseek-ai/dsh-credentials";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { TokenScope } from "./index.js";
import {
	type IssuedToken,
	type TokenMetadata,
	TokenStore,
} from "./token-store.js";

const clientRecordKey = /^dsh-control-mcp\/client-([a-f0-9]{32})$/;
const grantableScopes = new Set<TokenScope>([
	"status:read",
	"models:read",
	"workspaces:read",
	"sessions:list",
	"sessions:read",
	"sessions:follow",
	"chat:create",
	"chat:send",
	"chat:cancel",
]);
const maxClientTokens = 256;
const maxDisplayNameLength = 80;

export type TokenControllerCredentials = Pick<
	CredentialProvider,
	"listRecords" | "readRecord" | "modifyRecord" | "deleteRecord"
>;

export interface CreateClientTokenInput {
	displayName: string;
	scopes: readonly TokenScope[];
}

export interface TokenControllerApi {
	listTokenMetadata(): Promise<TokenMetadata[]>;
	createClientToken(input: CreateClientTokenInput): Promise<IssuedToken>;
	revokeClientToken(id: string): Promise<{ revoked: true }>;
}

function metadataOf(
	record: CredentialRecord | undefined,
	id: string,
): TokenMetadata | undefined {
	if (record?.kind !== "grant") return undefined;
	const value = record.payload as Partial<TokenMetadata> & { digest?: unknown };
	if (
		value.id !== id ||
		typeof value.displayName !== "string" ||
		!value.displayName.trim() ||
		!Array.isArray(value.scopes) ||
		!value.scopes.every(
			(scope): scope is TokenScope =>
				typeof scope === "string" && grantableScopes.has(scope as TokenScope),
		) ||
		!(
			value.allowedSessionIds === "*" ||
			(Array.isArray(value.allowedSessionIds) &&
				value.allowedSessionIds.every(
					(sessionId) => typeof sessionId === "string" && sessionId.length > 0,
				))
		) ||
		!Array.isArray(value.ownedSessionIds) ||
		!value.ownedSessionIds.every(
			(sessionId) => typeof sessionId === "string" && sessionId.length > 0,
		) ||
		typeof value.createdAt !== "number" ||
		!Number.isFinite(value.createdAt) ||
		typeof value.revoked !== "boolean"
	)
		return undefined;

	// Return an explicit public projection. In particular, credential payload
	// fields such as the secret digest are never copied into the remote result.
	return {
		id,
		displayName: value.displayName,
		scopes: [...value.scopes],
		allowedSessionIds:
			value.allowedSessionIds === "*" ? "*" : [...value.allowedSessionIds],
		ownedSessionIds: [...value.ownedSessionIds],
		createdAt: value.createdAt,
		revoked: value.revoked,
	};
}

/**
 * Build the owner-only management API over the existing credential-backed
 * store. DSH's local API exposes one shared operator identity to all callers.
 */
export function createTokenController(
	credentials: TokenControllerCredentials,
	webServer: Pick<WebServer, "host">,
): TokenControllerApi {
	if (webServer.host !== "127.0.0.1")
		throw new Error("Loopback binding required");

	const store = new TokenStore(credentials);
	return {
		async listTokenMetadata() {
			const entries = await credentials.listRecords();
			const clients = entries
				.flatMap((entry) => {
					if (entry.kind !== "grant") return [];
					const match = clientRecordKey.exec(String(entry.key));
					return match ? [{ key: entry.key, id: match[1] }] : [];
				})
				.slice(-maxClientTokens);
			const metadata: TokenMetadata[] = [];
			// CredentialProvider offers no paginated listing. Bound record reads and
			// concurrency so a corrupt/large store cannot fan out unbounded work.
			for (const { key, id } of clients) {
				const value = metadataOf(await credentials.readRecord(key), id);
				if (value) metadata.push(value);
			}
			return metadata.sort((left, right) => right.createdAt - left.createdAt);
		},
		async createClientToken(input) {
			if (
				!input ||
				typeof input.displayName !== "string" ||
				!input.displayName.trim() ||
				input.displayName.trim().length > maxDisplayNameLength ||
				!Array.isArray(input.scopes) ||
				input.scopes.length > grantableScopes.size ||
				new Set(input.scopes).size !== input.scopes.length ||
				!input.scopes.every(
					(scope) =>
						typeof scope === "string" &&
						grantableScopes.has(scope as TokenScope),
				)
			)
				throw new Error("Invalid token input");

			return store.issueToken({
				displayName: input.displayName,
				scopes: [...input.scopes],
				// New clients never receive access to sessions they did not create.
				allowedSessionIds: [],
			});
		},
		async revokeClientToken(id) {
			if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid token id");
			await store.revokeToken(id);
			return { revoked: true };
		},
	};
}

type TokenControllerContext = Context & {
	credentials: CredentialProvider;
	webServer: WebServer;
};

/**
 * DSH-authenticated Host→Client service for local settings callers.
 * @typert service tokenManagementController
 */
export class ClientTokenController extends TypertRemoteService {
	static inject = ["credentials", "webServer"];
	private readonly api: TokenControllerApi;

	constructor(ctx: TokenControllerContext) {
		super(ctx, "tokenManagementController", { namespace: "clientTokens" });
		this.api = createTokenController(ctx.credentials, ctx.webServer);
	}

	@Remote
	listTokenMetadata(): Promise<TokenMetadata[]> {
		return this.api.listTokenMetadata();
	}

	@Remote
	createClientToken(input: CreateClientTokenInput): Promise<IssuedToken> {
		return this.api.createClientToken(input);
	}

	@Remote
	revokeClientToken(id: string): Promise<{ revoked: true }> {
		return this.api.revokeClientToken(id);
	}
}
