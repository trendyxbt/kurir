/**
 * Day 2 QA, Section 4 (relay.ts). Calls submitRelay / submitRelayWithPermit directly.
 * LOCAL ANVIL ONLY (uses anvil_setBalance for the relayer-out-of-gas case).
 */
import { getAddress, parseUnits, type Address, type Hex } from "viem";
import { account, chain, env, publicClient, relayerFee, walletClient } from "../../src/config.js";
import { submitRelay, submitRelayWithPermit, type RelayResult } from "../../src/relay.js";
import { FRESH, QA_OTHER_KEY, QA_USER_KEY, check, done, looksRaw, qaUser, signIntent, signPermit, tokenAbi, type Intent } from "./lib.js";

if (!env.RPC_URL.includes("127.0.0.1")) throw new Error("relay-unit is for local anvil only");

const token = env.TOKEN_ADDRESS;
const kurir = env.KURIR_RELAYER_ADDRESS;
const tUSD = (n: string) => parseUnits(n, 18);
const bal = (who: Address) => publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [who] });
const tokenName = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "name" });
const kNonce = () => publicClient.readContract({ address: kurir, abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "nonces", args: [qaUser.address] });
const now = () => BigInt(Math.floor(Date.now() / 1000));

async function build(over: Partial<Intent> = {}, signer: Hex = QA_USER_KEY, permitValue?: bigint) {
  const intent: Intent = {
    token, from: qaUser.address, to: FRESH, amount: tUSD("3"), fee: relayerFee, relayer: account.address,
    nonce: await kNonce(), deadline: now() + 600n, ...over,
  };
  const sig = await signIntent(signer, intent, chain.id, kurir);
  const tn = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "nonces", args: [qaUser.address] });
  const permit = await signPermit(QA_USER_KEY, token, tokenName, tn, kurir, permitValue ?? intent.amount + intent.fee, now() + 600n, chain.id);
  return { intent, sig, permit };
}
const errRow = (r: RelayResult) => (r.ok ? `ok ${r.status}` : `${r.code}: ${r.message}`);

// ---- R2: permit path happy ----
const toBefore = await bal(FRESH);
const relayerTokBefore = await bal(account.address);
const happy = await build();
const r2 = await submitRelayWithPermit(happy.intent, happy.sig, happy.permit);
check("R2", "submitRelayWithPermit happy path → { txHash, status: 'success' }",
  r2.ok && r2.status === "success" && /^0x[0-9a-f]{64}$/.test(r2.txHash), r2.ok ? r2.txHash : errRow(r2));
check("R2", "tokens moved: recipient +3, relayer +fee, KurirRelayer holds 0",
  (await bal(FRESH)) - toBefore === tUSD("3") && (await bal(account.address)) - relayerTokBefore === relayerFee && (await bal(kurir)) === 0n);
check("R2", "user still has 0 BNB", (await publicClient.getBalance({ address: qaUser.address })) === 0n);

// ---- R1: existing-allowance path happy. Relayer applies the user's permit itself, so the user stays at 0 BNB. ----
const r1b = await build({ amount: tUSD("2") });
const ph = await walletClient.writeContract({
  address: token, abi: tokenAbi, functionName: "permit",
  args: [qaUser.address, kurir, r1b.permit.value, r1b.permit.deadline, r1b.permit.v, r1b.permit.r, r1b.permit.s],
});
await publicClient.waitForTransactionReceipt({ hash: ph });
const r1 = await submitRelay(r1b.intent, r1b.sig);
check("R1", "submitRelay happy path (prior allowance) → { txHash, status: 'success' }", r1.ok && r1.status === "success", errRow(r1));

// ---- R3: each custom error → plain message, no raw data ----
const cases: [string, Promise<RelayResult>][] = [];
{
  const b = await build({ relayer: getAddress("0x00000000000000000000000000000000000b0b00") });
  cases.push(["NotDesignatedRelayer", submitRelayWithPermit(b.intent, b.sig, b.permit)]);
}
{
  const b = await build({ deadline: now() - 60n });
  cases.push(["IntentExpired", submitRelayWithPermit(b.intent, b.sig, b.permit)]);
}
{
  const b = await build({ to: token });
  cases.push(["InvalidRecipient", submitRelayWithPermit(b.intent, b.sig, b.permit)]);
}
{
  const b = await build({}, QA_OTHER_KEY);
  cases.push(["InvalidSignature", submitRelayWithPermit(b.intent, b.sig, b.permit)]);
}
cases.push(["InvalidAccountNonce", submitRelayWithPermit(happy.intent, happy.sig, happy.permit)]); // replay of R2
{
  const b = await build({ amount: 0n });
  cases.push(["ZeroAmount", submitRelayWithPermit(b.intent, b.sig, b.permit)]);
}
for (const [name, p] of cases) {
  const r = await p;
  check("R3", `${name} → mapped code + plain Indonesian message, no hex/revert text`,
    !r.ok && r.code === name && !looksRaw(r.message), errRow(r));
}

// ---- R4: unexpected failures return a clean result, never throw ----
{
  const b = await build({ amount: tUSD("5000") }, QA_USER_KEY); // user holds < 1,000
  const r = await submitRelayWithPermit(b.intent, b.sig, b.permit);
  check("R4", "insufficient balance → clean result (ERC20InsufficientBalance), no throw", !r.ok && r.code === "ERC20InsufficientBalance" && !looksRaw(r.message), errRow(r));
}
{
  // token = a contract with no transferFrom → empty revert data, not in any ABI.
  const b = await build({ token: kurir, to: FRESH });
  const r = await submitRelay(b.intent, b.sig);
  check("R4", "revert with no decodable error → generic plain message, no throw", !r.ok && !looksRaw(r.message), errRow(r));
}
{
  const real = await publicClient.getBalance({ address: account.address });
  await publicClient.request({ method: "anvil_setBalance" as never, params: [account.address, "0x0"] as never });
  const b = await build({ amount: tUSD("1") });
  let r: RelayResult | undefined; let threw: unknown;
  try { r = await submitRelayWithPermit(b.intent, b.sig, b.permit); } catch (e) { threw = e; }
  await publicClient.request({ method: "anvil_setBalance" as never, params: [account.address, `0x${real.toString(16)}`] as never });
  check("R4", "relayer has 0 BNB → clean RelayerOutOfGas, no throw", !threw && !!r && !r.ok && r.code === "RelayerOutOfGas", threw ? String(threw) : errRow(r!));
}

done();
