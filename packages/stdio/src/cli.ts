#!/usr/bin/env node
import { readConfig } from "./config.js";
import { startStdioProxy } from "./proxy.js";

function writeError(message: string): void {
	process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
	let config: ReturnType<typeof readConfig>;
	try {
		config = readConfig(process.env);
	} catch (error) {
		writeError(
			error instanceof Error
				? error.message
				: "Invalid stdio proxy configuration.",
		);
		process.exitCode = 1;
		return;
	}

	let proxy: Awaited<ReturnType<typeof startStdioProxy>>;
	try {
		proxy = await startStdioProxy(config);
	} catch {
		writeError("Unable to connect to the DSH MCP HTTP endpoint.");
		process.exitCode = 1;
		return;
	}

	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		void proxy.close().finally(() => process.exit(0));
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

void main().catch(() => {
	writeError("Unable to start the DSH MCP stdio proxy.");
	process.exitCode = 1;
});
