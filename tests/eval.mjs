#!/usr/bin/env node
/**
 * Eval suite: OpenAI back-and-forth, UCP search gate, Stripe + Base rails.
 *
 *   npm test
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureTurn, isSearchableQuery, missingFields, SYSTEM } from "../src/intent.js";
import { splitIncentiveCents, netHumanCostCents } from "../src/cashback.js";
import { openaiConfigured } from "../src/openai.js";
import { ROOT } from "../src/config.js";

const BASE = process.env.EVAL_BASE || "http://localhost:5180";
let passed = 0;
let failed = 0;

function assert(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `${path} ${res.status}`);
  return data;
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10000) });
  return res.json();
}

function readUi() {
  return {
    html: readFileSync(join(ROOT, "ui/index.html"), "utf8"),
    js: readFileSync(join(ROOT, "ui/app.js"), "utf8"),
    settle: readFileSync(join(ROOT, "src/settle.js"), "utf8"),
  };
}

console.log("\n== rails: Stripe + Ethereum Sepolia, not Rain / Monad ==");
{
  const { html, js, settle } = readUi();
  assert("search bar is conversational", html.includes("It's raining and I want to go out"));
  assert("wallet tab is Stripe", html.includes("wallet-stripe") && html.includes("STRIPE TEST"));
  assert("wallet tab is Ethereum Sepolia", html.includes("ETHEREUM SEPOLIA") && html.includes("eip155:11155111"));
  assert("phase rail is stripe not rain", html.includes('data-phase="stripe"') && !html.includes('data-phase="rain"'));
  assert("HTML has no Monad", !/\bMonad\b/.test(html));
  assert("HTML has no Rain card/settle", !/RAIN SCOPED|Rain →|via Rain|wallet-rain|wallet-monad/i.test(html));
  assert("app.js settles via Stripe", js.includes("Charging Stripe") && js.includes("received via Stripe"));
  assert("app.js payout is Ethereum Sepolia", js.includes("Ethereum Sepolia") && !/\bMonad\b/.test(js));
  assert("settle.js uses stripe + base modules", settle.includes("chargePurchase") && settle.includes("recordBaseIncentive"));
  assert("settle.js has no Rain/Monad runtime", !/\bRain\b/.test(settle) && !/\bMonad\b/.test(settle));
}

console.log("\n== system prompt: back-and-forth ==");
{
  assert("prompt is multi-turn", /back-and-forth|Turn protocol/i.test(SYSTEM));
  assert("prompt forbids catalog search", /Do not search Shopify/i.test(SYSTEM));
  assert("prompt requires product and budget", /product AND budget/i.test(SYSTEM));
  assert("prompt uses rainy-day example", /raining/i.test(SYSTEM));
}

console.log("\n== cashback (midnightx402 60/40) ==");
{
  const split = splitIncentiveCents(100);
  assert("60% cashback", split.userCashbackCents === 60);
  assert("40% agent", split.agentShareCents === 40);
  assert("NHC = price − confirmed cashback", netHumanCostCents(1000, 60) === 940);
}

console.log("\n== OpenAI / intent conversation ==");
{
  let sid;
  try {
    const t1 = await captureTurn({ prompt: "it's a rainy day and I want to go out" });
    sid = t1.sessionId;
    assert("turn 1 does not search", t1.stopReason === "needs_clarification" && !t1.ready);
    assert("turn 1 missing product", t1.missing.includes("query"));
    assert("turn 1 offers choices", (t1.options || []).length >= 2);
    assert(
      "turn 1 uses OpenAI when keyed",
      !openaiConfigured() || t1.provider === "openai",
      `provider=${t1.provider}`,
    );

    const t2 = await captureTurn({ sessionId: sid, prompt: "umbrella" });
    assert("turn 2 still no UCP", t2.stopReason === "needs_clarification" && !t2.ready);
    assert("turn 2 captured product", isSearchableQuery(t2.parsed.query));
    assert("turn 2 still needs budget", t2.missing.includes("budget"));

    const t3 = await captureTurn({ sessionId: sid, prompt: "under $40" });
    assert("turn 3 ready", t3.ready === true && t3.stopReason === "ready");
    assert("turn 3 keeps product", /umbrella/i.test(t3.parsed.query));
    assert("turn 3 has budget 4000 cents", t3.parsed.maxPriceCents === 4000);
    assert("turn 3 missing empty", missingFields(t3.parsed).length === 0 || t3.missing.length === 0);
  } catch (err) {
    assert("conversation eval ran", false, err.message);
  }
}

console.log("\n== HTTP search gate + UCP + Stripe/Base settle ==");
try {
  await get("/api/wallets");
} catch (err) {
  console.log(`  skip HTTP (demo not reachable at ${BASE}: ${err.message})`);
}

{
  let reachable = true;
  try {
    await get("/api/wallets");
  } catch {
    reachable = false;
  }

  if (reachable) {
    const wallets = await get("/api/wallets");
    assert("wallets.stripe provider", wallets.stripe?.provider === "stripe");
    assert("wallets.base is Ethereum Sepolia", wallets.base?.chain === "Ethereum Sepolia" && wallets.base?.chainId === 11155111);

    const t1 = await post("/api/turn", { prompt: "it's a rainy day and I want to go out" });
    assert("HTTP turn 1 no bids", !t1.bids);
    const t2 = await post("/api/turn", { prompt: "umbrella", sessionId: t1.intentSessionId || t1.sessionId });
    assert("HTTP turn 2 no bids", !t2.bids);
    const t3 = await post("/api/turn", { prompt: "under $40", sessionId: t2.intentSessionId || t2.sessionId });
    assert("HTTP turn 3 searches UCP", t3.ready === true && Array.isArray(t3.bids) && t3.bids.length > 0);
    assert("HTTP turn 3 query is umbrella", /umbrella/i.test(t3.parsed.query));

    const pick = t3.bids[0];
    const receipt = await post("/api/settle", { sessionId: t3.sessionId, productId: pick.productId });
    assert("settle rail is Stripe", receipt.stripe?.provider === "stripe");
    assert("settle chain is Base", /Base/i.test(receipt.base?.chain));
    assert("settle split 60/40", receipt.economics?.split === "60/40");
    assert(
      "settle NHC uses confirmed cashback",
      receipt.economics.netHumanCostCents ===
        receipt.pick.priceCents - receipt.economics.confirmedCashbackCents,
    );

    let direct = await post("/api/turn", { prompt: "Find me chocolates under $10", limit: 5 });
    const sid = direct.intentSessionId || direct.sessionId;
    if (!direct.ready && (direct.missing || []).includes("budget")) {
      direct = await post("/api/turn", { prompt: "under $10", sessionId: sid, limit: 5 });
    }
    if (!direct.ready && (direct.missing || []).includes("query")) {
      direct = await post("/api/turn", { prompt: "chocolates under $10", sessionId: sid, limit: 5 });
    }
    assert(
      "chocolates prompt reaches UCP search",
      direct.ready === true && Array.isArray(direct.bids) && direct.bids.length > 0,
      `stop=${direct.stopReason} n=${direct.bids?.length} missing=${(direct.missing || []).join(",")}`,
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
