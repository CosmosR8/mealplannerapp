// api/plan/index.js
// Azure Static Web Apps Function (Node 18+)
// Purpose: POST /api/plan -> calls Azure AI Foundry Agents (Threads/Messages/Runs v1) using Entra client_credentials
// Returns: { text: "..." } always (or a helpful error message)

const { setTimeout: sleep } = require("timers/promises");

// Node 18 has fetch built-in. If not available (rare), you'd need a polyfill.
const hasFetch = typeof fetch === "function";

/**
 * Helper: safe JSON parse
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

    // Common pattern: msg.content is an array of blocks
    const content = msg.content;

    // If content is an array, walk blocks
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;

        // Newer schema patterns:
        // block = { type: "text", text: "..." }
        if (block.type === "text" && typeof block.text === "string") {
          out += block.text;
          continue;
        }

        // Some services: { type: "output_text", text: "..." }
        if (block.type === "output_text" && typeof block.text === "string") {
          out += block.text;
          continue;
        }

        // Older OpenAI-style: { type: "text", text: { value: "..." } }
        if (block.type === "text" && block.text && typeof block.text.value === "string") {
          out += block.text.value;
          continue;
        }

        // Sometimes: { text: { value } } without type
        if (block.text && typeof block.text.value === "string") {
          out += block.text.value;
          continue;
        }
      }
      continue;
    }

    // Sometimes content is already a string
    if (typeof content === "string") {
      out += content;
    }
  }

  return out.trim();
}

/**
 * Helper: get Entra token via client_credentials
 */
async function getToken({ tenantId, clientId, clientSecret }) {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  // Most Azure services accept this scope for client_credentials tokens.
  // If your tenant requires a different scope for this resource, errors will show clearly now.
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
