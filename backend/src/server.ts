import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { z } from "zod";
import { formatUnits, getAddress, isAddress } from "viem";
import { account, chain, env, relayerFee, TOKEN_DECIMALS } from "./config.js";
import { runGuard, type GuardResult } from "./guard.js";
import { explainWarn } from "./llmExplain.js";
import { submitRelay, submitRelayWithPermit } from "./relay.js";

// ---------- request schemas ----------

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "not a valid address")
  .transform((v) => getAddress(v));
const uint = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((v) => BigInt(v));
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/).transform((v) => v as `0x${string}`);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v as `0x${string}`);

const GuardBody = z.object({
  token: address,
  from: address,
  to: address,
  amount: uint,
  history: z.array(address).max(200).optional(),
});

const RelayBody = z.object({
  intent: z.object({
    token: address,
    from: address,
    to: address,
    amount: uint,
    fee: uint,
    relayer: address,
    nonce: uint,
    deadline: uint,
  }),
  signature: hex,
  permit: z
    .object({
      value: uint,
      deadline: uint,
      v: z.coerce.number().int().min(0).max(255),
      r: bytes32,
      s: bytes32,
    })
    .optional(),
});

// ---------- helpers ----------

async function guardWithExplanation(input: z.infer<typeof GuardBody>): Promise<GuardResult> {
  const result = await runGuard(input);
  // Only warn-level findings go to the explainer; blocks already carry a deterministic template.
  if (result.verdict === "warn") result.explanation = await explainWarn(result.findings);
  return result;
}

const explorerTx = (hash: string) => `${chain.blockExplorers.default.url}/tx/${hash}`;

// Double-submit guard: one in-flight relay per (from, nonce).
const inFlight = new Set<string>();

// ---------- app ----------

const app = express();
// Open CORS is for the hackathon demo only — lock to the frontend origin before any real deployment.
app.use(cors());
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** Everything the frontend needs to build and sign a SendIntent. */
app.get("/config", (_req, res) => {
  res.json({
    chainId: chain.id,
    kurirRelayer: env.KURIR_RELAYER_ADDRESS,
    token: env.TOKEN_ADDRESS,
    tokenDecimals: TOKEN_DECIMALS,
    relayer: account.address,
    fee: relayerFee.toString(),
    feeFormatted: formatUnits(relayerFee, TOKEN_DECIMALS),
    explorer: chain.blockExplorers.default.url,
  });
});

/** Called before the user signs anything. */
app.post("/guard", async (req, res) => {
  const body = GuardBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "BadRequest", issues: body.error.issues });
  res.json(await guardWithExplanation(body.data));
});

app.post("/relay", async (req, res) => {
  const body = RelayBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "BadRequest", issues: body.error.issues });
  const { intent, signature, permit } = body.data;

  // Relayer economics: only relay what we'll actually get paid for, in a token we trust.
  if (intent.token !== env.TOKEN_ADDRESS) {
    return void res.status(400).json({ error: "UnsupportedToken", message: "Token ini belum didukung relayer." });
  }
  if (intent.relayer !== account.address) {
    return void res.status(400).json({ error: "WrongRelayer", message: "Intent ini bukan untuk relayer ini." });
  }
  if (intent.fee < relayerFee) {
    return void res
      .status(400)
      .json({ error: "FeeTooLow", message: `Fee minimal ${formatUnits(relayerFee, TOKEN_DECIMALS)} token.` });
  }

  // Deterministic rules on the intent's own numbers.
  if (intent.amount === 0n) {
    return void res.status(400).json({ error: "ZeroAmount", message: "Jumlah kirim harus lebih dari 0." });
  }
  if (intent.fee > intent.amount) {
    return void res.status(422).json({
      error: "FeeExceedsAmount",
      message: "Fee-nya lebih gede dari jumlah yang dikirim. Naikin jumlahnya dulu ya.",
    });
  }

  // Deterministic rule: the permit must approve exactly what this send needs — no open-ended approvals.
  if (permit && permit.value > intent.amount + intent.fee) {
    return void res.status(422).json({
      error: "ExcessApproval",
      message: "Permit-nya minta izin lebih besar dari nominal + fee. Diblok biar nggak ada approval berlebih.",
    });
  }

  // Never trust the client's earlier /guard call — re-run the rules server-side.
  const guard = await runGuard({ token: intent.token, from: intent.from, to: intent.to, amount: intent.amount });
  if (guard.verdict === "block") {
    return void res.status(422).json({ error: "GuardBlocked", guard });
  }

  const key = `${intent.from}:${intent.nonce}`;
  if (inFlight.has(key)) {
    return void res.status(409).json({ error: "InFlight", message: "Transaksi ini lagi diproses." });
  }
  inFlight.add(key);
  try {
    const result = permit
      ? await submitRelayWithPermit(intent, signature, permit)
      : await submitRelay(intent, signature);

    if (!result.ok) return void res.status(422).json({ error: result.code, message: result.message });
    res.json({
      txHash: result.txHash,
      status: result.status,
      blockNumber: result.blockNumber.toString(),
      gasUsed: result.gasUsed.toString(),
      explorerUrl: explorerTx(result.txHash),
      guardVerdict: guard.verdict,
    });
  } finally {
    inFlight.delete(key);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // express.json() marks its own failures with a 4xx status (bad JSON / non-object body → 400,
  // over the size limit → 413). Those are client errors, not server errors.
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const tooLarge = status === 413;
    return void res.status(status).json({
      error: tooLarge ? "PayloadTooLarge" : "BadRequest",
      message: tooLarge ? "Request terlalu besar." : "Body request harus JSON object yang valid.",
    });
  }
  console.error("[server] unhandled:", err);
  res.status(500).json({ error: "Internal", message: "Server error." });
});

app.listen(env.PORT, () => {
  console.log(`Kurir backend on http://localhost:${env.PORT}`);
  console.log(`  relayer bot:   ${account.address}`);
  console.log(`  KurirRelayer:  ${env.KURIR_RELAYER_ADDRESS}`);
  console.log(`  token:         ${env.TOKEN_ADDRESS}`);
  console.log(`  explanations:  ${env.OPENAI_API_KEY ? `OpenAI (${env.OPENAI_MODEL})` : "templates (no API key)"}`);
});
