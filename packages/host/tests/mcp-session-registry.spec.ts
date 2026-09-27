import { describe, expect, it, vi } from "vitest";
import { McpSessionRegistry } from "../src/mcp-session-registry.js";

const resource = () => ({ close: vi.fn(async () => {}) });
describe("MCP session capacity and ownership", () => {
	it("reserves synchronously at four per principal and sixteen globally", () => {
		const registry = new McpSessionRegistry();
		for (let p = 0; p < 4; p++)
			for (let n = 0; n < 4; n++) registry.reserve(String(p), resource());
		expect(() => registry.reserve("0", resource())).toThrow(
			"Too many requests",
		);
		expect(() => registry.reserve("new", resource())).toThrow(
			"Too many requests",
		);
	});
	it("isolates lookup and closure and releases capacity", async () => {
		const registry = new McpSessionRegistry();
		const a = resource();
		const b = resource();
		registry.reserve("a", a, "a-session");
		registry.reserve("b", b, "b-session");
		expect(() => registry.get("b-session", "a")).toThrow("Forbidden");
		await registry.close("a-session");
		expect(a.close).toHaveBeenCalledOnce();
		expect(b.close).not.toHaveBeenCalled();
		expect(registry.size).toBe(1);
		await registry.dispose();
		expect(b.close).toHaveBeenCalledOnce();
		expect(registry.size).toBe(0);
	});
	it("caps concurrent calls at two per token and eight globally with idempotent release", async () => {
		const registry = new McpSessionRegistry();
		const releases: (() => void)[] = [];
		for (let p = 0; p < 4; p++)
			for (let n = 0; n < 2; n++)
				releases.push(registry.reserveCall(String(p)));
		expect(() => registry.reserveCall("0")).toThrow("Too many requests");
		expect(() => registry.reserveCall("new")).toThrow("Too many requests");
		releases[0]();
		releases[0]();
		expect(() => registry.reserveCall("0")).not.toThrow();
		await registry.dispose();
		expect(() => registry.reserve("a", resource())).toThrow();
	});
	it("expires abandoned sessions at 120 seconds", async () => {
		vi.useFakeTimers();
		const registry = new McpSessionRegistry();
		const a = resource();
		registry.reserve("a", a, "id");
		await vi.advanceTimersByTimeAsync(120000);
		expect(registry.size).toBe(0);
		expect(a.close).toHaveBeenCalledOnce();
		await registry.dispose();
		vi.useRealTimers();
	});
});
