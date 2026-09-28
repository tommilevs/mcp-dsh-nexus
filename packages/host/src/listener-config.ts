import { isIP } from "node:net";
import type {
	CredentialProvider,
	CredentialRecord,
} from "@deepseek-ai/dsh-credentials";
import { credentialKey } from "@deepseek-ai/dsh-credentials";

export interface ListenerPreferences {
	enabled: boolean;
	host: string;
	port: number;
	requireBearer: boolean;
}

export interface ListenerPreferenceStoreApi {
	get(): Promise<ListenerPreferences>;
	set(input: ListenerPreferences): Promise<ListenerPreferences>;
}

export type ListenerCredentials = Pick<
	CredentialProvider,
	"readRecord" | "modifyRecord"
>;

export const DEFAULT_LISTENER_PREFERENCES: Readonly<ListenerPreferences> = {
	enabled: true,
	host: "127.0.0.1",
	port: 43121,
	requireBearer: true,
};

const preferencesKey = credentialKey("dsh-control-mcp", "listener-settings");

export function isPrivateIPv4(address: string): boolean {
	if (isIP(address) !== 4) return false;
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((part) => part < 0 || part > 255))
		return false;
	const [a, b] = octets;
	return (
		a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
	);
}

export function isLoopbackIPv4(address: string): boolean {
	return isIP(address) === 4 && address.split(".")[0] === "127";
}

export function validateListenerPreferences(
	input: unknown,
): ListenerPreferences {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Invalid listener preferences");
	const value = input as Partial<ListenerPreferences>;
	if (
		typeof value.enabled !== "boolean" ||
		typeof value.host !== "string" ||
		!(isLoopbackIPv4(value.host) || isPrivateIPv4(value.host)) ||
		!Number.isInteger(value.port) ||
		(value.port as number) < 1024 ||
		(value.port as number) > 65535 ||
		typeof value.requireBearer !== "boolean" ||
		(!value.requireBearer && !isLoopbackIPv4(value.host))
	)
		throw new Error("Invalid listener preferences");
	return {
		enabled: value.enabled,
		host: value.host,
		port: value.port as number,
		requireBearer: value.requireBearer,
	};
}

function readPayload(record: CredentialRecord | undefined): unknown {
	if (record?.kind !== "grant") return undefined;
	return record.payload;
}

export class ListenerPreferenceStore implements ListenerPreferenceStoreApi {
	constructor(private readonly credentials: ListenerCredentials) {}

	async get(): Promise<ListenerPreferences> {
		try {
			const saved = readPayload(
				await this.credentials.readRecord(preferencesKey),
			);
			return saved === undefined
				? { ...DEFAULT_LISTENER_PREFERENCES }
				: validateListenerPreferences(saved);
		} catch {
			return { ...DEFAULT_LISTENER_PREFERENCES };
		}
	}

	async set(input: ListenerPreferences): Promise<ListenerPreferences> {
		const preferences = validateListenerPreferences(input);
		await this.credentials.modifyRecord(preferencesKey, async () => ({
			kind: "grant",
			payload: preferences,
		}));
		return preferences;
	}
}
