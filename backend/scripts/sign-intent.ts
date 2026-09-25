/**
 * Build and sign a Kurir SendIntent + EIP-2612 Permit with viem, and write the
 * /relay request body to a JSON file for curl.
 *
 *   SIGNER_KEY_FILE=/path/to/key TO=0x… AMOUNT=5 npx tsx scripts/sign-intent.ts > body.json
 *   curl -s localhost:8787/relay -H 'content-type: application/json' -d @body.json
 *
 * The signer is a throwaway testnet key (created on first run if the file doesn't exist).
 * It never holds BNB. If it has too little tUSD, the relayer tops it up via the public
 * MockStable.faucet(to) — the only tx this script sends, paid by the relayer.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { formatUnits, getAddress, parseAbi, parseSignature, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chain, env, publicClient, relayerFee, account as relayerAccount, walletClient } from "../src/config.js";

const keyFile = process.env.SIGNER_KEY_FILE;
if (!keyFile) throw new Error("Set SIGNER_KEY_FILE (a path outside the repo)");
if (!existsSync(keyFile)) writeFileSync(keyFile, generatePrivateKey(), { mode: 0o600 });
const user = privateKeyToAccount(readFileSync(keyFile, "utf8").trim() as Hex);

const to = getAddress((process.env.TO ?? "").toLowerCase());
const amount = parseUnits(process.env.AMOUNT ?? "5", 18);
const fee = relayerFee; // what GET /config advertises
const log = (...a: unknown[]) => console.error(...a); // stdout is reserved for the JSON body

const token = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function nonces(address) view returns (uint256)",
  "function faucet(address to)",
]);
const kurir = parseAbi(["function nonces(address) view returns (uint256)"]);

// 0. Make sure the signer has enough tUSD (relayer pays this one faucet tx; the signer never gets BNB).
const bal = await publicClient.readContract({ address: env.TOKEN_ADDRESS, abi: token, functionName: "balanceOf", args: [user.address] });
if (bal < amount + fee) {
  log(`signer ${user.address} has ${formatUnits(bal, 18)} tUSD, topping up via faucet…`);
  const hash = await walletClient.writeContract({ address: env.TOKEN_ADDRESS, abi: token, functionName: "faucet", args: [user.address] });
  await publicClient.waitForTransactionReceipt({ hash });
  log(`faucet tx: ${chain.blockExplorers.default.url}/tx/${hash}`);
}

// 1. Read the two nonces and the token's EIP-712 name.
const [intentNonce, permitNonce, tokenName] = await Promise.all([
  publicClient.readContract({ address: env.KURIR_RELAYER_ADDRESS, abi: kurir, functionName: "nonces", args: [user.address] }),
  publicClient.readContract({ address: env.TOKEN_ADDRESS, abi: token, functionName: "nonces", args: [user.address] }),
  publicClient.readContract({ address: env.TOKEN_ADDRESS, abi: token, functionName: "name" }),
]);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);

// 2. The SendIntent — field order must match SEND_INTENT_TYPEHASH in KurirRelayer.sol exactly.
const intent = {
  token: env.TOKEN_ADDRESS,
  from: user.address,
  to,
  amount,
  fee,
  relayer: relayerAccount.address, // only this address may submit it (front-run protection)
  nonce: intentNonce,
  deadline,
};

// 3. Sign it: EIP-712, domain { name: "Kurir", version: "1", chainId, verifyingContract: KurirRelayer }.
const signature = await user.signTypedData({
  domain: { name: "Kurir", version: "1", chainId: chain.id, verifyingContract: env.KURIR_RELAYER_ADDRESS },
  types: {
    SendIntent: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "relayer", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "SendIntent",
  message: intent,
});

// 4. Sign the EIP-2612 Permit on the token: KurirRelayer may pull exactly amount + fee, nothing more.
const permitSig = await user.signTypedData({
  domain: { name: tokenName, version: "1", chainId: chain.id, verifyingContract: env.TOKEN_ADDRESS },
  types: {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Permit",
  message: { owner: user.address, spender: env.KURIR_RELAYER_ADDRESS, value: amount + fee, nonce: permitNonce, deadline },
});
const { r, s, v, yParity } = parseSignature(permitSig);

// 5. Emit the /relay body (bigints as decimal strings).
const str = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, x]) => [k, typeof x === "bigint" ? x.toString() : x]));
log(`signer ${user.address} | BNB: ${formatUnits(await publicClient.getBalance({ address: user.address }), 18)} | nonce ${intentNonce}`);
console.log(
  JSON.stringify(
    {
      intent: str(intent),
      signature,
      permit: { value: (amount + fee).toString(), deadline: deadline.toString(), v: Number(v ?? BigInt(yParity + 27)), r, s },
    },
    null,
    2,
  ),
);
