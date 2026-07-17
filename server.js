import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  JIRA_BASE = "https://atomoperations.atlassian.net",
  JIRA_EMAIL,
  JIRA_TOKEN,
  SHARED_SECRET,
  PORT = 3000,
} = process.env;

const AUTH = "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");

// canonical board query (SRND · Marketing)
const REPORTERS = [
  "712020:13362eb4-ffd6-4b8d-b6fe-740a15ca3c05", "empty", "currentUser()",
  "712020:489e9019-8629-424c-ac99-d25804a6fc62", "712020:af196fed-861d-4fa4-9d45-d208e49cd36c",
  "712020:eee3cf39-02d2-47f2-9699-f199d4b9629f", "712020:08deb8e1-7a1f-4319-9d5a-7b981e74d4f7",
  "712020:ad2feae9-678b-4820-bf44-46585a35602b", "712020:ce8747ed-69b0-48c3-bbdf-ed1b0c18fd7c",
  "712020:523d0600-c0d4-4612-80f6-5d9b4bee5770",
  "712020:f18cf3aa-9b75-4533-bd79-8c5f528fddac", // Anton Kruk
];
const JQL = `project = SRND AND reporter IN (${REPORTERS.join(", ")}) AND "Products[Dropdown]" = Marketing ORDER BY parent ASC, status ASC, updated DESC`;
const FIELDS = "summary,status,assignee,parent,priority,customfield_12903,customfield_12763";
const STAGE = { Sprint: "sprint", Today: "today", Add: "add", Extra: "extra", "Готово": "done", Backlog: "backlog", Archived: "archived", Tracking: "tracking", Drop: "archived", Undone: "add", "Useful materials": "archived" };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Secret");
}
function json(res, code, obj) { cors(res); res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } }); });
}
async function jira(path, opts = {}) {
  const r = await fetch(JIRA_BASE + path, { ...opts, headers: { Authorization: AUTH, Accept: "application/json", "Content-Type": "application/json", ...(opts.headers || {}) } });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text ? JSON.parse(text) : null };
}

function marVal(v) { return v && typeof v === "object" ? (v.value || v.name) : v; }
function spVal(v) { if (v == null) return null; if (typeof v === "object") v = v.value || v.name; const f = Number(v); return Number.isFinite(f) ? f : String(v); }

async function boardData() {
  const url = `/rest/api/3/search/jql?jql=${encodeURIComponent(JQL)}&maxResults=300&fields=${encodeURIComponent(FIELDS)}`;
  const r = await jira(url);
  if (!r.ok) throw new Error("jira search " + r.status);
  const goals = new Map();
  const NONE = "__none__";
  for (const it of r.body.issues) {
    const f = it.fields;
    const p = f.parent;
    const gk = p ? p.key : NONE;
    if (!goals.has(gk)) goals.set(gk, { id: p ? p.key : null, title: p ? p.fields.summary.trim() : "Без привʼязаної цілі", tasks: [], ...(p ? {} : { none: true }) });
    const t = { id: it.key, text: f.summary.trim(), who: f.assignee ? f.assignee.displayName : null, stage: STAGE[f.status.name] || "add" };
    const m = marVal(f.customfield_12763); if (m) t.mar = m;
    const s = spVal(f.customfield_12903); if (s != null) t.sp = s;
    if (f.priority && f.priority.name) t.prio = f.priority.name;
    goals.get(gk).tasks.push(t);
  }
  const ordered = [...goals.entries()].filter(([k]) => k !== NONE).map(([, v]) => v);
  if (goals.has(NONE)) ordered.push(goals.get(NONE));
  return { goals: ordered };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/health") return json(res, 200, { ok: true, service: "srnd-jira-proxy" });

  const secret = req.headers["x-secret"] || url.searchParams.get("secret") || url.searchParams.get("k");
  const authed = SHARED_SECRET && secret === SHARED_SECRET;

  // serve the board (gated)
  if (url.pathname === "/" || url.pathname === "/board") {
    if (!authed) { res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" }); return res.end("<h2>401 — потрібен ?k=SECRET</h2>"); }
    try {
      const html = await readFile(join(__dirname, "board.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch (e) { res.writeHead(500); return res.end("board.html missing"); }
  }

  if (!authed) return json(res, 401, { error: "unauthorized" });

  try {
    if (url.pathname === "/board-data" && req.method === "GET") {
      return json(res, 200, await boardData());
    }
    if (url.pathname === "/transitions" && req.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key) return json(res, 400, { error: "missing key" });
      const t = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
      if (!t.ok) return json(res, t.status, { error: "jira", detail: t.body });
      return json(res, 200, { key, transitions: t.body.transitions.map((x) => ({ id: x.id, to: x.to.name })) });
    }
    if (url.pathname === "/transition" && req.method === "POST") {
      const { key, targetStatus } = await readBody(req);
      if (!key || !targetStatus) return json(res, 400, { error: "missing key or targetStatus" });
      const t = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
      if (!t.ok) return json(res, t.status, { error: "jira_transitions", detail: t.body });
      const match = t.body.transitions.find((x) => x.to.name === targetStatus);
      if (!match) return json(res, 409, { error: "transition_not_available", available: t.body.transitions.map((x) => x.to.name) });
      const r = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: match.id } }) });
      if (!r.ok) return json(res, r.status, { error: "transition_failed", detail: r.body });
      return json(res, 200, { ok: true, key, newStatus: targetStatus });
    }
    return json(res, 404, { error: "not_found" });
  } catch (e) {
    return json(res, 500, { error: "server", detail: String(e) });
  }
});

server.listen(PORT, () => console.log("srnd-jira-proxy listening on", PORT));
