import { randomUUID } from "node:crypto";

export interface SessionResource {
	close(): Promise<void>;
}
interface Entry {
	principalId: string;
	resource: SessionResource;
	timer: ReturnType<typeof setTimeout>;
}
/** Reservations happen before any await, including SDK initialization. */
export class McpSessionRegistry {
	private readonly entries = new Map<string, Entry>();
	private readonly calls = new Map<string, number>();
	private totalCalls = 0;
	private disposed = false;
	get size(): number {
		return this.entries.size;
	}
	reserve(
		principalId: string,
		resource: SessionResource,
		id: string = randomUUID(),
	): string {
		if (this.disposed) throw new Error("Service unavailable");
		if (
			this.entries.size >= 16 ||
			[...this.entries.values()].filter(
				(entry) => entry.principalId === principalId,
			).length >= 4
		)
			throw new Error("Too many requests");
		if (this.entries.has(id)) throw new Error("Session collision");
		const timer = setTimeout(() => {
			void this.close(id).catch(() => {});
		}, 120000);
		timer.unref();
		this.entries.set(id, { principalId, resource, timer });
		return id;
	}
	get(id: string, principalId: string): SessionResource {
		const entry = this.entries.get(id);
		if (!entry) throw new Error("Session not found");
		if (entry.principalId !== principalId) throw new Error("Forbidden");
		return entry.resource;
	}
	touch(id: string): void {
		this.entries.get(id)?.timer.refresh();
	}
	reserveCall(principalId: string): () => void {
		if (this.disposed) throw new Error("Service unavailable");
		const count = this.calls.get(principalId) ?? 0;
		if (count >= 2 || this.totalCalls >= 8)
			throw new Error("Too many requests");
		this.calls.set(principalId, count + 1);
		this.totalCalls++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (this.calls.get(principalId) ?? 1) - 1;
			if (remaining) this.calls.set(principalId, remaining);
			else this.calls.delete(principalId);
			this.totalCalls--;
		};
	}
	async close(id: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.entries.delete(id);
		clearTimeout(entry.timer);
		await entry.resource.close();
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		await Promise.allSettled(
			[...this.entries.keys()].map((id) => this.close(id)),
		);
	}
}
