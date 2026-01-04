const fetch = global.fetch;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function getToken() {
  const tenantId = requireEnv("AZURE_TENANT_ID");
  const clientId = requireEnv("AZURE_CLIENT_ID");
  const clientSecret = requireEnv("AZURE_CLIENT_SECRET");

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("grant_type", "client_credentials");
  body.set("scope", "https://ai.azure.com/.default");

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`Token error ${res.status}: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function foundryFetch(projectEndpoint, token, path, options = {}) {
  // IMPORTANT: correct query delimiter + api-version required for these endpoints
  const url =
    projectEndpoint.replace(/\/$/, "") +
    path +
    (path.includes("?") ? "&" : "?") +
    "api-version=v1";

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
    ...(options.headers || {})
  };

  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Foundry ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function extractAssistantText(messagesResponse) {
  const data = messagesResponse.data || messagesResponse.messages || [];
  const assistant = [...data].reverse().find(m => (m.role || "").toLowerCase() === "assistant");
  if (!assistant) return "";

  const parts = assistant.content || [];
  let out = "";
  for (const p of parts) {
    if (p.type === "text") {
      if (typeof p.text === "string") out += p.text + "\n";
      else if (p.text && typeof p.text.value === "string") out += p.text.value + "\n";
    }
  }
  return out.trim();
}

module.exports = async function (context, req) {
  try {
    const { prompt, endpoint, agentId } = req.body || {};
    if (!prompt) return { status: 400, body: { error: "Missing prompt" } };
    if (!endpoint) return { status: 400, body: { error: "Missing endpoint" } };
    if (!agentId) return { status: 400, body: { error: "Missing agentId" } };

    const token = await getToken();

    // 1) Create thread
    const thread = await foundryFetch(endpoint, token, "/threads", {
      method: "POST",
      body: JSON.stringify({})
    });
    const threadId = thread.id || thread.threadId || thread.thread_id;
    if (!threadId) throw new Error("Thread id not found");

    // 2) Add message
    await foundryFetch(endpoint, token, `/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: [{ type: "text", text: prompt }] })
    });

    // 3) Create run (assistant_id is REQUIRED by the REST contract)
    const run = await foundryFetch(endpoint, token, `/threads/${encodeURIComponent(threadId)}/runs`, {
      method: "POST",
      body: JSON.stringify({ assistant_id: agentId })
    });
    const runId = run.id || run.runId || run.run_id;
    if (!runId) throw new Error("Run id not found");

    // 4) Poll status
    for (let i = 0; i < 60; i++) {
      const s = await foundryFetch(endpoint, token, `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`, {
        method: "GET"
      });
      const st = (s.status || s.state || "").toLowerCase();
      if (["completed", "succeeded", "finished"].includes(st)) break;
      if (["failed", "cancelled", "canceled", "error"].includes(st)) throw new Error(`Run ended: ${st}`);
      await new Promise(r => setTimeout(r, 2000));
    }

    // 5) Get assistant output
    const msgs = await foundryFetch(endpoint, token, `/threads/${encodeURIComponent(threadId)}/messages`, { method: "GET" });
    const text = extractAssistantText(msgs);
    if (!text) throw new Error("No assistant text returned");

    return { status: 200, body: { text } };
  } catch (e) {
    context.log.error(e);
    return { status: 500, body: { error: String(e.message || e) } };
  }
};
