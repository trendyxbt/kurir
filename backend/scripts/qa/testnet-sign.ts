/**
 * Day 2 QA, Section 6 step 3. Builds + signs a SendIntent and Permit with viem for the QA user
 * and prints the /relay body (stdout) for curl. Testnet-only QA user (tUSD only, 0 BNB); if it
 * lacks tUSD, the relayer calls the public MockStable.faucet(user) first — the only tx sent here.
 *
 *   TO=0x… AMOUNT=5 npx tsx scripts/qa/testnet-sign.ts > body.json
 */
import { getAddress, parseUnits } from "viem";
import { account, chain, env, publicClient, relayerFee, walletClient } from "../../src/config.js";
import { kurirRelayerAbi } from "../../src/abi.js";
import { QA_USER_KEY, jsonable, qaUser, signIntent, signPermit, tokenAbi, type Intent } from "./lib.js";

const token = env.TOKEN_ADDRESS;
const kurir = env.KURIR_RELAYER_ADDRESS;
const to = getAddress((process.env.TO ?? "").toLowerCase());
const amount = parseUnits(process.env.AMOUNT ?? "5", 18);
const log = (...a: unknown[]) => console.error(...a);

const bal = () => publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [qaUser.address] });
if ((await bal()) < amount + relayerFee) {
  const hash = await walletClient.writeContract({ address: token, abi: tokenAbi, functionName: "faucet", args: [qaUser.address] });
  await publicClient.waitForTransactionReceipt({ hash });
  log(`faucet → QA user: ${hash}`);
}

const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const intent: Intent = {
  token, from: qaUser.address, to, amount, fee: relayerFee, relayer: account.address,
  nonce: await publicClient.readContract({ address: kurir, abi: kurirRelayerAbi, functionName: "nonces", args: [qaUser.address] }),
  deadline,
};
const signature = await signIntent(QA_USER_KEY, intent, chain.id, kurir);
const name = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "name" });
const tn = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "nonces", args: [qaUser.address] });
const permit = await signPermit(QA_USER_KEY, token, name, tn, kurir, amount + relayerFee, deadline, chain.id);

log(`QA user ${qaUser.address}: ${await bal()} tUSD base units, ${await publicClient.getBalance({ address: qaUser.address })} wei BNB, intent nonce ${intent.nonce}`);
console.log(JSON.stringify(jsonable({ intent, signature, permit })));
