// Production wiring for the api/ functions.

import type { Deps } from "./handlers.js";
import { judgeFromEnv } from "./judge.js";
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
    const deps: Deps = { store, now: () => new Date(), judge: judgeFromEnv() };
    const secret = process.env.DISCOVER_SECRET;
    if (secret) deps.discoverSecret = secret;
    return handler(request, deps);
  };
}
