// Production wiring for the api/ functions.

import type { Deps } from "./handlers.js";
import { storeFromEnv } from "./store.js";

const notConfigured = (): Response =>
  new Response(
    JSON.stringify({ error: "The campus-connect server has no storage configured yet." }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );

/** Runs a handler with the Upstash store from env, or returns 503 if it is not set up. */
export function withProductionDeps(
  handler: (request: Request, deps: Deps) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const store = storeFromEnv();
    if (store === null) return notConfigured();
    return handler(request, { store, now: () => new Date() });
  };
}
