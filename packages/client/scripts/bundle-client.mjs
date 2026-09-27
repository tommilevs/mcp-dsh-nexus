import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = new URL("../", import.meta.url);
const result = await build({
	entryPoints: [fileURLToPath(new URL("src/index.ts", packageRoot))],
	platform: "browser",
	format: "cjs",
	bundle: true,
	write: false,
	target: "es2022",
	jsx: "transform",
	jsxFactory: "React.createElement",
	jsxFragment: "React.Fragment",
	external: ["@deepseek-ai/*", "react", "react-dom"],
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error("The DSH client build produced no bundle");
const wrapper = `window.__ModuleLoader__.load({
  id: "@tommilevs/dsh-control-mcp-client",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    ${source}
    return module.exports;
  }
});\n`;
await mkdir(new URL("lib/", packageRoot), { recursive: true });
await writeFile(new URL("lib/index.js", packageRoot), wrapper);
