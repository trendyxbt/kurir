/**
 * Day 2 QA re-test of QA2-2 (full poisoning history). LOCAL ANVIL, after setup-local.ts.
 * The two setup relays to P sit in early blocks. With a tiny recent window, P is only "known"
 * if the guard really scans from KURIR_DEPLOY_BLOCK.
 *
 *   QA_HIST=chunked   LOG_LOOKBACK_BLOCKS=2 LOG_CHUNK_BLOCKS=3                  → full scan, many chunks
 *   QA_HIST=control   KURIR_DEPLOY_BLOCK unset, LOG_LOOKBACK_BLOCKS=2           → old behaviour (proves the test can fail)
 *   QA_HIST=fallback  LOG_LOOKBACK_BLOCKS=2 LOG_CHUNK_BLOCKS=3 LOG_MAX_CHUNKS=1 → full scan refused
 */
import { parseUnits } from "viem";
import { env, publicClient } from "../../src/config.js";
import { runGuard } from "../../src/guard.js";
import { P, P_LOOKALIKE, check, done, qaUser } from "./lib.js";

const mode = process.env.QA_HIST;
const latest = await publicClient.getBlockNumber();
const g = (to: `0x${string}`) => runGuard({ token: env.TOKEN_ADDRESS, from: qaUser.address, to, amount: parseUnits("10", 18) });
const codes = (r: Awaited<ReturnType<typeof g>>) => `${r.verdict} [${r.findings.map((f) => f.code).join(",") || "none"}]`;
const chunks = env.KURIR_DEPLOY_BLOCK === undefined ? 0 : Math.ceil(Number(latest - env.KURIR_DEPLOY_BLOCK + 1n) / Number(env.LOG_CHUNK_BLOCKS));
console.log(`latest=${latest} deploy=${env.KURIR_DEPLOY_BLOCK} window=${env.LOG_LOOKBACK_BLOCKS} chunk=${env.LOG_CHUNK_BLOCKS} → ${chunks} chunks, max ${env.LOG_MAX_CHUNKS}`);

if (mode === "chunked") {
  let r = await g(P_LOOKALIKE);
  check("QA2-2", "history outside the recent window is found via chunked scan: lookalike → warn ADDRESS_POISONING", r.verdict === "warn" && r.findings.some((f) => f.code === "ADDRESS_POISONING"), codes(r));
  r = await g(P);
  check("QA2-2", "P (sent to only in early blocks) is known → ok, no findings", r.verdict === "ok" && r.findings.length === 0, codes(r));
} else if (mode === "control") {
  if (env.KURIR_DEPLOY_BLOCK !== undefined) throw new Error("control needs KURIR_DEPLOY_BLOCK unset");
  const r = await g(P_LOOKALIKE);
  check("QA2-2", "control (no deploy block, 2-block window): the same lookalike is MISSED → ok", r.verdict === "ok", codes(r));
} else if (mode === "fallback") {
  const r = await g(P_LOOKALIKE);
  check("QA2-2", "full scan refused → falls back without crashing", ["ok", "warn"].includes(r.verdict), codes(r));
  check("QA2-2", "…and says so: CHECKS_DEGRADED (history is partial) rather than a silent ok", r.findings.some((f) => f.code === "CHECKS_DEGRADED"), codes(r));
} else throw new Error("set QA_HIST");
done();
