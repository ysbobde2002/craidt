import { config } from "./config.js";

export function openaiConfigured() {
  return Boolean(config.openai.apiKey);
}

function stripJson(raw) {
  let text = String(raw || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return text;
}

export async function chatJson({ system, messages }) {
  if (!openaiConfigured()) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openai.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `OpenAI HTTP ${res.status}`);
  }
  const raw = data.choices?.[0]?.message?.content || "{}";
  return JSON.parse(stripJson(raw));
}

/** Normalize intent JSON so omitted options become [] (never undefined / leftover). */
export function parseIntentJson(json) {
  const options = Array.isArray(json?.options)
    ? json.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 4)
    : [];
  return {
    query: String(json?.query || "").trim(),
    max_price: json?.max_price ?? null,
    options,
    response_message: String(json?.response_message || "").trim(),
  };
}
