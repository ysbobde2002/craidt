#!/usr/bin/env node
/**
 * Eval suite: OpenAI back-and-forth, UCP search gate, Stripe + Base rails.
 *
 *   npm test
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureTurn, isSearchableQuery, missingFields, SYSTEM, chipsForTurn, looksLikeBudgetChip, isGreeting, isSurpriseMe, isBrowseMore, suggestBudgetChips } from "../src/intent.js";
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
    headers: { "Content-Type": "application/json", "X-Craidt-Eval": "1" },
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
  assert("wallet tab is Stripe", html.includes("wallet-stripe") && /STRIPE (TEST|DEMO)/.test(html));
  assert("wallet tab is Ethereum Sepolia", html.includes("ETHEREUM SEPOLIA") && html.includes("LAST 3 TRANSACTIONS"));
  assert("profile has ID Rank Feedback Verify", /data-tab="profile-identity"/.test(html) && /profile-ranking/.test(html) && /profile-verify/.test(html));
  assert("wallet ETH tab is balances and txs only", html.includes('id="wallet-base"') && html.includes("baseEth") && html.includes("baseUsdc") && !html.includes("walletVerifyList") && !html.includes("AGENT IDENTITY"));
  assert("phase rail is stripe not rain", html.includes('data-phase="stripe"') && !html.includes('data-phase="rain"'));
  assert("HTML has no Monad", !/\bMonad\b/.test(html));
  assert("HTML has no Rain card/settle", !/RAIN SCOPED|Rain →|via Rain|wallet-rain|wallet-monad/i.test(html));
  assert("app.js settles via Stripe", js.includes("Charging Stripe") && js.includes("received via Stripe"));
  assert("app.js pushes USDC bid after receipt", js.includes("/api/incentive") && js.includes("x402 → buyer agent"));
  assert("app.js payout is Ethereum Sepolia", js.includes("Ethereum Sepolia") && !/\bMonad\b/.test(js));
  assert("app.js locks prior choice chips", js.includes("lockPreviousChoices") && js.includes("is-selected"));
  assert("settle.js uses stripe + base modules", settle.includes("chargePurchase") && settle.includes("payMerchantIncentive"));
  assert("x402 pays the buyer agent", readFileSync(join(ROOT, "src/x402.js"), "utf8").includes("payTo is the buyer agent"));
  assert("settle.js has no Rain/Monad runtime", !/\bRain\b/.test(settle) && !/\bMonad\b/.test(settle));
}

console.log("\n== system prompt: back-and-forth ==");
{
  assert("prompt is multi-turn", /back-and-forth|Turn protocol/i.test(SYSTEM));
  assert("prompt forbids catalog search", /Do not search Shopify/i.test(SYSTEM));
  assert("prompt requires product and budget", /product AND budget/i.test(SYSTEM));
  assert("prompt uses rainy-day example", /raining/i.test(SYSTEM));
  assert("prompt forbids option boilerplate", /choose from these options/i.test(SYSTEM));
  assert("prompt says chips are this-turn only", /THIS turn/i.test(SYSTEM));
  assert("prompt treats greetings separately", /Greeting/i.test(SYSTEM));
  assert("prompt handles surprise-me", /surprise me/i.test(SYSTEM));
  assert("prompt caps option browsing", /Do not browse forever/i.test(SYSTEM));
  assert("prompt asks for product-scaled budgets", /realistic dollar caps/i.test(SYSTEM));
  assert("prompt forbids generic $25/$50/$100 default", /Never default to \$25\/\$50\/\$100/i.test(SYSTEM));
}

console.log("\n== clarification chips are turn-scoped ==");
{
  const gifts = ["flowers", "chocolates", "a nice bottle of wine"];
  const product = chipsForTurn("query", gifts);
  assert("product turn keeps gift chips", product.includes("flowers") && product.includes("chocolates"));
  const leaked = chipsForTurn("budget", gifts);
  assert("budget turn drops gift chips", !leaked.some((o) => /flower|chocolate|wine/i.test(o)));
  assert("budget turn uses dollar chips", leaked.every(looksLikeBudgetChip) && leaked.length >= 2);
  const candyChips = chipsForTurn("budget", [], "candy");
  assert("candy fallback is small", candyChips.includes("$5") && candyChips.includes("$8"));
  assert("candy fallback is not $100", !candyChips.includes("$100"));
  assert("umbrella fallback is mid", suggestBudgetChips("umbrella").some((o) => o === "$20" || o === "$12"));
  assert("LLM dollar chips win over fallback", chipsForTurn("budget", ["$6", "$10"], "candy").join(",") === "$6,$10");
  assert("$50 is a budget chip", looksLikeBudgetChip("$50"));
  assert("flowers is not a budget chip", !looksLikeBudgetChip("flowers"));
  assert(
    "date prompt is not a searchable query",
    !isSearchableQuery("I want to go out on a date. What should I get?"),
  );
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
    const t2opts = (t2.options || []).map((o) => String(o).toLowerCase());
    assert(
      "turn 2 chips are not rain categories",
      !t2opts.some((o) => /umbrella|raincoat|rain boots/.test(o)),
      `options=${(t2.options || []).join(",")}`,
    );

    const t3 = await captureTurn({ sessionId: sid, prompt: "under $40" });
    assert("turn 3 ready", t3.ready === true && t3.stopReason === "ready");
    assert("turn 3 keeps product", /umbrella/i.test(t3.parsed.query));
    assert("turn 3 has budget 4000 cents", t3.parsed.maxPriceCents === 4000);
    assert("turn 3 missing empty", missingFields(t3.parsed).length === 0 || t3.missing.length === 0);
    assert("turn 3 has no chips", (t3.options || []).length === 0);
  } catch (err) {
    assert("conversation eval ran", false, err.message);
  }
}

console.log("\n== date-night clarification (no leftover gift chips) ==");
{
  try {
    const t1 = await captureTurn({ prompt: "I want to go out on a date. What should I get?" });
    const sid = t1.sessionId;
    assert("date turn 1 does not search", t1.stopReason === "needs_clarification" && !t1.ready);
    assert("date turn 1 missing product", t1.missing.includes("query"));
    assert("date turn 1 copy not boilerplate", !/choose from these options/i.test(t1.agentMessage));
    const t1opts = (t1.options || []).map((o) => o.toLowerCase());
    assert(
      "date turn 1 gift chips",
      t1opts.length >= 2 && t1opts.some((o) => /flower|chocolate|wine/.test(o)),
      `options=${(t1.options || []).join(",")}`,
    );

    const t2 = await captureTurn({ sessionId: sid, prompt: "Flowers" });
    assert("date turn 2 still no UCP", t2.stopReason === "needs_clarification" && !t2.ready);
    assert("date turn 2 captured flowers", /flower/i.test(t2.parsed.query), `query=${t2.parsed.query}`);
    assert("date turn 2 still needs budget", t2.missing.includes("budget"));
    const t2opts = (t2.options || []).map((o) => String(o).toLowerCase());
    assert(
      "date turn 2 chips are not gift categories",
      !t2opts.some((o) => /chocolate|wine/.test(o) && !looksLikeBudgetChip(o)),
      `options=${(t2.options || []).join(",")}`,
    );
    assert(
      "date turn 2 chips are budget amounts",
      t2opts.length === 0 || t2opts.every(looksLikeBudgetChip),
      `options=${(t2.options || []).join(",")}`,
    );
    assert("date turn 2 copy not boilerplate", !/choose from these options/i.test(t2.agentMessage));
    assert("date turn 2 asks budget", /budget|spend/i.test(t2.agentMessage));
  } catch (err) {
    assert("date-night eval ran", false, err.message);
  }
}

console.log("\n== greetings / surprise-me / browse cap ==");
{
  assert("hola is a greeting", isGreeting("hola"));
  assert("hey is a greeting", isGreeting("hey"));
  assert("date prompt is not a greeting", !isGreeting("I want to go out on a date. What should I get?"));
  assert("surprise me detected", isSurpriseMe("suprise me") && isSurpriseMe("surprise me"));
  assert("anything else is browse not surprise", isBrowseMore("anything else?") && !isSurpriseMe("anything else?"));
  assert("more options is browse", isBrowseMore("more options?"));

  try {
    const hi = await captureTurn({ prompt: "hola" });
    assert("greeting does not search", hi.stopReason === "needs_clarification" && !hi.ready);
    assert("greeting has no date-night chips", !(hi.options || []).some((o) => /flower|chocolate|wine/i.test(o)), `options=${(hi.options || []).join(",")}`);
    assert("greeting asks what to buy", /pick up|order|buy|get/i.test(hi.agentMessage));

    const date = await captureTurn({ prompt: "I want to go out on a date. What should I get?" });
    const sid = date.sessionId;
    const surprise = await captureTurn({ sessionId: sid, prompt: "surprise me" });
    assert("surprise commits a product", isSearchableQuery(surprise.parsed.query), `query=${surprise.parsed.query}`);
    assert("surprise asks budget", surprise.missing.includes("budget"));
    assert(
      "surprise chips are budget not a new catalog",
      (surprise.options || []).every(looksLikeBudgetChip),
      `options=${(surprise.options || []).join(",")}`,
    );
    assert("surprise copy mentions the pick", /go with|budget/i.test(surprise.agentMessage));

    const d2 = await captureTurn({ prompt: "I want to go out on a date. What should I get?" });
    const sid2 = d2.sessionId;
    const else1 = await captureTurn({ sessionId: sid2, prompt: "anything else?" });
    assert("first browse still needs a product", else1.missing.includes("query"));
    const else2 = await captureTurn({ sessionId: sid2, prompt: "more options?" });
    assert("second browse commits", isSearchableQuery(else2.parsed.query), `query=${else2.parsed.query}`);
    assert("second browse asks budget", else2.missing.includes("budget"));
  } catch (err) {
    assert("greeting/surprise eval ran", false, err.message);
  }
}

console.log("\n== candy + stated max price ==");
{
  try {
    const candy = await captureTurn({ prompt: "I want candy whose max price is 10" });
    assert("candy+max is ready", candy.ready === true, `ready=${candy.ready} missing=${(candy.missing || []).join(",")}`);
    assert("candy query", /candy/i.test(candy.parsed.query), `query=${candy.parsed.query}`);
    assert("candy budget is $10", candy.parsed.maxPriceCents === 1000, `cents=${candy.parsed.maxPriceCents}`);
    assert("candy ready has no chips", (candy.options || []).length === 0);

    const coat = await captureTurn({ prompt: "give me a raincoat under $10" });
    assert("raincoat+$10 is ready", coat.ready === true, `ready=${coat.ready} missing=${(coat.missing || []).join(",")}`);
    assert("raincoat query", /raincoat/i.test(coat.parsed.query), `query=${coat.parsed.query}`);
    assert("raincoat budget is $10", coat.parsed.maxPriceCents === 1000, `cents=${coat.parsed.maxPriceCents}`);
    assert("raincoat does not re-ask budget", !/what's your budget/i.test(coat.agentMessage), `msg=${coat.agentMessage}`);
    assert("raincoat ready has no chips", (coat.options || []).length === 0);

    const ask = await captureTurn({ prompt: "I want some candy" });
    if (!ask.ready && (ask.missing || []).includes("budget")) {
      const amounts = (ask.options || []).map((o) => Number(String(o).replace(/[^0-9.]/g, "")));
      assert("candy budget chips stay under $25", amounts.length === 0 || amounts.every((n) => n > 0 && n <= 20), `options=${(ask.options || []).join(",")}`);
    } else {
      assert("candy-only either asks budget or is ready", ask.ready || (ask.missing || []).includes("query"));
    }
  } catch (err) {
    assert("candy eval ran", false, err.message);
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
    assert("wallets.base has ETH USDC and txs", Boolean(wallets.base?.buyerEth) && Boolean(wallets.base?.buyerUsdc) && Array.isArray(wallets.base?.buyerTxs));

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
    assert("settle chain is Ethereum Sepolia", /Ethereum Sepolia/i.test(receipt.base?.chain));
    assert("settle cashback waits for USDC", receipt.economics?.confirmedCashbackCents === 0);
    const paid = await post("/api/incentive", { sessionId: t3.sessionId, productId: pick.productId });
    assert("incentive split 60/40", paid.economics?.split === "60/40");
    assert(
      "incentive NHC uses confirmed cashback",
      paid.economics.netHumanCostCents ===
        paid.pick.priceCents - paid.economics.confirmedCashbackCents,
    );
    assert("incentive confirms USDC accounting", paid.base?.confirmed === true);
    assert("incentive rail is x402", paid.base?.rail === "x402");

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
