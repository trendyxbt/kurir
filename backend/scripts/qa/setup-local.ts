/**
 * Local anvil setup for Day 2 QA. Funds the QA user with tUSD (user stays at 0 BNB) and
 * creates on-chain send history: two 10 tUSD relays user → P. LOCAL ANVIL ONLY.
 */
import { parseUnits } from "viem";
import { account, chain, env, publicClient, relayerFee, walletClient } from "../../src/config.js";
import { submitRelayWithPermit } from "../../src/relay.js";
import { P, QA_USER_KEY, qaUser, signIntent, signPermit, tokenAbi } from "./lib.js";

if (!env.RPC_URL.includes("127.0.0.1")) throw new Error("setup-local is for local anvil only");

const token = env.TOKEN_ADDRESS;
const kurir = env.KURIR_RELAYER_ADDRESS;
const read = (functionName: "balanceOf" | "nonces", who: `0x${string}`) =>
  publicClient.readContract({ address: token, abi: tokenAbi, functionName, args: [who] });

const hash = await walletClient.writeContract({ address: token, abi: tokenAbi, functionName: "faucet", args: [qaUser.address] });
await publicClient.waitForTransactionReceipt({ hash });

const name = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "name" });
for (let k = 0; k < 2; k++) {
  const amount = parseUnits("10", 18);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const intent = {
    token, from: qaUser.address, to: P, amount, fee: relayerFee, relayer: account.address,
    nonce: await publicClient.readContract({ address: kurir, abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "nonces", args: [qaUser.address] }),
    deadline,
  };
  const sig = await signIntent(QA_USER_KEY, intent, chain.id, kurir);
  const permit = await signPermit(QA_USER_KEY, token, name, await read("nonces", qaUser.address), kurir, amount + relayerFee, deadline, chain.id);
  const r = await submitRelayWithPermit(intent, sig, permit);
  if (!r.ok) throw new Error(`setup relay failed: ${r.code}`);
}
console.log("user", qaUser.address, "tUSD", (await read("balanceOf", qaUser.address)).toString(),
  "BNB", (await publicClient.getBalance({ address: qaUser.address })).toString(),
  "P tUSD", (await read("balanceOf", P)).toString());
