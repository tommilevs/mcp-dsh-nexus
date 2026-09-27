import type { IncomingMessage } from "node:http";
import type {
	CredentialKey,
	CredentialRecord,
} from "@deepseek-ai/dsh-credentials";
import { describe, expect, it } from "vitest";
import { AuthService } from "../src/auth.js";
import { createTokenController } from "../src/token-controller.js";
import { TokenStore } from "../src/token-store.js";

function fixture(host: "127.0.0.1" | "0.0.0.0" = "127.0.0.1") {
	const records = new Map<CredentialKey, CredentialRecord>();
	let queue = Promise.resolve();
	const credentials = {
		readRecord: async (key: CredentialKey) => records.get(key),
		listRecords: async () =>
			[...records].map(([key, value]) => ({ key, kind: value.kind })),
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
	return {
		controller: createTokenController(credentials, { host }),
		credentials,
		store,
		records,
	};
}

const request = (authorization: string) =>
	({ headers: { authorization } }) as IncomingMessage;

describe("owner-authenticated client token management", () => {
	it("returns plaintext only at creation and exposes metadata from the list", async () => {
		const { controller, records } = fixture();
		const issued = await controller.createClientToken({
			displayName: "Workstation",
			scopes: ["status:read", "sessions:read"],
		});
		const listed = await controller.listTokenMetadata();

		expect(issued.token).toMatch(/^[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/);
		expect(listed).toEqual([issued.metadata]);
		expect(listed[0]).not.toHaveProperty("token");
		expect(JSON.stringify(listed)).not.toContain(issued.token);
		expect(JSON.stringify([...records.values()])).not.toContain(
			issued.token.split(".")[1],
		);
	});

	it("revokes a client so the next authenticated MCP operation is denied", async () => {
		const { controller, store } = fixture();
		const issued = await controller.createClientToken({
			displayName: "Workstation",
			scopes: ["status:read"],
		});
		const auth = new AuthService(store);
		const principal = await auth.resolvePrincipal(
			request(`Bearer ${issued.token}`),
		);

		await controller.revokeClientToken(issued.metadata.id);

		await expect(auth.authorizeTool(principal, "dsh_status")).rejects.toThrow(
			"Unauthorized",
		);
		await expect(
			auth.resolvePrincipal(request(`Bearer ${issued.token}`)),
		).rejects.toThrow("Unauthorized");
	});

	it("rejects admin permission and gives new clients no cross-session access", async () => {
		const { controller, store } = fixture();
		await expect(
			controller.createClientToken({
				displayName: "Invalid",
				scopes: ["admin" as never],
			}),
		).rejects.toThrow("Invalid token input");

		const issued = await controller.createClientToken({
			displayName: "Read only",
			scopes: ["sessions:read"],
			allowedSessionIds: ["other-session"],
		} as never);
		const principal = await store.getPrincipal(issued.metadata.id);
		expect(issued.metadata.allowedSessionIds).toEqual([]);
		expect(principal.allowedSessionIds).toEqual([]);
	});

	it("does not list or return the separate internal helper credential", async () => {
		const { controller, store } = fixture();
		const helper = await store.ensureInternalHelper(false);
		const listed = await controller.listTokenMetadata();

		expect(listed).toEqual([]);
		expect(JSON.stringify(listed)).not.toContain(helper);
	});

	it("refuses to mount the owner methods when DSH is not loopback-bound", () => {
		const { credentials } = fixture();

		expect(() =>
			createTokenController(credentials, { host: "0.0.0.0" }),
		).toThrow("Loopback binding required");
	});
});
