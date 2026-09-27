import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import {
	admitRequest,
	assertBodySize,
	assertHttpPolicy,
} from "../src/http-policy.js";
import { RequestLimiter } from "../src/rate-limiter.js";

const req = (
	headers: Record<string, string | undefined> = {},
	peer = "127.0.0.1",
) =>
	({
		headers: { host: "127.0.0.1:3000", ...headers },
		socket: { remoteAddress: peer },
	}) as IncomingMessage;
it("accepts exact loopback hosts and origins", () => {
	for (const host of ["127.0.0.1:3000", "localhost:3000"])
		for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
			expect(() =>
				assertHttpPolicy(req({ host, origin: `http://${host}` }, peer), 3000),
			).not.toThrow();
});
it("rejects hostile peers, hosts, null/foreign origins and forwarding headers", () => {
	for (const peer of ["127.0.0.2", "198.51.100.1", "::ffff:198.51.100.1"])
		expect(() => assertHttpPolicy(req({}, peer), 3000)).toThrow();
	for (const headers of [
		{ host: "evil:3000" },
		{ host: "localhost:3001" },
		{ origin: "null" },
		{ origin: "https://evil.test" },
		{ origin: "http://localhost:3000/path" },
		{ origin: "http://localhost:3001" },
		{ forwarded: "for=127.0.0.1" },
		{ "x-forwarded-for": "127.0.0.1" },
		{ "x-forwarded-anything": "x" },
	])
		expect(() => assertHttpPolicy(req(headers), 3000)).toThrow();
});
it("caps bodies at 64 KiB including declared sizes", () => {
	expect(() => assertBodySize(65536)).not.toThrow();
	expect(() => assertBodySize(65537)).toThrow();
	for (const size of ["65537", "-1", "1e3", "invalid"])
		expect(() =>
			assertHttpPolicy(req({ "content-length": size }), 3000),
		).toThrow();
});
it("requires a valid bearer without Origin and never charges unauthenticated traffic", async () => {
	const limiter = new RequestLimiter(() => 0);
	const auth = {
		resolvePrincipal: async () => {
			throw new Error("Unauthorized");
		},
	};
	for (let i = 0; i < 601; i++)
		await expect(admitRequest(req(), 3000, auth, limiter)).rejects.toThrow(
			"Unauthorized",
		);
	expect(limiter.principalCount).toBe(0);
	const valid = {
		resolvePrincipal: async () => ({
			id: "a",
			scopes: [],
			allowedSessionIds: [],
		}),
	};
	for (let i = 0; i < 120; i++)
		await expect(
			admitRequest(req(), 3000, valid, limiter),
		).resolves.toMatchObject({ id: "a" });
	await expect(admitRequest(req(), 3000, valid, limiter)).rejects.toThrow(
		"Too many requests",
	);
});

it("reserves the unauthenticated cap before concurrent credential lookups", async () => {
	const limiter = new RequestLimiter(() => 0);
	let lookups = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const auth = {
		resolvePrincipal: async () => {
			lookups++;
			await gate;
			throw new Error("Unauthorized");
		},
	};
	const requests = Array.from({ length: 17 }, () =>
		admitRequest(req(), 3000, auth, limiter),
	);
	expect(lookups).toBe(16);
	release();
	const results = await Promise.allSettled(requests);
	expect(results.filter((result) => result.status === "rejected")).toHaveLength(
		17,
	);
	expect(limiter.principalCount).toBe(0);
	await expect(
		admitRequest(
			req(),
			3000,
			{
				resolvePrincipal: async () => ({
					id: "valid",
					scopes: [],
					allowedSessionIds: [],
				}),
			},
			limiter,
		),
	).resolves.toMatchObject({ id: "valid" });
});
it("keeps successful authentication separate from unauthenticated quota", async () => {
	const limiter = new RequestLimiter(() => 0);
	let id = 0;
	const auth = {
		resolvePrincipal: async () => ({
			id: String(id++),
			scopes: [],
			allowedSessionIds: [],
		}),
	};
	for (let i = 0; i < 600; i++) await admitRequest(req(), 3000, auth, limiter);
	await expect(admitRequest(req(), 3000, auth, limiter)).rejects.toThrow(
		"Too many requests",
	);
});

it("admits exactly 120 authenticated concurrent requests for one principal", async () => {
	const limiter = new RequestLimiter(() => 0);
	const auth = {
		resolvePrincipal: async () => ({
			id: "a",
			scopes: [],
			allowedSessionIds: [],
		}),
	};
	for (let batch = 0; batch < 8; batch++) {
		const size = batch === 7 ? 8 : 16;
		const requests = await Promise.allSettled(
			Array.from({ length: size }, () =>
				admitRequest(req(), 3000, auth, limiter),
			),
		);
		expect(
			requests.filter((result) => result.status === "fulfilled"),
		).toHaveLength(size);
	}
	await expect(admitRequest(req(), 3000, auth, limiter)).rejects.toThrow(
		"Too many requests",
	);
});
it("rejects duplicate security headers", () => {
	for (const header of ["host", "origin", "content-length"]) {
		const request = req();
		request.rawHeaders = [header, "first", header, "second"];
		expect(() => assertHttpPolicy(request, 3000)).toThrow("Forbidden");
	}
});

it("releases all pending lookup slots after successful authentication", async () => {
	const limiter = new RequestLimiter(() => 0);
	let resolve!: () => void;
	const gate = new Promise<void>((done) => {
		resolve = done;
	});
	const auth = {
		resolvePrincipal: async () => {
			await gate;
			return { id: "a", scopes: [], allowedSessionIds: [] };
		},
	};
	const pending = Array.from({ length: 16 }, () =>
		admitRequest(req(), 3000, auth, limiter),
	);
	await expect(admitRequest(req(), 3000, auth, limiter)).rejects.toThrow(
		"Too many requests",
	);
	resolve();
	await Promise.all(pending);
	const next = await Promise.all(
		Array.from({ length: 16 }, () => admitRequest(req(), 3000, auth, limiter)),
	);
	expect(next).toHaveLength(16);
});
