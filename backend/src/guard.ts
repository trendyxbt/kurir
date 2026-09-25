/**
 * Pre-flight guard. Rules block, AI explains.
 *
 * Every check in this file is deterministic. Hard failures (`block`) never reach
 * an LLM. Gray areas (`warn`) are handed to llmExplain.ts only to be turned into
 * plain Bahasa Indonesia; the LLM cannot change the verdict.
 */
import { getAddress, type Address } from "viem";
import { kurirRelayerAbi } from "./abi.js";
import { env, largeSendThreshold, primaryClient, publicClient, scamList, secondaryClient } from "./config.js";
import { pastSends as indexedPastSends } from "./history.js";
import { templateExplain } from "./llmExplain.js";

export type Severity = "block" | "warn";

export type FindingCode =
  | "RECIPIENT_IS_TOKEN"
  | "RECIPIENT_IS_ZERO"
  | "RECIPIENT_IS_RELAYER"
  | "SCAM_LIST"
  | "ADDRESS_POISONING"
  | "FRESH_ADDRESS_LARGE_SEND"
  | "UNKNOWN_CONTRACT"
  | "CHECKS_DEGRADED";

export interface Finding {
  code: FindingCode;
  severity: Severity;
  /** English, for logs/devs. User-facing text comes from `explanation`. */
  message: string;
  data?: Record<string, string | number | boolean>;
}

export interface GuardInput {
  token: Address;
  from: Address;
  to: Address;
  /** Base units (wei-style). */
  amount: bigint;
  /** Addresses `from` has sent to before (e.g. from the frontend's localStorage). */
  history?: Address[];
}

export interface GuardResult {
  verdict: "block" | "warn" | "ok";
  findings: Finding[];
  explanation?: string;
}

interface PastSend {
  to: Address;
  amount: bigint;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** Runs all rule checks. Adds a template explanation for blocks; warn explanations are the caller's job. */
export async function runGuard(input: GuardInput): Promise<GuardResult> {
  const to = getAddress(input.to);
  const from = getAddress(input.from);
  const token = getAddress(input.token);

  // ---- Hard blocks: pure, no RPC, no LLM ----
  const blocks: Finding[] = [];
  if (to === ZERO) {
    blocks.push({ code: "RECIPIENT_IS_ZERO", severity: "block", message: "Recipient is the zero address." });
  }
  if (to === token) {
    blocks.push({
      code: "RECIPIENT_IS_TOKEN",
      severity: "block",
      message: "Recipient is the token contract itself; funds would be stuck. Mirrors on-chain InvalidRecipient.",
    });
  }
  if (to === env.KURIR_RELAYER_ADDRESS) {
    blocks.push({
      code: "RECIPIENT_IS_RELAYER",
      severity: "block",
      message: "Recipient is the KurirRelayer contract. Mirrors on-chain InvalidRecipient.",
    });
  }
  if (scamList.has(to)) {
    blocks.push({ code: "SCAM_LIST", severity: "block", message: "Recipient is on the known-scam list." });
  }
  if (blocks.length > 0) {
    return { verdict: "block", findings: blocks, explanation: templateExplain(blocks) };
  }

  // ---- Warn-level rules ----
  const warns: Finding[] = [];
  let degraded = false;

  // History comes from the in-memory index (instant). Only if its startup backfill hasn't
  // finished yet do we fall back to querying logs on the request path. Whenever the history we end
  // up with may be incomplete, say so (CHECKS_DEGRADED) instead of returning a confident "ok".
  let pastSends: PastSend[];
  const indexed = indexedPastSends(from);
  if (indexed) {
    pastSends = indexed.sends;
    if (!indexed.fresh) degraded = true; // index stopped catching up: recent relays may be missing
  } else {
    try {
      const r = await readPastSends(from);
      pastSends = r.sends;
      if (r.partial) degraded = true;
    } catch (err) {
      console.warn("[guard] getLogs failed, continuing with client history only:", shortErr(err));
      degraded = true;
      pastSends = [];
    }
  }

  const known = new Set<Address>([
    ...(input.history ?? []).map((a) => getAddress(a)),
    ...pastSends.map((s) => s.to),
  ]);

  // Address poisoning: same head and tail as a known address (or the sender's own), different middle.
  const poison = findLookalike(to, [...known, from]);
  if (poison) {
    warns.push({
      code: "ADDRESS_POISONING",
      severity: "warn",
      message: `Recipient shares first/last ${env.POISON_MATCH_CHARS} hex chars with ${poison.similarTo} but differs in ${poison.differingChars} chars.`,
      data: { similarTo: poison.similarTo, differingChars: poison.differingChars, isOwnAddress: poison.similarTo === from },
    });
  }

  if (!known.has(to)) {
    try {
      const [code, txCount] = await Promise.all([
        hedged((c) => c.getCode({ address: to })),
        hedged((c) => c.getTransactionCount({ address: to })),
      ]);
      const isContract = code !== undefined && code !== "0x";

      if (isContract) {
        warns.push({
          code: "UNKNOWN_CONTRACT",
          severity: "warn",
          message: "Recipient is a contract this sender has not sent to before.",
        });
      } else if (txCount === 0 && isLargeSend(input.amount, pastSends)) {
        warns.push({
          code: "FRESH_ADDRESS_LARGE_SEND",
          severity: "warn",
          message: "Recipient has no on-chain activity and the amount is large relative to this sender's usual sends.",
          data: { comparedTo: pastSends.length > 0 ? "median_past_send" : "static_threshold" },
        });
      }
    } catch (err) {
      console.warn("[guard] recipient lookup failed:", shortErr(err));
      degraded = true;
    }
  }

  if (degraded) {
    warns.push({
      code: "CHECKS_DEGRADED",
      severity: "warn",
      message: "Some on-chain checks could not run (RPC error); verdict is based on partial data.",
    });
  }

  return { verdict: warns.length > 0 ? "warn" : "ok", findings: warns };
}

/**
 * Hedged read: ask the primary RPC, and if it hasn't answered within HEDGE_AFTER_MS ask the
 * fallback too; first successful answer wins. Cuts the ~1-in-5 publicnode stall to ~0.4 s.
 */
const HEDGE_AFTER_MS = 400;
async function hedged<T>(read: (c: typeof primaryClient) => Promise<T>): Promise<T> {
  const first = read(primaryClient);
  const second = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => read(secondaryClient).then(resolve, reject), HEDGE_AFTER_MS);
    first.then(() => clearTimeout(timer), () => {});
  });
  return Promise.any([first, second]);
}

/** `partial` is true when the full history was wanted but only the recent window could be read. */
async function readPastSends(from: Address): Promise<{ sends: PastSend[]; partial: boolean }> {
  // cacheTime 0: viem otherwise caches the block number (~4s) and a send relayed moments ago would be missed.
  const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
  const window = latest > env.LOG_LOOKBACK_BLOCKS ? latest - env.LOG_LOOKBACK_BLOCKS : 0n;
  const query = (fromBlock: bigint) =>
    publicClient.getContractEvents({
      address: env.KURIR_RELAYER_ADDRESS,
      abi: kurirRelayerAbi,
      eventName: "Relayed",
      args: { from },
      fromBlock,
      toBlock: latest,
    });

  // Full history since deployment when the deploy block is known (a 5,000-block window is only
  // ~37 min at BSC testnet's 0.45 s blocks). Public RPCs cap each getLogs range (publicnode:
  // 50,000 blocks), so query in chunks, a few at a time. If any chunk fails, fall back to the
  // recent window instead of losing history entirely.
  const deploy = env.KURIR_DEPLOY_BLOCK;
  let logs: Awaited<ReturnType<typeof query>>;
  let partial = false;
  if (deploy !== undefined && deploy < window) {
    try {
      logs = await queryChunked(deploy, latest);
    } catch (err) {
      console.warn("[guard] full-history getLogs failed, using recent window:", shortErr(err));
      logs = await query(window);
      partial = true; // QA2-5: the caller must not present this as a complete check
    }
  } else {
    logs = await query(deploy !== undefined && deploy > window ? deploy : window);
  }
  return { sends: logs.map((l) => ({ to: getAddress(l.args.to!), amount: l.args.amount! })), partial };

  async function queryChunked(start: bigint, end: bigint) {
    const size = env.LOG_CHUNK_BLOCKS;
    const ranges: [bigint, bigint][] = [];
    for (let b = start; b <= end; b += size) ranges.push([b, b + size - 1n < end ? b + size - 1n : end]);
    if (ranges.length > env.LOG_MAX_CHUNKS) throw new Error(`${ranges.length} chunks exceeds LOG_MAX_CHUNKS`);
    const out: Awaited<ReturnType<typeof query>> = [];
    for (let i = 0; i < ranges.length; i += 4) {
      const batch = await Promise.all(
        ranges.slice(i, i + 4).map(([fromBlock, toBlock]) =>
          publicClient.getContractEvents({
            address: env.KURIR_RELAYER_ADDRESS,
            abi: kurirRelayerAbi,
            eventName: "Relayed",
            args: { from },
            fromBlock,
            toBlock,
          }),
        ),
      );
      for (const part of batch) out.push(...part);
    }
    return out;
  }
}

export function findLookalike(
  to: Address,
  candidates: Address[],
): { similarTo: Address; differingChars: number } | null {
  const n = env.POISON_MATCH_CHARS;
  const t = to.slice(2).toLowerCase();
  for (const c of candidates) {
    const h = c.slice(2).toLowerCase();
    if (h === t) continue;
    if (h.slice(0, n) === t.slice(0, n) && h.slice(-n) === t.slice(-n)) {
      let diff = 0;
      for (let i = 0; i < 40; i++) if (h[i] !== t[i]) diff++;
      return { similarTo: c, differingChars: diff };
    }
  }
  return null;
}

/** "Large" = over 3x the sender's median past send, or over the static threshold when there's no history. */
function isLargeSend(amount: bigint, past: PastSend[]): boolean {
  if (past.length === 0) return amount >= largeSendThreshold;
  const sorted = past.map((p) => p.amount).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median = sorted[Math.floor(sorted.length / 2)];
  return amount > median * 3n;
}

function shortErr(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}
