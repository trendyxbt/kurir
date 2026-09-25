/**
 * In-memory index of every Relayed event, so the guard never waits on eth_getLogs.
 *
 * Public BSC testnet RPCs cap log ranges (publicnode 50k blocks, others 5-10k or none) and
 * publicnode stalls on ~1 in 5 requests. Doing history lookups per /guard request made
 * "Check & Send" take 10-20 s. Instead: backfill once at startup in the background, poll new
 * blocks every few seconds, and record our own relays the moment their receipt arrives.
 *
 * The index is also saved to disk (backend/.cache). Old history comes from one third-party archive
 * RPC (ARCHIVE_RPC_URL); if it is down at startup, a restart would otherwise lose every send older
 * than publicnode's ~10 h log retention. With a snapshot, a restart resumes from the saved state
 * and only needs the (small) gap since it was written.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isHash, parseEventLogs, type Address, type Hex, type Log } from "viem";
import { kurirRelayerAbi } from "./abi.js";
import { archiveClient, chain, env, logsClient } from "./config.js";

export interface PastSend {
  to: Address;
  amount: bigint;
}

interface StoredEvent {
  key: string; // txHash:logIndex
  from: Address;
  to: Address;
  amount: string;
}

interface Snapshot {
  version: 1;
  chainId: number;
  contract: Address;
  deployBlock: string | null;
  indexedTo: string;
  /** A block a little behind indexedTo and its hash, to prove on load that this is still the same chain. */
  anchorBlock: string;
  anchorHash: Hex;
  savedAt: string;
  events: StoredEvent[];
}

const byFrom = new Map<Address, PastSend[]>();
const store: StoredEvent[] = []; // the same events, in a form we can persist
const seen = new Set<string>(); // txHash:logIndex, so backfill, polling and receipts never double-count
let indexedTo: bigint | undefined; // last block fully indexed
let ready = false; // usable data present (from a snapshot or a completed backfill)
let lastOkAt = 0; // last time the head was confirmed reachable and indexed up to date; 0 = not yet since start
let snapshotInfo: { loaded: boolean; events: number; savedAt: string | null } = { loaded: false, events: 0, savedAt: null };

const POLL_MS = 4000;
const SNAPSHOT_EVERY_MS = 5 * 60_000; // refresh even without new events, so the resume gap stays small
const ANCHOR_DEPTH = 32n; // deep enough that a short reorg cannot invalidate the anchor

const CACHE_DIR =
  env.HISTORY_CACHE_DIR === "off"
    ? undefined
    : (env.HISTORY_CACHE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".cache"));
const CACHE_FILE = CACHE_DIR && join(CACHE_DIR, `history-${chain.id}-${env.KURIR_RELAYER_ADDRESS.toLowerCase()}.json`);

function addStored(e: StoredEvent): boolean {
  if (seen.has(e.key)) return false;
  seen.add(e.key);
  store.push(e);
  const list = byFrom.get(e.from) ?? [];
  list.push({ to: e.to, amount: BigInt(e.amount) });
  byFrom.set(e.from, list);
  return true;
}

function add(logs: Log[]): number {
  let added = 0;
  for (const ev of parseEventLogs({ abi: kurirRelayerAbi, eventName: "Relayed", logs })) {
    const ok = addStored({
      key: `${ev.transactionHash}:${ev.logIndex}`,
      from: getAddress(ev.args.from),
      to: getAddress(ev.args.to),
      amount: ev.args.amount.toString(),
    });
    if (ok) added++;
  }
  if (added > 0) scheduleSave();
  return added;
}

function resetState() {
  byFrom.clear();
  store.length = 0;
  seen.clear();
  indexedTo = undefined;
  ready = false;
  lastOkAt = 0;
  snapshotInfo = { loaded: false, events: 0, savedAt: null };
}

/** Hash of a block, asking the normal RPC first and the archive RPC second. */
async function blockHash(blockNumber: bigint): Promise<Hex> {
  try {
    return (await logsClient.getBlock({ blockNumber })).hash;
  } catch {
    return (await archiveClient.getBlock({ blockNumber })).hash;
  }
}

let saveTimer: NodeJS.Timeout | undefined;
let lastSaveAt = 0;
let lastSavedTo: bigint | undefined;

/** Debounced. While still backfilling, save rarely (each save asks an RPC for the anchor block hash);
 *  `urgent` (backfill just finished) overrides a pending slow timer, so completion is checkpointed promptly. */
function scheduleSave(urgent = false) {
  if (!CACHE_FILE) return;
  if (saveTimer) {
    if (!urgent) return;
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void saveSnapshot();
  }, urgent || lastOkAt > 0 ? 1000 : 15_000);
  saveTimer.unref();
}

async function saveSnapshot() {
  // A snapshot is valid whenever the store holds every event up to indexedTo, including mid-backfill.
  if (!CACHE_FILE || !CACHE_DIR || indexedTo === undefined) return;
  const to = indexedTo;
  const anchorBlock = to > ANCHOR_DEPTH ? to - ANCHOR_DEPTH : 0n;
  try {
    const snap: Snapshot = {
      version: 1,
      chainId: chain.id,
      contract: env.KURIR_RELAYER_ADDRESS,
      deployBlock: env.KURIR_DEPLOY_BLOCK?.toString() ?? null,
      indexedTo: to.toString(),
      anchorBlock: anchorBlock.toString(),
      anchorHash: await blockHash(anchorBlock),
      savedAt: new Date().toISOString(),
      events: store.slice(),
    };
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(snap));
    await rename(tmp, CACHE_FILE); // atomic: a crash mid-write can never leave a half-written snapshot
    lastSaveAt = Date.now();
    lastSavedTo = to;
    snapshotInfo.savedAt = snap.savedAt;
  } catch (err) {
    console.warn("[history] could not save snapshot:", err instanceof Error ? err.message.split("\n")[0] : err);
  }
}

/** Load the saved index if (and only if) it belongs to this chain, contract and config. */
async function loadSnapshot(): Promise<boolean> {
  if (!CACHE_FILE) return false;
  let raw: string;
  try {
    raw = await readFile(CACHE_FILE, "utf8");
  } catch {
    return false; // no snapshot yet
  }
  try {
    const s = JSON.parse(raw) as Snapshot;
    if (s.version !== 1) throw new Error("unknown snapshot version");
    if (s.chainId !== chain.id || String(s.contract).toLowerCase() !== env.KURIR_RELAYER_ADDRESS.toLowerCase()) {
      throw new Error("belongs to a different chain or contract");
    }
    if ((s.deployBlock ?? null) !== (env.KURIR_DEPLOY_BLOCK?.toString() ?? null)) throw new Error("KURIR_DEPLOY_BLOCK changed");
    if (!isHash(s.anchorHash)) throw new Error("bad anchor hash");
    const to = BigInt(s.indexedTo);
    const events = s.events.map((e) => ({
      key: String(e.key),
      from: getAddress(e.from),
      to: getAddress(e.to),
      amount: BigInt(e.amount).toString(),
    }));

    // Same chain? An anvil reset reuses the chain id and deterministic addresses, so check the block hash.
    const actual = await blockHash(BigInt(s.anchorBlock)).catch(() => null);
    if (actual && actual.toLowerCase() !== s.anchorHash.toLowerCase()) throw new Error("the chain no longer matches (reset or deep reorg)");
    if (!actual) console.warn("[history] could not verify the snapshot's anchor block (RPC unreachable); using it, flagged as unconfirmed");

    for (const e of events) addStored(e);
    indexedTo = to;
    ready = true; // usable immediately; lastOkAt stays 0 until we catch up, so the guard reports it as unconfirmed
    snapshotInfo = { loaded: true, events: events.length, savedAt: s.savedAt };
    lastSavedTo = to;
    console.log(`[history] loaded snapshot: ${events.length} relays, indexed to block ${to} (saved ${s.savedAt})`);
    return true;
  } catch (err) {
    resetState();
    console.warn("[history] ignoring snapshot:", err instanceof Error ? err.message.split("\n")[0] : err);
    return false;
  }
}

function chunks(fromBlock: bigint, toBlock: bigint, size: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let b = fromBlock; b <= toBlock; b += size) out.push([b, b + size - 1n < toBlock ? b + size - 1n : toBlock]);
  return out;
}

const RECENT_WINDOW = 60_000n; // blocks publicnode still serves logs for (it prunes at ~80k, ~10 h on testnet)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A finished, contiguous range: its events are added and everything up to `to` is now indexed. */
function commitRange(logs: Log[], to: bigint) {
  add(logs);
  indexedTo = to; // progress survives a failed attempt, so retries resume instead of restarting
}

/** Recent blocks: publicnode, big ranges, not rate limited. */
async function fetchRecent(fromBlock: bigint, toBlock: bigint) {
  for (const [a, b] of chunks(fromBlock, toBlock, env.LOG_CHUNK_BLOCKS)) {
    commitRange(await logsClient.getLogs({ address: env.KURIR_RELAYER_ADDRESS, fromBlock: a, toBlock: b }), b);
  }
}

/** One archive chunk. The free archive RPC rate-limits (-32029 after a burst of ~3), so back off and retry. */
async function archiveChunk(a: bigint, b: bigint): Promise<Log[]> {
  const q = { address: env.KURIR_RELAYER_ADDRESS, fromBlock: a, toBlock: b };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await archiveClient.getLogs(q);
    } catch {
      if (attempt < 3) await sleep(1500 * 2 ** attempt);
    }
  }
  return logsClient.getLogs(q); // last resort; fails for pruned blocks, which surfaces as a failed attempt
}

/**
 * Everything from `fromBlock` to `toBlock`. Blocks older than publicnode's retention come from the
 * archive RPC, one throttled request at a time; the recent part comes from publicnode. A resume
 * from a snapshot usually only needs the recent part, so it never touches the archive at all.
 */
async function fetchHistory(fromBlock: bigint, toBlock: bigint) {
  const recentFloor = toBlock > RECENT_WINDOW ? toBlock - RECENT_WINDOW : 0n;
  if (fromBlock < recentFloor) {
    for (const [a, b] of chunks(fromBlock, recentFloor - 1n, env.ARCHIVE_CHUNK_BLOCKS)) {
      commitRange(await archiveChunk(a, b), b);
      scheduleSave();
      await sleep(env.ARCHIVE_MIN_INTERVAL_MS);
    }
  }
  await fetchRecent(fromBlock > recentFloor ? fromBlock : recentFloor, toBlock);
}

/** Record Relayed events from a receipt we just got (instant, no RPC). */
export function recordReceiptLogs(logs: Log[]): void {
  add(logs.filter((l) => l.address.toLowerCase() === env.KURIR_RELAYER_ADDRESS.toLowerCase()));
}

/**
 * Past sends by `from`, or null while the startup backfill hasn't finished. `fresh` is false when
 * polling has stalled for over a minute, i.e. relays by other relayers may be missing.
 */
export function pastSends(from: Address): { sends: PastSend[]; fresh: boolean } | null {
  if (!ready) return null;
  // Right after loading a snapshot, lastOkAt is 0: the data is usable but not yet confirmed up to date.
  return { sends: byFrom.get(getAddress(from)) ?? [], fresh: lastOkAt > 0 && Date.now() - lastOkAt < env.HISTORY_STALE_MS };
}

export function historyStatus() {
  return {
    ready,
    synced: lastOkAt > 0,
    indexedTo: indexedTo?.toString(),
    senders: byFrom.size,
    events: seen.size,
    ageMs: lastOkAt > 0 ? Date.now() - lastOkAt : null,
    snapshot: snapshotInfo,
  };
}

export function startHistoryIndexer(): void {
  const run = async () => {
    const t = Date.now();
    let resumed = await loadSnapshot();
    for (let attempt = 1; ; attempt++) {
      try {
        const latest = await logsClient.getBlockNumber({ cacheTime: 0 });
        if (resumed && indexedTo !== undefined && latest < indexedTo) {
          console.warn(`[history] snapshot is ahead of the chain (${indexedTo} > ${latest}); discarding it`);
          resetState();
          resumed = false;
        }
        const from = indexedTo !== undefined
          ? indexedTo + 1n
          : (env.KURIR_DEPLOY_BLOCK ?? (latest > env.LOG_LOOKBACK_BLOCKS ? latest - env.LOG_LOOKBACK_BLOCKS : 0n));
        await fetchHistory(from, latest);
        indexedTo = latest;
        lastOkAt = Date.now();
        ready = true;
        console.log(`[history] ${resumed ? "caught up from snapshot" : "backfilled"} blocks ${from}-${latest}: ${seen.size} relays from ${byFrom.size} senders (${Date.now() - t} ms)`);
        scheduleSave(true);
        break;
      } catch (err) {
        console.warn(`[history] ${resumed ? "catch-up" : "backfill"} attempt ${attempt} failed, retrying:`, err instanceof Error ? err.message.split("\n")[0] : err);
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
        lastOkAt = Date.now();
        if (Date.now() - lastSaveAt > SNAPSHOT_EVERY_MS && indexedTo !== lastSavedTo) scheduleSave();
      } catch {
        // a stalled poll just retries next tick; receipts of our own relays are recorded directly
      }
      setTimeout(poll, POLL_MS).unref();
    };
    setTimeout(poll, POLL_MS).unref();
  };
  void run();
}
