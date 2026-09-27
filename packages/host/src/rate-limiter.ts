import { performance } from "node:perf_hooks";
/** Sliding window storage never exceeds 600 accepted requests / active principals. */
export class RequestLimiter {
	private readonly requests: { id: string; time: number }[] = [];
	private lookupsInFlight = 0;
	/** Reserve synchronously before credential lookup; release on every outcome. */
	reserveUnauthenticated(): () => void {
		if (this.lookupsInFlight >= 16) throw new Error("Too many requests");
		this.lookupsInFlight++;
		let released = false;
		return () => {
			if (!released) {
				released = true;
				this.lookupsInFlight--;
			}
		};
	}
	private readonly counts = new Map<string, number>();
	constructor(private readonly clock: () => number = () => performance.now()) {}
	get principalCount(): number {
		return this.counts.size;
	}
	admit(id: string): void {
		const now = this.clock();
		while (this.requests.length && this.requests[0].time <= now - 60000) {
			const request = this.requests[0];
			this.requests.shift();
			const count = (this.counts.get(request.id) ?? 1) - 1;
			if (count) this.counts.set(request.id, count);
			else this.counts.delete(request.id);
		}
		const count = this.counts.get(id) ?? 0;
		if (count >= 120 || this.requests.length >= 600)
			throw new Error("Too many requests");
		this.requests.push({ id, time: now });
		this.counts.set(id, count + 1);
	}
}
