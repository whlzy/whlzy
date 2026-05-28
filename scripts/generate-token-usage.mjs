#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const ROOT = process.cwd();
const README_PATH = path.join(ROOT, "README.md");
const DATA_DIR = path.join(ROOT, "data");
const ASSETS_DIR = path.join(ROOT, "assets");
const DATA_PATH = path.join(DATA_DIR, "token-usage.json");
const SVG_PATH = path.join(ASSETS_DIR, "token-usage.svg");
const DRY_RUN = process.argv.includes("--dry-run");

const PROVIDER_LABELS = {
  codex: "Codex",
  claude: "Claude",
  vertexai: "Vertex AI",
  bedrock: "Bedrock"
};

const PROVIDER_COLORS = {
  codex: "#38bdf8",
  claude: "#f59e0b",
  vertexai: "#22c55e",
  bedrock: "#a78bfa"
};

const MODEL_COLORS = [
  "#2563eb",
  "#f97316",
  "#16a34a",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#ca8a04",
  "#db2777",
  "#0f766e",
  "#9333ea",
  "#65a30d",
  "#ea580c",
  "#0284c7",
  "#be123c"
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFileIfChanged(file, content) {
  if (DRY_RUN) return;
  ensureDir(path.dirname(file));
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
  fs.writeFileSync(file, content);
}

function formatInt(value) {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("en-US");
}

function compactInt(value) {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

function providerColor(provider) {
  return PROVIDER_COLORS[provider] || "#94a3b8";
}

function modelColor(index) {
  return MODEL_COLORS[index % MODEL_COLORS.length];
}

function timestampInfo(value) {
  if (!value || typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return {
    timestamp: iso,
    minute: iso.slice(0, 16),
    date: iso.slice(0, 10)
  };
}

function dayKeyFromTimestamp(value) {
  return timestampInfo(value)?.date || null;
}

function daysAgoKey(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function dateKeysBetween(firstDay, lastDay) {
  if (!firstDay || !lastDay) return [];
  const first = new Date(`${firstDay}T00:00:00.000Z`);
  const last = new Date(`${lastDay}T00:00:00.000Z`);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()) || first > last) return [];
  const days = [];
  for (const cursor = new Date(first); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

function continuousDays(byDay) {
  const activeDays = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (activeDays.length === 0) return [];
  const activeByDate = new Map(activeDays.map((day) => [day.date, day]));
  return dateKeysBetween(activeDays[0].date, activeDays.at(-1).date).map((date) => (
    activeByDate.get(date) || { date, totalTokens: 0 }
  ));
}

function addUsage(map, record, keyParts, grain) {
  const key = keyParts.join("\u0000");
  const existing = map.get(key) || {
    ...(grain === "minute" ? { minute: record.minute, date: record.date } : { date: record.date }),
    provider: record.provider,
    tool: record.tool,
    model: record.model || "unknown",
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    requestCount: 0,
    sources: new Set()
  };
  existing.inputTokens += record.inputTokens || 0;
  existing.cacheReadTokens += record.cacheReadTokens || record.cachedTokens || 0;
  existing.cacheCreationTokens += record.cacheCreationTokens || 0;
  existing.outputTokens += record.outputTokens || 0;
  existing.totalTokens += record.totalTokens || derivedTotalTokens(record);
  existing.costUSD += record.costUSD || 0;
  existing.requestCount += record.requestCount || 0;
  if (record.source) existing.sources.add(record.source);
  map.set(key, existing);
}

function addDailyRecord(map, record) {
  if (!record.date || !record.provider || !record.tool) return;
  addUsage(map, record, [record.date, record.provider, record.tool, record.model || "unknown"], "day");
}

function addMinuteRecord(map, record) {
  if (!record.minute || !record.date || !record.provider || !record.tool) return;
  addUsage(map, record, [record.minute, record.provider, record.tool, record.model || "unknown"], "minute");
}

function derivedTotalTokens(record) {
  const input = record.inputTokens || 0;
  const cacheRead = record.cacheReadTokens || record.cachedTokens || 0;
  const cacheCreation = record.cacheCreationTokens || 0;
  const output = record.outputTokens || 0;
  return record.provider === "codex"
    ? input + output
    : input + cacheRead + cacheCreation + output;
}

const MODEL_ALIASES = new Map([
  ["gpt-5.2", "gpt-5.2-codex"],
  ["claude-opus-4-5-20251101", "claude-opus-4-5"],
  ["claude-opus-4-5-thinking", "claude-opus-4-5"],
  ["claude-opus-4-6-thinking", "claude-opus-4-6"],
  ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
  ["claude-haiku-4-5-20251001", "claude-haiku-4-5"]
]);

function canonicalModelName(model) {
  if (!model || typeof model !== "string") return "unknown";
  const normalized = model.trim().toLowerCase();
  if (!normalized) return "unknown";
  return MODEL_ALIASES.get(normalized) || normalized;
}

function normalizeCodexModel(model) {
  return canonicalModelName(model);
}

function normalizeClaudeModel(model) {
  return canonicalModelName(model);
}

function intValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function parseCodexJsonlFile(file, events, tool) {
  let currentModel = null;
  let previousTotals = null;
  let rawTotalsBaseline = null;
  let sawDivergentTotals = false;
  let currentTurnId = null;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    if (!line.includes('"event_msg"') && !line.includes('"turn_context"')) continue;
    if (line.includes('"event_msg"') && !line.includes('"token_count"') && !line.includes('"task_started"')) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const type = obj.type;
    const time = timestampInfo(obj.timestamp);
    if (!time) continue;
    if (type === "turn_context") {
      currentModel = obj.payload?.model || obj.payload?.model_name || obj.payload?.info?.model || currentModel;
      continue;
    }
    if (type !== "event_msg") continue;
    const payload = obj.payload || {};
    if (payload.type === "task_started") {
      currentTurnId = payload.turn_id || payload.turnId || payload.id || currentTurnId;
      continue;
    }
    if (payload.type !== "token_count") continue;

    const info = payload.info || {};
    const model = normalizeCodexModel(currentModel || info.model || info.model_name || payload.model || obj.model || "codex");
    const total = info.total_token_usage;
    const last = info.last_token_usage;

    const usageTotals = (usage) => ({
      input: intValue(usage?.input_tokens),
      cached: intValue(usage?.cached_input_tokens ?? usage?.cache_read_input_tokens),
      output: intValue(usage?.output_tokens)
    });
    const addTotals = (a, b) => ({
      input: (a?.input || 0) + (b?.input || 0),
      cached: (a?.cached || 0) + (b?.cached || 0),
      output: (a?.output || 0) + (b?.output || 0)
    });
    const deltaTotals = (from, to) => ({
      input: Math.max(0, (to?.input || 0) - (from?.input || 0)),
      cached: Math.max(0, (to?.cached || 0) - (from?.cached || 0)),
      output: Math.max(0, (to?.output || 0) - (from?.output || 0))
    });
    const equalTotals = (a, b) =>
      (a?.input || 0) === (b?.input || 0)
      && (a?.cached || 0) === (b?.cached || 0)
      && (a?.output || 0) === (b?.output || 0);

    let delta = null;
    if (last) {
      const rawDelta = usageTotals(last);
      delta = rawDelta;
      if (total && !sawDivergentTotals) {
        const rawTotals = usageTotals(total);
        const totalDelta = deltaTotals(rawTotalsBaseline, rawTotals);
        if (
          rawTotalsBaseline
          && rawTotals.input >= rawTotalsBaseline.input
          && rawTotals.cached >= rawTotalsBaseline.cached
          && rawTotals.output >= rawTotalsBaseline.output
          && totalDelta.input <= rawDelta.input
          && totalDelta.cached <= rawDelta.cached
          && totalDelta.output <= rawDelta.output
        ) {
          delta = totalDelta;
        }
        const counted = addTotals(previousTotals, delta);
        previousTotals = counted;
        rawTotalsBaseline = rawTotals;
        if (!equalTotals(rawTotals, counted)) sawDivergentTotals = true;
      } else {
        previousTotals = addTotals(previousTotals, delta);
        rawTotalsBaseline = previousTotals;
      }
    } else if (total) {
      const rawTotals = usageTotals(total);
      delta = deltaTotals(rawTotalsBaseline, rawTotals);
      previousTotals = addTotals(previousTotals, delta);
      rawTotalsBaseline = rawTotals;
      if (!equalTotals(rawTotals, previousTotals)) sawDivergentTotals = true;
    }
    if (!delta) continue;
    const cacheRead = Math.min(delta.cached, delta.input);
    // Codex cached input is a subset of input tokens, so do not add it again.
    const totalTokens = delta.input + delta.output;
    if (delta.input === 0 && cacheRead === 0 && delta.output === 0) continue;
    events.push({
      id: eventId("codex", tool, currentTurnId || null, obj.timestamp, events.length),
      timestamp: time.timestamp,
      minute: time.minute,
      date: time.date,
      provider: "codex",
      tool,
      model,
      inputTokens: delta.input,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: 0,
      outputTokens: delta.output,
      totalTokens,
      requestCount: totalTokens > 0 ? 1 : 0,
      sourceId: currentTurnId || null
    });
  }
}

function walkJsonlFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonlFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function collectCodexJsonl(events) {
  const homeEntries = [
    [process.env.CODEX_HOME, "codex-env"],
    [path.join(os.homedir(), ".codex"), "codex-cli"],
    [path.join(os.homedir(), ".codex-api"), "codex-api"]
  ].filter(([home]) => Boolean(home));
  const homeTools = new Map();
  for (const [home, tool] of homeEntries) {
    const normalized = path.resolve(home);
    if (!homeTools.has(normalized)) {
      let label = tool;
      if (normalized === path.resolve(os.homedir(), ".codex")) label = "codex-cli";
      if (normalized === path.resolve(os.homedir(), ".codex-api")) label = "codex-api";
      homeTools.set(normalized, label);
    }
  }
  const roots = [];
  for (const [home, tool] of homeTools) {
    roots.push([path.join(home, "sessions"), tool]);
    roots.push([path.join(home, "archived_sessions"), tool]);
  }
  const seen = new Set();
  for (const [root, tool] of roots) {
    for (const file of walkJsonlFiles(root)) {
      if (seen.has(file)) continue;
      seen.add(file);
      parseCodexJsonlFile(file, events, tool);
    }
  }
}

function claudeRootCandidates() {
  const roots = [];
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    for (const item of configured.split(",")) {
      const raw = item.trim();
      if (!raw) continue;
      roots.push(raw.endsWith("/projects") ? raw : path.join(raw, "projects"));
    }
  }
  roots.push(path.join(os.homedir(), ".claude", "projects"));
  roots.push(path.join(os.homedir(), ".config", "claude", "projects"));
  roots.push(path.join(os.homedir(), ".claude", "transcripts"));
  return [...new Set(roots)];
}

function claudeProviderForEntry(obj, model) {
  const messageId = obj.message?.id;
  const requestId = obj.requestId;
  if (typeof messageId === "string" && messageId.includes("_vrtx_")) return "vertexai";
  if (typeof requestId === "string" && requestId.includes("_vrtx_")) return "vertexai";
  if (typeof model === "string" && model.startsWith("claude-") && model.includes("@")) return "vertexai";
  return "claude";
}

function eventId(provider, tool, sourceId, timestamp, fallback) {
  const hash = crypto
    .createHash("sha256")
    .update([provider, tool, sourceId || "event", timestamp || "unknown", fallback].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `${provider}:${tool}:${hash}`;
}

function parseClaudeJsonlFile(file, keyedRows, unkeyedRows) {
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const message = obj.message || {};
    const usage = message.usage || {};
    const model = normalizeClaudeModel(message.model);
    const time = timestampInfo(obj.timestamp);
    if (!time || model === "unknown") continue;

    const inputTokens = intValue(usage.input_tokens);
    const cacheReadTokens = intValue(usage.cache_read_input_tokens);
    const cacheCreationTokens = intValue(usage.cache_creation_input_tokens);
    const outputTokens = intValue(usage.output_tokens);
    const totalTokens = inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens;
    if (totalTokens === 0) continue;

    const row = {
      id: eventId(claudeProviderForEntry(obj, model), "claude-code", message.id || obj.uuid || null, obj.timestamp, file),
      timestamp: time.timestamp,
      minute: time.minute,
      date: time.date,
      provider: claudeProviderForEntry(obj, model),
      tool: "claude-code",
      model,
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      outputTokens,
      totalTokens,
      requestCount: 1,
      isSidechain: Boolean(obj.isSidechain),
      pathRole: file.includes("/subagents/") ? "subagent" : "parent",
      sourceId: message.id || obj.uuid || null,
      stopReason: message.stop_reason || null
    };

    const messageId = message.id;
    if (messageId) {
      const key = `${row.provider}:${messageId}`;
      keyedRows.set(key, betterClaudeRow(keyedRows.get(key), row));
    } else {
      unkeyedRows.push(row);
    }
  }
}

function betterClaudeRow(existing, candidate) {
  if (!existing) return candidate;
  const existingFinal = Boolean(existing.stopReason);
  const candidateFinal = Boolean(candidate.stopReason);
  if (existingFinal !== candidateFinal) return candidateFinal ? candidate : existing;
  if (candidate.totalTokens !== existing.totalTokens) {
    return candidate.totalTokens > existing.totalTokens ? candidate : existing;
  }
  return candidate.timestamp > existing.timestamp ? candidate : existing;
}

function collectClaudeJsonl(events) {
  const keyedRows = new Map();
  const unkeyedRows = [];
  const seen = new Set();
  for (const root of claudeRootCandidates()) {
    for (const file of walkJsonlFiles(root)) {
      if (seen.has(file)) continue;
      seen.add(file);
      parseClaudeJsonlFile(file, keyedRows, unkeyedRows);
    }
  }
  for (const row of [...keyedRows.values(), ...unkeyedRows]) {
    events.push(row);
  }
}

function claudeStatsCachePath() {
  return path.join(os.homedir(), ".claude", "stats-cache.json");
}

function applyClaudeStatsDaily(events) {
  const file = claudeStatsCachePath();
  if (!fs.existsSync(file)) return events;
  let stats;
  try {
    stats = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return events;
  }
  const dailyModelTokens = Array.isArray(stats.dailyModelTokens) ? stats.dailyModelTokens : [];
  if (dailyModelTokens.length === 0) return events;

  const nextEvents = events.filter((event) => event.provider !== "claude" || event.tool !== "claude-code");
  for (const day of dailyModelTokens) {
    const time = timestampInfo(`${day.date}T12:00:00.000Z`);
    if (!time) continue;
    for (const [rawModel, rawTokens] of Object.entries(day.tokensByModel || {})) {
      const totalTokens = intValue(rawTokens);
      if (totalTokens === 0) continue;
      const model = normalizeClaudeModel(rawModel);
      nextEvents.push({
        id: eventId("claude", "claude-code-stats-daily", model, time.timestamp, file),
        timestamp: time.timestamp,
        minute: time.minute,
        date: time.date,
        provider: "claude",
        tool: "claude-code-stats-daily",
        model,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        totalTokens,
        requestCount: 0,
        sourceId: "stats-cache",
        allocation: "daily"
      });
    }
  }
  return nextEvents;
}

function aggregateEvents(events) {
  const dailyMap = new Map();
  const minuteMap = new Map();
  for (const event of events) {
    addDailyRecord(dailyMap, event);
    addMinuteRecord(minuteMap, event);
  }
  return {
    dailyRecords: serializeAggregateRecords(dailyMap),
    minuteRecords: serializeAggregateRecords(minuteMap)
  };
}

function serializeAggregateRecords(records) {
  return [...records.values()]
    .map((record) => ({
      ...(record.minute ? { minute: record.minute } : {}),
      date: record.date,
      provider: record.provider,
      tool: record.tool,
      model: record.model,
      inputTokens: record.inputTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheCreationTokens: record.cacheCreationTokens,
      cachedTokens: record.cacheReadTokens + record.cacheCreationTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      costUSD: Number(record.costUSD.toFixed(8)),
      requestCount: record.requestCount
    }))
    .sort((a, b) =>
      (a.minute || a.date).localeCompare(b.minute || b.date)
      || a.provider.localeCompare(b.provider)
      || a.tool.localeCompare(b.tool)
      || a.model.localeCompare(b.model));
}

function serializeEvents(events) {
  return events
    .map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      minute: event.minute,
      date: event.date,
      provider: event.provider,
      tool: event.tool,
      model: event.model,
      inputTokens: event.inputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      cachedTokens: event.cacheReadTokens + event.cacheCreationTokens,
      outputTokens: event.outputTokens,
      totalTokens: event.totalTokens,
      requestCount: event.requestCount,
      sourceId: event.sourceId
    }))
    .sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp)
      || a.provider.localeCompare(b.provider)
      || a.tool.localeCompare(b.tool)
      || a.model.localeCompare(b.model)
      || a.id.localeCompare(b.id));
}

function summarize(records) {
  const byProvider = new Map();
  const byDay = new Map();
  const byModel = new Map();
  const cutoff7 = daysAgoKey(6);
  const cutoff30 = daysAgoKey(29);
  let totals = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    requestCount: 0,
    last7Tokens: 0,
    last30Tokens: 0
  };

  for (const record of records) {
    applySummaryRecord(record, true);
  }

  function applySummaryRecord(record, includeDatedWindows) {
    totals.inputTokens += record.inputTokens;
    totals.cacheReadTokens += record.cacheReadTokens;
    totals.cacheCreationTokens += record.cacheCreationTokens;
    totals.cachedTokens += record.cacheReadTokens + record.cacheCreationTokens;
    totals.outputTokens += record.outputTokens;
    totals.totalTokens += record.totalTokens;
    totals.costUSD += record.costUSD;
    totals.requestCount += record.requestCount;
    if (includeDatedWindows && record.date >= cutoff7) totals.last7Tokens += record.totalTokens;
    if (includeDatedWindows && record.date >= cutoff30) totals.last30Tokens += record.totalTokens;

    const provider = byProvider.get(record.provider) || {
      provider: record.provider,
      label: PROVIDER_LABELS[record.provider] || record.provider,
      totalTokens: 0,
      last7Tokens: 0,
      last30Tokens: 0,
      costUSD: 0,
      requestCount: 0,
      firstSeen: record.date || null,
      lastSeen: record.date || null,
      models: new Set(),
      modelTotals: new Map(),
      tools: new Set()
    };
    provider.totalTokens += record.totalTokens;
    provider.costUSD += record.costUSD;
    provider.requestCount += record.requestCount;
    if (record.date) {
      provider.firstSeen = provider.firstSeen && provider.firstSeen < record.date ? provider.firstSeen : record.date;
      provider.lastSeen = provider.lastSeen && provider.lastSeen > record.date ? provider.lastSeen : record.date;
    }
    if (includeDatedWindows && record.date >= cutoff7) provider.last7Tokens += record.totalTokens;
    if (includeDatedWindows && record.date >= cutoff30) provider.last30Tokens += record.totalTokens;
    provider.models.add(record.model);
    provider.modelTotals.set(record.model, (provider.modelTotals.get(record.model) || 0) + record.totalTokens);
    provider.tools.add(record.tool);
    byProvider.set(record.provider, provider);

    if (includeDatedWindows && record.date) {
      const day = byDay.get(record.date) || { date: record.date, totalTokens: 0 };
      day.totalTokens += record.totalTokens;
      byDay.set(record.date, day);
    }

    const modelKey = `${record.provider}:${record.model}`;
    const model = byModel.get(modelKey) || {
      provider: record.provider,
      model: record.model,
      totalTokens: 0
    };
    model.totalTokens += record.totalTokens;
    byModel.set(modelKey, model);
  }

  totals.costUSD = Number(totals.costUSD.toFixed(8));
  const days = continuousDays(byDay);
  return {
    generatedAt: new Date().toISOString(),
    range: {
      firstDay: days[0]?.date || null,
      lastDay: days.at(-1)?.date || null
    },
    totals,
    providers: [...byProvider.values()]
      .map((item) => ({
        ...item,
        costUSD: Number(item.costUSD.toFixed(8)),
        models: [...item.modelTotals.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([model]) => model),
        modelTotals: undefined,
        tools: [...item.tools].sort()
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    days,
    models: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  };
}

function markdownTable(summary) {
  const rows = summary.providers.map((provider) => {
    return [
      provider.label,
      compactInt(provider.totalTokens),
      compactInt(provider.last30Tokens),
      compactInt(provider.last7Tokens),
      provider.models.slice(0, 3).join(", ") || "-",
      provider.lastSeen || "-"
    ];
  });
  const table = [
    "| Tool | All-time tokens | 30d | 7d | Top models | Last seen |",
    "| --- | ---: | ---: | ---: | --- | --- |",
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`)
  ].join("\n");
  return table;
}

function markdownCell(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function chartBarLayout(count, width) {
  if (count <= 0) return { gap: 0, barWidth: 0, step: 0 };
  const desiredGap = count > 110 ? 1 : 2;
  const maxGap = count > 1 ? width / (count - 1) : 0;
  const gap = count > 1 ? Math.min(desiredGap, maxGap * 0.45) : 0;
  const barWidth = Math.max(0, (width - gap * (count - 1)) / count);
  return { gap, barWidth, step: barWidth + gap };
}

function svgNumber(value) {
  return Number(value.toFixed(3));
}

function sparkline(days, width, height) {
  const recent = days.slice(-30);
  const max = Math.max(1, ...recent.map((day) => day.totalTokens));
  const gap = 3;
  const barWidth = Math.max(3, Math.floor((width - gap * (recent.length - 1)) / Math.max(1, recent.length)));
  return recent.map((day, index) => {
    const h = Math.max(2, Math.round((day.totalTokens / max) * height));
    const x = index * (barWidth + gap);
    const y = height - h;
    const opacity = 0.38 + 0.62 * (day.totalTokens / max);
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="2" fill="#38bdf8" opacity="${opacity.toFixed(2)}"><title>${day.date}: ${formatInt(day.totalTokens)} tokens</title></rect>`;
  }).join("");
}

function providerDaySeries(dailyRecords, providers, days) {
  const daySet = new Set(days);
  const providerSet = new Set(providers.map((provider) => provider.provider));
  const byDayProvider = new Map();
  for (const record of dailyRecords) {
    if (!daySet.has(record.date) || !providerSet.has(record.provider)) continue;
    const key = `${record.date}\u0000${record.provider}`;
    byDayProvider.set(key, (byDayProvider.get(key) || 0) + record.totalTokens);
  }
  return days.map((date) => ({
    date,
    totalTokens: providers.reduce((sum, provider) => sum + (byDayProvider.get(`${date}\u0000${provider.provider}`) || 0), 0),
    providers: providers.map((provider) => ({
      provider: provider.provider,
      totalTokens: byDayProvider.get(`${date}\u0000${provider.provider}`) || 0
    }))
  }));
}

function formatDateLabel(date) {
  const [, month, day] = date.split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = Number(month) - 1;
  return `${monthNames[monthIndex] || month} ${Number(day)}`;
}

function rankingDaySeries(summary, maxModels = 12) {
  const days = summary.days.map((day) => day.date);
  const topModels = summary.models.slice(0, maxModels);
  const topKeys = new Set(topModels.map((model) => `${model.provider}\u0000${model.model}`));
  const rows = new Map(days.map((date) => [date, {
    date,
    totalTokens: 0,
    segments: [
      ...topModels.map((model, index) => ({
        key: `${model.provider}\u0000${model.model}`,
        label: model.model,
        provider: model.provider,
        color: modelColor(index),
        totalTokens: 0
      })),
      {
        key: "__other__",
        label: "other",
        provider: "other",
        color: "#d6d6d6",
        totalTokens: 0
      }
    ]
  }]));

  for (const record of summary.dailyRecords || []) {
    const row = rows.get(record.date);
    if (!row) continue;
    const key = `${record.provider}\u0000${record.model}`;
    const segment = row.segments.find((item) => item.key === (topKeys.has(key) ? key : "__other__"));
    if (!segment) continue;
    segment.totalTokens += record.totalTokens;
    row.totalTokens += record.totalTokens;
  }
  return [...rows.values()];
}

function stackedRankingBars(summary, width, height) {
  const series = rankingDaySeries(summary);
  const max = Math.max(1, ...series.map((day) => day.totalTokens));
  const { barWidth, step } = chartBarLayout(series.length, width);
  return series.map((day, index) => {
    let yCursor = height;
    const x = index * step;
    const segments = day.segments.map((item) => {
      if (item.totalTokens <= 0) return "";
      const segmentHeight = Math.max(1, Math.round((item.totalTokens / max) * height));
      yCursor -= segmentHeight;
      return `<rect x="${svgNumber(x)}" y="${Math.max(0, yCursor)}" width="${svgNumber(barWidth)}" height="${segmentHeight}" fill="${item.color}"><title>${day.date} · ${escapeXml(item.label)}: ${formatInt(item.totalTokens)}</title></rect>`;
    }).join("");
    return `${segments}`;
  }).join("");
}

function rankingAxis(summary, width, height) {
  const days = summary.days.map((day) => day.date);
  if (!days.length) return "";
  const ticks = 7;
  const { barWidth, step: barStep } = chartBarLayout(days.length, width);
  const step = Math.max(1, Math.floor((days.length - 1) / Math.max(1, ticks - 1)));
  const indexes = [];
  for (let index = 0; index < days.length; index += step) indexes.push(index);
  return indexes.map((index) => {
    const x = index * barStep;
    const anchor = index === 0 ? "start" : "middle";
    const textX = anchor === "middle" ? x + barWidth / 2 : x;
    return `<text x="${svgNumber(textX)}" y="${height + 34}" text-anchor="${anchor}" class="tick">${formatDateLabel(days[index])}</text>`;
  }).join("");
}

function yAxisLabels(maxTokens, height, width) {
  return [0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = height - ratio * height;
    return `
      <line x1="0" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}" class="grid"/>
      <text x="-26" y="${(y + 7).toFixed(1)}" text-anchor="end" class="axis">${compactInt(maxTokens * ratio)}</text>`;
  }).join("");
}

function rankingLegend(summary) {
  return summary.models.slice(0, 8).map((model, index) => {
    const x = index % 4 * 295;
    const y = Math.floor(index / 4) * 27;
    return `
      <rect x="${x}" y="${y}" width="11" height="11" rx="2" fill="${modelColor(index)}"/>
      <text x="${x + 18}" y="${y + 11}" class="legend">${escapeXml(model.model.slice(0, 26))}</text>`;
  }).join("");
}

function svgCard(summary) {
  const baseWidth = 2048;
  const baseHeight = 980;
  const crop = {
    left: 36,
    top: 72,
    right: 48,
    bottom: 24
  };
  const width = baseWidth - crop.left - crop.right;
  const height = baseHeight - crop.top - crop.bottom;
  const updated = summary.generatedAt.replace("T", " ").slice(0, 16) + " UTC";
  const chartX = 150;
  const chartY = 225;
  const chartWidth = 1798;
  const chartHeight = 610;
  const maxTokens = Math.max(1, ...summary.days.map((day) => day.totalTokens));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="${crop.left} ${crop.top} ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">AI token usage visualization</title>
  <desc id="desc">A profile ranking chart showing local AI token usage by day and model.</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .title { fill: #20242a; font-size: 46px; font-weight: 760; }
    .subtitle { fill: #5f6671; font-size: 30px; font-weight: 420; }
    .section { fill: #606773; font-size: 38px; font-weight: 650; }
    .axis { fill: #666; font-size: 24px; font-weight: 420; }
    .tick { fill: #666; font-size: 24px; font-weight: 420; }
    .legend { fill: #5f6671; font-size: 24px; font-weight: 500; }
    .metric { fill: #20242a; font-size: 24px; font-weight: 650; }
    .grid { stroke: #eceff3; stroke-width: 1; }
    .icon { fill: #606773; }
  </style>
  <rect x="${crop.left}" y="${crop.top}" width="${width}" height="${height}" fill="#ffffff"/>
  <text x="58" y="116" class="title">Token Usage</text>

  <g transform="translate(${chartX}, ${chartY})">
    ${yAxisLabels(maxTokens, chartHeight, chartWidth)}
    <g>
      ${stackedRankingBars(summary, chartWidth, chartHeight)}
    </g>
    ${rankingAxis(summary, chartWidth, chartHeight)}
  </g>
  <g transform="translate(150, 908)">
    ${rankingLegend(summary)}
  </g>
</svg>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function updateReadme(summary) {
  const start = "<!-- TOKEN_USAGE_START -->";
  const end = "<!-- TOKEN_USAGE_END -->";
  const current = fs.existsSync(README_PATH) ? fs.readFileSync(README_PATH, "utf8") : `${start}\n${end}\n`;
  const block = [
    start,
    "![AI token usage](./assets/token-usage.svg)",
    "",
    markdownTable(summary),
    "",
    `<sub>Updated ${summary.generatedAt}. Full normalized data: [data/token-usage.json](./data/token-usage.json).</sub>`,
    end
  ].join("\n");
  const next = current.includes(start) && current.includes(end)
    ? current.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block)
    : `${current.trim()}\n\n${block}\n`;
  writeFileIfChanged(README_PATH, next);
}

function main() {
  const events = [];
  collectCodexJsonl(events);
  collectClaudeJsonl(events);
  const usageEvents = serializeEvents(applyClaudeStatsDaily(events));
  const { dailyRecords, minuteRecords } = aggregateEvents(usageEvents);
  const summary = summarize(dailyRecords);
  summary.dailyRecords = dailyRecords;
  summary.minuteRecords = minuteRecords;
  summary.eventCount = usageEvents.length;
  const payload = {
    ...summary,
    grain: {
      events: "individual token usage event",
      minuteRecords: "minute/provider/tool/model aggregate",
      dailyRecords: "day/provider/tool/model aggregate"
    },
    usageEvents,
    minuteRecords,
    dailyRecords,
    records: dailyRecords
  };

  writeFileIfChanged(DATA_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileIfChanged(SVG_PATH, svgCard(summary));
  updateReadme(summary);

  console.log(
    `Generated ${usageEvents.length} events, ${minuteRecords.length} minute rows, `
      + `${dailyRecords.length} daily rows across ${summary.providers.length} providers.`);
  console.log(`Total tokens: ${formatInt(summary.totals.totalTokens)}`);
}

main();
