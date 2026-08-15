#!/usr/bin/env node
/**
 * Builds assets/model-pie.svg from git history.
 *
 * Counts commits that carry a `Model:` trailer (e.g. `Model: Cursor Grok 4.6`).
 * Commits without a trailer count as Cursor Grok 4.6. Tracker-bot refreshes
 * and merge commits are skipped.
 *
 * The SVG is a pie: slice area is commit share, color is model family.
 * A single-model chart shows 100% and the family name in the center.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "model-pie.svg");
const SKIP_SUBJECT = /^chore:\s*refresh model tracker$/i;

const SIZE = 420;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 168;
const GAP_DEG = 2.4;

const FAMILY_COLORS = [
  [/grok/i, "#F59E0B"],
  [/claude|anthropic/i, "#E8A87C"],
  [/gpt|openai|chatgpt/i, "#34D399"],
  [/gemini|google/i, "#60A5FA"],
  [/composer/i, "#A78BFA"],
  [/cursor/i, "#22D3EE"],
  [/copilot/i, "#93C5FD"],
  [/unattributed|human/i, "#64748B"],
];

const FALLBACK_PALETTE = [
  "#FB7185",
  "#F472B6",
  "#C084FC",
  "#818CF8",
  "#38BDF8",
  "#2DD4BF",
  "#A3E635",
  "#FBBF24",
];

function git(args) {
  return execSync(`git ${args}`, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseCommits() {
  let raw = "";
  try {
    raw = git("log --no-merges --format=%H%x00%aI%x00%s%x00%b%x1e");
  } catch {
    return [];
  }

  return raw
    .split("\x1e")
    .map((chunk) => chunk.replace(/^\n/, "").trimEnd())
    .filter(Boolean)
    .map((chunk) => {
      const [hash = "", date = "", subject = "", body = ""] = chunk.split("\x00");
      return { hash, date, subject: subject.trim(), body };
    })
    .filter((c) => c.hash && !SKIP_SUBJECT.test(c.subject));
}

function extractModel(body) {
  const match = body.match(/^Model:\s*(.+)$/im);
  if (!match) return null;
  const name = match[1].trim().replace(/\s+/g, " ");
  return name || null;
}

function groupKey(name) {
  return name.toLowerCase();
}

function colorFor(key) {
  for (const [re, color] of FAMILY_COLORS) {
    if (re.test(key)) return color;
  }
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function familyName(label) {
  const key = groupKey(label);
  if (/grok/i.test(key)) return "Grok";
  if (/claude|anthropic/i.test(key)) return "Claude";
  if (/gpt|openai|chatgpt/i.test(key)) return "GPT";
  if (/gemini|google/i.test(key)) return "Gemini";
  if (/composer/i.test(key)) return "Composer";
  if (/copilot/i.test(key)) return "Copilot";
  if (/cursor/i.test(key)) return "Cursor";
  return label.replace(/^Cursor\s+/i, "").split(/\s+/)[0] || label;
}

function collect(commits) {
  const models = new Map();

  for (const commit of commits) {
    const named = extractModel(commit.body);
    const label = named ?? "Cursor Grok 4.6";
    const key = groupKey(label);
    const existing = models.get(key);
    if (existing) {
      existing.count += 1;
      if (named && named.length > existing.label.length) existing.label = named;
    } else {
      models.set(key, {
        key,
        label,
        count: 1,
        color: colorFor(key),
      });
    }
  }

  return [...models.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
}

function polar(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: +(cx + r * Math.cos(rad)).toFixed(3),
    y: +(cy + r * Math.sin(rad)).toFixed(3),
  };
}

function pieSlice(startDeg, endDeg) {
  const sweep = endDeg - startDeg;
  const large = sweep > 180 ? 1 : 0;
  const a0 = polar(CX, CY, R, startDeg);
  const a1 = polar(CX, CY, R, endDeg);
  return `M ${CX} ${CY} L ${a0.x} ${a0.y} A ${R} ${R} 0 ${large} 1 ${a1.x} ${a1.y} Z`;
}

function centerLabel(percent, name) {
  return `
  <text x="${CX}" y="${CY - 8}" text-anchor="middle" fill="#0D1117" font-size="56" font-weight="700">${percent}%</text>
  <text x="${CX}" y="${CY + 28}" text-anchor="middle" fill="#0D1117" font-size="18" font-weight="600">${esc(name)}</text>`;
}

function render(commits, rows) {
  const total = Math.max(commits.length, 1);
  const summary = rows
    .map((r) => `${r.label} ${r.count} (${Math.round((r.count / total) * 100)}%)`)
    .join(", ");
  const desc = commits.length ? summary : "No commits yet.";

  let slices = "";
  let label = "";
  if (!commits.length || !rows.length) {
    slices = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="#30363D"/>`;
  } else if (rows.length === 1) {
    const row = rows[0];
    slices = `
  <circle cx="${CX}" cy="${CY}" r="${R}" fill="${row.color}">
    <title>${esc(`${row.label} · ${row.count} · 100%`)}</title>
  </circle>`;
    label = centerLabel(100, familyName(row.label));
  } else {
    let cursor = 0;
    slices = rows
      .map((row) => {
        const span = (row.count / total) * 360;
        const start = cursor;
        const end = cursor + span;
        cursor = end;
        const pad = span > GAP_DEG * 2 ? GAP_DEG / 2 : 0;
        const d = pieSlice(start + pad, end - pad);
        const pct = Math.round((row.count / total) * 100);
        return `
  <path d="${d}" fill="${row.color}">
    <title>${esc(`${row.label} · ${row.count} · ${pct}%`)}</title>
  </path>`;
      })
      .join("");
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-labelledby="title desc">
  <title id="title">Cursor model commit share</title>
  <desc id="desc">${esc(desc)}</desc>
  <g font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">
    ${slices}
    ${label}
  </g>
</svg>
`;
}

const commits = parseCommits();
const rows = collect(commits);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, render(commits, rows));
console.log(`Wrote ${OUT} (${commits.length} commits, ${rows.length} groups)`);
