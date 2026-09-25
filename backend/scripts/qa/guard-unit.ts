/**
 * Day 2 QA, Section 2 (guard.ts) + L1 (template fallback). Unit level: calls runGuard()
 * directly, not through HTTP, so a server bug can't mask a guard bug.
 *
 *   QA_MODE=normal    → the 8 plan cases + extra edges, against local anvil after setup-local.ts
 *   QA_MODE=degraded  → RPC_URL points at a dead port: hard blocks must still be hard blocks
 *
 * Requires SCAM_LIST to contain SCAM and OPENAI_API_KEY to be empty.
 */
import { getAddress, parseUnits } from "viem";
import { env } from "../../src/config.js";
import { runGuard, type GuardResult } from "../../src/guard.js";
import { explainWarn, templateExplain } from "../../src/llmExplain.js";
import { FRESH, H, H_LOOKALIKE, P, P_LOOKALIKE, SCAM, ZERO, check, done, qaUser } from "./lib.js";

const mode = process.env.QA_MODE ?? "normal";
const OTHER_CONTRACT = getAddress(process.env.QA_OTHER_CONTRACT ?? "0x0000000000000000000000000000000000000001");
const token = env.TOKEN_ADDRESS;
const from = qaUser.address;
const tUSD = (n: string) => parseUnits(n, 18);

const g = (to: string, amount: string, history?: string[]) =>
  runGuard({ token, from, to: getAddress(to), amount: tUSD(amount), history: history?.map((a) => getAddress(a)) });
const codes = (r: GuardResult) => r.findings.map((f) => f.code).join(",") || "none";
const summary = (r: GuardResult) => `${r.verdict} [${codes(r)}]`;

if (env.OPENAI_API_KEY) throw new Error("run with OPENAI_API_KEY empty");

// ---- Hard blocks: must hold in both modes, including with the RPC dead ----
for (const [id, label, to] of [
  ["G1", "to == token", token],
  ["G1b", "to == token, lowercase", token.toLowerCase()],
  ["G2", "to == 0x0", ZERO],
  ["G3", "to on SCAM_LIST", SCAM],
  ["G3b", "to on SCAM_LIST, lowercase", SCAM.toLowerCase()],
  ["G+", "to == KurirRelayer", env.KURIR_RELAYER_ADDRESS],
] as const) {
  const r = await g(to, "10");
  check(id, `${label} → block, only block findings, has template explanation`,
    r.verdict === "block" && r.findings.every((f) => f.severity === "block") && !!r.explanation, summary(r));
}

if (mode === "degraded") {
  const r = await g(P, "10", [P]);
  check("DEG", "RPC dead: non-block send degrades to warn CHECKS_DEGRADED (not ok, not a crash)",
    r.verdict === "warn" && codes(r).includes("CHECKS_DEGRADED"), summary(r));
  done();
}

// ---- Warn / ok cases (need the on-chain state from setup-local.ts) ----
let r = await g(P_LOOKALIKE, "10");
check("G4", "near-miss of on-chain history address → warn ADDRESS_POISONING (not block)",
  r.verdict === "warn" && codes(r).includes("ADDRESS_POISONING"), summary(r));
check("G4", "poisoning finding names the real address it imitates",
  r.findings.find((f) => f.code === "ADDRESS_POISONING")?.data?.similarTo === P, r.findings[0]?.data);

r = await g(H_LOOKALIKE, "10", [H]);
check("G4b", "near-miss of client `history` address → warn ADDRESS_POISONING",
  r.verdict === "warn" && codes(r).includes("ADDRESS_POISONING"), summary(r));

r = await g(getAddress(from.slice(0, 6) + "0".repeat(32) + from.slice(-4)), "10");
check("G4c", "near-miss of the sender's OWN address → warn ADDRESS_POISONING",
  r.verdict === "warn" && codes(r).includes("ADDRESS_POISONING"), summary(r));

r = await g(FRESH, "100"); // past sends are 10 + 10 → median 10 → "large" is > 30
check("G5", "fresh address, amount 10x the sender's median → warn FRESH_ADDRESS_LARGE_SEND",
  r.verdict === "warn" && codes(r) === "FRESH_ADDRESS_LARGE_SEND", summary(r));
r = await g(FRESH, "5");
check("G5-", "control: fresh address, amount below 3x median → ok (no over-flagging)", r.verdict === "ok", summary(r));

r = await g(OTHER_CONTRACT, "5");
check("G6", "contract the sender never sent to → warn UNKNOWN_CONTRACT",
  r.verdict === "warn" && codes(r) === "UNKNOWN_CONTRACT", summary(r));

r = await g(P, "10");
check("G7", "previously-used address (on-chain history only), ordinary amount → ok, no findings",
  r.verdict === "ok" && r.findings.length === 0, summary(r));
r = await g(P, "25");
check("G7b", "previously-used address, 2.5x median → still ok", r.verdict === "ok", summary(r));

r = await g(H, "10", [H]);
check("G8", "to exactly equals a `history` entry → ok (exact match is never poisoning)",
  r.verdict === "ok" && r.findings.length === 0, summary(r));
r = await g(H.toLowerCase(), "10", [H]);
check("G8b", "exact match, different letter case → ok", r.verdict === "ok", summary(r));

// ---- L1: no API key → warn still gets a usable Indonesian template sentence ----
r = await g(P_LOOKALIKE, "10");
const text = await explainWarn(r.findings);
check("L1", "explainWarn with no key returns the template (non-empty, equals templateExplain)",
  typeof text === "string" && text.length > 20 && text === templateExplain(r.findings), text);
check("L1", "runGuard itself leaves warn explanations to the caller (no LLM inside guard)", r.explanation === undefined);

done();
