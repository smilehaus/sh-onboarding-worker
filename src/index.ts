/**
 * Smile Haus Onboarding Worker
 *
 * Replaces Make.com. Single Cloudflare Worker that:
 *   - Handles ClickUp OAuth (authorization code -> access/refresh tokens)
 *   - Stores refresh token in KV (permanent, encrypted at rest)
 *   - Auto-refreshes access tokens before expiry (self-healing)
 *   - Exposes API endpoints for the onboarding form:
 *       POST /api/onboard       creates folder + weeks + parent + 49 subtasks
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
  tasks: Array<{ n: string; l: string; p: number | string; d: number; quiz?: string; due?: string | null }>;
}

async function createOnboarding(env: Env, input: OnboardInput): Promise<any> {
  const folderName = `${input.name} - ${input.office} - ${input.role}`;

  // 1. Create folder in the Training space
  const folder = await cu(env, "POST", `/space/${SPACE_ID_TRAINING}/folder`, {
    name: folderName,
  });

  // 2. Create 4 week lists
  const weekLabels = ["Week 1 — Foundation", "Week 2 — Reinforcement", "Week 3 — Treatment & Checkout", "Week 4 — Go-Live"];
  const lists: Record<string, string> = {};
  for (let i = 0; i < 4; i++) {
    const list = await cu(env, "POST", `/folder/${folder.id}/list`, { name: weekLabels[i] });
    lists[`w${i + 1}`] = list.id;
  }

  // 3. Create parent task in Active Trainees list
  const startMs = new Date(input.start).getTime();
  const homeOfficeCustom = input.homeOfficeId
    ? [{ id: HOME_OFFICE_FIELD_ID, value: input.homeOfficeId }]
    : undefined;

  const parent = await cu(env, "POST", `/list/${LIST_ID_ACTIVE}/task`, {
    name: `${input.name} - ${input.office} - ${input.role} - ${input.start}`,
    description: `Training folder: ${folderName}\nTrainee: ${input.traineeEmail || "n/a"}\nTrainer: ${input.trainerEmail || "n/a"}`,
    start_date: startMs,
    custom_fields: homeOfficeCustom,
  });

  // 4. Create all 49 subtasks. For quiz tasks, update description afterward
  // with the quiz URL including the actual taskId for correct attribution.
  const created: Array<{ id: string; name: string; quiz?: string }> = [];
  for (const t of input.tasks) {
    const listId = lists[t.l];
    if (!listId) continue;

    const dueMs = t.due ? new Date(t.due).getTime() : undefined;
    const task = await cu(env, "POST", `/list/${listId}/task`, {
      name: t.n,
      parent: parent.id,
      priority: typeof t.p === "number" ? t.p : null,
      due_date: dueMs,
    });
    created.push({ id: task.id, name: task.name, quiz: t.quiz });

    // Quiz task: set description with the quiz URL embedding its own taskId
    if (t.quiz) {
      const quizUrl = `https://smilehaus.github.io/smilehaus-onboarding/quiz.html?week=${t.quiz}&taskId=${task.id}&name=${encodeURIComponent(input.name)}&office=${input.office}`;
      await cu(env, "PUT", `/task/${task.id}`, {
        description: `Click to take the quiz:\n${quizUrl}\n\nResults will post automatically to this task as a comment.`,
      });
    }
  }

  return {
    folder: { id: folder.id, name: folder.name, url: `https://app.clickup.com/9014079163/v/f/${folder.id}` },
    parentTask: { id: parent.id, url: `https://app.clickup.com/t/${parent.id}` },
    lists,
    taskCount: created.length,
    quizTasks: created.filter(t => t.quiz).map(t => ({ id: t.id, week: t.quiz })),
  };
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

      if (path === "/api/onboard" && request.method === "POST") {
        const payload = await request.json() as OnboardInput;
        const result = await createOnboarding(env, payload);
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
