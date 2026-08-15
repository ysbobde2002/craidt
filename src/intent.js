import { randomUUID } from "node:crypto";
import { openaiConfigured, chatJson, parseIntentJson } from "./openai.js";

const sessions = new Map();

export const DATE_OPTIONS = ["flowers", "chocolates", "a nice bottle of wine"];
export const RAIN_OPTIONS = ["umbrella", "rain boots", "raincoat"];

export const SYSTEM = `You are the buyer-side shopping agent for craidt — a concise commerce assistant.

This is a back-and-forth conversation. One turn = one user message + one question (or a search confirmation).
Do not search Shopify yourself. The server searches UCP only after you have BOTH a product and a budget.

Sound like a shopper helping a human, not a form. One short sentence. Never say "choose from these options" or "what would you like to choose".

Turn protocol:
0. Greeting / small talk ("hola", "hi", "hey") with no shopping context → greet back in one short line, ask what they want to buy. query empty, options = []. Do NOT offer flowers/chocolates/wine (or any catalog) unless they mentioned a date, gift, rain, or a product.
1. Vague situation ("it's raining, I want to go out" / "I want to go out on a date") → query empty, ask what to pick up, put 2–3 product choices in options. Do not invent a budget.
   Date night / gift / romance only: flowers, chocolates, a nice bottle of wine.
   Rain: umbrella, rain boots, raincoat.
   Never use the date-night list as a default for unrelated messages.
2. They pick a product ("Flowers" / "umbrella" / "candy") → set query to that product. Acknowledge it. If budget is still unknown, ask the budget for THAT item only. options MUST be 2–3 realistic dollar caps for that product — candy/snacks around $5–$12, an umbrella around $15–$35, flowers around $20–$50. Never default to $25/$50/$100. Never repeat the previous product chips. Do not set max_price until they pick a chip or state a number.
3. "surprise me" / "you pick" / "whatever" → YOU pick one product (from the last options if any). Set query. Acknowledge the pick. Ask budget with realistic dollar chips for THAT product. Do not re-list the menu.
4. "anything else" / "more options" → at most ONE alternate product menu. If they ask for more again, pick one yourself, set query, ask budget with realistic dollar chips. Do not browse forever.
5. They give a budget ("under $40", "max price is $10") → set max_price to that number. If query is already known from earlier turns, keep it (send query empty in this object if you are only capturing budget). options = [].
6. Only when product AND budget are known: response_message confirms you will search for that product under that budget. options = [].
7. If a single message already names a product AND a budget ("chocolates under $10", "candy whose max price is 10"), set both now and confirm search. Do not ask extra questions.

options are for THIS turn's question only. Never copy prior-turn choices.
Asking what to buy → product names. Asking budget → realistic "$N" chips for the product, not a generic $25/$50/$100. Ready to search → [].

Return JSON only:
{
  "query": "short searchable product phrase, or empty string",
  "max_price": null or number in USD,
  "options": ["choice A", "choice B"],
  "response_message": "one short sentence to the human"
}

Never set max_price until the human picks a budget chip or states a number. Budget option chips are suggestions scaled to the product, not the user's chosen budget. Ask ONE question per turn. Do not keep generating catalogs when the human wants you to decide.
`;

function emptyRequirements() {
  return { query: "", maxPriceCents: null, options: [] };
}

export function missingFields(req) {
  const missing = [];
  if (!isSearchableQuery(req.query)) missing.push("query");
  if (!req.maxPriceCents || req.maxPriceCents <= 0) missing.push("budget");
  return missing;
}

export function isSearchableQuery(query) {
  const q = String(query || "").trim();
  if (q.length < 3) return false;
  if (
    /^(go(ing)? out|rainy day|it'?s raining|weather|help|something|stuff|idk|date( night)?|outing|gift)$/i.test(
      q,
    )
  ) {
    return false;
  }
  const lower = q.toLowerCase();
  const namedProduct = PRODUCT_HINTS.some((word) => productHintRe(word).test(lower));
  if (!namedProduct && (isDateNight(q) || isRainyOuting(q))) return false;
  if (!namedProduct && /what should i (get|buy|order)/i.test(q)) return false;
  return true;
}

export function looksLikeBudgetChip(opt) {
  const s = String(opt || "").trim();
  if (!s) return false;
  return (
    /^\$?\s*\d+(?:\.\d{1,2})?\s*(?:usd|dollars?)?$/i.test(s) ||
    /\b(?:under|below|max(?:imum)?)\s+\$?\s*\d+/i.test(s)
  );
}

function sameChip(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

/** Realistic budget chips for THIS product. LLM should supply these; this is regex/empty fallback only. */
export function suggestBudgetChips(query) {
  const q = String(query || "").toLowerCase();
  if (/\b(candy|candies|chocolate|snack|gum|lollipop|cookie|sweets?)\b/.test(q)) {
    return ["$5", "$8", "$12"];
  }
  if (/\b(flower|bouquet|rose)\b/.test(q)) return ["$20", "$35", "$50"];
  if (/\b(wine|champagne)\b/.test(q)) return ["$15", "$30", "$45"];
  if (/\b(umbrella|poncho)\b/.test(q)) return ["$12", "$20", "$35"];
  if (/\b(boot|shoe|sneaker|jacket|raincoat)\b/.test(q)) return ["$40", "$70", "$100"];
  if (/\b(blanket|candle|book|plush|toy)\b/.test(q)) return ["$12", "$20", "$35"];
  return ["$15", "$30", "$50"];
}

/** Chips must match the current question. Never inherit the previous turn's menu. */
export function chipsForTurn(missingField, rawOptions, query = "") {
  const raw = (Array.isArray(rawOptions) ? rawOptions : [])
    .map((o) => String(o).trim())
    .filter(Boolean)
    .slice(0, 4);
  if (missingField === "query") {
    return raw.filter((o) => !looksLikeBudgetChip(o));
  }
  if (missingField === "budget") {
    const budgetish = raw.filter(looksLikeBudgetChip);
    return budgetish.length ? budgetish : suggestBudgetChips(query);
  }
  return [];
}

function mergeRequirements(prior, next) {
  const query = isSearchableQuery(next.query) ? next.query.trim() : prior.query;
  const maxPriceCents =
    next.maxPriceCents && next.maxPriceCents > 0 ? next.maxPriceCents : prior.maxPriceCents;
  return { query: query || "", maxPriceCents: maxPriceCents || null, options: [] };
}

function dollarsToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function extractBudgetCents(text) {
  const under = text.match(
    /\b(?:under|below|less\s+than|max(?:imum)?|budget)\s*\$?\s*(\d+(?:\.\d{1,2})?)\b/i,
  );
  if (under) return Math.round(Number(under[1]) * 100);
  const maxPrice = text.match(
    /\bmax(?:imum)?(?:\s+price)?(?:\s+is|\s+of|:)?\s*\$?\s*(\d+(?:\.\d{1,2})?)\b/i,
  );
  if (maxPrice) return Math.round(Number(maxPrice[1]) * 100);
  const dollar = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  if (dollar) return Math.round(Number(dollar[1]) * 100);
  const bare = text.match(/^\s*(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)?\s*$/i);
  if (bare) return Math.round(Number(bare[1]) * 100);
  return null;
}

const PRODUCT_HINTS = [
  "umbrella",
  "raincoat",
  "poncho",
  "boot",
  "shoe",
  "sneaker",
  "flower",
  "chocolate",
  "candy",
  "wine",
  "charger",
  "cable",
  "jacket",
  "hat",
];

function productHintRe(word) {
  return new RegExp(`\\b${word}s?\\b`, "i");
}

function findProductHint(text) {
  const lower = String(text || "").toLowerCase();
  return PRODUCT_HINTS.find((word) => productHintRe(word).test(lower));
}

function isDateNight(text) {
  return (
    /\b(date night|on a date|romantic|anniversary|valentine)\b/i.test(text) ||
    (/\bdate\b/i.test(text) && /\b(get|gift|bring|buy|order|pick)\b/i.test(text))
  );
}

function isRainyOuting(text) {
  return /\b(rain|rainy|weather|cold|snow)\b/i.test(text);
}

export function isGreeting(text) {
  return /^(hola|hi+|hey+|hello|yo+|sup|what'?s up|howdy|gm|good (morning|afternoon|evening))[\s!?.]*$/i.test(
    String(text || "").trim(),
  );
}

export function isSurpriseMe(text) {
  const t = String(text || "").trim();
  return (
    /\b(surpri?se(\s+me)?|suprise(\s+me)?|you pick|you choose|dealer'?s choice|up to you|pick (one|for me)|whatever)\b/i.test(
      t,
    ) || /^(anything|idk|i don'?t know|not sure)\s*[?.!]*$/i.test(t)
  );
}

export function isBrowseMore(text) {
  return /\b((anything|something) else|more options|other (options|ideas)|what else|another (idea|option)|more ideas)\b/i.test(
    String(text || ""),
  );
}

function productChips(list) {
  return (list || []).map((o) => String(o).trim()).filter((o) => o && !looksLikeBudgetChip(o));
}

function pickProduct(list) {
  return productChips(list)[0] || "";
}

function commitPick(parsed, pick) {
  const query = String(pick || "").trim();
  const budgetOpts = (parsed.options || []).filter(looksLikeBudgetChip);
  return {
    ...parsed,
    query,
    options: budgetOpts,
    response_message: `I'll go with ${query}. ${budgetAsk(query)}`,
  };
}

/** Greetings, surprise-me, and browse loops — keep the agent from becoming a catalog. */
export function applyConversationalGuards(parsed, prompt, session) {
  const prior = session.requirements || emptyRequirements();
  const lastProducts = productChips(session.lastChipOptions);
  const incomingProducts = productChips(parsed.options);

  if (isGreeting(prompt) && !prior.query && !findProductHint(prompt)) {
    const msg = String(parsed.response_message || "");
    const leakedCatalog = /flower|chocolate|wine|umbrella|raincoat/i.test(msg) || incomingProducts.length > 0;
    return {
      ...parsed,
      query: "",
      options: [],
      response_message: leakedCatalog || !msg ? "Hey — what should I pick up?" : msg,
    };
  }

  if (isSurpriseMe(prompt) && !prior.query && !findProductHint(prompt)) {
    const pick = pickProduct(lastProducts) || pickProduct(incomingProducts);
    if (pick) return commitPick(parsed, pick);
    return {
      ...parsed,
      query: "",
      options: ["a small gift", "something practical"],
      response_message: "Want a small gift, or something practical?",
    };
  }

  if (isBrowseMore(prompt) && !prior.query && !findProductHint(prompt)) {
    session.browseAsks = (session.browseAsks || 0) + 1;
    if (session.browseAsks >= 2) {
      const pick = pickProduct(incomingProducts) || pickProduct(lastProducts) || DATE_OPTIONS[0];
      return commitPick(parsed, pick);
    }
    const alts = incomingProducts.length ? incomingProducts : lastProducts;
    return {
      ...parsed,
      query: "",
      options: alts,
    };
  }

  return parsed;
}

function queryFromHint(hit) {
  if (hit === "boot") return "rain boots";
  if (hit === "flower") return "flowers";
  if (hit === "chocolate") return "chocolates";
  if (hit === "candy") return "candy";
  return hit;
}

function applyStatedConstraints(parsed, prompt) {
  const statedBudget = extractBudgetCents(prompt);
  const hit = findProductHint(prompt);
  const next = { ...parsed };
  if (statedBudget) next.maxPriceCents = statedBudget;
  if (!isSearchableQuery(next.query) && hit) next.query = queryFromHint(hit);
  return next;
}

function applyChipReply(parsed, prompt, lastChipOptions) {
  const chip = (lastChipOptions || []).find((o) => sameChip(o, prompt));
  if (!chip) return parsed;
  if (looksLikeBudgetChip(chip)) {
    return {
      ...parsed,
      maxPriceCents: parsed.maxPriceCents || extractBudgetCents(chip) || extractBudgetCents(prompt),
    };
  }
  if (!isSearchableQuery(parsed.query)) {
    return { ...parsed, query: chip };
  }
  return parsed;
}

function budgetAsk(query) {
  const q = String(query || "").trim();
  if (!q) return "What's your budget?";
  if (/^(a|an|the)\s/i.test(q)) return `What's your budget for ${q}?`;
  return `What's your budget for the ${q}?`;
}

function defaultQuestion(missing, req, options) {
  const chips = options || req.options || [];
  if (missing === "query") {
    if (chips.length) {
      const list = chips.slice(0, 3).join(", ").replace(/, ([^,]*)$/, ", or $1");
      return `What should I pick up — ${list}?`;
    }
    return "What should I order for you?";
  }
  return budgetAsk(req.query);
}

function isStiffAsk(msg) {
  return /choose from (these )?options|what would you like to choose/i.test(String(msg || ""));
}

function polishMessage(msg, missing, req, options, ready) {
  const text = String(msg || "").trim();
  if (ready) {
    if (!text || /budget/i.test(text) || isStiffAsk(text)) {
      return `Searching Shopify for "${req.query}" under $${(req.maxPriceCents / 100).toFixed(0)}.`;
    }
    return text;
  }
  if (!text || isStiffAsk(text)) return defaultQuestion(missing, req, options);
  return text;
}

function preferSituationalChips(prompt, rawOptions) {
  const raw = Array.isArray(rawOptions) ? rawOptions : [];
  if (isDateNight(prompt) && !findProductHint(prompt)) {
    return raw.some((o) => /flower|chocolate|wine/i.test(o)) ? raw : [...DATE_OPTIONS];
  }
  if (isRainyOuting(prompt) && !findProductHint(prompt)) {
    return raw.some((o) => /umbrella|boot|raincoat/i.test(o)) ? raw : [...RAIN_OPTIONS];
  }
  return raw;
}

function parseWithRegex(text, prior) {
  const budget = extractBudgetCents(text);
  const hit = findProductHint(text);
  let query = hit ? queryFromHint(hit) : "";
  const dateNight = isDateNight(text) && !hit;
  const rainy = isRainyOuting(text) && !hit && !dateNight;
  let options = [];
  if (dateNight && !prior.query) options = [...DATE_OPTIONS];
  else if (rainy && !prior.query) options = [...RAIN_OPTIONS];

  let response_message = "";
  if (isGreeting(text) && !query && !prior.query) {
    response_message = "Hey — what should I pick up?";
    options = [];
  } else if (dateNight && !prior.query) {
    response_message = "Date night — flowers, chocolates, or a bottle of wine?";
  } else if (rainy && !prior.query) {
    response_message = "It's raining — umbrella, rain boots, or a raincoat?";
  } else if (!query && !prior.query) {
    response_message = "What should I order for you?";
  } else if (!(budget || prior.maxPriceCents)) {
    response_message = budgetAsk(query || prior.query);
    options = suggestBudgetChips(query || prior.query);
  } else {
    response_message = "Got it — I'll search Shopify next.";
  }
  return {
    query,
    maxPriceCents: budget,
    options,
    response_message,
  };
}

function gapHint(session) {
  const missing = missingFields(session.requirements);
  if (missing[0] === "budget") {
    return `Product is already "${session.requirements.query}". Ask budget for that item only. options MUST be 2–3 realistic dollar caps for "${session.requirements.query}" (candy → "$5","$8","$12"; umbrella → "$12","$20","$35"). Never default to $25/$50/$100. Never send product names in options. Do not set max_price until they answer.`;
  }
  if (missing[0] === "query") {
    return "Ask what to pick up. options = product names only. Do not invent a budget. Greetings get options = []. Date-night chips only if they mentioned a date/gift. Surprise-me: pick one product and ask budget.";
  }
  return "If the ask is vague, options = product names for this turn only. Do not invent a budget.";
}

async function parseWithOpenAI(text, session) {
  const history = session.history.slice(-8).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));
  const prior = `Known so far: query=${session.requirements.query || "(none)"}; budget=${
    session.requirements.maxPriceCents
      ? "$" + (session.requirements.maxPriceCents / 100).toFixed(0)
      : "(none)"
  }. ${gapHint(session)}`;
  const json = await chatJson({
    system: `${SYSTEM}\n${prior}`,
    messages: [...history, { role: "user", content: text }],
  });
  const intent = parseIntentJson(json);
  return {
    query: intent.query,
    maxPriceCents: dollarsToCents(intent.max_price),
    options: intent.options,
    response_message: intent.response_message,
  };
}

function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);
  const session = {
    id: randomUUID(),
    history: [],
    requirements: emptyRequirements(),
    lastChipOptions: [],
    browseAsks: 0,
    turn: 0,
  };
  sessions.set(session.id, session);
  return session;
}

/**
 * Multi-turn buyer intent capture.
 * Ready only when there is a searchable product query AND a budget.
 * Does not call Shopify UCP.
 */
export async function captureTurn({ sessionId, prompt }) {
  const session = getOrCreateSession(sessionId);
  session.turn += 1;
  session.history.push({ role: "user", content: prompt });

  let parsed;
  let provider = "regex";
  if (openaiConfigured()) {
    try {
      parsed = await parseWithOpenAI(prompt, session);
      provider = "openai";
    } catch {
      parsed = parseWithRegex(prompt, session.requirements);
      provider = "regex";
    }
  } else {
    parsed = parseWithRegex(prompt, session.requirements);
  }

  parsed = applyChipReply(parsed, prompt, session.lastChipOptions);
  parsed = applyConversationalGuards(parsed, prompt, session);
  parsed = applyStatedConstraints(parsed, prompt);
  session.requirements = mergeRequirements(session.requirements, parsed);
  const missing = missingFields(session.requirements);
  const ready = missing.length === 0;
  const rawOptions =
    !ready && missing[0] === "query" ? preferSituationalChips(prompt, parsed.options) : parsed.options;
  const options = ready ? [] : chipsForTurn(missing[0], rawOptions, session.requirements.query);
  session.requirements.options = options;
  session.lastChipOptions = options;

  const agentMessage = polishMessage(
    parsed.response_message,
    missing[0],
    session.requirements,
    options,
    ready,
  );

  session.history.push({ role: "assistant", content: agentMessage });

  return {
    sessionId: session.id,
    stopReason: ready ? "ready" : "needs_clarification",
    agentMessage,
    options,
    parsed: {
      raw: prompt,
      query: session.requirements.query,
      intent: prompt,
      maxPriceCents: session.requirements.maxPriceCents,
      shipTo: { country: "US", region: "CA", postalCode: "94103" },
    },
    missing,
    provider,
    ready,
  };
}

export function resetIntentSession(sessionId) {
  if (sessionId) sessions.delete(sessionId);
}
