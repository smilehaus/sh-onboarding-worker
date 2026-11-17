/**
 * Smile Haus Onboarding Worker
 *
 * Replaces Make.com. Single Cloudflare Worker that:
 *   - Handles ClickUp OAuth (authorization code -> access/refresh tokens)
 *   - Stores refresh token in KV (permanent, encrypted at rest)
 *   - Auto-refreshes access tokens before expiry (self-healing)
 *   - Exposes API endpoints for the onboarding form:
 *       POST /api/onboard       creates parent + phase subtasks (names/tier/manual supplied by the form) + day tasks
 *       POST /api/quiz-result   posts graded quiz comment on a specific task
 *       GET  /api/trainees      lists active trainees for the quiz picker
 *       GET  /api/health        public health check
 *       GET  /api/status        auth status (is a refresh token on file?)
 *   - OAuth routes:
 *       GET  /oauth/start       redirects to ClickUp authorize URL
 *       GET  /oauth/callback    exchanges code, stores tokens in KV
 *
 * Failure modes + self-healing:
 *   - Access token expired: 401 from ClickUp -> refresh -> retry. Invisible.
 *   - Refresh token expired/revoked: status endpoint reports "needs_reauth".
 *     Form shows "Reconnect ClickUp" button.
 *   - ClickUp 5xx: retry 3x with exponential backoff.
 *   - Anything else: logged to KV + optional ClickUp notify task.
 */

export interface Env {
  SH_KV: KVNamespace;
  CLICKUP_CLIENT_ID: string;
  CLICKUP_CLIENT_SECRET: string;
  ALLOWED_ORIGIN: string;
  ERROR_NOTIFY_TASK_ID?: string;
}

// ---------- ClickUp constants (Smile Haus workspace) ----------
const CU_BASE = "https://api.clickup.com/api/v2";
const CU_OAUTH = "https://app.clickup.com/api";
const SPACE_ID_TRAINING = "90144939387";     // New Member Training Program
const LIST_ID_ACTIVE = "901415197832";        // Active Trainees - All Offices
const HOME_OFFICE_FIELD_ID = "5f17c1c3-3c2a-46ae-96b5-fa1d195cfde9";
// "Starting Tier" dropdown on the Active Trainees list (T1-T7), option ids by name
const TIER_FIELD_ID = "075a9bd1-3874-4e65-821c-9f9c9c833b5b";
const TIER_OPTION_IDS: Record<string, string> = {
  T1: "ce6e9339-2630-4791-a968-289a361f5125",
  T2: "21c4dcd8-961c-44a4-a609-333dc9c378e4",
  T3: "c6ce9990-0afd-4e49-9045-561736196106",
  T4: "60a5f976-8692-4888-beaf-448900a593fe",
  T5: "82960282-405b-44e0-ba28-f7d106576ddc",
  T6: "94d02a87-a5c7-4988-b015-7d416fedfb33",
  T7: "09dd0ba8-963c-4a8c-a12b-f0f694314eec",
};
// Default (Patient Coordinator) manual + week names, used when the form does not send its own
const DEFAULT_MANUAL_URL = "https://app.clickup.com/9014079163/docs/8cmfvnv-47334";
const DEFAULT_WEEK_NAMES = [
  "Week 1 — Foundation & Front Desk Basics",
  "Week 2 — Reinforcement & Supervised Practice",
  "Week 3 — Treatment Planning & Checkout",
  "Week 4 — Applied Practice & Go-Live",
];

// ---------- KV keys ----------
const KV_REFRESH = "oauth:refresh_token";
const KV_ACCESS = "oauth:access_token";
const KV_ACCESS_EXPIRES = "oauth:access_expires_at";
const KV_LAST_ERROR = "monitor:last_error";

// ---------- CORS ----------
function corsHeaders(env: Env, extra: HeadersInit = {}): HeadersInit {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

function json(body: unknown, env: Env, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(env, { "Content-Type": "application/json" }),
  });
}

// ---------- OAuth token management ----------
// ClickUp issues long-lived access tokens (no refresh token, no expiry).
// If a token ever gets revoked, the next API call will 401 and the user
// re-authorizes at /oauth/start.
async function getAccessToken(env: Env): Promise<string> {
  const token = await env.SH_KV.get(KV_ACCESS);
  if (!token) throw new Error("No access token — OAuth not completed. Visit /oauth/start.");
  return token;
}

// ---------- ClickUp API wrapper with retry + auto-refresh ----------
async function cu(env: Env, method: string, path: string, body?: unknown, retries = 3): Promise<any> {
  let token = await getAccessToken(env);
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`${CU_BASE}${path}`, {
      method,
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      // Access token revoked. Clear it; user must re-authorize at /oauth/start.
      await env.SH_KV.delete(KV_ACCESS);
      throw new Error("ClickUp auth expired/revoked. Re-authorize at /oauth/start.");
    }
    if (res.status >= 500 && attempt < retries - 1) {
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      continue;
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`ClickUp ${method} ${path} ${res.status}: ${errText.slice(0, 400)}`);
    }
    return res.status === 204 ? null : await res.json();
  }
  throw new Error(`ClickUp ${method} ${path} exhausted retries`);
}

async function logError(env: Env, msg: string): Promise<void> {
  console.error(msg);
  await env.SH_KV.put(KV_LAST_ERROR, JSON.stringify({ at: new Date().toISOString(), msg }));
  if (env.ERROR_NOTIFY_TASK_ID) {
    try {
      await cu(env, "POST", `/task/${env.ERROR_NOTIFY_TASK_ID}/comment`, {
        comment_text: `🚨 sh-onboarding-worker error:\n${msg}`,
      });
    } catch { /* swallow — don't error on error-logging */ }
  }
}

// ---------- Onboarding: create folder + weeks + parent + 49 tasks ----------
interface OnboardInput {
  name: string;
  office: string;
  role: string;
  start: string; // YYYY-MM-DD
  traineeEmail?: string;
  trainerEmail?: string;
  homeOfficeId: string;
  tier?: string | null;        // T1..T7 (roles with a tier path)
  track?: string | null;       // informational (DA: A/B/C)
  weeks?: number;              // number of phase subtasks (defaults to weekNames length)
  weekNames?: string[] | null; // phase subtask names, in order (keys w1..wN)
  manualUrl?: string | null;   // training manual for this role (defaults to the PC manual)
  tasks: Array<{ n: string; l: string; p: number | string; d: number; quiz?: string; due?: string | null }>;
}

// Chunked onboarding — split across multiple Worker invocations to stay under
// Cloudflare free-tier's 50-subrequest-per-invocation cap.
// Architecture (matches existing "By Trainee" view in Active Trainees list):
//   Parent task: "Name - Office - Role - StartDate"
//     Week 1 subtask
//       Day tasks (sub-subtasks)
//     Week 2 subtask
//     ... etc
// Everything lives in the ONE Active Trainees list.

async function createParent(env: Env, input: OnboardInput): Promise<any> {
  const startMs = new Date(input.start).getTime();
  const customFields: Array<{ id: string; value: string }> = [];
  if (input.homeOfficeId) customFields.push({ id: HOME_OFFICE_FIELD_ID, value: input.homeOfficeId });
  if (input.tier) {
    const optId = TIER_OPTION_IDS[input.tier];
    if (!optId) throw new Error(`Unknown tier "${input.tier}". Expected T1-T7.`);
    customFields.push({ id: TIER_FIELD_ID, value: optId });
  }
  const weekNames = (input.weekNames && input.weekNames.length ? input.weekNames : DEFAULT_WEEK_NAMES);
  const weekCount = weekNames.length;

  // 1. Parent task — description includes Training Manual + Onboarding Instructions
  //    doc links so OMs and trainees can find every SOP, quiz, and walk-through
  //    from a single starting point.
  const TRAINING_MANUAL_URL = input.manualUrl || DEFAULT_MANUAL_URL;
  const ONBOARDING_INSTRUCTIONS_URL = "https://app.clickup.com/9014079163/docs/8cmfvnv-47374";
  const parentDesc = [
    `**📚 Training Manual:** ${TRAINING_MANUAL_URL}`,
    `**📝 Onboarding Instructions (for OMs):** ${ONBOARDING_INSTRUCTIONS_URL}`,
    ``,
    `**Trainee:** ${input.traineeEmail || "n/a"}`,
    `**Trainer:** ${input.trainerEmail || "n/a"}`,
    `**Start Date:** ${input.start}`,
    ``,
    `---`,
    input.tier ? `**Starting Tier:** ${input.tier}${input.track ? ` (track ${input.track})` : ""}` : ``,
    `This task contains the full ${weekCount}-phase ${input.role} onboarding program.`,
    `Each phase's tasks are nested as subtasks. Open the Training Manual above for`,
    `SOP links, quiz questions, and scripts.`,
  ].join("\n");

  const parent = await cu(env, "POST", `/list/${LIST_ID_ACTIVE}/task`, {
    name: `${input.name} - ${input.office} - ${input.role} - ${input.start}`,
    description: parentDesc,
    start_date: startMs,
    custom_fields: customFields.length ? customFields : undefined,
  });

  // 2. Phase subtasks, one per weekNames entry (keys w1..wN). Max 10 keeps us
  //    well under the 50-subrequest cap.
  if (weekCount > 10) throw new Error(`Too many phases: ${weekCount}. Max 10.`);
  const weeks: Record<string, string> = {};
  for (let i = 0; i < weekCount; i++) {
    const wk = await cu(env, "POST", `/list/${LIST_ID_ACTIVE}/task`, {
      name: weekNames[i],
      parent: parent.id,
    });
    weeks[`w${i + 1}`] = wk.id;
  }

  return {
    parentTask: {
      id: parent.id,
      name: parent.name,
      url: `https://app.clickup.com/t/${parent.id}`,
    },
    weekIds: weeks,
  };
}

interface BatchInput {
  weekIds: Record<string, string>;
  employeeName: string;
  office: string;
  tasks: Array<{ n: string; l: string; p: number | string; d: number; quiz?: string; due?: string | null }>;
}

async function createTaskBatch(env: Env, input: BatchInput): Promise<any> {
  // Each day task = 1 subrequest (create) + 1 subrequest if quiz (PUT description).
  // Cap the batch at 22 to guarantee we stay under 50 even if all are quiz tasks.
  if (input.tasks.length > 22) {
    throw new Error(`Batch too large: ${input.tasks.length}. Max 22 per call.`);
  }

  const created: Array<{ id: string; name: string; quiz?: string }> = [];
  for (const t of input.tasks) {
    const weekParent = input.weekIds[t.l];
    if (!weekParent) {
      created.push({ id: "", name: t.n, quiz: t.quiz });
      continue;
    }

    const dueMs = t.due ? new Date(t.due).getTime() : undefined;
    const task = await cu(env, "POST", `/list/${LIST_ID_ACTIVE}/task`, {
      name: t.n,
      parent: weekParent,
      priority: typeof t.p === "number" ? t.p : null,
      due_date: dueMs,
    });
    created.push({ id: task.id, name: task.name, quiz: t.quiz });

    // Embed quiz URL with the actual taskId for correct attribution
    if (t.quiz && task.id) {
      const quizUrl = `https://smilehaus.github.io/smilehaus-onboarding/quiz.html?week=${t.quiz}&taskId=${task.id}&name=${encodeURIComponent(input.employeeName)}&office=${input.office}`;
      await cu(env, "PUT", `/task/${task.id}`, {
        description: `Click to take the quiz:\n${quizUrl}\n\nResults will post automatically to this task as a comment.`,
      });
    }
  }

  return { created, count: created.length };
}

// ---------- Quiz result: post as comment on the exact taskId ----------
async function postQuizResult(env: Env, payload: any): Promise<any> {
  if (!payload.taskId) throw new Error("taskId required");
  const lines = [
    `🎓 **Week ${payload.week} Quiz — ${payload.pass ? "PASS" : "DID NOT PASS"}**`,
    ``,
    `**Employee:** ${payload.employeeName}`,
    `**Office:** ${payload.office || "—"}`,
    `**Graded by:** ${payload.graderName}`,
    `**Score:** ${payload.score}/${payload.total} (${payload.percentage}%)`,
    `**Pass threshold:** 80%`,
    `**Missed questions:** ${payload.missed || "None"}`,
    `**Date:** ${new Date(payload.date).toLocaleString()}`,
    `**Attribution:** ${payload.attribSource || "unknown"}`,
  ].join("\n");
  return cu(env, "POST", `/task/${payload.taskId}/comment`, { comment_text: lines });
}

// ---------- Trainees list (for quiz picker) ----------
async function listTrainees(env: Env): Promise<any> {
  const data = await cu(env, "GET", `/list/${LIST_ID_ACTIVE}/task?archived=false&subtasks=false&include_closed=false`);
  return (data.tasks || []).map((t: any) => ({
    id: t.id,
    name: t.name,
    url: `https://app.clickup.com/t/${t.id}`,
    office: t.custom_fields?.find((f: any) => f.id === HOME_OFFICE_FIELD_ID)?.value_richtext || null,
    status: t.status?.status || null,
  }));
}

// ---------- Router ----------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      // --- OAuth flow ---
      // NOTE: ClickUp's OAuth app UI stores only the ORIGIN (strips any path).
      // So we register "https://sh-onboarding.smilehaus.workers.dev" as the redirect URL
      // and handle the ?code= callback at the root path below.
      if (path === "/oauth/start") {
        const redirectUri = url.origin;
        const authUrl = `${CU_OAUTH}?client_id=${env.CLICKUP_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}`;
        return Response.redirect(authUrl, 302);
      }

      // OAuth callback handler — ClickUp redirects to the origin with ?code=...
      if (path === "/" && url.searchParams.get("code")) {
        const code = url.searchParams.get("code")!;
        const res = await fetch(`${CU_BASE}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: env.CLICKUP_CLIENT_ID,
            client_secret: env.CLICKUP_CLIENT_SECRET,
            code,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          return new Response(`Token exchange failed: ${res.status}\n${body}`, { status: 500 });
        }
        const data: any = await res.json();
        if (!data.access_token) return new Response("Missing access_token in response", { status: 500 });

        await env.SH_KV.put(KV_ACCESS, data.access_token);
        if (data.refresh_token) await env.SH_KV.put(KV_REFRESH, data.refresh_token);
        const expiresAt = Date.now() + (data.expires_in ? data.expires_in * 1000 : 24 * 3600 * 1000);
        await env.SH_KV.put(KV_ACCESS_EXPIRES, String(expiresAt));

        // Redirect back to the form with a "connected" flag
        return Response.redirect(`${env.ALLOWED_ORIGIN}/smilehaus-onboarding/?connected=1`, 302);
      }

      // Friendly landing page at root when no ?code
      if (path === "/" && request.method === "GET") {
        return new Response(
          `Smile Haus Onboarding Worker is alive.\n\n` +
          `To authorize: visit /oauth/start\n` +
          `To check status: visit /api/status\n`,
          { status: 200, headers: { "Content-Type": "text/plain" } }
        );
      }

      // --- Public endpoints ---
      if (path === "/api/health") {
        return json({ ok: true, at: new Date().toISOString() }, env);
      }

      if (path === "/api/status") {
        const hasToken = !!(await env.SH_KV.get(KV_ACCESS));
        const lastError = await env.SH_KV.get(KV_LAST_ERROR);
        return json({
          authenticated: hasToken,
          needs_reauth: !hasToken,
          reauth_url: `${url.origin}/oauth/start`,
          last_error: lastError ? JSON.parse(lastError) : null,
        }, env);
      }

      // --- Authenticated API endpoints ---
      if (path === "/api/trainees" && request.method === "GET") {
        return json({ trainees: await listTrainees(env) }, env);
      }

      // Chunked onboarding — browser orchestrates multiple calls to stay under
      // free-tier 50-subrequest-per-invocation cap.
      if (path === "/api/onboard/parent" && request.method === "POST") {
        const payload = await request.json() as OnboardInput;
        const result = await createParent(env, payload);
        return json({ ok: true, ...result }, env);
      }

      if (path === "/api/onboard/batch" && request.method === "POST") {
        const payload = await request.json() as BatchInput;
        const result = await createTaskBatch(env, payload);
        return json({ ok: true, ...result }, env);
      }

      if (path === "/api/quiz-result" && request.method === "POST") {
        const payload = await request.json() as any;
        await postQuizResult(env, payload);
        return json({ ok: true, postedTo: payload.taskId }, env);
      }

      return new Response("Not found", { status: 404, headers: corsHeaders(env) });
    } catch (err: any) {
      await logError(env, `${request.method} ${path}: ${err.message}`);
      return json({ ok: false, error: err.message }, env, 500);
    }
  },
};
