/**
 * Compare LLM-written explanations against the Bahasa templates, through the real
 * explainWarn() path, with timings.
 *
 *   LLM_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen3:4b npx tsx scripts/llm-compare.ts
 *
 * A result identical to the template means the LLM call failed or timed out and the
 * fallback was used (the reason is logged by llmExplain).
 */
import type { Finding } from "../src/guard.js";
import { explainWarn, llmEnabled, templateExplain } from "../src/llmExplain.js";
import { env } from "../src/config.js";

if (!llmEnabled) throw new Error("Set LLM_BASE_URL (or OPENAI_API_KEY) to compare");

const cases: { name: string; findings: Finding[] }[] = [
  {
    name: "poisoning: lookalike of a past recipient (demo moment 2)",
    findings: [{ code: "ADDRESS_POISONING", severity: "warn", message: "", data: { similarTo: "0xa0DdF5669C3F11CF6c5131509a5271C94708B002", differingChars: 6, isOwnAddress: false } }],
  },
  {
    name: "poisoning: lookalike of your own wallet",
    findings: [{ code: "ADDRESS_POISONING", severity: "warn", message: "", data: { similarTo: "0xE4ca0B609C94CDC7C3E8Ae33A53E95dcc2909b33", differingChars: 5, isOwnAddress: true } }],
  },
  { name: "fresh address + large amount", findings: [{ code: "FRESH_ADDRESS_LARGE_SEND", severity: "warn", message: "" }] },
  { name: "contract never sent to before", findings: [{ code: "UNKNOWN_CONTRACT", severity: "warn", message: "" }] },
  {
    name: "two findings at once",
    findings: [
      { code: "UNKNOWN_CONTRACT", severity: "warn", message: "" },
      { code: "FRESH_ADDRESS_LARGE_SEND", severity: "warn", message: "" },
    ],
  },
];

console.log(`model ${env.OPENAI_MODEL} @ ${env.LLM_BASE_URL} | timeout ${env.LLM_TIMEOUT_MS} ms\n`);
const times: number[] = [];
let fallbacks = 0;
for (const c of cases) {
  const template = templateExplain(c.findings);
  const t = Date.now();
  const text = await explainWarn(c.findings);
  const ms = Date.now() - t;
  times.push(ms);
  const fellBack = text === template;
  if (fellBack) fallbacks++;
  console.log(`■ ${c.name}  [${(ms / 1000).toFixed(1)} s${fellBack ? ", FELL BACK TO TEMPLATE" : ""}]`);
  console.log(`  LLM:      ${text}`);
  console.log(`  template: ${template}\n`);
}
const sorted = [...times].sort((a, b) => a - b);
console.log(`timings: ${times.map((m) => (m / 1000).toFixed(1)).join(" / ")} s  (median ${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(1)} s) | fallbacks: ${fallbacks}/${cases.length}`);
