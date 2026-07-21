// Secrets/vars aren't picked up by `wrangler types` (worker-configuration.d.ts
// is generated from wrangler.json bindings only), so declare them here
// instead of hand-editing the generated file.
declare global {
	interface Env {
		// Signs/verifies per-connection user auth tokens. Set via
		// `wrangler secret put REALTIME_TOKEN_SECRET`, matching the signer in
		// apps/business/lib/realtime/token.ts.
		REALTIME_TOKEN_SECRET: string;
		// Authenticates server-to-server calls: apps/business -> this Worker's
		// /deliver, and this Worker -> apps/business's
		// /api/internal/messages/check-delivery. Set via
		// `wrangler secret put REALTIME_SERVICE_SECRET`, matching
		// REALTIME_SERVICE_SECRET in apps/business's env.
		REALTIME_SERVICE_SECRET: string;
		// Base URL of apps/business, used for the offline-fallback alarm's
		// check-delivery callback (e.g. https://business.openbookings.co).
		APPS_BUSINESS_URL: string;
	}
}

export {};
