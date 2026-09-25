/**
 * Checkpoint script for relay.ts error mapping, against the live BSC testnet contract.
 *
 *   npx tsx scripts/relay-errors-check.ts
 *
 * Every case reverts at the simulateContract step, so no transaction is ever sent
 * and no gas is spent. Signs with a throwaway key generated in memory (never funded).
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseUnits, type Hex } from "viem";
import { account, chain, env } from "../src/config.js";
import { submitRelay, submitRelayWithPermit, type SendIntent } from "../src/relay.js";

const user = privateKeyToAccount(generatePrivateKey());
const now = BigInt(Math.floor(Date.now() / 1000));

async function sign(i: SendIntent): Promise<Hex> {
  return user.signTypedData({
    domain: { name: "Kurir", version: "1", chainId: chain.id, verifyingContract: env.KURIR_RELAYER_ADDRESS },
    types: {
      SendIntent: [
        { name: "token", type: "address" }, { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "amount", type: "uint256" }, { name: "fee", type: "uint256" }, { name: "relayer", type: "address" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "SendIntent",
    message: i,
  });
}

const base: SendIntent = {
  token: env.TOKEN_ADDRESS,
  from: user.address,
  to: "0x9f3a000000000000000000000000000000c0ffee",
  amount: parseUnits("10", 18),
  fee: parseUnits("0.5", 18),
  relayer: account.address,
  nonce: 0n,
  deadline: now + 600n,
};

const cases: { name: string; expect: string; intent: SendIntent; badSig?: boolean; permit?: boolean }[] = [
  { name: "intent names a different relayer", expect: "NotDesignatedRelayer", intent: { ...base, relayer: "0x000000000000000000000000000000000000beef" } },
  { name: "deadline already passed", expect: "IntentExpired", intent: { ...base, deadline: now - 60n } },
  { name: "recipient is the token contract", expect: "InvalidRecipient", intent: { ...base, to: env.TOKEN_ADDRESS } },
  { name: "signature doesn't match the intent", expect: "InvalidSignature", intent: base, badSig: true },
  { name: "wrong nonce (valid signature)", expect: "InvalidAccountNonce", intent: { ...base, nonce: 5n } },
  { name: "zero amount", expect: "ZeroAmount", intent: { ...base, amount: 0n } },
  { name: "valid intent, but no tUSD/permit (relayWithPermit)", expect: "ERC20InsufficientAllowance", intent: base, permit: true },
];

let fails = 0;
for (const c of cases) {
  let sig = await sign(c.intent);
  if (c.badSig) sig = await sign({ ...c.intent, amount: c.intent.amount + 1n }); // signed a different amount
  const res = c.permit
    ? await submitRelayWithPermit(c.intent, sig, { value: 0n, deadline: now + 600n, v: 27, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` })
    : await submitRelay(c.intent, sig);

  const leaks = !res.ok && /0x[0-9a-fA-F]{8,}/.test(res.message);
  const ok = !res.ok && res.code === c.expect && !leaks;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(`      ${res.ok ? `UNEXPECTED SUCCESS ${res.txHash}` : `code=${res.code}  message="${res.message}"${leaks ? "  (LEAKS HEX)" : ""}`}`);
}
console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILED`} — no transactions sent (all rejected at simulation)`);
process.exit(fails === 0 ? 0 : 1);
