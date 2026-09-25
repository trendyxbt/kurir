/**
 * Day 2 QA: backend/src/history.ts (in-memory Relayed index), over HTTP against a running server.
 * LOCAL ANVIL ONLY. Needs setup-local.ts to have run. Server must have the indexer started (default).
 *
 *   API=http://localhost:8788 npx tsx scripts/qa/history-index.ts
 *
 * Recipients are derived per run, so the test is re-runnable.
 */
import { getAddress, keccak256, parseUnits, toHex, type Address } from "viem";
import { account, chain, env, publicClient, relayerFee } from "../../src/config.js";
import { submitRelayWithPermit } from "../../src/relay.js";
import { QA_USER_KEY, check, done, jsonable, qaUser, signIntent, signPermit, tokenAbi, type Intent } from "./lib.js";

if (!env.RPC_URL.includes("127.0.0.1")) throw new Error("local anvil only");
const API = process.env.API ?? "http://localhost:8788";
const token = env.TOKEN_ADDRESS;
const kurir = env.KURIR_RELAYER_ADDRESS;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36);

/** A fresh recipient plus a same-head/same-tail lookalike of it (POISON_MATCH_CHARS = 4). */
function pair(tag: string): { real: Address; look: Address } {
  const h = keccak256(toHex(`${run}-${tag}`)).slice(2, 42);
  const look = h.slice(0, 4) + "f".repeat(32) + h.slice(-4);
  return { real: getAddress("0x" + h), look: getAddress("0x" + look) };
}
const health = async () => (await (await fetch(API + "/health")).json()) as any;
async function guard(to: Address, amount = "10") {
  const t = Date.now();
  const r = await fetch(API + "/guard", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, from: qaUser.address, to, amount: parseUnits(amount, 18).toString() }),
  });
  return { ms: Date.now() - t, json: (await r.json()) as any };
}
const codes = (j: any) => `${j.verdict} [${j.findings.map((f: any) => f.code).join(",") || "none"}]`;

const tokenName = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "name" });
const nonceAbi = [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
async function build(to: Address) {
  const amount = parseUnits("3", 18);
  const deadline = now() + 600n;
  const intent: Intent = {
    token, from: qaUser.address, to, amount, fee: relayerFee, relayer: account.address,
    nonce: await publicClient.readContract({ address: kurir, abi: nonceAbi, functionName: "nonces", args: [qaUser.address] }), deadline,
  };
  const signature = await signIntent(QA_USER_KEY, intent, chain.id, kurir);
  const tn = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "nonces", args: [qaUser.address] });
  const permit = await signPermit(QA_USER_KEY, token, tokenName, tn, kurir, amount + relayerFee, deadline, chain.id);
  return { intent, signature, permit };
}

// ---- IX1: startup backfill ----
let h = await health();
check("IX1", "/health reports the index ready with backfilled events", h.history.ready === true && h.history.events >= 2, h.history);

// ---- IX2: backfilled history reaches the guard (no client history sent) ----
let g = await guard(getAddress("0x7a3cffffffffffffffffffffffffffffffff9b2e"));
check("IX2", "lookalike of an address sent to before server start → warn ADDRESS_POISONING", g.json.verdict === "warn" && g.json.findings.some((f: any) => f.code === "ADDRESS_POISONING"), codes(g.json));

// ---- IX3: the server's own relay is recorded instantly and exactly once ----
const A = pair("A");
const before = (await health()).history.events;
let b = await build(A.real);
let r = await fetch(API + "/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(jsonable(b)) });
check("IX3", "/relay to a new recipient succeeds", r.status === 200, r.status);
const afterImmediate = (await health()).history.events;
g = await guard(A.look);
check("IX3", "immediately after /relay (before any 4 s poll can matter): events +1 and lookalike of the new recipient → warn", afterImmediate === before + 1 && g.json.verdict === "warn", { events: `${before}→${afterImmediate}`, verdict: codes(g.json) });
await sleep(9000); // > 2 poll ticks: polling must dedupe against the receipt-recorded event
const afterPoll = (await health()).history.events;
check("IX3", "after the poller has seen the same block: still +1 (txHash:logIndex dedupe, no double count)", afterPoll === before + 1, { events: afterPoll });

// ---- IX4: a relay the server did NOT submit is picked up by polling ----
const B = pair("B");
b = await build(B.real);
const rr = await submitRelayWithPermit(b.intent, b.signature, b.permit); // separate process → server never sees the receipt
check("IX4", "relay submitted from another process succeeds", rr.ok, rr.ok ? rr.txHash : rr.code);
const t0 = Date.now();
let seen = false;
for (; Date.now() - t0 < 15000; await sleep(500)) {
  g = await guard(B.look);
  if (g.json.verdict === "warn" && g.json.findings.some((f: any) => f.code === "ADDRESS_POISONING")) { seen = true; break; }
}
check("IX4", "poller picks it up: lookalike of that recipient → warn ADDRESS_POISONING", seen, `${Date.now() - t0} ms after relay`);

// ---- IX5: /guard latency with the index ----
const lat: number[] = [];
for (let i = 0; i < 30; i++) lat.push((await guard(getAddress("0x7a3c5d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a9b2e"))).ms);
lat.sort((x, y) => x - y);
check("IX5", "/guard to a known address: 30 calls, p95 < 250 ms", lat[Math.floor(lat.length * 0.95) - 1] < 250, `median ${lat[15]} ms, p95 ${lat[Math.floor(lat.length * 0.95) - 1]} ms, max ${lat[29]} ms`);
h = await health();
check("IX5", "/health still ok with fresh index", h.ok === true && h.history.ageMs < 8000, h.history);

done();
