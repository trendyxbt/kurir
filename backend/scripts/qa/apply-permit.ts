/** Day 2 QA, R1 on testnet: the relayer applies the user's permit as its own tx, so the user stays at 0 BNB. */
import { readFileSync } from "node:fs";
import { env, publicClient, walletClient } from "../../src/config.js";
import { tokenAbi } from "./lib.js";
const { intent, permit } = JSON.parse(readFileSync(process.env.BODY!, "utf8"));
const hash = await walletClient.writeContract({
  address: env.TOKEN_ADDRESS, abi: tokenAbi, functionName: "permit",
  args: [intent.from, env.KURIR_RELAYER_ADDRESS, BigInt(permit.value), BigInt(permit.deadline), permit.v, permit.r, permit.s],
});
await publicClient.waitForTransactionReceipt({ hash });
console.log(`permit applied: ${hash}`);
