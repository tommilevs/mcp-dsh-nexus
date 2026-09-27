import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
	type CredentialKey,
	type CredentialRecord,
	credentialKey,
} from "@deepseek-ai/dsh-credentials";
import { describe, expect, it } from "vitest";
import { AuthService } from "../src/auth.js";
import { TokenStore } from "../src/token-store.js";

function fixture() {
	const records = new Map<CredentialKey, CredentialRecord>();
	let queue = Promise.resolve();
	const credentials = {
		readRecord: async (key: CredentialKey) => records.get(key),
		deleteRecord: async (key: CredentialKey) => {
			records.delete(key);
		},
		modifyRecord(
			key: CredentialKey,
			mutate: (
				record: CredentialRecord | undefined,
			) => Promise<CredentialRecord | undefined>,
		) {
			const result = queue.then(async () => {
				const next = await mutate(records.get(key));
				if (next) records.set(key, next);
				return records.get(key);
			});
			queue = result.then(
				() => {},
				() => {},
			);
			return result;
		},
	};
	const store = new TokenStore(credentials);
	return { store, records, auth: new AuthService(store) };
}
const request = (authorization?: string) =>
	({ headers: { authorization } }) as IncomingMessage;
describe("credential-backed client tokens", () => {
	it("issues independent random identifiers and 256-bit secrets, storing only a digest", async () => {
		const { store, records, auth } = fixture();
		const issued = await store.issueToken({
			displayName: "IDE",
			scopes: ["status:read"],
		});
		const [id, secret] = issued.token.split(".");
		expect(id).toMatch(/^[a-f0-9]{32}$/);
		expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(secret, "base64url")).toHaveLength(32);
		const record = records.get(
			credentialKey("dsh-control-mcp", `client-${id}`),
		);
		expect(JSON.stringify(record)).not.toContain(secret);
		expect(JSON.stringify(record)).toContain(
			createHash("sha256").update(secret).digest("hex"),
		);
		expect(
			await auth.resolvePrincipal(request(`Bearer ${issued.token}`)),
		).toMatchObject({ id, scopes: ["status:read"] });
		expect(
			await store.issueToken({ displayName: "IDE", scopes: [] }),
		).not.toEqual(issued);
	});
	it("denies altered secrets, missing and malformed headers without leaking credentials", async () => {
		const { store, auth } = fixture();
		const issued = await store.issueToken({ displayName: "IDE", scopes: [] });
		for (const value of [
			undefined,
			"Basic abc",
			`Bearer ${issued.token} extra`,
			`Bearer ${issued.token.slice(0, -1)}!`,
			`Bearer ${issued.token.split(".")[0]}.${"a".repeat(43)}`,
		]) {
			await expect(auth.resolvePrincipal(request(value))).rejects.toThrow(
				"Unauthorized",
			);
		}
	});
	it("revokes and deletes credentials immediately, including previously resolved principals", async () => {
		const { store, auth, records } = fixture();
		const issued = await store.issueToken({
			displayName: "IDE",
			scopes: ["status:read"],
		});
		const principal = await auth.resolvePrincipal(
			request(`Bearer ${issued.token}`),
		);
		await store.revokeToken(principal.id);
		await expect(
			auth.resolvePrincipal(request(`Bearer ${issued.token}`)),
		).rejects.toThrow("Unauthorized");
		await expect(auth.authorizeTool(principal, "dsh_status")).rejects.toThrow(
			"Unauthorized",
		);
		await store.deleteToken(principal.id);
		expect(records.size).toBe(0);
	});
	it("checks scopes and session allowlists, and persists concurrent creator ownership", async () => {
		const { store, auth } = fixture();
		const issued = await store.issueToken({
			displayName: "IDE",
			scopes: ["sessions:read"],
			allowedSessionIds: ["allowed"],
		});
		const principal = await auth.resolvePrincipal(
			request(`Bearer ${issued.token}`),
		);
		await expect(
			auth.authorizeTool(principal, "dsh_send_message", "allowed"),
		).rejects.toThrow("Forbidden");
		await expect(
			auth.authorizeTool(principal, "dsh_read_session", "foreign"),
		).rejects.toThrow("Forbidden");
		await expect(
			auth.authorizeTool(principal, "dsh_read_session", "allowed"),
		).resolves.toBeUndefined();
		await Promise.all([
			store.recordOwnedSession(principal.id, "owned-a"),
			store.recordOwnedSession(principal.id, "owned-b"),
		]);
		for (const id of ["owned-a", "owned-b"])
			await expect(
				auth.authorizeTool(principal, "dsh_read_session", id),
			).resolves.toBeUndefined();
		await expect(auth.authorizeTool(principal, "unknown")).rejects.toThrow(
			"Forbidden",
		);
	});
	it("stores a distinct internal helper secret and gates screenshot scope", async () => {
		const { store, records, auth } = fixture();
		const helper = await store.ensureInternalHelper(false);
		expect(
			records.has(credentialKey("dsh-control-mcp", "internal-helper")),
		).toBe(true);
		const principal = await auth.resolvePrincipal(request(`Bearer ${helper}`));
		await expect(
			auth.authorizeTool(principal, "dsh_status"),
		).resolves.toBeUndefined();
		await expect(
			auth.authorizeTool(principal, "dsh_create_chat"),
		).rejects.toThrow("Forbidden");
		await expect(
			auth.authorizeTool(principal, "dsh_capture_screenshot"),
		).rejects.toThrow("Forbidden");
		expect(await store.ensureInternalHelper(true)).toBe(helper);
		await expect(
			auth.authorizeTool(principal, "dsh_capture_screenshot"),
		).resolves.toBeUndefined();
		await store.ensureInternalHelper(false);
		await expect(
			auth.authorizeTool(principal, "dsh_capture_screenshot"),
		).rejects.toThrow("Forbidden");
	});
});

it("rejects unsupported scopes before writing credentials", async () => {
	const { store, records } = fixture();
	await expect(
		store.issueToken({
			displayName: "IDE",
			scopes: ["shell:execute"] as never,
		}),
	).rejects.toThrow("Invalid token input");
	expect(records.size).toBe(0);
});
it("rejects malformed stored token records without leaking secrets", async () => {
	const { store, records, auth } = fixture();
	const issued = await store.issueToken({
		displayName: "IDE",
		scopes: ["status:read"],
	});
	const id = issued.metadata.id;
	records.set(credentialKey("dsh-control-mcp", `client-${id}`), {
		kind: "grant",
		payload: {
			id,
			digest: "short",
			scopes: ["status:read"],
			allowedSessionIds: [],
			ownedSessionIds: [],
			revoked: false,
		},
	});
	await expect(
		auth.resolvePrincipal(request(`Bearer ${issued.token}`)),
	).rejects.toThrow("Unauthorized");
});
