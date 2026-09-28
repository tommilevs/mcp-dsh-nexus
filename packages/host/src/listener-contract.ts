import type { ListenerPreferences } from "./listener-config.js";

export interface ListenerStatus {
	state: "listening" | "disabled" | "error";
	preferences: ListenerPreferences;
	url: string | null;
	availableAddresses: string[];
	error: "address-not-available" | "port-unavailable" | null;
}

export interface DshControlMcpListener {
	getPreferences(): Promise<ListenerPreferences>;
	setPreferences(input: ListenerPreferences): Promise<ListenerStatus>;
	getStatus(): ListenerStatus;
}
