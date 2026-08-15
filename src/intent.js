import { randomUUID } from "node:crypto";
import { openaiConfigured, chatJson } from "./openai.js";

const sessions = new Map();

export const SYSTEM = `You are the buyer-side shopping agent for craidt, talking in the text bar.

This is a back-and-forth conversation. One turn = one user message + one question (or a search confirmation).
Do not search Shopify yourself. The server searches UCP only after you have BOTH a product and a budget.

Turn protocol:
1. Vague situation ("it's raining, I want to go out") → query empty, ask what to order, put 2–3 product choices in options. Do not invent a budget.
2. They pick a product ("umbrella") → set query to that product. If budget is still unknown, ask for it. options may be empty.
3. They give a budget ("under $40") → set max_price. If query is already known from earlier turns, keep it (send query empty in this object if you are only capturing budget).
4. Only when product AND budget are known: response_message confirms you will search for that product under that budget.
5. If a single message already names a product AND a budget ("chocolates under $10"), set both now and confirm search. Do not ask extra questions.

Return JSON only:
{
  "query": "short searchable product phrase, or empty string",
  "max_price": null or number in USD,
  "options": ["choice A", "choice B"],
  "response_message": "one short sentence to the human"
}

Never guess a product or a price. Ask ONE question per turn.
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
  if (/^(go(ing)? out|rainy day|it'?s raining|weather|help|something|stuff|idk)$/i.test(q)) {
    return false;
  }
  return true;
}

function mergeRequirements(prior, next) {
  const query = isSearchableQuery(next.query) ? next.query.trim() : prior.query;
  const maxPriceCents =
    next.maxPriceCents && next.maxPriceCents > 0 ? next.maxPriceCents : prior.maxPriceCents;
  const options = Array.isArray(next.options) && next.options.length ? next.options : prior.options;
  return { query: query || "", maxPriceCents: maxPriceCents || null, options: options || [] };
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
  "boots",
  "shoe",
  "shoes",
  "sneaker",
  "chocolate",
  "charger",
  "cable",
  "jacket",
  "hat",
];

function parseWithRegex(text, prior) {
  const budget = extractBudgetCents(text);
  const lower = text.toLowerCase();
  const hit = PRODUCT_HINTS.find((word) => lower.includes(word));
  let query = "";
  if (hit) query = hit === "boot" ? "rain boots" : hit;
  const situational = /\b(rain|rainy|weather|go(ing)? out|cold|snow)\b/i.test(text) && !hit;
  const options = situational ? ["umbrella", "rain boots", "raincoat"] : [];
  let response_message = "";
  if (situational && !prior.query) {
    response_message = "Want me to order an umbrella, rain boots, or a raincoat?";
  } else if (!query && !prior.query) {
    response_message = "What should I order for you?";
  } else if (!(budget || prior.maxPriceCents)) {
    response_message = "What's your budget for this?";
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

function defaultQuestion(missing, req) {
  if (missing === "query") {
    return req.options?.length
      ? `Should I order ${req.options.slice(0, 3).join(", ").replace(/, ([^,]*)$/, ", or $1")}?`
      : "What should I order for you?";
  }
  return "What's your budget for this?";
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
  }.`;
  const json = await chatJson({
    system: `${SYSTEM}\n${prior}`,
    messages: [...history, { role: "user", content: text }],
  });
  return {
    query: String(json.query || "").trim(),
    maxPriceCents: dollarsToCents(json.max_price),
    options: Array.isArray(json.options) ? json.options.map(String).slice(0, 4) : [],
    response_message: String(json.response_message || "").trim(),
  };
}

function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);
  const session = {
    id: randomUUID(),
    history: [],
    requirements: emptyRequirements(),
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

  session.requirements = mergeRequirements(session.requirements, parsed);
  const missing = missingFields(session.requirements);
  const ready = missing.length === 0;
  const agentMessage = ready
    ? parsed.response_message ||
      `Searching Shopify for "${session.requirements.query}" under $${(session.requirements.maxPriceCents / 100).toFixed(0)}.`
    : parsed.response_message || defaultQuestion(missing[0], session.requirements);

  session.history.push({ role: "assistant", content: agentMessage });

  return {
    sessionId: session.id,
    stopReason: ready ? "ready" : "needs_clarification",
    agentMessage,
    options: ready ? [] : session.requirements.options || [],
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
