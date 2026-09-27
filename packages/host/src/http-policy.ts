import type { IncomingMessage } from "node:http";
import type { TokenPrincipal } from "./index.js";
import type { RequestLimiter } from "./rate-limiter.js";
export const MAX_BODY_BYTES = 64 * 1024;
export function assertBodySize(size: number): void {
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BODY_BYTES)
		throw new Error("Request body too large");
}
export function assertHttpPolicy(req: IncomingMessage, port: number): void {
	if (
		!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
			req.socket.remoteAddress ?? "",
		)
	)
		throw new Error("Forbidden");
	const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
	if (typeof req.headers.host !== "string" || !hosts.includes(req.headers.host))
		throw new Error("Forbidden");
	if (
		Object.keys(req.headers).some(
			(name) =>
				name.toLowerCase() === "forwarded" ||
				name.toLowerCase().startsWith("x-forwarded-"),
		)
	)
		throw new Error("Forbidden");
	for (const name of ["host", "origin", "content-length"])
		if (
			req.rawHeaders?.filter(
				(value, index) => index % 2 === 0 && value.toLowerCase() === name,
			).length > 1
		)
			throw new Error("Forbidden");
	const origin = req.headers.origin;
	if (
		origin !== undefined &&
		(typeof origin !== "string" ||
			!hosts.map((host) => `http://${host}`).includes(origin))
	)
		throw new Error("Forbidden");
	const length = req.headers["content-length"];
	if (length !== undefined) {
		if (typeof length !== "string" || !/^\d+$/.test(length))
			throw new Error("Invalid content length");
		assertBodySize(Number(length));
	}
}
/** Must run before scope checks, MCP parsing, or SDK transport dispatch. */
export async function admitRequest(
	req: IncomingMessage,
	port: number,
	auth: { resolvePrincipal(req: IncomingMessage): Promise<TokenPrincipal> },
	limiter: RequestLimiter,
): Promise<TokenPrincipal> {
	assertHttpPolicy(req, port);
	const release = limiter.reserveUnauthenticated();
	let principal: TokenPrincipal;
	try {
		principal = await auth.resolvePrincipal(req);
	} finally {
		release();
	}
	limiter.admit(principal.id);
	return principal;
}
