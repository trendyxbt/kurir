/**
 * Pre-flight guard. Rules block, AI explains.
 *
 * Every check in this file is deterministic. Hard failures (`block`) never reach
 * an LLM. Gray areas (`warn`) are handed to llmExplain.ts only to be turned into
 * plain Bahasa Indonesia; the LLM cannot change the verdict.
 */
import { getAddress, type Address } from "viem";
import { kurirRelayerAbi } from "./abi.js";
import { env, largeSendThreshold, publicClient, scamList } from "./config.js";
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

  const pastSends = await readPastSends(from).catch((err) => {
    console.warn("[guard] getLogs failed, continuing with client history only:", shortErr(err));
    degraded = true;
    return [] as PastSend[];
  });

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
        publicClient.getCode({ address: to }),
        publicClient.getTransactionCount({ address: to }),
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

async function readPastSends(from: Address): Promise<PastSend[]> {
  // cacheTime 0: viem otherwise caches the block number (~4s) and a send relayed moments ago would be missed.
  const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
  const fromBlock = latest > env.LOG_LOOKBACK_BLOCKS ? latest - env.LOG_LOOKBACK_BLOCKS : 0n;
  const logs = await publicClient.getContractEvents({
    address: env.KURIR_RELAYER_ADDRESS,
    abi: kurirRelayerAbi,
    eventName: "Relayed",
    args: { from },
    fromBlock,
    toBlock: latest,
  });
  return logs.map((l) => ({ to: getAddress(l.args.to!), amount: l.args.amount! }));
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
