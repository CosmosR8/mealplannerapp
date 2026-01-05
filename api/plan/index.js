// api/plan/index.js
// Azure Static Web Apps Functions (Node 18+ classic model)
// POST /api/plan -> calls Azure AI Foundry Agents (Threads/Messages/Runs v1)
// Always returns JSON so Network->Response is never blank.

const { setTimeout: sleep } = require("timers/promises");

// Ensure Node 18+ runtime has fetch
if (typeof fetch !== "function") {
  throw new Error("fetch() is not available. Ensure Node 18+ runtime.");
}

/** Safe JSON parse from a Response */
async function safeJson(res) {
  const txt = await res.text();
  try { return { json: JSON.parse(txt), raw: txt }; }
  catch { return { json: null, raw: txt }; }
}

/** Extract assistant text across different message schemas */
function extractAssistantText(messages) {
  let out = "";

  for (const msg of messages || []) {
    if (msg?.role !== "assistant") continue;
    const content = msg.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;

        // { type: "text", text: "..." }
        if (block.type === "text" && typeof block.text === "string") {
          out += block.text;
          continue;
        }

        // { type: "output_text", text: "..." }
        if (block.type === "output_text" && typeof block.text === "string") {
          out += block.text;
          continue;
        }

        // { type: "text", text: { value: "..." } }
        if (block.type === "text" && block.text && typeof block.text.value === "string") {
          out += block.text.value;
          continue;
        }

        // { text: { value: "..." } } (no type)
        if (block.text && typeof block.text.value === "string") {
          out += block.text.value;
          continue;
        }
      }
      continue;
    }

    if (typeof content === "string") {
      out += content;
    }
  }

  return out.trim();
}

/** Entra client_credentials token for Azure AI Services scope */
async function getToken({ tenantId, clientId, clientSecret }) {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("scope", "https://cognitiveservices.azure.com/.default");
  body.set("grant_type", "client_credentials");

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const { json, raw } = await safeJson(res);
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}). ${json?.error_description || raw || "No details"}`);
  }
  if (!json?.access_token) {
    throw new Error(`Token response missing access_token. Raw: ${raw || "(empty)"}`);
  }
  return json.access_token;
}

/** Remove trailing slash and optional trailing /api segment */
function normalizeEndpoint(url) {
  const s = String(url || "").replace(/\/+$/, "");
  return s.endsWith("/api") ? s.slice(0, -4) : s;
}

/** Poll a run until it reaches a terminal state */
async function waitForRunCompletion({ headers, baseUrl, projectId, threadId, runId }) {
  const maxMs = Number(process.env.RUN_POLL_TIMEOUT_MS || 120000); // 2 min default
  const intervalMs = Number(process.env.RUN_POLL_INTERVAL_MS || 1500);
  const start = Date.now();

  while (true) {
    const url = `${baseUrl}/openai/agents/v1/projects/${projectId}/threads/${threadId}/runs/${runId}?api-version=2024-05-01-preview`;
    const res = await fetch(url, { headers });
    const { json, raw } = await safeJson(res);
    if (!res.ok) {
      throw new Error(`Run status failed (${res.status}): ${raw || res.statusText}`);
    }
    const status = json?.status;
    if (!status) {
      throw new Error(`Run status missing. Raw: ${raw || "(empty)"}`);
    }
    if (["completed", "failed", "cancelled", "expired"].includes(status)) {
      return json;
    }
    if (Date.now() - start > maxMs) {
      throw new Error(`Run polling timed out after ${maxMs}ms. Last status: ${status}`);
    }
    await sleep(intervalMs);
  }
}

module.exports = async function (context, req) {
  try {
    // 1) Parse the incoming body
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = body.prompt || body.input || body.text || "";
    if (!prompt || typeof prompt !== "string") {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Missing 'prompt' (string) in request body." }
      };
      return;
    }

    // 2) Read configuration from environment
    const apiKey = process.env.FOUNDRY_API_KEY; // easiest path
    const tenantId = process.env.AZURE_TENANT_ID;
    const clientId = process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;

    // Project settings (from Foundry)
    const projectEndpoint = normalizeEndpoint(process.env.PROJECT_ENDPOINT);
    const projectId = process.env.PROJECT_ID;
    const agentId = process.env.AGENT_ID;

    const missing = [];
    if (!projectEndpoint) missing.push("PROJECT_ENDPOINT");
    if (!projectId)      missing.push("PROJECT_ID");
    if (!agentId)        missing.push("AGENT_ID");

    // For Entra path, these are required; for API Key path, they are not.
    const usingApiKey = Boolean(apiKey);
    if (!usingApiKey) {
      if (!tenantId)    missing.push("AZURE_TENANT_ID");
      if (!clientId)    missing.push("AZURE_CLIENT_ID");
      if (!clientSecret) missing.push("AZURE_CLIENT_SECRET");
    }

    if (missing.length) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: `Missing required environment variables: ${missing.join(", ")}` }
      };
      return;
    }

    // 3) Build headers for Foundry
    let headers = { "Content-Type": "application/json" };
    if (usingApiKey) {
      headers["api-key"] = apiKey; // Foundry project API key
    } else {
      const token = await getToken({ tenantId, clientId, clientSecret });
      headers["Authorization"] = `Bearer ${token}`;
    }

    // 4) Create a thread
    const createThreadUrl = `${projectEndpoint}/openai/agents/v1/projects/${projectId}/threads?api-version=2024-05-01-preview`;
    const threadRes = await fetch(createThreadUrl, { method: "POST", headers, body: JSON.stringify({}) });
    const { json: threadJson, raw: threadRaw } = await safeJson(threadRes);
    if (!threadRes.ok) {
      throw new Error(`Create thread failed (${threadRes.status}): ${threadRaw || threadRes.statusText}`);
    }
    const threadId = threadJson?.id;
    if (!threadId) throw new Error(`Create thread missing id. Raw: ${threadRaw || "(empty)"}`);

    // 5) Add user message
    const msgUrl = `${projectEndpoint}/openai/agents/v1/projects/${projectId}/threads/${threadId}/messages?api-version=2024-05-01-preview`;
    const msgRes = await fetch(msgUrl, { method: "POST", headers, body: JSON.stringify({ role: "user", content: prompt }) });
    const { raw: msgRaw } = await safeJson(msgRes);
    if (!msgRes.ok) {
      throw new Error(`Add message failed (${msgRes.status}): ${msgRaw || msgRes.statusText}`);
    }

    // 6) Create run
    const runUrl = `${projectEndpoint}/openai/agents/v1/projects/${projectId}/threads/${threadId}/runs?api-version=2024-05-01-preview`;
    const runRes = await fetch(runUrl, { method: "POST", headers, body: JSON.stringify({ agent_id: agentId }) });
    const { json: runJson, raw: runRaw } = await safeJson(runRes);
    if (!runRes.ok) {
      throw new Error(`Create run failed (${runRes.status}): ${runRaw || runRes.statusText}`);
    }
    const runId = runJson?.id;
    if (!runId) throw new Error(`Create run missing id. Raw: ${runRaw || "(empty)"}`);

    // 7) Wait for completion
    const finalRun = await waitForRunCompletion({ headers, baseUrl: projectEndpoint, projectId, threadId, runId });
    if (finalRun?.status !== "completed") {
      const errMsg = finalRun?.last_error?.message || finalRun?.error?.message || `Run ended with status: ${finalRun?.status}`;
      throw new Error(errMsg);
    }

    // 8) List messages and extract assistant text
    const listMsgUrl = `${projectEndpoint}/openai/agents/v1/projects/${projectId}/threads/${threadId}/messages?api-version=2024-05-01-preview`;
    const listRes = await fetch(listMsgUrl, { headers });
    const { json: listJson, raw: listRaw } = await safeJson(listRes);
    if (!listRes.ok) {
      throw new Error(`List messages failed (${listRes.status}): ${listRaw || listRes.statusText}`);
    }
    const messages = listJson?.data || listJson?.messages || listJson || [];
    const text = extractAssistantText(messages);
    if (!text) throw new Error("No assistant text found in messages response.");

    // 9) Respond (use context.res!)
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { text }
    };
  } catch (err) {
    context.log.error("ERROR in /api/plan:", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: err?.message || String(err), stack: err?.stack || null }
    };
  }
};
