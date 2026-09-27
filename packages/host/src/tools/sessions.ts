import type { ToolServices } from "./registry.js";
import {
	boundedInteger,
	boundedSignal,
	canAccessSession,
	type JsonSchema,
	nextWithSignal,
	stringInput,
} from "./registry.js";

const READ_SESSION: JsonSchema = {
	type: "object",
	properties: {
		sessionId: { type: "string", minLength: 1, maxLength: 256 },
		limit: { type: "integer", minimum: 1, maximum: 200 },
	},
	required: ["sessionId"],
	additionalProperties: false,
};
const MAX_SESSION_FOLLOW_SECONDS = 55;
const FOLLOW_SESSION: JsonSchema = {
	type: "object",
	properties: {
		sessionId: { type: "string", minLength: 1, maxLength: 256 },
		timeoutSeconds: {
			type: "integer",
			minimum: 1,
			maximum: MAX_SESSION_FOLLOW_SECONDS,
		},
		maxMessages: { type: "integer", minimum: 1, maximum: 50 },
	},
	required: ["sessionId"],
	additionalProperties: false,
};

interface SessionSummary {
	sessionId: string;
	updatedAt: number;
	running: boolean;
	blank: boolean;
	agentAvailable: boolean;
	projections?: {
		values: {
			title?: string | null;
			modelSelection?: {
				lastUsed: { provider: string; model: string } | null;
				next: { provider: string; model: string } | null;
			};
			agentPreset?: string | null;
		};
	};
}
export interface SessionEvent {
	type: string;
	seq: number;
	time: number;
	data: unknown;
}
export interface SessionEventEntry {
	type: "event";
	event: SessionEvent;
}
interface SessionSnapshot {
	type: "snapshot";
	cursor: number;
	records: SessionEventEntry[];
	hasMore: boolean;
}
interface SessionFollowFrame {
	type: "snapshot" | "event" | "assistant-stream";
	cursor?: number;
	records?: SessionEventEntry[];
	event?: SessionEvent;
}
interface SessionApi {
	list(
		request: { cursor?: string },
		signal: AbortSignal,
	): Promise<{ items: SessionSummary[] }>;
	follow(
		request: {
			address: { kind: "session"; sessionId: string };
			maxMessages?: number;
		},
		signal: AbortSignal,
	): AsyncIterable<SessionFollowFrame>;
	page(
		request: {
			address: { kind: "session"; sessionId: string };
			throughSeq: number;
			maxMessages: number;
		},
		signal: AbortSignal,
	): Promise<{ records: SessionEventEntry[]; hasMore: boolean }>;
}

/** Register visible-session list/read/follow operations with strict per-token filtering. */
export function registerSessionTools(services: ToolServices): void {
	const controller = services.ctx.sessionController as unknown as SessionApi;
	services.register(
		"dsh_list_sessions",
		"sessions:list",
		"List sessions visible to this token. At most 100 summaries are returned.",
		{
			type: "object",
			properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
			additionalProperties: false,
		},
		async (input, signal) => {
			const limit = boundedInteger(input, "limit", 100, 100);
			const result = await controller.list({}, signal);
			signal.throwIfAborted();
			const visible = result.items.filter((item) =>
				canAccessSession(
					services.principal,
					services.localOwnedSessions,
					item.sessionId,
				),
			);
			const sessions = visible.slice(0, limit).map((item) => {
				const values = item.projections?.values;
				const selection =
					values?.modelSelection?.lastUsed ?? values?.modelSelection?.next;
				return {
					sessionId: item.sessionId,
					title: values?.title?.slice(0, 160) ?? null,
					updatedAt: item.updatedAt,
					running: item.running,
					blank: item.blank,
					agentAvailable: item.agentAvailable,
					...(values?.agentPreset
						? { agentPreset: values.agentPreset.slice(0, 128) }
						: {}),
					...(selection
						? {
								model: {
									provider: selection.provider.slice(0, 128),
									id: selection.model.slice(0, 256),
								},
							}
						: {}),
				};
			});
			return { sessions, hasMore: visible.length > sessions.length };
		},
	);

	services.register(
		"dsh_read_session",
		"sessions:read",
		"Read a bounded text-only page of messages from a session visible to this token.",
		READ_SESSION,
		async (input, callerSignal) => {
			const sessionId = stringInput(input, "sessionId", 256);
			const limit = boundedInteger(input, "limit", 50, 200);
			const deadline = boundedSignal(callerSignal, 60000);
			const iterator = controller
				.follow(
					{ address: { kind: "session", sessionId }, maxMessages: 1 },
					deadline.signal,
				)
				[Symbol.asyncIterator]();
			try {
				const first = await nextWithSignal(iterator, deadline.signal);
				if (
					first === undefined ||
					first.done ||
					first.value.type !== "snapshot"
				)
					throw new Error("Session snapshot unavailable");
				const snapshot = first.value as SessionSnapshot;
				const page = await controller.page(
					{
						address: { kind: "session", sessionId },
						throughSeq: snapshot.cursor,
						maxMessages: limit,
					},
					deadline.signal,
				);
				deadline.signal.throwIfAborted();
				const messages = projectMessages(page.records, 32000);
				return { sessionId, messages, hasMore: page.hasMore };
			} finally {
				deadline.dispose();
				await iterator.return?.();
			}
		},
		(input) =>
			typeof input.sessionId === "string" ? input.sessionId : undefined,
	);

	services.register(
		"dsh_follow_session",
		"sessions:follow",
		"Follow recent and new durable user/assistant messages for up to 55 seconds; assistant attempt-stream frames are omitted.",
		FOLLOW_SESSION,
		async (input, callerSignal) => {
			const sessionId = stringInput(input, "sessionId", 256);
			const timeoutSeconds = boundedInteger(
				input,
				"timeoutSeconds",
				15,
				MAX_SESSION_FOLLOW_SECONDS,
			);
			const maxMessages = boundedInteger(input, "maxMessages", 30, 50);
			const deadline = boundedSignal(callerSignal, timeoutSeconds * 1000);
			const iterator = controller
				.follow(
					{ address: { kind: "session", sessionId }, maxMessages },
					deadline.signal,
				)
				[Symbol.asyncIterator]();
			const records: SessionEventEntry[] = [];
			let cursor: number | undefined;
			let hasMore = false;
			try {
				while (records.length < maxMessages) {
					const next = await nextWithSignal(iterator, deadline.signal);
					if (next === undefined || next.done) break;
					const frame = next.value;
					if (frame.type === "snapshot") {
						cursor = frame.cursor;
						for (const entry of frame.records ?? []) {
							if (isMessageEvent(entry.event)) records.push(entry);
						}
					} else if (frame.type === "event" && frame.event) {
						cursor = frame.event.seq;
						if (isMessageEvent(frame.event))
							records.push({ type: "event", event: frame.event });
					}
					if (records.length >= maxMessages) {
						hasMore = true;
						break;
					}
				}
				if (callerSignal.aborted) throw new Error("Cancelled");
				return {
					sessionId,
					messages: projectMessages(records.slice(0, maxMessages), 32000),
					cursor: cursor ?? null,
					timedOut: deadline.timedOut(),
					hasMore,
				};
			} finally {
				deadline.dispose();
				await iterator.return?.();
			}
		},
		(input) =>
			typeof input.sessionId === "string" ? input.sessionId : undefined,
	);
}

export function isMessageEvent(event: SessionEvent): boolean {
	return event.type === "user/message" || event.type === "assistant/message";
}

export function projectMessages(
	records: readonly SessionEventEntry[],
	maximumText: number,
): Array<{
	seq: number;
	time: number;
	role: "user" | "assistant";
	text: string;
}> {
	const result: Array<{
		seq: number;
		time: number;
		role: "user" | "assistant";
		text: string;
	}> = [];
	let remaining = maximumText;
	for (const { event } of records) {
		if (!isMessageEvent(event) || remaining <= 0) continue;
		const data = record(event.data);
		const message = event.type === "user/message" ? data : record(data.message);
		const text = contentText(message.content, remaining);
		if (!text) continue;
		remaining -= text.length;
		result.push({
			seq: event.seq,
			time: event.time,
			role: event.type === "user/message" ? "user" : "assistant",
			text,
		});
	}
	return result;
}

function contentText(value: unknown, maximum: number): string {
	if (!Array.isArray(value)) return "";
	let output = "";
	for (const part of value) {
		if (typeof part !== "object" || part === null) continue;
		const item = part as { type?: unknown; text?: unknown };
		if (item.type !== "text" || typeof item.text !== "string") continue;
		const separator = output ? "\n" : "";
		const rest = maximum - output.length - separator.length;
		if (rest <= 0) break;
		output += separator + item.text.slice(0, rest);
	}
	return output;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
