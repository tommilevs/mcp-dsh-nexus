import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	type CredentialProvider,
	type CredentialRecord,
	credentialKey,
} from "@deepseek-ai/dsh-credentials";
import type { TokenPrincipal, TokenScope } from "./index.js";
export type TokenCredentials = Pick<
	CredentialProvider,
	"readRecord" | "modifyRecord" | "deleteRecord"
>;
export interface IssueTokenInput {
	displayName: string;
	scopes: readonly TokenScope[];
	allowedSessionIds?: readonly string[] | "*";
}
export interface TokenMetadata extends IssueTokenInput {
	allowedSessionIds: readonly string[] | "*";
	id: string;
	ownedSessionIds: readonly string[];
	createdAt: number;
	revoked: boolean;
}
export interface IssuedToken {
	token: string;
	metadata: TokenMetadata;
}
interface ClientRecord extends TokenMetadata {
	digest: string;
	helperToken?: string;
}
const helperScopes: TokenScope[] = [
	"status:read",
	"models:read",
	"workspaces:read",
	"sessions:list",
	"sessions:read",
	"sessions:follow",
];
const validScopes = new Set<TokenScope>([
	...helperScopes,
	"chat:create",
	"chat:send",
	"chat:cancel",
	"screenshot:capture",
	"settings:read",
	"settings:propose",
	"plugins:read",
	"plugins:propose",
]);
const validIds = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.every((id) => typeof id === "string" && id.length > 0);
const validScopeList = (value: unknown): value is TokenScope[] =>
	Array.isArray(value) && value.every((scope) => validScopes.has(scope));
const digest = (secret: string) =>
	createHash("sha256").update(secret).digest("hex");
function key(id: string) {
	if (id !== "internal-helper" && !/^[a-f0-9]{32}$/.test(id))
		throw new Error("Unauthorized");
	return credentialKey(
		"dsh-control-mcp",
		id === "internal-helper" ? id : `client-${id}`,
	);
}
function unpack(record: CredentialRecord | undefined): ClientRecord {
	if (record?.kind !== "grant") throw new Error("Unauthorized");
	const value = record.payload as unknown as ClientRecord;
	if (
		!value ||
		typeof value.id !== "string" ||
		typeof value.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.digest) ||
		!validScopeList(value.scopes) ||
		!(value.allowedSessionIds === "*" || validIds(value.allowedSessionIds)) ||
		!validIds(value.ownedSessionIds) ||
		typeof value.revoked !== "boolean"
	)
		throw new Error("Unauthorized");
	return value;
}
function pack(record: ClientRecord): CredentialRecord {
	return { kind: "grant", payload: record };
}
export class TokenStore {
	constructor(private readonly credentials: TokenCredentials) {}
	async issueToken(input: IssueTokenInput): Promise<IssuedToken> {
		if (
			!input ||
			typeof input.displayName !== "string" ||
			!input.displayName.trim() ||
			!validScopeList(input.scopes) ||
			(input.allowedSessionIds !== undefined &&
				input.allowedSessionIds !== "*" &&
				!validIds(input.allowedSessionIds))
		)
			throw new Error("Invalid token input");
		const id = randomBytes(16).toString("hex");
		const secret = randomBytes(32).toString("base64url");
		const metadata: TokenMetadata = {
			id,
			displayName: input.displayName,
			scopes: [...input.scopes],
			allowedSessionIds:
				input.allowedSessionIds === "*"
					? "*"
					: [...(input.allowedSessionIds ?? [])],
			ownedSessionIds: [],
			createdAt: Date.now(),
			revoked: false,
		};
		await this.credentials.modifyRecord(key(id), async (current) => {
			if (current) throw new Error("Token collision");
			return pack({ ...metadata, digest: digest(secret) });
		});
		return { token: `${id}.${secret}`, metadata };
	}
	async getPrincipal(id: string): Promise<TokenPrincipal> {
		const record = unpack(await this.credentials.readRecord(key(id)));
		if (record.revoked || record.id !== id) throw new Error("Unauthorized");
		return {
			id,
			scopes: [...record.scopes],
			allowedSessionIds:
				record.allowedSessionIds === "*"
					? "*"
					: [
							...new Set([
								...record.allowedSessionIds,
								...record.ownedSessionIds,
							]),
						],
		};
	}
	async resolveToken(token: string): Promise<TokenPrincipal> {
		const match = /^([a-f0-9]{32}|internal-helper)\.([A-Za-z0-9_-]{43})$/.exec(
			token,
		);
		if (!match) throw new Error("Unauthorized");
		const [, id, secret] = match;
		const record = unpack(await this.credentials.readRecord(key(id)));
		if (
			!timingSafeEqual(
				Buffer.from(record.digest, "hex"),
				Buffer.from(digest(secret), "hex"),
			) ||
			record.revoked ||
			record.id !== id
		)
			throw new Error("Unauthorized");
		return this.getPrincipal(id);
	}
	async revokeToken(id: string): Promise<void> {
		await this.credentials.modifyRecord(key(id), async (current) =>
			pack({ ...unpack(current), revoked: true }),
		);
	}
	async deleteToken(id: string): Promise<void> {
		await this.credentials.deleteRecord(key(id));
	}
	async recordOwnedSession(
		principalId: string,
		sessionId: string,
	): Promise<void> {
		await this.credentials.modifyRecord(key(principalId), async (current) => {
			const record = unpack(current);
			if (record.revoked) throw new Error("Unauthorized");
			return pack({
				...record,
				ownedSessionIds: [...new Set([...record.ownedSessionIds, sessionId])],
			});
		});
	}
	async ensureInternalHelper(screenshotReady: boolean): Promise<string> {
		const result = await this.credentials.modifyRecord(
			key("internal-helper"),
			async (current) => {
				const existing = current ? unpack(current) : undefined;
				const secret =
					existing?.helperToken?.split(".")[1] ??
					randomBytes(32).toString("base64url");
				return pack({
					id: "internal-helper",
					displayName: "DSH internal helper",
					scopes: screenshotReady
						? [...helperScopes, "screenshot:capture"]
						: helperScopes,
					allowedSessionIds: "*",
					ownedSessionIds: [],
					createdAt: existing?.createdAt ?? Date.now(),
					revoked: false,
					digest: digest(secret),
					helperToken: `internal-helper.${secret}`,
				});
			},
		);
		const token = unpack(result).helperToken;
		if (!token) throw new Error("Unauthorized");
		return token;
	}
}
