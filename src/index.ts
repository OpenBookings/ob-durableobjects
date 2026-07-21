import { DurableObject } from "cloudflare:workers";

// How long to wait after a message arrives with no active socket before
// asking apps/business whether the recipient has since read it (and, if
// not, to send the fallback email). Kept as a constant for now; revisit if
// product wants this tunable per-thread or per-user.
const OFFLINE_FALLBACK_DELAY_MS = 5 * 60 * 1000;

type PendingDelivery = {
	messageId: string;
	threadId: string;
	recipientId: string;
	deadline: number;
};

/**
 * One instance per OpenBookings user, keyed by their Better Auth user id.
 * Holds that user's open WebSocket connection(s) for real-time thread
 * messaging, replacing the old SSE + Postgres LISTEN/NOTIFY transport.
 */
export class UserThreadDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected websocket upgrade", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		// Hibernatable API: the runtime can evict this DO from memory between
		// messages and restore it on the next event, so an idle connection
		// doesn't keep the DO (or its socket) resident the whole time.
		this.ctx.acceptWebSocket(server);

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {
		// Clients don't send app-level messages yet — delivery is push-only
		// from the DO. Ping/pong keepalive is handled by the runtime.
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean) {
		ws.close(code, reason);
	}

	async webSocketError(_ws: WebSocket, _error: unknown) {
		// No-op: the runtime cleans up the socket; nothing to persist yet.
	}

	/**
	 * RPC entry point (called via the DO stub, not over fetch) used by the
	 * top-level Worker's /deliver route. Pushes to any open socket for this
	 * user; if none is open, schedules the offline-fallback alarm instead.
	 */
	async deliver(recipientId: string, threadId: string, message: { id: string }): Promise<void> {
		const sockets = this.ctx.getWebSockets();
		if (sockets.length > 0) {
			const payload = JSON.stringify({ type: "message", message });
			for (const ws of sockets) {
				ws.send(payload);
			}
			return;
		}

		await this.scheduleOfflineFallback({ messageId: message.id, threadId, recipientId });
	}

	private async scheduleOfflineFallback(
		entry: Omit<PendingDelivery, "deadline">,
	): Promise<void> {
		const deadline = Date.now() + OFFLINE_FALLBACK_DELAY_MS;
		await this.ctx.storage.put<PendingDelivery>(`pending:${entry.messageId}`, {
			...entry,
			deadline,
		});

		const currentAlarm = await this.ctx.storage.getAlarm();
		if (currentAlarm === null || deadline < currentAlarm) {
			await this.ctx.storage.setAlarm(deadline);
		}
	}

	/**
	 * Fires at the earliest pending deadline. Only processes entries that are
	 * actually due — anything scheduled later (a message that arrived after
	 * an earlier one, so shares this alarm invocation but has its own later
	 * deadline) is left in storage and the alarm is rescheduled for it.
	 */
	async alarm(): Promise<void> {
		const now = Date.now();
		const pending = await this.ctx.storage.list<PendingDelivery>({ prefix: "pending:" });

		const due: PendingDelivery[] = [];
		let nextDeadline: number | null = null;

		for (const [key, entry] of pending) {
			if (entry.deadline <= now) {
				due.push(entry);
				await this.ctx.storage.delete(key);
			} else if (nextDeadline === null || entry.deadline < nextDeadline) {
				nextDeadline = entry.deadline;
			}
		}

		if (due.length > 0) {
			await this.notifyCheckDelivery(due);
		}
		if (nextDeadline !== null) {
			await this.ctx.storage.setAlarm(nextDeadline);
		}
	}

	private async notifyCheckDelivery(entries: PendingDelivery[]): Promise<void> {
		try {
			const res = await fetch(`${this.env.APPS_BUSINESS_URL}/api/internal/messages/check-delivery`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.env.REALTIME_SERVICE_SECRET}`,
				},
				body: JSON.stringify({
					messages: entries.map(({ messageId, threadId, recipientId }) => ({
						messageId,
						threadId,
						recipientId,
					})),
				}),
			});
			if (!res.ok) {
				console.error(`check-delivery callback failed: ${res.status}`);
			}
		} catch (err) {
			console.error("check-delivery callback request failed", err);
		}
	}
}

/**
 * Verifies a short-lived token minted by apps/business's
 * POST /api/realtime/token (see apps/business/lib/realtime/token.ts for the
 * matching signer). Token shape: `${userId}.${expiresAtMs}.${signature}`,
 * signature = base64url(HMAC-SHA256(secret, `${userId}.${expiresAtMs}`)).
 *
 * Verified here in the top-level Worker fetch handler, not inside the DO,
 * so the DO never has to trust a client-supplied userId — the id it's
 * addressed by is the one this function returns after verifying the
 * signature.
 */
async function verifyToken(token: string, secret: string): Promise<string | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [userId, expiresAtStr, signature] = parts;
	if (!userId || !signature) return null;

	const expiresAt = Number(expiresAtStr);
	if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;

	let signatureBytes: Uint8Array;
	try {
		signatureBytes = base64UrlToBytes(signature);
	} catch {
		return null;
	}

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);

	const valid = await crypto.subtle.verify(
		"HMAC",
		key,
		signatureBytes,
		new TextEncoder().encode(`${userId}.${expiresAtStr}`),
	);

	return valid ? userId : null;
}

function base64UrlToBytes(base64Url: string): Uint8Array {
	const base64 = base64Url
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Constant-time comparison for the server-to-server shared secret. */
function timingSafeEqual(a: string, b: string): boolean {
	const aBytes = new TextEncoder().encode(a);
	const bBytes = new TextEncoder().encode(b);
	if (aBytes.length !== bBytes.length) return false;
	let diff = 0;
	for (let i = 0; i < aBytes.length; i++) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	return diff === 0;
}

function isAuthorizedService(request: Request, env: Env): boolean {
	const header = request.headers.get("Authorization") ?? "";
	const expected = `Bearer ${env.REALTIME_SERVICE_SECRET}`;
	return timingSafeEqual(header, expected);
}

type DeliverRequestBody = {
	recipientId?: unknown;
	threadId?: unknown;
	message?: unknown;
};

/**
 * `.jurisdiction("eu")` isn't supported by the local `wrangler dev`
 * (miniflare) simulator as of wrangler 4.88 — it throws on every call,
 * which would make local dev/testing impossible. Real deployments always
 * get the EU-pinned namespace; local dev silently falls back to the
 * unscoped one, since there's no real data-residency concern for a
 * throwaway local DO instance.
 */
function getUserNamespace(env: Env): DurableObjectNamespace<UserThreadDO> {
	try {
		return env.USER_THREAD_DO.jurisdiction("eu");
	} catch {
		return env.USER_THREAD_DO;
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/connect") {
			const token = url.searchParams.get("token");
			if (!token) return new Response("Missing token", { status: 401 });

			const userId = await verifyToken(token, env.REALTIME_TOKEN_SECRET);
			if (!userId) return new Response("Invalid or expired token", { status: 401 });

			// Jurisdiction pinning: every access to a given user's DO must go
			// through this same jurisdiction-scoped namespace, or the runtime
			// will treat it as a different (non-EU) instance.
			const namespace = getUserNamespace(env);
			const id = namespace.idFromName(userId);
			const stub = namespace.get(id);
			return stub.fetch(request);
		}

		if (url.pathname === "/deliver" && request.method === "POST") {
			if (!isAuthorizedService(request, env)) {
				return new Response("Unauthorized", { status: 401 });
			}

			let body: DeliverRequestBody;
			try {
				body = await request.json();
			} catch {
				return new Response("Invalid JSON", { status: 400 });
			}

			const { recipientId, threadId, message } = body;
			if (
				typeof recipientId !== "string" ||
				typeof threadId !== "string" ||
				typeof message !== "object" ||
				message === null ||
				typeof (message as { id?: unknown }).id !== "string"
			) {
				return new Response("Invalid payload", { status: 400 });
			}

			const namespace = getUserNamespace(env);
			const id = namespace.idFromName(recipientId);
			const stub = namespace.get(id);
			await stub.deliver(recipientId, threadId, message as { id: string });
			return new Response(null, { status: 202 });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
