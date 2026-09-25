/**
 * Day 2 QA, L2: with an LLM configured, warn explanations are a real Bahasa sentence — not JSON, not
 * English, not the silent template fallback. Runs the real explainWarn() path, N times per case.
 * Free when pointed at a local model:
 *
 *   LLM_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen3:4b-instruct npx tsx scripts/qa/l2-llm.ts
 */
import { explainWarn, llmEnabled, templateExplain } from "../../src/llmExplain.js";
import { env } from "../../src/config.js";
import type { Finding } from "../../src/guard.js";
import { check, done } from "./lib.js";

if (!llmEnabled) throw new Error("configure an LLM (LLM_BASE_URL) first");
const RUNS = Number(process.env.QA_RUNS ?? 3);
const real = "0xa0DdF5669C3F11CF6c5131509a5271C94708B002";
const w = (code: Finding["code"], data?: Finding["data"]): Finding => ({ code, severity: "warn", message: "", data });
const cases: [string, Finding[]][] = [
  ["poisoning (demo moment 2)", [w("ADDRESS_POISONING", { similarTo: real, differingChars: 30, isOwnAddress: false })]],
  ["poisoning of own address", [w("ADDRESS_POISONING", { similarTo: real, differingChars: 30, isOwnAddress: true })]],
  ["fresh address, large send", [w("FRESH_ADDRESS_LARGE_SEND", { comparedTo: "median_past_send" })]],
  ["unknown contract", [w("UNKNOWN_CONTRACT")]],
  ["poisoning + degraded", [w("ADDRESS_POISONING", { similarTo: real, differingChars: 30, isOwnAddress: false }), w("CHECKS_DEGRADED")]],
];

// Words that only make sense in Indonesian; an English or empty answer has none of them.
const ID_WORDS = /\b(ini|itu|yang|dan|tapi|kamu|nggak|udah|lagi|dulu|sama|mirip|alamat|cek|banget|sebelum|kirim|ya|aja|dari|ke|di)\b/gi;
const EN_ONLY = /\b(the|this|that|please|address is|you have|before sending|check the)\b/i;
const FORBIDDEN = /\b(aman|diblok|jangan kirim|batalin)\b/i; // prompt rules: warn is final, no "safe"/"blocked"/"don't send"

const latencies: number[] = [];
let fallbacks = 0;
for (const [name, findings] of cases) {
  const tpl = templateExplain(findings);
  for (let k = 1; k <= RUNS; k++) {
    const t = Date.now();
    const s = await explainWarn(findings);
    const ms = Date.now() - t;
    latencies.push(ms);
    const words = s.split(/\s+/).filter(Boolean).length;
    const idHits = (s.match(ID_WORDS) ?? []).length;
    const isFallback = s === tpl;
    if (isFallback) fallbacks++;
    const problems = [
      isFallback && "TEMPLATE FALLBACK (LLM failed/timed out)",
      /[{}[\]]|"\w+":/.test(s) && "looks like JSON",
      /<\/?think>/.test(s) && "leaked <think>",
      s.includes("\n") && "multi-line",
      words > 30 && `${words} words > 30`,
      idHits < 2 && "not Indonesian",
      EN_ONLY.test(s) && "English phrasing",
      FORBIDDEN.test(s) && `forbidden word: ${s.match(FORBIDDEN)![0]}`,
      name.startsWith("poisoning") && !name.includes("own") && !/30|tiga puluh/.test(s) && "no specific (30 chars)",
    ].filter(Boolean);
    check("L2", `${name} #${k} (${ms} ms, ${words} words)`, problems.length === 0, problems.length ? `${problems.join("; ")} | ${s}` : s);
  }
}
const sorted = [...latencies].sort((a, b) => a - b);
console.log(`\nmodel ${env.OPENAI_MODEL} @ ${env.LLM_BASE_URL}, timeout ${env.LLM_TIMEOUT_MS} ms`);
console.log(`latency ms: min ${sorted[0]}, median ${sorted[Math.floor(sorted.length / 2)]}, max ${sorted.at(-1)} | template fallbacks: ${fallbacks}/${latencies.length}`);
done();
