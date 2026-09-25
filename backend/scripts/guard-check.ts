/**
 * Checkpoint script for guard.ts + llmExplain.ts routing, against BSC testnet.
 *
 *   npx tsx scripts/guard-check.ts
 *
 * Sets a FAKE OpenAI key and intercepts every call to api.openai.com, so we can
 * prove which verdicts reach the LLM step (only "warn") without spending anything.
 */
process.env.OPENAI_API_KEY = "sk-fake-for-routing-test";
process.env.SCAM_LIST = "0x000000000000000000000000000000000000dEaD";

const realFetch = globalThis.fetch;
let llmCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("api.openai.com")) {
    llmCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: "[fake LLM sentence]" } }] }), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { runGuard } = await import("../src/guard.js");
const { explainWarn } = await import("../src/llmExplain.js");
const { env } = await import("../src/config.js");
const { parseUnits, getAddress } = await import("viem");

const from = getAddress("0xE4ca0B609C94CDC7C3E8Ae33A53E95dcc2909b33"); // demo wallet
const past = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const cases = [
  { name: "normal fresh address, small amount", to: "0x9f3a000000000000000000000000000000c0ffee", amount: "10", expect: "ok" },
  { name: "send to token contract", to: env.TOKEN_ADDRESS, amount: "10", expect: "block" },
  { name: "zero address", to: "0x0000000000000000000000000000000000000000", amount: "10", expect: "block" },
  { name: "scam list hit", to: "0x000000000000000000000000000000000000dEaD", amount: "10", expect: "block" },
  { name: "poisoned lookalike of a past recipient", to: "0x1234ffffffabcdef1234567890abcdef12345678", amount: "10", history: [past], expect: "warn" },
  { name: "fresh address + large amount (>= 500)", to: "0x9f3a000000000000000000000000000000c0ffee", amount: "600", expect: "warn" },
  { name: "contract never sent to before (canonical Create2 deployer)", to: "0x4e59b44847b379578588920cA78FbF26c0B4956C", amount: "10", expect: "warn" },
];

let fails = 0;
for (const c of cases) {
  const before = llmCalls;
  const result = await runGuard({
    token: env.TOKEN_ADDRESS,
    from,
    to: getAddress(c.to.toLowerCase()),
    amount: parseUnits(c.amount, 18),
    history: c.history,
  });
  // Same routing as server.ts: only "warn" goes to the explainer.
  if (result.verdict === "warn") result.explanation = await explainWarn(result.findings);
  const hitLlm = llmCalls - before;
  const ok = result.verdict === c.expect && (c.expect === "warn" ? hitLlm === 1 : hitLlm === 0);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(`      verdict=${result.verdict}  findings=[${result.findings.map((f) => f.code).join(", ")}]  LLM calls=${hitLlm}`);
  if (result.explanation) console.log(`      explanation: ${result.explanation}`);
}
console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILED`} — total LLM calls: ${llmCalls} (only warn verdicts may call it)`);
process.exit(fails === 0 ? 0 : 1);
