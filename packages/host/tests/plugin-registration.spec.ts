import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const packageRoot = new URL("../", import.meta.url);
const manifestPath = new URL("package.json", packageRoot);

// Catch a package that installs successfully but cannot activate its Host plugin.
describe("DSH Host plugin registration", () => {
	it("exposes an ESM Host entry and an installable Cordis bundle patch", () => {
		expect(existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		expect(manifest.name).toBe("@tommilevs/dsh-control-mcp-host");
		expect(manifest.type).toBe("module");
		expect(manifest.exports["."].default).toBe("./lib/index.js");
		expect(manifest.main).toBe("lib/index.js");
		const patchPath = new URL(manifest.dsh.bundle.patch, packageRoot);
		expect(existsSync(patchPath)).toBe(true);
		const rows = parse(readFileSync(patchPath, "utf8"))[0].insert;
		expect(rows).toHaveLength(2);
		expect(rows[1].name).toBe("@tommilevs/dsh-control-mcp-client");
		expect(rows[0].name).toBe(manifest.name);
		expect(rows[0].inject).toEqual([
			"webServer",
			"credentials",
			"sessionController",
			"workspaceController",
		]);
		expect(manifest.files).toContain("cordis.patch.yml");
		for (const name of [
			"@deepseek-ai/cordis",
			"@deepseek-ai/dsh-host-webserver",
			"@deepseek-ai/dsh-credentials",
			"@deepseek-ai/dsh-api-session-controller",
			"@deepseek-ai/dsh-api-workspace-controller",
		]) {
			expect(manifest.peerDependencies[name]).toBeTypeOf("string");
		}
		for (const name of [
			"@deepseek-ai/dsh-host-webserver",
			"@deepseek-ai/dsh-credentials",
			"@deepseek-ai/dsh-api-session-controller",
			"@deepseek-ai/dsh-api-workspace-controller",
		]) {
			expect(manifest.peerDependencies[name]).toBe(">=0.1.7-rc.1 <0.1.8");
		}
	});

	it("exports the Cordis apply(ctx, config) Host entry", async () => {
		const entryPath = new URL("src/index.ts", packageRoot);
		expect(existsSync(entryPath)).toBe(true);
		const entry = await import(fileURLToPath(entryPath));
		expect(entry.apply).toBeTypeOf("function");
		expect(entry.apply.length).toBe(2);
		expect(entry.inject).toEqual([
			"webServer",
			"credentials",
			"sessionController",
			"workspaceController",
		]);
	});
});
