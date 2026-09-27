import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceAnalyzer } from "@deepseek-ai/dsh-typert-generator";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

describe("Host Remote generation", () => {
	it("includes installed-protocol Remote methods in the Host model", () => {
		const analysis = new WorkspaceAnalyzer({
			root: workspaceRoot,
			hostConfig: "tsconfig.host.json",
			faces: ["host"],
			packages: ["@tommilevs/dsh-control-mcp-host"],
		}).analyze();
		const host = analysis.faces.find((face) => face.face === "host");
		const api = host?.packages.find(
			(packageModel) => packageModel.name === "@tommilevs/dsh-control-mcp-host",
		);

		expect(api?.services.map((service) => service.key)).toContain(
			"tokenManagementController",
		);
		expect(api?.invocations.map((invocation) => invocation.method)).toEqual([
			"createClientToken",
			"listTokenMetadata",
			"revokeClientToken",
		]);
	});
});
