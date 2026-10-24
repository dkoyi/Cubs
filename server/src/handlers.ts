// HTTP handlers using Web-standard Request/Response. The api/ files wire these
// to the production store; tests call them directly with an InMemoryStore.

import {
  authorize,
  deleteStudent,
  listMatches,
  listRequests,
  matchView,
  requestView,
  respond,
  tryMatch,
  upsertRequest,
} from "./service.js";
import type { MatchView, RequestView } from "./service.js";
import type { Store } from "./store.js";
import { isToken, isUuid, parseJoin, parseRespond } from "./validate.js";

export interface Deps {
  store: Store;
  now: () => Date;
}

const MAX_BODY_BYTES = 16 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const error = (status: number, message: string): Response => json(status, { error: message });

/** Returns the student id, or an error Response. */
async function authenticate(request: Request, store: Store): Promise<string | Response> {
  const sid = request.headers.get("x-student-id")?.trim().toLowerCase() ?? "";
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!isUuid(sid)) return error(400, "Missing or invalid X-Student-Id header.");
  if (!isToken(token)) return error(401, "Missing or invalid Authorization: Bearer token.");
  if (!(await authorize(store, sid, token))) {
    return error(401, "This token does not match the one first used with this student id.");
  }
  return sid;
}

/** Returns the parsed JSON body, or an error Response. */
async function readJson(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return error(413, "Request body is too large.");
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return error(400, "Request body must be valid JSON.");
  }
}

async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    // Log only the message: errors here never carry request bodies or contact info.
    console.error("campus-connect error:", e instanceof Error ? e.message : "unknown error");
    return error(500, "Something went wrong on the campus-connect server. Try again later.");
  }
}

/** POST /api/requests */
export function handleJoin(request: Request, deps: Deps): Promise<Response> {
  return guarded(async () => {
    const sid = await authenticate(request, deps.store);
    if (sid instanceof Response) return sid;
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const now = deps.now();
    const input = parseJoin(body, now);
    if (!input.ok) return error(400, input.error);

    const { request: req, updated } = await upsertRequest(deps.store, sid, input.value, now);
    const m = await tryMatch(deps.store, req, now);
    const match = m === null ? null : await matchView(deps.store, m, sid, now);
    const fresh = m === null ? req : { ...req, match_id: m.id };
    return json(200, { request: await requestView(deps.store, fresh, now), match, updated });
  });
}

/** GET /api/matches. Also retries matching for the student's open requests. */
export function handleMatches(request: Request, deps: Deps): Promise<Response> {
  return guarded(async () => {
    const sid = await authenticate(request, deps.store);
    if (sid instanceof Response) return sid;
    const now = deps.now();

    const requests = await listRequests(deps.store, sid);
    for (const req of requests) await tryMatch(deps.store, req, now);

    const matches: MatchView[] = [];
    for (const m of await listMatches(deps.store, sid)) {
      const view = await matchView(deps.store, m, sid, now);
      if (view !== null) matches.push(view);
    }
    matches.sort((a, b) => a.time.start.localeCompare(b.time.start));

    const views: RequestView[] = [];
    for (const req of await listRequests(deps.store, sid)) {
      views.push(await requestView(deps.store, req, now));
    }
    return json(200, { requests: views, matches });
  });
}

/** POST /api/respond with {match_id, accept} */
export function handleRespond(request: Request, deps: Deps): Promise<Response> {
  return guarded(async () => {
    const sid = await authenticate(request, deps.store);
    if (sid instanceof Response) return sid;
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const input = parseRespond(body);
    if (!input.ok) return error(400, input.error);
    const now = deps.now();

    const outcome = await respond(deps.store, sid, input.value.match_id, input.value.accept, now);
    if (outcome.kind === "not_found") return error(404, "No match with that id for this student.");
    if (outcome.kind === "closed") {
      return json(409, { error: `This match is already ${outcome.status}.`, status: outcome.status });
    }
    const view = await matchView(deps.store, outcome.match, sid, now);
    if (view === null) return error(410, "The other student is no longer in the pool.");
    return json(200, { match: view });
  });
}

/** DELETE /api/me */
export function handleLeave(request: Request, deps: Deps): Promise<Response> {
  return guarded(async () => {
    const sid = await authenticate(request, deps.store);
    if (sid instanceof Response) return sid;
    await deleteStudent(deps.store, sid);
    return json(200, { deleted: true });
  });
}
