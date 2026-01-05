
(function () {
  const $ = (id) => document.getElementById(id);
  const cfg = window.MEALPLANNER_CONFIG;

  const form = $("plannerForm");
  const out = $("output");
  const groceryOut = $("groceryList");
  const statusEl = $("status");

  const btnStop = $("btnStop");
  const btnCopy = $("btnCopy");
  const btnAmazon = $("btnAmazonCart");

  const btnIngredients = $("btnIngredients");
  const modal = $("ingredientsModal");
  const btnCloseModal = $("btnCloseModal");
  const ingredientsContent = $("ingredientsContent");

  const STORAGE_KEY_PLAN = "mealplanner_last_plan_text";
  const STORAGE_KEY_GROCERY = "mealplanner_last_grocery";

  let abort = new AbortController();

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (c) => {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  function todayAsDateInputValue() {
    const d = new Date();
    const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return tz.toISOString().slice(0, 10);
  }

  function renderPantry() {
    const pantry = cfg.approvedPantry || {};
    const parts = [];
    for (const [section, items] of Object.entries(pantry)) {
      parts.push(`<h4>${escapeHtml(section)}</h4><ul>`);
      (items || []).forEach((it) => parts.push(`<li>${escapeHtml(it)}</li>`));
      parts.push("</ul>");
    }
    ingredientsContent.innerHTML = parts.join("\n");
  }

  function amazonCartUrl(items) {
    const base = "https://www.amazon.com/gp/aws/cart/add.html";
    const params = [];
    (items || []).forEach((it, idx) => {
      const n = idx + 1;
      if (!it || !it.asin) return;
      const q = Number(it.qty || 1);
      params.push(`ASIN.${n}=${encodeURIComponent(it.asin)}`);
      params.push(`Quantity.${n}=${encodeURIComponent(String(q))}`);
    });
    params.push(`tag=${encodeURIComponent(cfg.amazonAffiliateTag || "")}`);
    return base + "?" + params.join("&");
  }

  function parseCartItemsFromText(text) {
    const re =
      /\b(B0[0-9A-Z]{8}|B[0-9A-Z]{9})\b(?:[^\n\r]*?\b(x|qty|quantity)\s*[:]?\s*(\d+))?/gi;
    const counts = new Map();
    let m;
    while ((m = re.exec(text || ""))) {
      const asin = m[1].toUpperCase();
      const qty = m[3] ? parseInt(m[3], 10) : 1;
      counts.set(asin, (counts.get(asin) || 0) + (isFinite(qty) ? qty : 1));
    }
    return Array.from(counts.entries()).map(([asin, qty]) => ({ asin, qty }));
  }

  // ✅ UPDATED: call SWA Function proxy; send only the prompt
  async function runPlanner(userText) {
    const payload = {
      prompt: userText,
      // IMPORTANT: do NOT send endpoint/agentId from the browser.
      // Backend should use environment variables for PROJECT_ENDPOINT + AGENT_ID.
    };

    setStatus("Calling /api/plan…");

    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });

    // Always read response body and log it for debugging
    const raw = await res.text();

    console.groupCollapsed(`[api/plan] ${res.status} ${res.ok ? "OK" : "FAIL"}`);
    console.log("raw response:", raw);
    console.groupEnd();

    let json;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      json = { error: raw };
    }

    if (!res.ok) {
      const msg = json?.error ? String(json.error) : raw || res.statusText;
      throw new Error(msg);
    }

    if (!json.text) throw new Error("No text returned from /api/plan");
    return json.text;
  }

  function buildPrompt(inputs) {
    const lines = [];
    lines.push(`Generate a 7-day high-protein meal plan starting on ${inputs.startDate}.`);
    lines.push(`User weight: ${inputs.weight} lbs. Target calories/day: ${inputs.calories}.`);
    lines.push(`Variety setting: ${inputs.variety}.`);
    if (inputs.allergies) lines.push(`Allergies: ${inputs.allergies}.`);
    lines.push(`Avoid items: ${inputs.avoid || "seafood"}.`);
    lines.push("Output human-readable text only with prep time and macros per item + daily totals.");
    lines.push("Include a grocery list section at the end (human-readable).");
    if (inputs.reuse) {
      const last = localStorage.getItem(STORAGE_KEY_PLAN);
      lines.push(
        last
          ? "Reuse last week’s plan where appropriate, updating dates."
          : "Reuse requested but none stored; generate new."
      );
    }
    return lines.join("\n");
  }

  function splitGroceryList(text) {
    const rx = /\n\s*(grocery list|shopping list|ingredients)\s*[:\-]?\s*\n/i;
    const m = rx.exec(text);
    if (!m) return { plan: text, grocery: "" };
    const idx = m.index;
    return { plan: text.slice(0, idx).trim(), grocery: text.slice(idx).trim() };
  }

  function renderBlock(title, text) {
    return `
      <div>
        <div class="muted" style="font-size:12px;margin-bottom:6px">${escapeHtml(title)}</div>
        <pre style="white-space:pre-wrap;margin:0">${escapeHtml(text)}</pre>
      </div>
    `;
  }

  function setOutput(planText, groceryText) {
    out.innerHTML = renderBlock("Meal Plan", planText);
    groceryOut.innerHTML = groceryText
      ? renderBlock("Grocery List", groceryText)
      : '<p class="muted">No grocery list section detected.</p>';

    btnCopy.disabled = false;

    const parsed = parseCartItemsFromText(groceryText || planText);
    const items = parsed.length ? parsed : cfg.starterCartItems || [];
    btnAmazon.removeAttribute("disabled");
    btnAmazon.href = amazonCartUrl(items);

    localStorage.setItem(STORAGE_KEY_PLAN, planText);
    localStorage.setItem(STORAGE_KEY_GROCERY, groceryText || "");
  }

  function validateConfig() {
    // Config no longer needs endpoint/agentId for runtime calls
    if (!cfg) throw new Error("Missing MEALPLANNER_CONFIG in config.js");
  }

  function setGenerating(on) {
    $("btnGenerate").disabled = on;
    btnStop.disabled = !on;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    abort = new AbortController();

    setGenerating(true);
    setStatus("Starting…");

    out.innerHTML = '<p class="muted">Generating…</p>';
    groceryOut.innerHTML = '<p class="muted">Generating…</p>';
    btnCopy.disabled = true;
    btnAmazon.setAttribute("disabled", "disabled");

    try {
      validateConfig();

      const inputs = {
        weight: $("weight").value,
        calories: $("calories").value,
        startDate: $("startDate").value,
        allergies: $("allergies").value.trim(),
        avoid: $("avoid").value.trim(),
        variety: $("variety").value,
        reuse: $("reuseLastWeek").checked,
      };

      const prompt = buildPrompt(inputs);

      setStatus("Working…");
      const text = await runPlanner(prompt);

      const s = splitGroceryList(text);
      setOutput(s.plan, s.grocery);

      setStatus("Done");
    } catch (err) {
      console.error(err);
      const msg =
        err?.name === "AbortError" ? "Request cancelled." : String(err?.message || err);

      out.innerHTML = `<p class="muted">Error:</p><pre style="white-space:pre-wrap">${escapeHtml(
        msg
      )}</pre>`;
      groceryOut.innerHTML = '<p class="muted">—</p>';
      setStatus("");
    } finally {
      setGenerating(false);
    }
  });

  btnStop.addEventListener("click", () => {
    abort.abort();
    setStatus("Stopped");
    setGenerating(false);
  });

  btnCopy.addEventListener("click", async () => {
    const t = (out.innerText || "").trim();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      setStatus("Copied");
      setTimeout(() => setStatus(""), 1200);
    } catch {
      setStatus("Copy failed");
    }
  });

  btnIngredients.addEventListener("click", () => {
    renderPantry();
    modal.showModal?.();
  });

  btnCloseModal.addEventListener("click", () => modal.close());

  $("startDate").value = todayAsDateInputValue();
})();
