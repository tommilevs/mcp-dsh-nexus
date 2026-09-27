import { randomUUID } from "node:crypto";
import type { ToolServices } from "./registry.js";
import {
	boundedInteger,
	boundedSignal,
	type JsonSchema,
	nextWithSignal,
	stringInput,
} from "./registry.js";
import type { SessionEvent, SessionEventEntry } from "./sessions.js";

const CREATE_CHAT: JsonSchema = {
	type: "object",
	properties: { workspaceId: { type: "string", minLength: 1, maxLength: 128 } },
	additionalProperties: false,
};
const SEND_MESSAGE: JsonSchema = {
	type: "object",
	properties: {
		sessionId: { type: "string", minLength: 1, maxLength: 256 },
		text: { type: "string", minLength: 1, maxLength: 32000 },
	},
	required: ["sessionId", "text"],
	additionalProperties: false,
};
const MAX_RUN_WAIT_SECONDS = 55;
const WAIT_RUN: JsonSchema = {
	type: "object",
	properties: {
		sessionId: { type: "string", minLength: 1, maxLength: 256 },
		requestId: { type: "string", minLength: 1, maxLength: 128 },
		timeoutSeconds: {
			type: "integer",
			minimum: 1,
			maximum: MAX_RUN_WAIT_SECONDS,
		},
	},
	required: ["sessionId", "requestId"],
	additionalProperties: false,
};

interface WorkspaceItem {
	workspaceId: string;
	path: string;
	title: string;
	sessionIds: readonly string[];
}
interface WorkspaceFrame {
	type: string;
	value?: { items: readonly WorkspaceItem[] };
}
interface ChatSessionApi {
	create(request: { workspaceId?: string }): Promise<{ sessionId: string }>;
	prompt(
		request: {
			requestId: string;
			sessionId: string;
			mode: "queue";
			content: Array<{ type: "text"; text: string }>;
		},
		signal: AbortSignal,
	): Promise<{ accepted: true }>;
	cancel(request: { sessionId: string }): { accepted: true };
	follow(
		request: {
			address: { kind: "session"; sessionId: string };
			maxMessages?: number;
		},
		signal: AbortSignal,
	): AsyncIterable<{
		type: "snapshot" | "event" | "assistant-stream";
		cursor?: number;
		records?: SessionEventEntry[];
		event?: SessionEvent;
	}>;
	page(
		request: {
			address: { kind: "session"; sessionId: string };
			throughSeq: number;
			beforeSeq?: number;
			maxMessages: number;
		},
		signal: AbortSignal,
	): Promise<{ records: SessionEventEntry[]; hasMore: boolean }>;
}

/** Create, send, wait, and cancel operations are restricted to token-visible sessions. */
export function registerChatTools(services: ToolServices): void {
	const controller = services.ctx
		.sessionController as unknown as ChatSessionApi;
	services.register(
		"dsh_create_chat",
		"chat:create",
		"Create a DSH chat in the current default workspace, or in a listed workspace. It uses DSH's current default model. Model selection is intentionally excluded because DSH's session API also changes the global default model.",
		CREATE_CHAT,
		async (input, signal) => {
			const workspaceId =
				input.workspaceId === undefined
					? undefined
					: stringInput(input, "workspaceId", 128);
			if (workspaceId !== undefined) {
				await services.auth.authorizeTool(
					services.principal,
					"dsh_list_workspaces",
				);
				const iterator = services.ctx.workspaceController
					.follow(signal)
					[Symbol.asyncIterator]();
				try {
					const first = await nextWithSignal(iterator, signal);
					if (
						first === undefined ||
						first.done ||
						first.value.type !== "baseline" ||
						!(first.value as WorkspaceFrame).value?.items.some(
							(item) => item.workspaceId === workspaceId,
						)
					)
						throw new Error("Workspace unavailable");
				} finally {
					await iterator.return?.();
				}
			}
			signal.throwIfAborted();
			const created = await controller.create(
				workspaceId === undefined ? {} : { workspaceId },
			);
			// Persist before disclosing the opaque ID; no response is returned if this fails.
			await services.auth.recordOwnedSession(
				services.principal.id,
				created.sessionId,
			);
			services.localOwnedSessions.add(created.sessionId);
			return {
				sessionId: created.sessionId,
				...(workspaceId ? { workspaceId } : {}),
			};
		},
	);

	services.register(
		"dsh_send_message",
		"chat:send",
		"Queue plain text in a session visible to this token. Returns a requestId for dsh_wait_run.",
		SEND_MESSAGE,
		async (input, signal) => {
			const sessionId = stringInput(input, "sessionId", 256);
			const text = stringInput(input, "text", 32000);
			if (!text.trim()) throw new Error("Empty message");
			const requestId = randomUUID();
			const admission = await controller.prompt(
				{
					requestId,
					sessionId,
					mode: "queue",
					content: [{ type: "text", text }],
				},
				signal,
			);
			if (!admission.accepted) throw new Error("Prompt was not accepted");
			return { accepted: true, requestId, sessionId };
		},
		(input) =>
			typeof input.sessionId === "string" ? input.sessionId : undefined,
	);

	services.register(
		"dsh_wait_run",
		"sessions:follow",
		"Wait for the durable turn corresponding to a dsh_send_message requestId. Completion is determined only from its matching turn/end event, never an assistant-stream frame.",
		WAIT_RUN,
		async (input, callerSignal) => {
			const sessionId = stringInput(input, "sessionId", 256);
			const requestId = stringInput(input, "requestId", 128);
			const timeoutSeconds = boundedInteger(
				input,
				"timeoutSeconds",
				MAX_RUN_WAIT_SECONDS,
				MAX_RUN_WAIT_SECONDS,
			);
			const deadline = boundedSignal(callerSignal, timeoutSeconds * 1000);
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
				const cursor = first.value.cursor;
				if (typeof cursor !== "number" || !Number.isSafeInteger(cursor))
					throw new Error("Invalid Session cursor");

				const historical: SessionEvent[] = [];
				let beforeSeq: number | undefined;
				let inspectedMessages = 0;
				let hasMoreHistory = true;
				while (hasMoreHistory && inspectedMessages < 200) {
					const pageLimit = Math.min(50, 200 - inspectedMessages);
					const page = await controller.page(
						{
							address: { kind: "session", sessionId },
							throughSeq: cursor,
							...(beforeSeq === undefined ? {} : { beforeSeq }),
							maxMessages: pageLimit,
						},
						deadline.signal,
					);
					deadline.signal.throwIfAborted();
					historical.unshift(...page.records.map((record) => record.event));
					inspectedMessages += page.records.filter(
						(record) =>
							record.event.type === "user/message" ||
							record.event.type === "assistant/message",
					).length;
					hasMoreHistory = page.hasMore && page.records.length > 0;
					beforeSeq = page.records[0]?.event.seq;
				}

				const tracker = createRunTracker(requestId);
				for (const event of historical) {
					const result = tracker.accept(event);
					if (result) return { sessionId, requestId, ...result };
				}

				while (!deadline.signal.aborted) {
					const next = await nextWithSignal(iterator, deadline.signal);
					if (next === undefined || next.done) break;
					// SessionController.follow emits durable events separately from optional model-attempt frames.
					if (next.value.type !== "event" || !next.value.event) continue;
					const result = tracker.accept(next.value.event);
					if (result) return { sessionId, requestId, ...result };
				}
				if (callerSignal.aborted) throw new Error("Cancelled");
				return {
					sessionId,
					requestId,
					status: deadline.timedOut() ? "timeout" : "ended",
					...(tracker.turn === undefined ? {} : { turn: tracker.turn }),
				};
			} finally {
				deadline.dispose();
				await iterator.return?.();
			}
		},
		(input) =>
			typeof input.sessionId === "string" ? input.sessionId : undefined,
	);

	services.register(
		"dsh_cancel_run",
		"chat:cancel",
		"Request cancellation of the active turn for a session visible to this token.",
		{
			type: "object",
			properties: {
				sessionId: { type: "string", minLength: 1, maxLength: 256 },
			},
			required: ["sessionId"],
			additionalProperties: false,
		},
		async (input) => {
			const sessionId = stringInput(input, "sessionId", 256);
			const result = await controller.cancel({ sessionId });
			return { accepted: result.accepted === true, sessionId };
		},
		(input) =>
			typeof input.sessionId === "string" ? input.sessionId : undefined,
	);
}

function createRunTracker(requestId: string) {
	let userMessageSeq: number | undefined;
	let activeTurn: number | undefined;
	let requestTurn: number | undefined;
	return {
		get turn() {
			return requestTurn;
		},
		accept(
			event: SessionEvent,
		): { status: string; turn: number; reason?: unknown } | undefined {
			const data = asRecord(event.data);
			if (event.type === "turn/start" && typeof data.turn === "number") {
				activeTurn = data.turn;
				return;
			}
			if (event.type === "user/message" && userMessageSeq === undefined) {
				const source = asRecord(data.source);
				if (source.kind === "user" && source.rpcId === requestId) {
					userMessageSeq = event.seq;
					requestTurn = activeTurn;
				}
				return;
			}
			if (
				event.type !== "turn/end" ||
				typeof data.turn !== "number" ||
				data.turn !== activeTurn
			)
				return;
			activeTurn = undefined;
			if (
				userMessageSeq === undefined ||
				requestTurn === undefined ||
				event.seq <= userMessageSeq ||
				data.turn !== requestTurn
			)
				return;
			const reason = asRecord(data.reason);
			return {
				status: typeof reason.kind === "string" ? reason.kind : "unknown",
				turn: requestTurn,
				...(typeof reason.kind === "string" ? { reason: reason.kind } : {}),
			};
		},
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
