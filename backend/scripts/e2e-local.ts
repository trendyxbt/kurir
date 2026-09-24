/**
 * Local end-to-end rehearsal: anvil (chain id 97) + backend + the same EIP-712
 * signing the frontend does. Never touches BSC testnet.
 *
 *   USERKEY=0x… API=http://localhost:8787 RPC=http://127.0.0.1:8545 npx tsx scripts/e2e-local.ts
 *
 * USERKEY must hold tUSD and can (should) hold 0 BNB.
 */
import { createPublicClient, http, parseAbi, parseSignature, parseUnits, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const API = process.env.API ?? "http://localhost:8787";
const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const user = privateKeyToAccount(process.env.USERKEY as Hex);
const pub = createPublicClient({ transport: http(RPC) });
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function nonces(address) view returns (uint256)",
]);

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failures++;
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};
const str = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

const cfg = (await (await fetch(API + "/config")).json()) as {
  chainId: number; kurirRelayer: Address; token: Address; relayer: Address; fee: string;
};
const bal = (who: Address) => pub.readContract({ address: cfg.token, abi: erc20, functionName: "balanceOf", args: [who] });

async function buildSigned(to: Address, amount: bigint, permitValue?: bigint) {
  const fee = BigInt(cfg.fee);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const [nonce, permitNonce, name] = await Promise.all([
    pub.readContract({ address: cfg.kurirRelayer, abi: parseAbi(["function nonces(address) view returns (uint256)"]), functionName: "nonces", args: [user.address] }),
    pub.readContract({ address: cfg.token, abi: erc20, functionName: "nonces", args: [user.address] }),
    pub.readContract({ address: cfg.token, abi: erc20, functionName: "name" }),
  ]);
  const intent = { token: cfg.token, from: user.address, to, amount, fee, relayer: cfg.relayer, nonce, deadline };
  const signature = await user.signTypedData({
    domain: { name: "Kurir", version: "1", chainId: cfg.chainId, verifyingContract: cfg.kurirRelayer },
    types: {
      SendIntent: [
        { name: "token", type: "address" }, { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "amount", type: "uint256" }, { name: "fee", type: "uint256" }, { name: "relayer", type: "address" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "SendIntent",
    message: intent,
  });
  const value = permitValue ?? amount + fee;
  const permitSig = await user.signTypedData({
    domain: { name, version: "1", chainId: cfg.chainId, verifyingContract: cfg.token },
    types: {
      Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: user.address, spender: cfg.kurirRelayer, value, nonce: permitNonce, deadline },
  });
  const { r, s, v } = parseSignature(permitSig);
  return { intent: str(intent), signature, permit: { value: value.toString(), deadline: deadline.toString(), v: Number(v), r, s } };
}

const recipient = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const amount = parseUnits("10", 18);

// --- Demo moment 1: gasless send ---
const g1 = await post("/guard", { token: cfg.token, from: user.address, to: recipient, amount: amount.toString() });
check("guard: fresh recipient, small amount → ok", g1.json.verdict === "ok", g1.json.verdict);

const before = { user: await bal(user.address), to: await bal(recipient), bot: await bal(cfg.relayer), kurir: await bal(cfg.kurirRelayer) };
const payload = await buildSigned(recipient, amount);
const t0 = Date.now();
const r1 = await post("/relay", payload);
check("relay: gasless send succeeds", r1.status === 200 && r1.json.status === "success", { status: r1.status, gasUsed: r1.json.gasUsed, ms: Date.now() - t0 });
check("recipient +10 tUSD", (await bal(recipient)) - before.to === amount);
check("relayer bot +fee in tUSD", (await bal(cfg.relayer)) - before.bot === BigInt(cfg.fee));
check("KurirRelayer contract balance stays 0", (await bal(cfg.kurirRelayer)) === 0n);
check("user still has 0 BNB", (await pub.getBalance({ address: user.address })) === 0n);

// --- Server-side rules on /relay ---
const r2 = await post("/relay", payload);
check("relay: replay rejected (InvalidAccountNonce)", r2.status === 422 && r2.json.error === "InvalidAccountNonce", r2.json);

const tampered = await buildSigned(recipient, amount);
// Bump the amount but stay within the signed permit, so only the intent signature can catch it.
(tampered.intent as any).amount = parseUnits("10.4", 18).toString();
const r3 = await post("/relay", tampered);
check("relay: tampered amount rejected (InvalidSignature)", r3.status === 422 && r3.json.error === "InvalidSignature", r3.json);

const excess = await buildSigned(recipient, amount, 2n ** 256n - 1n);
const r4 = await post("/relay", excess);
check("relay: unlimited permit rejected (ExcessApproval)", r4.status === 422 && r4.json.error === "ExcessApproval", r4.json.error);

const toToken = await buildSigned(cfg.token, amount);
const r5 = await post("/relay", toToken);
check("relay: send to token contract blocked server-side", r5.status === 422 && r5.json.error === "GuardBlocked", r5.json.error);

// --- Demo moment 2: poisoned address ---
const h = recipient.slice(2).toLowerCase();
const lookalike = getAddress("0x" + h.slice(0, 4) + "ffffff" + h.slice(10));
const g2 = await post("/guard", { token: cfg.token, from: user.address, to: lookalike, amount: amount.toString() });
check("guard: lookalike of past recipient → warn", g2.json.verdict === "warn" && g2.json.findings.some((f: any) => f.code === "ADDRESS_POISONING"), g2.json.explanation);

const g3 = await post("/guard", { token: cfg.token, from: user.address, to: cfg.token, amount: amount.toString() });
check("guard: to === token → block", g3.json.verdict === "block", g3.json.explanation);

const g4 = await post("/guard", { token: cfg.token, from: user.address, to: "0x000000000000000000000000000000000000dEaD", amount: "1" });
check("guard: scam list → block", g4.json.verdict === "block" && g4.json.findings[0].code === "SCAM_LIST", g4.json.explanation);

const g5 = await post("/guard", { token: cfg.token, from: user.address, to: "0x9999999999999999999999999999999999999999", amount: parseUnits("600", 18).toString() });
check("guard: large send to fresh address → warn", g5.json.verdict === "warn", g5.json.explanation);

const g6 = await post("/guard", { token: cfg.token, from: user.address, to: cfg.kurirRelayer, amount: "1" });
check("guard: to === KurirRelayer → block", g6.json.verdict === "block", g6.json.findings?.[0]?.code);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
