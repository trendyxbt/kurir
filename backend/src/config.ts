import "dotenv/config";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
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

const EnvSchema = z.object({
  RPC_URL: z.string().url().default("https://bsc-testnet-rpc.publicnode.com"),
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
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
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

export const publicClient = createPublicClient({ chain, transport: http(env.RPC_URL) });
export const walletClient = createWalletClient({ account, chain, transport: http(env.RPC_URL) });
