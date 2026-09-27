import { expect, it } from "vitest";
import { RequestLimiter } from "../src/rate-limiter.js";

it("allows exactly 120 per principal and resets after a rolling minute", () => {
	let now = 0;
	const limiter = new RequestLimiter(() => now);
	for (let i = 0; i < 120; i++) limiter.admit("a");
	expect(() => limiter.admit("a")).toThrow("Too many requests");
	now = 59999;
	expect(() => limiter.admit("a")).toThrow();
	now = 60000;
	expect(() => limiter.admit("a")).not.toThrow();
});
it("caps aggregate at 600 across distinct principals", () => {
	let now = 0;
	const limiter = new RequestLimiter(() => now);
	for (let i = 0; i < 600; i++) limiter.admit(String(i));
	expect(() => limiter.admit("new")).toThrow();
	expect(limiter.principalCount).toBe(600);
	now = 60000;
	limiter.admit("new");
	expect(limiter.principalCount).toBe(1);
});
it("does not consume aggregate capacity on per-principal denial", () => {
	const limiter = new RequestLimiter(() => 0);
	for (let i = 0; i < 120; i++) limiter.admit("a");
	for (let i = 0; i < 50; i++) expect(() => limiter.admit("a")).toThrow();
	for (let i = 0; i < 480; i++) limiter.admit(String(i));
	expect(() => limiter.admit("next")).toThrow();
});

it("reserves exactly 16 lookup slots and releases them idempotently", () => {
	const limiter = new RequestLimiter(() => 0);
	const releases = Array.from({ length: 16 }, () =>
		limiter.reserveUnauthenticated(),
	);
	expect(() => limiter.reserveUnauthenticated()).toThrow("Too many requests");
	releases[0]();
	releases[0]();
	const replacement = limiter.reserveUnauthenticated();
	expect(() => limiter.reserveUnauthenticated()).toThrow("Too many requests");
	replacement();
	for (const release of releases) release();
	for (let i = 0; i < 1000; i++) limiter.reserveUnauthenticated()();
});
