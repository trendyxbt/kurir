/**
 * Day 2 QA helpers (qa/day2-acceptance-criteria.md). Written by QA, independent of the
 * developer's checkpoint scripts. Signing is built from the EIP-712 spec in README/CLAUDE.md,
 * not copied from backend code.
 */
import { getAddress, keccak256, parseAbi, parseSignature, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const QA_USER_KEY = keccak256(toHex("kurir-qa-day2-user")) as Hex;
export const QA_OTHER_KEY = keccak256(toHex("kurir-qa-day2-wrong-signer")) as Hex;
export const qaUser = privateKeyToAccount(QA_USER_KEY);

export const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function nonces(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function faucet(address to)",
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
]);

export interface Intent {
  token: Address; from: Address; to: Address; amount: bigint; fee: bigint;
  relayer: Address; nonce: bigint; deadline: bigint;
}
export interface Permit { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex }

export async function signIntent(key: Hex, i: Intent, chainId: number, kurir: Address): Promise<Hex> {
  return privateKeyToAccount(key).signTypedData({
    domain: { name: "Kurir", version: "1", chainId, verifyingContract: kurir },
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

export async function signPermit(
  key: Hex, token: Address, tokenName: string, tokenNonce: bigint, spender: Address,
  value: bigint, deadline: bigint, chainId: number,
): Promise<Permit> {
  const acct = privateKeyToAccount(key);
  const sig = await acct.signTypedData({
    domain: { name: tokenName, version: "1", chainId, verifyingContract: token },
    types: {
      Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: acct.address, spender, value, nonce: tokenNonce, deadline },
  });
  const { v, r, s } = parseSignature(sig);
  return { value, deadline, v: Number(v), r, s };
}

/** JSON-safe copy (bigint → decimal string) for HTTP bodies. */
export const jsonable = (o: unknown): unknown =>
  JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

let failures = 0;
const rows: string[] = [];
export function check(id: string, name: string, cond: boolean, detail?: unknown) {
  const line = `${cond ? "PASS" : "FAIL"}  ${id.padEnd(5)} ${name}${detail !== undefined ? `  → ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
  console.log(line);
  rows.push(line);
  if (!cond) failures++;
}
export function done() {
  console.log(`\n${rows.length - failures}/${rows.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

/** A user-facing message must not leak raw revert data, selectors, or stack frames. */
export const looksRaw = (s: unknown) =>
  typeof s !== "string" || s.length === 0 || /0x[0-9a-fA-F]{8,}|\bat \S+\.(ts|js)|Error:|revert/i.test(s);

// Fixed addresses used across the QA run.
export const P = getAddress("0x7a3c5d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a9b2e"); // has on-chain send history (set up by setup-local)
export const P_LOOKALIKE = getAddress("0x7a3cffffffffffffffffffffffffffffffff9b2e"); // same first/last 4 as P
export const H = getAddress("0x5eed000000000000000000000000000000000001"); // only in client-side `history`
export const H_LOOKALIKE = getAddress("0x5eedaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001");
export const FRESH = getAddress("0x9f3a00000000000000000000000000000000c0fe"); // never seen anywhere
export const SCAM = getAddress("0x000000000000000000000000000000000000dead");
export const ZERO = getAddress("0x0000000000000000000000000000000000000000");
