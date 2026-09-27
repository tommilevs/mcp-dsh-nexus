import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";

describe("stdio proxy configuration", () => {
	it("requires a token from the dedicated environment variable", () => {
		expect(() => readConfig({})).toThrow("DSH_CONTROL_MCP_TOKEN is required");
		expect(() => readConfig({ DSH_CONTROL_MCP_TOKEN: "  " })).toThrow(
			"DSH_CONTROL_MCP_TOKEN is required",
		);
	});

	it("requires the current DSH Host endpoint from configuration", () => {
		expect(() =>
			readConfig({ DSH_CONTROL_MCP_TOKEN: "test-bearer-value" }),
		).toThrow("DSH_CONTROL_MCP_URL is required");
	});

	it("uses a configurable loopback HTTP endpoint without putting the token in its URL", () => {
		const config = readConfig({
			DSH_CONTROL_MCP_TOKEN: "test-bearer-value",
			DSH_CONTROL_MCP_URL: "http://127.0.0.1:43127/api/dsh-control-mcp/mcp",
		});

		expect(config.endpoint.href).toBe(
			"http://127.0.0.1:43127/api/dsh-control-mcp/mcp",
		);
		expect(config.endpoint.href).not.toContain("test-bearer-value");
		expect(config.token).toBe("test-bearer-value");
	});

	it.each([
		"https://127.0.0.1:43127/api/dsh-control-mcp/mcp",
		"http://example.com/api/dsh-control-mcp/mcp",
		"http://127.0.0.1:43127/other",
		"http://user:password@127.0.0.1:43127/api/dsh-control-mcp/mcp",
		"http://127.0.0.1:43127/api/dsh-control-mcp/mcp?token=secret",
	])("rejects unsafe endpoint configuration %s", (endpoint) => {
		expect(() =>
			readConfig({
				DSH_CONTROL_MCP_TOKEN: "test-bearer-value",
				DSH_CONTROL_MCP_URL: endpoint,
			}),
		).toThrow("DSH_CONTROL_MCP_URL must be a loopback HTTP MCP endpoint");
	});
});
