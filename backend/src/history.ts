/**
 * In-memory index of every Relayed event, so the guard never waits on eth_getLogs.
 *
 * Public BSC testnet RPCs cap log ranges (publicnode 50k blocks, others 5-10k or none) and
 * publicnode stalls on ~1 in 5 requests. Doing history lookups per /guard request made
 * "Check & Send" take 10-20 s. Instead: backfill once at startup in the background, poll new
 * blocks every few seconds, and record our own relays the moment their receipt arrives.
 */
import { getAddress, parseEventLogs, type Address, type Log } from "viem";
import { kurirRelayerAbi } from "./abi.js";
import { archiveClient, env, logsClient } from "./config.js";

export interface PastSend {
  to: Address;
  amount: bigint;
}

const byFrom = new Map<Address, PastSend[]>();
const seen = new Set<string>(); // txHash:logIndex, so backfill, polling and receipts never double-count
let indexedTo: bigint | undefined; // last block fully indexed
let ready = false;

const POLL_MS = 4000;

function add(logs: Log[]) {
  for (const ev of parseEventLogs({ abi: kurirRelayerAbi, eventName: "Relayed", logs })) {
    const key = `${ev.transactionHash}:${ev.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = getAddress(ev.args.from);
    const list = byFrom.get(from) ?? [];
    list.push({ to: getAddress(ev.args.to), amount: ev.args.amount });
    byFrom.set(from, list);
  }
}

function chunks(fromBlock: bigint, toBlock: bigint, size: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let b = fromBlock; b <= toBlock; b += size) out.push([b, b + size - 1n < toBlock ? b + size - 1n : toBlock]);
  return out;
}

/** Recent blocks: publicnode, large ranges. */
async function fetchRecent(fromBlock: bigint, toBlock: bigint) {
  for (const [a, b] of chunks(fromBlock, toBlock, env.LOG_CHUNK_BLOCKS)) {
    add(await logsClient.getLogs({ address: env.KURIR_RELAYER_ADDRESS, fromBlock: a, toBlock: b }));
  }
}

/** Full history: the archive RPC in small ranges, 3 at a time; each chunk falls back to publicnode. */
async function fetchHistory(fromBlock: bigint, toBlock: bigint) {
  const list = chunks(fromBlock, toBlock, env.ARCHIVE_CHUNK_BLOCKS);
  for (let i = 0; i < list.length; i += 3) {
    const batch = await Promise.all(
      list.slice(i, i + 3).map(async ([a, b]) => {
        const q = { address: env.KURIR_RELAYER_ADDRESS, fromBlock: a, toBlock: b };
        try {
          return await archiveClient.getLogs(q);
        } catch {
          return await logsClient.getLogs(q);
        }
      }),
    );
    for (const logs of batch) add(logs);
  }
}

/** Record Relayed events from a receipt we just got (instant, no RPC). */
export function recordReceiptLogs(logs: Log[]): void {
  add(logs.filter((l) => l.address.toLowerCase() === env.KURIR_RELAYER_ADDRESS.toLowerCase()));
}

/** Past sends by `from`, or null while the startup backfill hasn't finished. */
export function pastSends(from: Address): PastSend[] | null {
  return ready ? (byFrom.get(getAddress(from)) ?? []) : null;
}

export function historyStatus() {
  return { ready, indexedTo: indexedTo?.toString(), senders: byFrom.size, events: seen.size };
}

export function startHistoryIndexer(): void {
  const run = async () => {
    const t = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const latest = await logsClient.getBlockNumber({ cacheTime: 0 });
        const start = env.KURIR_DEPLOY_BLOCK ?? (latest > env.LOG_LOOKBACK_BLOCKS ? latest - env.LOG_LOOKBACK_BLOCKS : 0n);
        await fetchHistory(start, latest);
        indexedTo = latest;
        ready = true;
        console.log(`[history] backfilled blocks ${start}-${latest}: ${seen.size} relays from ${byFrom.size} senders (${Date.now() - t} ms)`);
        break;
      } catch (err) {
        console.warn(`[history] backfill attempt ${attempt} failed, retrying:`, err instanceof Error ? err.message.split("\n")[0] : err);
        await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 15_000)));
      }
    }
    const poll = async () => {
      try {
        const latest = await logsClient.getBlockNumber({ cacheTime: 0 });
        if (indexedTo !== undefined && latest > indexedTo) {
          await fetchRecent(indexedTo + 1n, latest);
          indexedTo = latest;
        }
      } catch {
        // a stalled poll just retries next tick; receipts of our own relays are recorded directly
      }
      setTimeout(poll, POLL_MS).unref();
    };
    setTimeout(poll, POLL_MS).unref();
  };
  void run();
}
