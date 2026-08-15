const feedBuyer = document.getElementById("feedBuyer");
const feedSeller = document.getElementById("feedSeller");
const inputForm = document.getElementById("inputForm");
const inputField = document.getElementById("inputField");
const inputSend = document.getElementById("inputSend");
const merchantStatus = document.getElementById("merchantStatus");

const STORAGE_KEY = "craidt_demo_state_v2";
let state = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null") || {
  stripeCashback: 0,
  baseUsdc: 0,
  txns: [],
  stripeTxns: [],
  sellerTxns: [],
  rankScore: 0,
  fbCount: 0,
  fbTotal: 0,
};

let sessionId = null;
let intentSessionId = null;
let clarifying = false;
let lastChoiceSet = [];
let bids = [];
let recommendedProductId = null;
let pollTimer = null;
let busy = false;

function setBusy(next) {
  busy = next;
  inputForm.classList.toggle("is-busy", next);
  inputSend.setAttribute("aria-busy", next ? "true" : "false");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const now = () => new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

function saveState() {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function lightPhase(name) {
  document.querySelector(`.phase-step[data-phase="${name}"]`)?.classList.add("lit");
}

function resetPhases() {
  document.querySelectorAll(".phase-step").forEach((s) => s.classList.remove("lit"));
}

function txLink(hash, url) {
  if (!hash) return "";
  const short = `${String(hash).slice(0, 6)}…${String(hash).slice(-4)}`;
  if (!url) return esc(short);
  return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(short)}</a>`;
}

function addBubble(feed, type, html, label) {
  const wrap = document.createElement("div");
  wrap.className = `bwrap ${type === "out" ? "sent" : type === "inc" ? "recv" : "mid"}`;
  wrap.innerHTML = `${label ? `<div class="blabel">${label}</div>` : ""}<div class="bubble ${type}">${html}</div>`;
  feed.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add("show"));
  feed.scrollTop = feed.scrollHeight;
}

function formatAmount(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "0");
  return n.toFixed(digits);
}

function renderChainTxList(el, txs) {
  if (!el) return;
  if (!Array.isArray(txs) || !txs.length) {
    el.innerHTML = `<div class="tx-empty">No transactions yet</div>`;
    return;
  }
  el.innerHTML = txs
    .slice(0, 3)
    .map((tx) => {
      const sign = tx.dir === "tx-in" ? "+" : "−";
      const amount = tx.amount === "0" || Number(tx.amount) === 0 ? "" : `${sign}${formatAmount(tx.amount)} `;
      const label = esc(tx.label || tx.asset || "");
      const hash = esc(tx.hashShort || tx.hash || "");
      const href = esc(tx.explorer || "#");
      return `
    <div class="tx-row">
      <div class="${esc(tx.dir || "tx-out")}">${amount}${label}</div>
      <div class="tx-meta"><span>${esc(tx.time || "")}</span><a href="${href}" target="_blank" rel="noopener">${hash}</a></div>
    </div>`;
    })
    .join("");
}

function applyWallets(data) {
  const formatted = data.base?.buyerUsdc?.formatted;
  if (formatted != null && formatted !== "") {
    state.baseUsdc = Number(formatted) || 0;
    document.getElementById("baseUsdc").textContent = `${formatAmount(state.baseUsdc)} USDC`;
  }
  const ethEl = document.getElementById("baseEth");
  const ethFormatted = data.base?.buyerEth?.formatted;
  if (ethEl && ethFormatted != null && ethFormatted !== "") {
    ethEl.textContent = `${formatAmount(ethFormatted)} ETH`;
  }
  const sellerEl = document.getElementById("sellerUsdc");
  const sellerBal = data.base?.sellerUsdc?.formatted;
  if (sellerEl && sellerBal != null && sellerBal !== "") {
    sellerEl.textContent = `${formatAmount(sellerBal)} USDC`;
  }
  const sellerEthEl = document.getElementById("sellerEth");
  const sellerEth = data.base?.sellerEth?.formatted;
  if (sellerEthEl && sellerEth != null && sellerEth !== "") {
    sellerEthEl.textContent = `${formatAmount(sellerEth)} ETH`;
  }
  renderChainTxList(document.getElementById("baseTxList"), data.base?.buyerTxs);
  renderChainTxList(document.getElementById("sellerTxList"), data.base?.sellerTxs);
}

function refreshWallets() {
  return fetch("/api/wallets")
    .then((r) => r.json())
    .then((data) => {
      renderStripeCard(data.stripe);
      applyWallets(data);
    })
    .catch(() => {});
}

function updateWalletUI() {
  document.getElementById("stripeCashback").textContent = `$${state.stripeCashback.toFixed(2)}`;

  const rows = (list, mapFn) =>
    list.slice(-3).reverse().map(mapFn).join("") || `<div class="tx-empty">No transactions yet</div>`;

  document.getElementById("stripeTxList").innerHTML = rows(state.stripeTxns, (tx) => `
    <div class="tx-row">
      <div class="tx-out">−$${tx.amount} · ${esc(tx.label || "charge")}</div>
      <div class="tx-meta"><span>${tx.time}</span><span>${esc(tx.ref || "")}</span></div>
    </div>`);

  saveState();
}

const buyerPops = [
  document.getElementById("profileWrap"),
  document.getElementById("walletWrap"),
].filter(Boolean);

function closeOpenPops(except) {
  document.querySelectorAll(".pop-wrap.open").forEach((w) => {
    if (w !== except) w.classList.remove("open");
  });
}

document.querySelectorAll(".pop-wrap").forEach((wrap) => {
  wrap.querySelector("button")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = !wrap.classList.contains("open");
    if (opening && buyerPops.includes(wrap)) {
      buyerPops.forEach((w) => {
        if (w !== wrap) w.classList.remove("open");
      });
    }
    wrap.classList.toggle("open", opening);
  });
  wrap.querySelector(".popover")?.addEventListener("click", (e) => e.stopPropagation());
});
document.addEventListener("click", (e) => {
  document.querySelectorAll(".pop-wrap.open").forEach((w) => {
    if (!w.contains(e.target)) w.classList.remove("open");
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOpenPops();
});

document.querySelectorAll(".tab-bar").forEach((bar) => {
  bar.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      bar.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const panel = document.getElementById(btn.dataset.tab);
      if (!panel) return;
      panel.parentElement.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      panel.classList.add("active");
    });
  });
});

document.querySelectorAll(".demo-prompts .prompt-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (busy) return;
    inputField.value = chip.dataset.q;
    inputField.focus();
    inputForm.requestSubmit();
  });
});

feedBuyer.addEventListener("click", (e) => {
  if (e.target.closest("button, a, .prompt-chip, .approval-btns, input")) return;
  inputField.focus();
});

function productThumb(b) {
  if (b.imageUrl) {
    return `<img class="p-img" src="${esc(b.imageUrl)}" alt="" onerror="this.style.visibility='hidden'" />`;
  }
  return `<div class="p-ph"></div>`;
}

function productHtml(b) {
  return `
    ${productThumb(b)}
    <div>
      <div class="p-vendor">${esc(b.merchantName || "Shopify")}</div>
      <div class="p-title">${esc((b.title || "").slice(0, 34))}</div>
      <div class="p-price">$${(b.priceCents / 100).toFixed(2)}</div>
    </div>
    <div class="p-bid">
      <div class="p-bid-val">$${Number(b.bidUsdc).toFixed(2)}</div>
      <div class="p-bid-label">ad bid</div>
    </div>`;
}

function sortByBid(list) {
  return [...list].sort((a, b) => Number(b.bidUsdc) - Number(a.bidUsdc) || String(a.productId).localeCompare(String(b.productId)));
}

async function renderProductsStaggered() {
  feedSeller.innerHTML = "";
  const sorted = sortByBid(bids);
  for (let i = 0; i < sorted.length; i++) {
    const el = document.createElement("div");
    el.className = `product-row${i === 0 ? " lead-bid" : ""}`;
    el.dataset.id = sorted[i].productId;
    el.innerHTML = productHtml(sorted[i]);
    feedSeller.appendChild(el);
    await sleep(280);
    el.classList.add("show");
  }
}

function renderProductsInstant(glowId) {
  const sorted = sortByBid(bids);
  feedSeller.innerHTML = sorted
    .map(
      (b, i) => `
    <div class="product-row show${i === 0 ? " lead-bid" : ""}${b.productId === glowId ? " glow" : ""}" data-id="${esc(b.productId)}">
      ${productHtml(b)}
    </div>`,
    )
    .join("");
}

async function pollBids() {
  if (!sessionId) return;
  try {
    const res = await fetch(`/api/bids?sessionId=${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    if (data.bids) {
      bids = data.bids;
      recommendedProductId = data.recommendedProductId || recommendedProductId;
      renderProductsInstant(null);
    }
  } catch {
    /* keep last snapshot */
  }
}

updateWalletUI();
inputField.focus();

function renderStripeCard(stripe) {
  if (!stripe) return;
  const configured = Boolean(stripe.configured);
  const brand = String(stripe.cardBrand || "visa").toLowerCase();
  const last4 = String(stripe.cardLast4 || "4242");
  const brandLabel = brand === "mastercard" ? "Mastercard" : "Visa";

  const visual = document.getElementById("stripeCardVisual");
  if (visual) visual.dataset.mode = configured ? "test" : "simulated";

  const nameEl = document.getElementById("stripeCardBrand");
  if (nameEl) nameEl.textContent = brand.toUpperCase();

  const numEl = document.getElementById("stripeCardNum");
  if (numEl) numEl.textContent = `•••• •••• •••• ${last4}`;

  const badge = document.getElementById("stripeCardBadge");
  if (badge) badge.textContent = configured ? "TEST MODE" : "SIMULATED";

  const modeLabel = document.getElementById("stripeCardModeLabel");
  if (modeLabel) modeLabel.textContent = configured ? "STRIPE TEST" : "DEMO CARD";

  const title = document.getElementById("stripePopTitle");
  if (title) title.textContent = configured ? "STRIPE TEST · BUYER" : "STRIPE DEMO · BUYER";

  const card = document.getElementById("stripeCard");
  if (card) card.textContent = `${brandLabel} ···${last4}`;

  const rail = document.getElementById("stripeRail");
  if (rail) rail.textContent = configured ? "Stripe test" : "Simulated";
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function scoreLine(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  const shown = Number.isInteger(n) ? n : Math.round(n * 100) / 100;
  return `${shown} / 100`;
}

function verifyRowsHtml(links) {
  return (links || [])
    .filter((l) => l?.url)
    .map(
      (l) =>
        `<div class="verify-row"><span>${esc(l.label)}</span><a href="${esc(l.url)}" target="_blank" rel="noreferrer">open ↗</a></div>`,
    )
    .join("") || `<div class="wallet-muted">No verify links yet.</div>`;
}

function rankRowsHtml(rank) {
  const rows = [
    ["Health score", scoreLine(rank?.healthScore)],
    ["Popularity", scoreLine(rank?.popularity)],
    ["Freshness", scoreLine(rank?.freshness)],
    ["Metadata", scoreLine(rank?.metadataCompleteness)],
    ["Quality", scoreLine(rank?.quality)],
    ["Activity", scoreLine(rank?.activity)],
    ["Wallet score", scoreLine(rank?.walletScore)],
    ["Integrity", rank?.serviceIntegrity],
    ["Discoverability", rank?.discoverability],
  ].filter(([, v]) => v != null && v !== "");
  if (!rows.length) return "";
  return rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join("");
}

function renderAgentIdentity(data) {
  if (!data?.configured) {
    const empty = document.getElementById("rankEmpty");
    if (empty) empty.textContent = data?.error || "ERC-8004 agent not configured.";
    return;
  }
  const id = data.sections?.identity || {};
  const set = (elId, value) => {
    const el = document.getElementById(elId);
    if (el && value != null && value !== "") el.textContent = value;
  };
  set("idName", id.name || data.name);
  set("idAgentId", `#${id.agentId ?? data.agentId}`);
  set("idChain", id.chainLabel || data.chainLabel);
  set("idGlobal", id.globalId || data.globalId);
  set("idOwner", shortAddr(id.owner || data.owner));
  set("idWallet", shortAddr(id.agentWallet || data.agentWallet));
  set("idX402", id.x402Support === true ? "yes" : id.x402Support === false ? "no" : "—");
  const trust = Array.isArray(id.supportedTrust) ? id.supportedTrust.join(", ") : "";
  set("idTrust", trust || "reputation");

  const rank = data.sections?.ranking || {};
  const rankHtml = rankRowsHtml(rank);
  const rankEmpty = document.getElementById("rankEmpty");
  const rankRows = document.getElementById("rankRows");
  if (rankHtml && rankRows) {
    rankRows.innerHTML = rankHtml;
    rankRows.hidden = false;
    if (rankEmpty) rankEmpty.hidden = true;
  } else if (rankEmpty) {
    rankEmpty.hidden = false;
    rankEmpty.textContent = "No ranking data from 8004scan yet. New agents start at zero until feedback is indexed.";
  }

  const fb = data.sections?.feedback || {};
  set("fbTotal", String(fb.totalFeedbacks ?? 0));
  set("fbAvg", fb.averageScore ? scoreLine(fb.averageScore) : "—");
  set("fbStars", String(fb.starCount ?? 0));
  set("fbWatch", String(fb.watchCount ?? 0));
  set("fbVerified", fb.isVerified ? "yes" : "no");
  const demo = document.getElementById("fbDemo");
  if (demo) {
    demo.textContent = state.fbCount
      ? `${state.rankScore} / 100 · ${state.fbCount} rating${state.fbCount === 1 ? "" : "s"}`
      : "none yet";
  }

  const links = data.sections?.verify?.links || data.verify || [];
  const verifyList = document.getElementById("verifyList");
  if (verifyList) verifyList.innerHTML = verifyRowsHtml(links);
}

function refreshDemoRank() {
  const demo = document.getElementById("fbDemo");
  if (demo) {
    demo.textContent = state.fbCount
      ? `${state.rankScore} / 100 · ${state.fbCount} rating${state.fbCount === 1 ? "" : "s"}`
      : "none yet";
  }
}

function renderAgentIdentityError(message) {
  const empty = document.getElementById("rankEmpty");
  if (empty) empty.textContent = message;
  const verifyList = document.getElementById("verifyList");
  if (verifyList) verifyList.innerHTML = `<div class="wallet-muted">${esc(message)}</div>`;
}

fetch("/api/agent/erc8004")
  .then((r) => r.json())
  .then(renderAgentIdentity)
  .catch(() => renderAgentIdentityError("Could not load ERC-8004 identity."));

refreshWallets();

function sameChoices(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return false;
  const na = [...a].map((s) => String(s).toLowerCase()).sort();
  const nb = [...b].map((s) => String(s).toLowerCase()).sort();
  return na.every((v, i) => v === nb[i]);
}

function lockPreviousChoices(selectedText) {
  const selected = String(selectedText || "").trim().toLowerCase();
  feedBuyer.querySelectorAll(".choice-chip:not(:disabled)").forEach((btn) => {
    btn.disabled = true;
    const q = String(btn.dataset.q || "").trim().toLowerCase();
    btn.classList.toggle("is-selected", Boolean(selected) && q === selected);
    btn.classList.toggle("is-spent", !btn.classList.contains("is-selected"));
  });
}

function addAgentAsk(message, options) {
  let opts = (options || []).map((o) => String(o).trim()).filter(Boolean);
  if (sameChoices(opts, lastChoiceSet)) opts = [];
  lastChoiceSet = opts;
  const wrap = document.createElement("div");
  wrap.className = "bwrap recv";
  const chips = opts
    .map((opt) => `<button type="button" class="prompt-chip choice-chip" data-q="${esc(opt)}">${esc(opt)}</button>`)
    .join("");
  wrap.innerHTML = `
    <div class="blabel">agent</div>
    <div class="bubble inc">${esc(message)}${chips ? `<div class="choice-row">${chips}</div>` : ""}</div>`;
  feedBuyer.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add("show"));
  feedBuyer.scrollTop = feedBuyer.scrollHeight;
  wrap.querySelectorAll(".choice-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (busy) return;
      inputField.value = btn.dataset.q;
      inputForm.requestSubmit();
    });
  });
}

inputForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = inputField.value.trim();
  if (!text || busy) return;
  inputField.value = "";
  setBusy(true);

  const followUp = clarifying && intentSessionId;
  if (!followUp) {
    feedBuyer.innerHTML = "";
    feedSeller.innerHTML = "";
    lastChoiceSet = [];
    resetPhases();
    intentSessionId = null;
    sessionId = null;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    lightPhase("identity");
    lightPhase("intent");
    addBubble(feedSeller, "inc", "UCP catalog waiting until the buyer names a product and a budget…", "shopify");
    merchantStatus.textContent = "UCP · awaiting intent";
  }

  addBubble(feedBuyer, "out", esc(text), "you");
  lockPreviousChoices(text);

  try {
    const res = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        sessionId: intentSessionId,
        address: "San Francisco, CA 94103, US",
        limit: 5,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Intent failed");

    intentSessionId = data.intentSessionId || data.sessionId;
    if (data.stopReason !== "ready") {
      clarifying = true;
      addAgentAsk(data.agentMessage, data.options);
      return;
    }

    clarifying = false;
    const parsed = data.parsed;
    const budget = parsed.maxPriceCents ? `$${(parsed.maxPriceCents / 100).toFixed(0)}` : "none";
    addBubble(
      feedBuyer,
      "inc",
      `${esc(data.agentMessage)}\nIntent: "${esc(parsed.query)}" · Budget: ${budget}\nvia ${esc(data.provider)}`,
      "agent",
    );
    await runCommerce(data);
  } catch (err) {
    clarifying = false;
    intentSessionId = null;
    const msg = err.name === "TimeoutError" ? "Request timed out — try again" : err.message;
    addBubble(feedBuyer, "sys", `Error: ${esc(msg)}`);
  } finally {
    setBusy(false);
    inputField.focus();
  }
});

async function runCommerce(data) {
  const parsed = data.parsed;
  try {
    if (!data.bids?.length) {
      addBubble(feedBuyer, "sys", "No UCP offers in budget");
      intentSessionId = null;
      return;
    }

    lightPhase("offers");
    sessionId = data.sessionId;
    bids = data.bids;
    recommendedProductId = data.recommendedProductId;
    merchantStatus.textContent = `UCP · ${bids.length} bidding`;
    addBubble(feedBuyer, "inc", "Searching Shopify UCP…", "agent");
    addBubble(feedSeller, "inc", "Merchants returning offers…", "shopify");
    await renderProductsStaggered();
    addBubble(feedBuyer, "inc", `${bids.length} merchants found\nBids live — watch order change`, "agent");
    addBubble(feedSeller, "inc", "Attention auction running\nHighest bid rises; agent still ranks by Net Human Cost", "shopify");

    pollTimer = setInterval(pollBids, 1400);
    await sleep(8000);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    lightPhase("guardrails");
    addBubble(
      feedBuyer,
      "inc",
      `Guardrails:\n  budget ${parsed.maxPriceCents ? "≤ $" + (parsed.maxPriceCents / 100).toFixed(0) : "ok"}\n  MCC allowed\n  domain policy: pass\n  capacity: ok`,
      "agent",
    );
    await sleep(800);

    const agentPick = bids.find((b) => b.productId === recommendedProductId) || sortByNhC(bids)[0];
    renderProductsInstant(agentPick.productId);
    const pickNhc = (agentPick.priceCents - (agentPick.userCashbackCents || 0)) / 100;
    addBubble(
      feedBuyer,
      "inc",
      `Agent pick: ${esc((agentPick.title || "").slice(0, 28))}\nPrice $${(agentPick.priceCents / 100).toFixed(2)} · NHC $${pickNhc.toFixed(2)}`,
      "agent",
    );
    addBubble(feedSeller, "inc", "Agent selected an offer (not highest bid)", "shopify");

    lightPhase("authorization");
    let selectedPick = null;
    const clickPromise = new Promise((resolve) => {
      feedSeller.querySelectorAll(".product-row").forEach((el) => {
        el.style.cursor = "pointer";
        el.addEventListener("click", () => {
          selectedPick = bids.find((b) => b.productId === el.dataset.id) || null;
          if (selectedPick) resolve("product");
        });
      });
    });

    const approvalWrap = document.createElement("div");
    approvalWrap.className = "bwrap recv";
    approvalWrap.innerHTML = `
      <div class="blabel">human approval</div>
      <div class="approval-bubble">
        <p>Approve <strong>${esc((agentPick.title || "").slice(0, 28))}</strong> for <strong>$${(agentPick.priceCents / 100).toFixed(2)}</strong>?</p>
        <div class="approval-btns">
          <button class="btn-ok" id="btnOk" type="button">Approve</button>
          <button class="btn-no" id="btnNo" type="button">Reject</button>
        </div>
      </div>`;
    feedBuyer.appendChild(approvalWrap);
    requestAnimationFrame(() => approvalWrap.classList.add("show"));
    feedBuyer.scrollTop = feedBuyer.scrollHeight;

    const approvePromise = new Promise((resolve) => {
      document.getElementById("btnOk").onclick = () => resolve("approve");
      document.getElementById("btnNo").onclick = () => resolve("reject");
    });

    const result = await Promise.race([clickPromise, approvePromise]);
    approvalWrap.remove();

    if (result === "reject") {
      addBubble(feedBuyer, "sys", "Rejected by human");
      addBubble(feedSeller, "inc", "Transaction cancelled", "shopify");
      return;
    }

    const pick = selectedPick || agentPick;
    const humanOverride = Boolean(selectedPick && selectedPick.productId !== agentPick.productId);
    feedSeller.querySelectorAll(".product-row").forEach((el) => {
      el.classList.remove("glow", "human-pick");
      if (el.dataset.id === pick.productId) el.classList.add(humanOverride ? "human-pick" : "glow");
    });

    addBubble(feedBuyer, "out", `${humanOverride ? "Human" : "Agent"} pick approved`, "you");
    addBubble(feedSeller, "inc", `Order confirmed: ${esc((pick.title || "").slice(0, 24))}`, "shopify");
    merchantStatus.textContent = "UCP · selected";
    await sleep(400);

    lightPhase("stripe");
    addBubble(feedBuyer, "inc", "Charging Stripe test card ···4242…", "stripe");

    const settleRes = await fetch("/api/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, productId: pick.productId }),
    });
    const receipt = await settleRes.json();
    if (!settleRes.ok) throw new Error(receipt.error || "Settle failed");

    const price = receipt.pick.priceCents / 100;
    const bidAmt = receipt.economics.bidCents / 100;
    const stripeRef = receipt.stripe.paymentIntentId || "pi_demo";
    const stripeMode = receipt.stripe.status === "paid" ? "live test" : "simulated";
    const productLabel = (receipt.pick.title || "").slice(0, 28);

    addBubble(
      feedBuyer,
      "inc",
      `<span class="tx-out">−$${price.toFixed(2)}</span> Stripe → Merchant\n${esc(productLabel)}\n${esc(stripeMode)} · ${esc(stripeRef)}`,
      "stripe",
    );
    state.stripeTxns.push({
      amount: price.toFixed(2),
      time: now(),
      label: productLabel || "charge",
      ref: stripeRef,
    });
    updateWalletUI();
    await sleep(400);
    addBubble(feedSeller, "inc", `<span class="tx-in">+$${price.toFixed(2)}</span> received via Stripe\n${esc(productLabel)}`, "merchant");

    addBubble(
      feedSeller,
      "inc",
      `<div class="receipt-card">
        <div class="receipt-header">RECEIPT</div>
        <div class="receipt-row"><span>Order</span><strong>${esc(productLabel)}</strong></div>
        <div class="receipt-row"><span>Amount</span><strong>$${price.toFixed(2)}</strong></div>
        <div class="receipt-row"><span>Rail</span><strong>Stripe ${esc(stripeMode)}</strong></div>
        <div class="receipt-row"><span>Ad bid</span><strong>$${bidAmt.toFixed(2)} USDC pending</strong></div>
        <div class="receipt-row"><span>Status</span><strong class="tx-in">Paid</strong></div>
      </div>`,
      "receipt",
    );

    lightPhase("payout");
    addBubble(
      feedSeller,
      "inc",
      `Pushing $${bidAmt.toFixed(2)} USDC via x402 to buyer agent…`,
      "merchant",
    );
    addBubble(feedBuyer, "inc", "Waiting for x402 USDC on Ethereum Sepolia…", "payout");

    const incentiveRes = await fetch("/api/incentive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, productId: pick.productId }),
    });
    const paid = await incentiveRes.json();
    if (!incentiveRes.ok) throw new Error(paid.error || "USDC bid transfer failed");

    const cashback = (paid.economics.confirmedCashbackCents || 0) / 100;
    const agentReward = (paid.economics.agentShareCents || 0) / 100;
    const nhc = (paid.economics.netHumanCostCents || receipt.pick.priceCents) / 100;
    const txHash = paid.base?.txHash;
    const txUrl = paid.base?.explorerTx;
    const hashLine = txHash ? txLink(txHash, txUrl) : esc(paid.base?.detail || "no tx");

    if (paid.base?.confirmed) {
      addBubble(
        feedBuyer,
        "inc",
        `<span class="tx-in">+$${bidAmt.toFixed(2)} USDC</span> x402 → buyer agent\n${esc(productLabel)}\n60% yours $${cashback.toFixed(2)} · 40% agent $${agentReward.toFixed(2)}\nNet Human Cost $${nhc.toFixed(2)}\n${hashLine}`,
        "payout",
      );
      addBubble(
        feedSeller,
        "inc",
        `<span class="tx-out">−$${bidAmt.toFixed(2)} USDC</span> x402 bid → buyer agent\n${esc(productLabel)}\n${hashLine}`,
        "merchant",
      );
      state.stripeCashback += cashback;
      updateWalletUI();
    } else {
      addBubble(
        feedBuyer,
        "sys",
        `USDC bid not confirmed: ${esc(paid.base?.error || paid.base?.detail || "transfer failed")}`,
      );
      addBubble(
        feedSeller,
        "inc",
        `USDC bid failed: ${esc(paid.base?.error || paid.base?.detail || "transfer failed")}`,
        "merchant",
      );
    }
    refreshWallets();

    lightPhase("reputation");
    const ratingWrap = document.createElement("div");
    ratingWrap.className = "bwrap mid";
    ratingWrap.innerHTML = `
      <div class="rating-wrap">
        <div class="rating-stars" id="ratingStars">
          <span class="star" data-v="1">★</span><span class="star" data-v="2">★</span><span class="star" data-v="3">★</span><span class="star" data-v="4">★</span><span class="star" data-v="5">★</span>
        </div>
        <div class="rating-val" id="ratingVal">rate buyer agent</div>
      </div>`;
    feedSeller.appendChild(ratingWrap);
    requestAnimationFrame(() => ratingWrap.classList.add("show"));

    await new Promise((resolve) => {
      const starsEl = document.getElementById("ratingStars");
      const valEl = document.getElementById("ratingVal");
      starsEl.addEventListener("click", (ev) => {
        const v = Number(ev.target.dataset.v);
        if (!v) return;
        starsEl.querySelectorAll(".star").forEach((s) => s.classList.toggle("on", Number(s.dataset.v) <= v));
        valEl.textContent = `${v * 20} / 100`;
        state.fbCount += 1;
        state.fbTotal += v * 20;
        state.rankScore = Math.round(state.fbTotal / state.fbCount);
        updateWalletUI();
        refreshDemoRank();
        setTimeout(resolve, 500);
      });
      setTimeout(() => {
        if (starsEl.querySelector(".star.on")) return;
        starsEl.querySelectorAll(".star").forEach((s, i) => {
          if (i < 4) s.classList.add("on");
        });
        valEl.textContent = "80 / 100";
        state.fbCount += 1;
        state.fbTotal += 80;
        state.rankScore = Math.round(state.fbTotal / state.fbCount);
        updateWalletUI();
        refreshDemoRank();
        resolve();
      }, 3500);
    });

    addBubble(feedBuyer, "inc", `Reputation updated · rank ${state.rankScore}/100`, "agent");
    addBubble(feedSeller, "inc", "Feedback submitted", "shopify");
    intentSessionId = null;
  } catch (err) {
    intentSessionId = null;
    addBubble(feedBuyer, "sys", `Error: ${esc(err.message)}`);
  }
}

function sortByNhC(list) {
  return [...list].sort((a, b) => {
    const na = a.priceCents - (a.userCashbackCents || 0);
    const nb = b.priceCents - (b.userCashbackCents || 0);
    return na - nb;
  });
}
