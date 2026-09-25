/**
 * QA2-2 / QA2-5 check against the real BSC testnet, WITHOUT starting the history indexer, so the
 * guard must use its request-path fallback (chunked scan from the deploy block, which publicnode
 * refuses for old blocks).
 *
 *   npx tsx scripts/guard-history-check.ts              # request-path fallback
 *   HISTORY_INDEXER=1 npx tsx scripts/guard-history-check.ts   # with the index (waits for backfill)
 *
 * The recipient is a lookalike of 0xa0Dd…B002, which the demo wallet really sent to.
 */
import { getAddress } from "viem";
import { env } from "../src/config.js";
import { runGuard } from "../src/guard.js";
import { historyStatus, startHistoryIndexer } from "../src/history.js";

const from = getAddress("0xE4ca0B609C94CDC7C3E8Ae33A53E95dcc2909b33");
const lookalike = getAddress("0xa0ddf5669c3f11cf6c513150ffffffc94708b002");
const known = getAddress("0xa0ddf5669c3f11cf6c5131509a5271c94708b002");

if (process.env.HISTORY_INDEXER) {
  startHistoryIndexer();
  while (!historyStatus().synced) await new Promise((r) => setTimeout(r, 500));
}
const codes = (r: Awaited<ReturnType<typeof runGuard>>) => `${r.verdict} [${r.findings.map((f) => f.code).join(", ") || "none"}]`;
const g = (to: typeof from) => runGuard({ token: env.TOKEN_ADDRESS, from, to, amount: 5n * 10n ** 18n });

const a = await g(lookalike);
const b = await g(known);
console.log(`mode: ${process.env.HISTORY_INDEXER ? "history index" : "request-path fallback (no index)"}`);
console.log(`  lookalike of past recipient -> ${codes(a)}`);
console.log(`  the past recipient itself   -> ${codes(b)}`);
const detected = a.findings.some((f) => f.code === "ADDRESS_POISONING");
const flagged = a.findings.some((f) => f.code === "CHECKS_DEGRADED");
console.log(detected ? "RESULT: poisoning detected" : flagged ? "RESULT: not detected, but honestly flagged CHECKS_DEGRADED" : "RESULT: SILENT OK — history was missing and nobody was told (QA2-5)");
process.exit(detected || flagged ? 0 : 1);
