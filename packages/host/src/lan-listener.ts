import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import type { AuthService } from "./auth.js";
import { createHttpRoute, MCP_PATH } from "./http-route.js";
import type { DshHostContext } from "./index.js";
import {
	DEFAULT_LISTENER_PREFERENCES,
	isPrivateIPv4,
	ListenerPreferenceStore,
	type ListenerPreferences,
	validateListenerPreferences,
} from "./listener-config.js";
import type {
	DshControlMcpListener,
	ListenerStatus,
} from "./listener-contract.js";
import { registerTools, type ToolCallGate } from "./tools/registry.js";

export class LanMcpListener implements DshControlMcpListener {
	private readonly preferences: ListenerPreferenceStore;
	private server: Server | null = null;
	private route: ReturnType<typeof createHttpRoute> | null = null;
	private current: ListenerPreferences = {
		...DEFAULT_LISTENER_PREFERENCES,
	};
	private lastError: ListenerStatus["error"] = null;

	constructor(
		private readonly ctx: DshHostContext,
		private readonly auth: AuthService,
		private readonly toolCallGate: ToolCallGate,
	) {
		this.preferences = new ListenerPreferenceStore(ctx.credentials);
	}

	async start(): Promise<void> {
		const saved = await this.preferences.get();
		await this.reconfigure(saved);
	}

	async setPreferences(input: ListenerPreferences): Promise<ListenerStatus> {
		const preferences = validateListenerPreferences(input);
		await this.preferences.set(preferences);
		await this.reconfigure(preferences);
		return this.getStatus();
	}

	async getPreferences(): Promise<ListenerPreferences> {
		return this.preferences.get();
	}

	getStatus(): ListenerStatus {
		const listening = this.server?.listening === true;
		return {
			state: listening
				? "listening"
				: this.current.enabled
					? "error"
					: "disabled",
			preferences: { ...this.current },
			url: listening
				? `http://${this.current.host}:${this.current.port}${MCP_PATH}`
				: null,
			availableAddresses: this.availableAddresses(),
			error: this.lastError,
		};
	}

	async close(): Promise<void> {
		await this.closeActive();
	}

	private async reconfigure(requested: ListenerPreferences): Promise<void> {
		await this.closeActive();
		this.lastError = null;
		if (!requested.enabled) {
			this.current = requested;
			return;
		}
		if (!this.availableAddresses().includes(requested.host)) {
			this.lastError = "address-not-available";
			await this.bindSafeFallback(requested);
			return;
		}
		try {
			await this.bind(requested);
			this.current = requested;
		} catch {
			this.lastError = "port-unavailable";
			await this.bindSafeFallback(requested);
		}
	}

	private async bindSafeFallback(
		requested: ListenerPreferences,
	): Promise<void> {
		const fallback: ListenerPreferences = {
			...requested,
			host: "127.0.0.1",
			requireBearer: true,
		};
		try {
			await this.bind(fallback);
			this.current = fallback;
			await this.preferences.set(fallback);
		} catch {
			this.current = { ...fallback, enabled: false };
		}
	}

	private async bind(preferences: ListenerPreferences): Promise<void> {
		const route = createHttpRoute({
			port: () => preferences.port,
			auth: this.auth,
			access: {
				bindAddress: preferences.host,
				requireBearer: preferences.requireBearer,
			},
			registerTools: (server, principal) =>
				registerTools(
					server,
					this.ctx,
					principal,
					this.auth,
					this.toolCallGate,
				),
		});
		const server = createServer((req, res) => {
			if (req.url !== MCP_PATH) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end('{"error":"Not found"}');
				return;
			}
			void route.handler(req, res);
		});
		this.route = route;
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = () => {
					server.off("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(preferences.port, preferences.host);
			});
		} catch (error) {
			this.route = null;
			this.server = null;
			await route.dispose();
			throw error;
		}
	}

	private async closeActive(): Promise<void> {
		const route = this.route;
		const server = this.server;
		this.route = null;
		this.server = null;
		if (route) await route.dispose();
		if (server?.listening) {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		}
	}

	private availableAddresses(): string[] {
		const addresses = ["127.0.0.1"];
		for (const entries of Object.values(networkInterfaces())) {
			for (const entry of entries ?? []) {
				if (
					entry.family === "IPv4" &&
					!entry.internal &&
					isPrivateIPv4(entry.address)
				)
					addresses.push(entry.address);
			}
		}
		return [...new Set(addresses)];
	}
}
