import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceTypertGenerator } from "@deepseek-ai/dsh-typert-generator";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(packageDirectory, "../../..");
const packageName = "@tommilevs/dsh-control-mcp-host";
const [artifact] = new WorkspaceTypertGenerator(workspaceRoot).generate(
	[packageName],
	["host"],
);

if (!artifact?.remote) {
	throw new Error(`${packageName} did not produce its Host Remote artifacts`);
}

const outputDirectory = resolve(workspaceRoot, artifact.packageRoot, "lib");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(resolve(outputDirectory, "typert.host.js"), artifact.js);
writeFileSync(resolve(outputDirectory, "typert.host.d.ts"), artifact.dts);
writeFileSync(
	resolve(outputDirectory, "typert.remote-client.js"),
	artifact.remote.js,
);
writeFileSync(
	resolve(outputDirectory, "typert.remote-client.d.ts"),
	artifact.remote.dts,
);
writeFileSync(
	resolve(outputDirectory, "typert.remote-client.d.ts.map"),
	artifact.remote.dtsMap,
);
