// api/plan/index.js
// Azure Static Web Apps Function (Node 18+)
// POST /api/plan -> calls Azure AI Foundry Agents (Threads/Messages/Runs v1) using Entra client_credentials
// Returns: { text: "..." } on success
// Returns: { error, stack, details } on failure (so DevTools Network->Response is never blank)

const { setTimeout: sleep } = require("timers/promises");

// Node 18 has fetch built-in in Azure Functions runtime
if (typeof fetch !== "function") {
  throw new Error("fetch() is not available. Ensure Node 18+ runtime.");
}

/**
 * Helper: read response body safely
 */
async function safeJson(res) {
  const txt = await res.text();
  try {
    return { json: JSON.parse(txt), raw: txt };
  } catch {
    return { json: null, raw: txt };
  }
}

/**
 * Helper: extract assistant text from messages (handles multiple schemas)
 */
function extractAssistantText(messages) {
  let out = "";

  for (const msg of messages || []) {
    if (msg?.role !== "assistant") continue;

    const content = msg.content;

    // Array of blocks is common
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;

        // block = { type: "text", text: "..." }
        if (block.type === "text" && typeof block.text === "string") {
          out += block.text;
          continue;
        }

        // block = { type: "output_text", text: "..." }
        if (block.type === "output_text" && typeof block.text === "string") {
          out += block.text;
          continue;
        }

        // block = { type: "text", text: { value: "..." } }
        if (block.type === "text" && block.text && typeof block.text.value === "string") {
          out += block.text.value;
          continue;
        }

        // block = { text: { value: "..." } } (no type)
        if (block.text && typeof block.text.value === "string") {
          out += block.text.value;
          continue;
        }
      }
      continue;
    }

    // Sometimes content is already a string
    if (typeof content === "string") out += content;
  }

  return out.trim();
}

/**
 * Entra token via client_credentials
 * Scope is commonly https://cognitiveservices.azure.com/.default for Azure AI services.
 */
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
    throw new Error(
      `Token request failed (${res.status}). ${json?.error_description || raw || "No details"}`
    );
  }

  if (!json?.access_token) {
    throw new Error(`Token response missing access_token. Raw: ${raw || "(empty)"}`);
  }

  return json.access_token;
}

/**
 * Normalize env var so it doesn't end with /
 */
function stripTrailingSlash(s) {
  return (s || "").replace(/\/+$/, "");
}

/**
 * Poll run until terminal state
 */
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

    // Common terminal states: completed, failed, cancelled, expired
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
    // 1) Parse body safely (SWA can provide object OR string)
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const prompt = body.prompt || body.input || body.text || "";
    if (!prompt || typeof prompt !== "string") {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Missing 'prompt' (string) in request body." },
      };
    }

    // 2) Load required config from env (recommended)
    const tenantId = process.env.AZURE_TENANT_ID;
    const clientId = process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;

    // These must be the RUNTIME endpoint + project/agent IDs
    const projectEndpoint = stripTrailingSlash(process.env.PROJECT_ENDPOINT);
    const projectId = process.env.PROJECT_ID;
    const agentId = process.env.AGENT_ID;

    const missing = [];
    if (!tenantId) missing.push("AZURE_TENANT_ID");
    if (!clientId) missing.push("AZURE_CLIENT_ID");
    if (!clientSecret) missing.push("AZURE_CLIENT_SECRET");
    if (!projectEndpoint) missing.push("PROJECT_ENDPOINT");
    if (!projectId) missing.push("PROJECT_ID");
    if (!agentId) missing.push("AGENT_ID");

    if (missing.length) {
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: {
          error: `Missing required environment variables: ${missing.join(", ")}`,
        },
      };
    }

    // 3) Entra token
    const token = await getToken({ tenantId, clientId, clientSecret });

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // 4) Create thread
    const createThreadUrl = `${projectEndpoint}/openai/agents/v1/projects/${projectId}/threads?api-version=2024-05-01-preview`;
    const threadRes = await fetch(createThreadUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

    const { json: threadJson, raw: threadRaw } = await safeJson(threadRes);
    if (!threadRes.ok) {
      throw new Error(`Create thread failed (${threadRes.status}): ${threadRaw || threadRes.statusText}`);
    }

    const threadId = threadJson?.id;
    if (!threadId) throw new Error(`Create thread missing id. Raw: ${threadRaw || "(empty)"}`);

    // 5) Add user message
    const msgUrl = `${projectEndpoint}/openai/agents/v1/projects/${projectId}/threads/${threadId}/messages?api-version=2024-05-01-preview`;
    const msgRes = await fetch(msgUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        role: "user",
        content: prompt,
      }),
    });

    const { raw: msgRaw } = await safeJson(msgRes);
    if (!msgRes.ok) {
      throw new Error(`Add message failed (${msgRes.status}): ${msgRaw || msgRes.statusText}`);
    }

    // 6) Create run (execute agent)
    const runUrl = `${projectEndpoint}/openai/agents/v1/projects/${projectId}/threads/${threadId}/runs?api-version=2024-05-01-preview`;
    const runRes = await fetch(runUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent_id: agentId,
      }),
    });

    const { json: runJson, raw: runRaw } = await safeJson(runRes);
    if (!runRes.ok) {
      throw new Error(`Create run failed (${runRes.status}): ${runRaw || runRes.statusText}`);
    }

    const runId = runJson?.id;
    if (!runId) throw new Error(`Create run missing id. Raw: ${runRaw || "(empty)"}`);

    // 7) Poll run to completion
    const finalRun = await waitForRunCompletion({
      headers,
      baseUrl: projectEndpoint,
      projectId,
      threadId,
      runId,
    });

    if (finalRun?.status !== "completed") {
      const errMsg =
        finalRun?.last_error?.message ||
        finalRun?.error?.message ||
        `Run ended with status: ${finalRun?.status}`;
      throw new Error(errMsg);
    }

    // 8) Fetch messages
    const listMsgUrl = `${projectEndpoint}/openai/agents/v1/projects/${projectId}/threads/${threadId}/messages?api-version=2024-05-01-preview`;
    const listRes = await fetch(listMsgUrl, { headers });

    const { json: listJson, raw: listRaw } = await safeJson(listRes);
    if (!listRes.ok) {
      throw new Error(`List messages failed (${listRes.status}): ${listRaw || listRes.statusText}`);
    }

    // Messages may appear under data or messages depending on schema
    const messages = listJson?.data || listJson?.messages || listJson || [];
    const text = extractAssistantText(messages);

    if (!text) {
      // Provide some debug context without leaking secrets
      throw new Error("No assistant text found in messages response.");
    }

    // 9) Return success
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { text },
    };
  } catch (err) {
    // ✅ This ensures Network->Response is never blank again
    context.log.error("ERROR in /api/plan:", err);

    return {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: {
        error: err?.message || String(err),
        stack: err?.stack || null,
      },
    };
  }
};
