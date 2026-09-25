/**
 * Probe for the history snapshot (src/history.ts), against the real BSC testnet. One scenario per
 * process, driven by env vars, because the index is process-wide state.
 *
 *   HISTORY_CACHE_DIR=/tmp/kurir-snap WAIT_S=20 npx tsx scripts/history-snapshot-check.ts
 *
 * Prints the index status after WAIT_S seconds (or as soon as it is synced), then asks the guard about
 * a lookalike of a real past recipient of the demo wallet, and about the real recipient itself.
 * Set ARCHIVE_RPC_URL / RPC_URL to a dead port to simulate an outage.
 */
import { getAddress } from "viem";
import { env } from "../src/config.js";
import { runGuard } from "../src/guard.js";
import { historyStatus, startHistoryIndexer } from "../src/history.js";

// Defaults are the BSC testnet demo wallet and one of its real past recipients (0xa0Dd…B002).
// PROBE_FROM / PROBE_KNOWN / PROBE_LOOKALIKE override them, e.g. for a local chain.
const from = getAddress(process.env.PROBE_FROM ?? "0xE4ca0B609C94CDC7C3E8Ae33A53E95dcc2909b33");
const lookalike = getAddress(process.env.PROBE_LOOKALIKE ?? "0xa0ddf5669c3f11cf6c513150ffffffc94708b002");
const known = getAddress(process.env.PROBE_KNOWN ?? "0xa0ddf5669c3f11cf6c5131509a5271c94708b002");

const waitMs = Number(process.env.WAIT_S ?? 20) * 1000;
startHistoryIndexer();
const t0 = Date.now();
while (Date.now() - t0 < waitMs && !historyStatus().synced) await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, Number(process.env.SETTLE_MS ?? 0))); // let a debounced save land

const st = historyStatus();
const codes = (r: Awaited<ReturnType<typeof runGuard>>) => `${r.verdict} [${r.findings.map((f) => f.code).join(", ") || "none"}]`;
const g = (to: typeof from) => runGuard({ token: env.TOKEN_ADDRESS, from, to, amount: 5n * 10n ** 18n });
const a = await g(lookalike);
const b = await g(known);
console.log(
  `status: ready=${st.ready} synced=${st.synced} events=${st.events} indexedTo=${st.indexedTo} snapshot.loaded=${st.snapshot.loaded}(${st.snapshot.events})`,
);
console.log(`  lookalike of past recipient -> ${codes(a)}`);
console.log(`  the past recipient itself   -> ${codes(b)}`);
process.exit(0);
