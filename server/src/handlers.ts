// HTTP handlers using Web-standard Request/Response. The api/ files wire these
// to the production store; tests call them directly with an InMemoryStore.

import { createHash, timingSafeEqual } from "node:crypto";
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
import type { Judge } from "./judge.js";
import { acknowledgeDelivery, answerSuggestion, deleteLoopData, discoverAll, getContext, hasOpenSuggestion, pendingFor, previewSuggestion, putContext, runDiscovery } from "./loop.js";
import type { AnswerValue } from "./loop.js";
import type { Store } from "./store.js";
import { isRecord, isToken, isUuid, parseJoin, parseRespond } from "./validate.js";
import { connectionHistory, OUTCOMES, recordOutcome } from "./continuity.js";
import type { Outcome } from "./continuity.js";
import { isFresh, parsePolicy } from "./signals.js";
import { CAPABILITIES, SKILL_RELEASE } from "./capabilities.js";

export interface Deps {
  store: Store;
  now: () => Date;
  /** Model judge for discovery. Absent or null: rules-only suggestions. */
  judge?: Judge | null;
  /** Shared secret for POST /api/discover. Absent: that endpoint is off. */
  discoverSecret?: string;
}

const MAX_BODY_BYTES = 16 * 1024;
/** PUT /api/context carries up to 60 signals, so it gets a larger limit. */
const MAX_CONTEXT_BYTES = 96 * 1024;

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
async function readJson(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  const raw = await request.text();
  if (raw.length > maxBytes) return error(413, "Request body is too large.");
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
    await deleteLoopData(deps.store, sid);
    await deleteStudent(deps.store, sid);
    return json(200, { deleted: true });
  });
}

/** PUT /api/context: merge signals, policy and free times, then look for a suggestion for this student. */
export function handlePutContext(request: Request, deps: Deps): Promise<Response> {
  return guarded(async () => {
    const sid = await authenticate(request, deps.store);
    if (sid instanceof Response) return sid;
    const body = await readJson(request, MAX_CONTEXT_BYTES);
    if (body instanceof Response) return body;
    if (isRecord(body) && body.client_release !== undefined && body.client_release !== SKILL_RELEASE) return error(409, "UPDATE REQUIRED. Client and server releases must match for setup.");
    const now = deps.now();
    const outcome = await putContext(deps.store, sid, body, now);
    if (!outcome.ok) return error(outcome.error.startsWith("CONTEXT CONFLICT.") ? 409 : 400, outcome.error);
    await runDiscovery(deps.store, sid, now, deps.judge ?? null);
    return json(200, { ...outcome.value, open_suggestion: await hasOpenSuggestion(deps.store, sid, now),
      ...(isRecord(body) && body.client_release ? { skill_release: SKILL_RELEASE, intro_mode: (await getContext(deps.store, sid))?.policy.intro } : {}) });
  });
}

/** Public compatibility metadata; no student records are read or changed. */
export function handleCapabilities(_request: Request, _deps: Deps): Promise<Response> {
  return Promise.resolve(json(200, { skill_release: SKILL_RELEASE, capabilities: CAPABILITIES }));
}

/** The authenticated person's current context and durable profile, for portable identity. */
export function handleGetContext(request: Request, deps: Deps): Promise<Response> {
  return guarded(async () => {
    const sid = await authenticate(request, deps.store);
    if (sid instanceof Response) return sid;
    const ctx = await getContext(deps.store, sid);
    if (ctx === null) return error(404, "No retained Super Cub profile for this identity.");
    const policy = parsePolicy(undefined, ctx.policy);
    if (!policy.ok) return error(500, "The stored profile could not be read.");
    return json(200, { policy: policy.value, context_version: await deps.store.get(`context-version:${sid}`), signals: ctx.signals.filter((s) => isFresh(s, deps.now())),
      free: ctx.free.filter((w) => Date.parse(w.end) > deps.now().getTime()), tz: ctx.tz, updated_at: ctx.updated_at });
  });
}

/** GET /api/suggestions: at most one ask to relay now, plus agreed outcomes. */
export function handleSuggestions(request: Request, deps: Deps): Promise<Response> {
  return guarded(async () => {
    const sid = await authenticate(request, deps.store);
    if (sid instanceof Response) return sid;
    const id = new URL(request.url).searchParams.get("id");
    if (id !== null) {
      if (!isUuid(id)) return error(400, "Invalid suggestion id.");
      const ask = await previewSuggestion(deps.store, sid, id, deps.now());
      return ask === null ? error(404, "This introduction is no longer open.") : json(200, { ask });
    }
    return json(200, await pendingFor(deps.store, sid, deps.now(), request.headers.get("x-supercub-delivery") === "acknowledged"));
  });
}

const ANSWERS: readonly AnswerValue[] = ["yes", "no", "later"];
const isAnswer = (value: unknown): value is AnswerValue =>
  typeof value === "string" && (ANSWERS as readonly string[]).includes(value);

/** The suggestion id from /api/suggestions/{id}/answer, else ?id=, else the body's id. */
function suggestionId(request: Request, body: Record<string, unknown>): string {
  const url = new URL(request.url);
  const fromPath = /\/api\/suggestions\/([^/]+)\/(?:answer|delivered)\/?$/.exec(url.pathname)?.[1];
  const raw = fromPath ?? url.searchParams.get("id") ?? body.id;
  return typeof raw === "string" ? decodeURIComponent(raw).trim().toLowerCase() : "";
}

export function handleDelivered(request: Request, deps: Deps): Promise<Response> {
  return guarded(async () => {
    const sid = await authenticate(request, deps.store);
    if (sid instanceof Response) return sid;
    const body = await readJson(request);
    if (body instanceof Response) return body;
    if (!isRecord(body) || (body.kind !== "ask" && body.kind !== "agreed")) return error(400, "kind must be ask or agreed.");
    const id = suggestionId(request, body);
    if (!isUuid(id)) return error(400, "Invalid suggestion id.");
    if (!(await acknowledgeDelivery(deps.store, sid, id, body.kind, deps.now()))) return error(404, "No current message for this identity.");
    return json(200, { delivered: true });
  });
}

export function handleConnections(request: Request, deps: Deps): Promise<Response> {
  return guarded(async () => {
    const sid = await authenticate(request, deps.store);
    if (sid instanceof Response) return sid;
    if (request.method === "GET") return json(200, { connections: await connectionHistory(deps.store, sid) });
    const body = await readJson(request);
    if (body instanceof Response) return body;
    if (!isRecord(body) || !isUuid(String(body.id)) || !(OUTCOMES as readonly unknown[]).includes(body.outcome)) {
      return error(400, "Give a connection id and outcome: met, did_not_meet, useful, not_useful or reset.");
    }
    if (!(await recordOutcome(deps.store, sid, String(body.id), body.outcome as Outcome))) return error(404, "No retained connection for this identity.");
    return json(200, { saved: true });
  });
}

/** POST /api/suggestions/:id/answer with {answer: yes | no | later} */
export function handleAnswer(request: Request, deps: Deps): Promise<Response> {
  return guarded(async () => {
    const sid = await authenticate(request, deps.store);
    if (sid instanceof Response) return sid;
    const body = await readJson(request);
    if (body instanceof Response) return body;
    if (!isRecord(body)) return error(400, "Request body must be a JSON object.");
    const id = suggestionId(request, body);
    if (!isUuid(id)) return error(400, "The suggestion id must come from GET /api/suggestions.");
    if (!isAnswer(body.answer)) return error(400, "answer must be yes, no or later.");

    const outcome = await answerSuggestion(deps.store, sid, id, body.answer, deps.now());
    switch (outcome.kind) {
      case "not_found":
        return error(404, "No suggestion with that id for this student.");
      case "expired":
        return json(410, { error: "This suggestion has expired.", status: "expired" });
      case "already_answered":
        return json(409, { error: "You already answered this suggestion.", status: "answered" });
      case "waiting":
        return json(200, { status: "waiting" });
      case "later":
        return json(200, { status: "later", ask_again_at: outcome.ask_again_at });
      case "passed":
        return json(200, { status: "passed" });
      case "agreed":
        return json(200, { status: "agreed", ...outcome.view });
    }
  });
}

/** POST /api/discover: discovery across all participating students. Needs the X-Discover-Secret header. */
export function handleDiscover(request: Request, deps: Deps): Promise<Response> {
  return guarded(async () => {
    const secret = deps.discoverSecret ?? "";
    if (secret.length === 0) return error(503, "Discovery runs are not configured on this server.");
    const given = request.headers.get("x-discover-secret") ?? "";
    const a = Buffer.from(createHash("sha256").update(given).digest("hex"));
    const b = Buffer.from(createHash("sha256").update(secret).digest("hex"));
    if (!timingSafeEqual(a, b)) return error(401, "Missing or wrong X-Discover-Secret header.");
    return json(200, await discoverAll(deps.store, deps.now(), deps.judge ?? null));
  });
}
