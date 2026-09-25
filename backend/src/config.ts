import "dotenv/config";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "not a valid address")
  .transform((v) => getAddress(v));

/** `KEY=` in .env means "unset", not "empty string". */
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const EnvSchema = z.object({
  RPC_URL: z.string().url().default("https://bsc-testnet-rpc.publicnode.com"),
  /** Second RPC for failover and hedged reads. Needn't support eth_getLogs (history uses RPC_URL). */
  RPC_URL_FALLBACK: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().default("https://data-seed-prebsc-1-s1.bnbchain.org:8545"),
  ),
  /**
   * RPC that still serves old logs, for the startup history backfill. publicnode prunes logs
   * older than ~80k blocks (~10 h on testnet); onfinality keeps full history but caps ranges at 5k.
   */
  ARCHIVE_RPC_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().default("https://bnb-testnet.api.onfinality.io/public"),
  ),
  ARCHIVE_CHUNK_BLOCKS: z.coerce.bigint().min(1n).default(5000n),
  /** Per-request RPC timeout. Public testnet RPCs answer in 0.1-0.7 s but ~1 in 5 requests stalls. */
  RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  RELAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key"),
  KURIR_RELAYER_ADDRESS: address,
  TOKEN_ADDRESS: address,
  RELAYER_FEE: z.string().regex(/^\d+(\.\d+)?$/).default("0.5"),
  SCAM_LIST: z.string().default(""),
  POISON_MATCH_CHARS: z.coerce.number().int().min(2).max(10).default(4),
  LARGE_SEND_THRESHOLD: z.string().regex(/^\d+(\.\d+)?$/).default("500"),
  LOG_LOOKBACK_BLOCKS: z.coerce.bigint().default(5000n),
  /** Block KurirRelayer was deployed in. When set, the poisoning check scans all history since then. */
  KURIR_DEPLOY_BLOCK: z.coerce.bigint().optional(),
  /** Max blocks per getLogs call (publicnode's cap is 50,000). */
  LOG_CHUNK_BLOCKS: z.coerce.bigint().min(1n).default(50000n),
  /** Safety cap: beyond this many chunks, use the recent window instead (100 × 50k ≈ 26 days of testnet). */
  LOG_MAX_CHUNKS: z.coerce.number().int().positive().default(100),
  // Any OpenAI-compatible chat API. Explanations use the LLM only when LLM_BASE_URL or OPENAI_API_KEY is
  // set; otherwise the Bahasa templates are used. Local Ollama: LLM_BASE_URL=http://localhost:11434/v1.
  LLM_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  /** Ollama only: keep the model loaded this long (e.g. "2h") so no demo request pays a cold load. */
  LLM_KEEP_ALIVE: z.preprocess(emptyToUndefined, z.string().optional()),
  PORT: z.coerce.number().int().default(8787),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid backend/.env:");
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}
export const env = parsed.data;

/** MockStable uses 18 decimals; all on-chain amounts are base units (bigint). */
export const TOKEN_DECIMALS = 18;
export const relayerFee = parseUnits(env.RELAYER_FEE, TOKEN_DECIMALS);
export const largeSendThreshold = parseUnits(env.LARGE_SEND_THRESHOLD, TOKEN_DECIMALS);

export const scamList: Set<Address> = new Set(
  env.SCAM_LIST.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      if (!isAddress(s, { strict: false })) throw new Error(`SCAM_LIST entry is not an address: ${s}`);
      return getAddress(s);
    }),
);

export const chain = bscTestnet;
export const account = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);

// Fail fast and fail over: viem's defaults (10 s timeout, 3 retries) turned one stalled request
// into a 20-30 s wait. A stuck request is abandoned after RPC_TIMEOUT_MS and sent to the fallback.
const rpc = (url: string) => http(url, { timeout: env.RPC_TIMEOUT_MS, retryCount: 1, retryDelay: 100 });
const transport = fallback([rpc(env.RPC_URL), rpc(env.RPC_URL_FALLBACK)], { retryCount: 1 });

export const publicClient = createPublicClient({ chain, transport });
export const walletClient = createWalletClient({ account, chain, transport });

/** Single-endpoint clients for hedged reads (race both, first answer wins). */
export const primaryClient = createPublicClient({ chain, transport: rpc(env.RPC_URL) });
export const secondaryClient = createPublicClient({ chain, transport: rpc(env.RPC_URL_FALLBACK) });

/** Old history for the startup backfill (see ARCHIVE_RPC_URL). */
export const archiveClient = createPublicClient({
  chain,
  transport: http(env.ARCHIVE_RPC_URL, { timeout: 15_000, retryCount: 2, retryDelay: 500 }),
});

/** Recent history (eth_getLogs) on RPC_URL, used only by the background indexer's polling. */
export const logsClient = createPublicClient({
  chain,
  transport: http(env.RPC_URL, { timeout: 10_000, retryCount: 3, retryDelay: 500 }),
});
