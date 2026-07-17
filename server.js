import http from "node:http";

const {
  JIRA_BASE = "https://atomoperations.atlassian.net",
  JIRA_EMAIL,
  JIRA_TOKEN,
  SHARED_SECRET,
  PORT = 3000,
} = process.env;

const AUTH = "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Secret");
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
async function jira(path, opts = {}) {
  const r = await fetch(JIRA_BASE + path, {
    ...opts,
    headers: { Authorization: AUTH, Accept: "application/json", "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text ? JSON.parse(text) : null };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://x");

  // public health check
  if (url.pathname === "/" || url.pathname === "/health") {
    return json(res, 200, { ok: true, service: "srnd-jira-proxy" });
  }

  // shared-secret gate for everything else
  const secret = req.headers["x-secret"] || url.searchParams.get("secret");
  if (!SHARED_SECRET || secret !== SHARED_SECRET) {
    return json(res, 401, { error: "unauthorized" });
  }

  try {
    // GET /transitions?key=SRND-123  -> which target statuses are allowed right now
    if (url.pathname === "/transitions" && req.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key) return json(res, 400, { error: "missing key" });
      const t = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
      if (!t.ok) return json(res, t.status, { error: "jira", detail: t.body });
      return json(res, 200, { key, transitions: t.body.transitions.map((x) => ({ id: x.id, to: x.to.name })) });
    }

    // POST /transition {key, targetStatus}  -> move the issue in Jira
    if (url.pathname === "/transition" && req.method === "POST") {
      const { key, targetStatus } = await readBody(req);
      if (!key || !targetStatus) return json(res, 400, { error: "missing key or targetStatus" });
      const t = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
      if (!t.ok) return json(res, t.status, { error: "jira_transitions", detail: t.body });
      const match = t.body.transitions.find((x) => x.to.name === targetStatus);
      if (!match) return json(res, 409, { error: "transition_not_available", available: t.body.transitions.map((x) => x.to.name) });
      const r = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: match.id } }),
      });
      if (!r.ok) return json(res, r.status, { error: "transition_failed", detail: r.body });
      return json(res, 200, { ok: true, key, newStatus: targetStatus });
    }

    return json(res, 404, { error: "not_found" });
  } catch (e) {
    return json(res, 500, { error: "server", detail: String(e) });
  }
});

server.listen(PORT, () => console.log("srnd-jira-proxy listening on", PORT));
