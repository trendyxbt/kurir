/**
 * Day 2 QA, Section 5 (server.ts) + L3, over real HTTP against a running backend.
 *
 *   API=http://localhost:8788 QA_SERVER_LOG=<server stdout file> npx tsx scripts/qa/http.ts
 *
 * The server must run with scripts/qa/llm-spy.mjs preloaded and a fake OPENAI_API_KEY, so the
 * LLM path is live but intercepted. LOCAL ANVIL ONLY.
 */
import { readFileSync } from "node:fs";
import { parseUnits, type Address } from "viem";
import { chain, env, publicClient, relayerFee, account } from "../../src/config.js";
import { kurirRelayerAbi } from "../../src/abi.js";
import { FRESH, H, H_LOOKALIKE, P, P_LOOKALIKE, QA_USER_KEY, SCAM, ZERO, check, done, jsonable, looksRaw, qaUser, signIntent, signPermit, tokenAbi, type Intent } from "./lib.js";

if (!env.RPC_URL.includes("127.0.0.1")) throw new Error("http.ts is for local anvil only");
const API = process.env.API ?? "http://localhost:8788";
const LOG = process.env.QA_SERVER_LOG!;
const token = env.TOKEN_ADDRESS;
const kurir = env.KURIR_RELAYER_ADDRESS;
const tUSD = (n: string) => parseUnits(n, 18);
const now = () => BigInt(Math.floor(Date.now() / 1000));
const spyCalls = () => (readFileSync(LOG, "utf8").match(/\[qa-llm-spy\]/g) ?? []).length;
const bal = (who: Address) => publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [who] });
const kNonce = () => publicClient.readContract({ address: kurir, abi: kurirRelayerAbi, functionName: "nonces", args: [qaUser.address] });
const tokenName = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "name" });

async function raw(path: string, body: string, contentType = "application/json") {
  const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": contentType }, body });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, text, json };
}
const post = (path: string, body: unknown) => raw(path, JSON.stringify(jsonable(body)));
const guard = (to: Address, amount: string, history?: Address[]) =>
  post("/guard", { token, from: qaUser.address, to, amount: tUSD(amount), ...(history ? { history } : {}) });

async function signed(over: Partial<Intent> = {}) {
  const intent: Intent = {
    token, from: qaUser.address, to: P, amount: tUSD("4"), fee: relayerFee, relayer: account.address,
    nonce: await kNonce(), deadline: now() + 600n, ...over,
  };
  const signature = await signIntent(QA_USER_KEY, intent, chain.id, kurir);
  const tn = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "nonces", args: [qaUser.address] });
  const permit = await signPermit(QA_USER_KEY, token, tokenName, tn, kurir, intent.amount + intent.fee, now() + 600n, chain.id);
  return { intent, signature, permit };
}

// ---------- S1 / S2 + L3 ----------
let c0 = spyCalls();
let r = await guard(P, "10");
check("S1", "/guard normal (previously-used) address → 200 ok, no findings", r.status === 200 && r.json?.verdict === "ok" && r.json.findings.length === 0, r.json);
check("L3", "ok verdict → 0 LLM calls", spyCalls() - c0 === 0, spyCalls() - c0);

c0 = spyCalls();
r = await guard(token, "10");
check("S2", "/guard to token contract → block", r.json?.verdict === "block", r.json?.findings?.map((f: any) => f.code));
r = await guard(SCAM, "10");
check("S2+", "/guard to scam-list address → block", r.json?.verdict === "block");
r = await guard(ZERO, "10");
check("S2+", "/guard to zero address → block", r.json?.verdict === "block");
check("L3", "3 block verdicts → 0 LLM calls", spyCalls() - c0 === 0, spyCalls() - c0);

c0 = spyCalls();
r = await guard(P_LOOKALIKE, "10");
check("L3", "warn (poisoning) → exactly 1 LLM call, explanation comes from it", r.json?.verdict === "warn" && spyCalls() - c0 === 1 && r.json.explanation === "[qa-spy sentence]", { calls: spyCalls() - c0, explanation: r.json?.explanation });
c0 = spyCalls();
r = await guard(H_LOOKALIKE, "10", [H]);
check("L3", "warn via client history → exactly 1 LLM call", r.json?.verdict === "warn" && spyCalls() - c0 === 1);

// ---------- S4: bypass /guard entirely and go straight to /relay with VALID signatures ----------
const relayerTxBefore = await publicClient.getTransactionCount({ address: account.address });
const nonceBefore = await kNonce();

for (const [label, to] of [["token contract", token], ["zero address", ZERO], ["KurirRelayer", kurir]] as [string, Address][]) {
  const b = await signed({ to });
  r = await post("/relay", b);
  check("S4", `/relay (no prior /guard) to ${label} → 422 GuardBlocked`, r.status === 422 && r.json?.error === "GuardBlocked", { status: r.status, error: r.json?.error });
}

// The decisive one: the contract itself would ACCEPT a send to a scam-list address. Only the server guard stops it.
const scam = await signed({ to: SCAM });
let chainWouldAccept = false;
try {
  await publicClient.simulateContract({ address: kurir, abi: kurirRelayerAbi, functionName: "relayWithPermit", args: [scam.intent, scam.signature, scam.permit], account });
  chainWouldAccept = true;
} catch { /* contract rejected */ }
check("S4", "control: the contract alone WOULD accept this scam-list send (simulation succeeds)", chainWouldAccept);
const scamBefore = await bal(SCAM);
r = await post("/relay", scam);
check("S4", "/relay (no prior /guard) to scam-list address → 422 GuardBlocked", r.status === 422 && r.json?.error === "GuardBlocked" && r.json.guard?.findings?.[0]?.code === "SCAM_LIST", { status: r.status, error: r.json?.error });
r = await post("/relay", { ...scam, intent: { ...jsonable(scam.intent) as object, to: SCAM.toLowerCase() } });
check("S4", "same, recipient sent in lowercase → still GuardBlocked (sig mismatch irrelevant; guard runs first)", r.status === 422 && r.json?.error === "GuardBlocked", r.json?.error);

check("S4", "nothing reached the chain: scam balance, user nonce and relayer tx count unchanged",
  (await bal(SCAM)) === scamBefore && (await kNonce()) === nonceBefore && (await publicClient.getTransactionCount({ address: account.address })) === relayerTxBefore);

// ---------- S3 (local) + replay ----------
const good = await signed({ to: P, amount: tUSD("4") });
const pBefore = await bal(P);
r = await post("/relay", good);
check("S3", "/relay happy path → 200 with txHash + explorer URL, tokens moved", r.status === 200 && /^0x[0-9a-f]{64}$/.test(r.json?.txHash) && r.json.explorerUrl?.includes(r.json.txHash) && (await bal(P)) - pBefore === tUSD("4"), r.json);
r = await post("/relay", good);
check("R3", "same signed intent again → clean replay rejection (InvalidAccountNonce, plain message)", r.status === 422 && r.json?.error === "InvalidAccountNonce" && !looksRaw(r.json.message), r.json);

// ---------- R4 over HTTP: unexpected failure does not take the server down ----------
const broke = await signed({ to: P, amount: tUSD("900000") });
r = await post("/relay", { ...broke, permit: undefined });
check("R4", "insufficient balance via /relay → clean 4xx JSON", r.status >= 400 && r.status < 500 && !looksRaw(r.json?.message), r.json);
const health = await fetch(API + "/health").then((x) => x.json()).catch(() => null);
check("R4", "server still alive after the failure (/health ok)", health?.ok === true);

// ---------- S5: malformed bodies → clean 4xx, no stack trace ----------
const malformed: [string, string, string, string?][] = [
  ["/guard", "empty object", "{}"],
  ["/guard", "missing amount", JSON.stringify({ token, from: qaUser.address, to: P })],
  ["/guard", "bad address", JSON.stringify({ token, from: qaUser.address, to: "0x1234", amount: "1" })],
  ["/guard", "negative amount", JSON.stringify({ token, from: qaUser.address, to: P, amount: "-1" })],
  ["/guard", "decimal amount", JSON.stringify({ token, from: qaUser.address, to: P, amount: "1.5" })],
  ["/guard", "history too long (201)", JSON.stringify({ token, from: qaUser.address, to: P, amount: "1", history: Array(201).fill(P) })],
  ["/guard", "invalid JSON syntax", "{\"token\": "],
  ["/guard", "JSON array instead of object", "[]"],
  ["/guard", "JSON null", "null"],
  ["/guard", "text/plain body", "hello", "text/plain"],
  ["/relay", "empty object", "{}"],
  ["/relay", "intent missing fields", JSON.stringify({ intent: { token }, signature: "0x" })],
  ["/relay", "signature not hex", JSON.stringify({ ...(jsonable(good) as object), signature: "hello" })],
  ["/relay", "permit.v out of range", JSON.stringify({ ...(jsonable(good) as object), permit: { ...(jsonable(good.permit) as object), v: 300 } })],
  ["/relay", "amount above uint256 max", JSON.stringify({ ...(jsonable(good) as object), intent: { ...(jsonable(good.intent) as object), amount: "9".repeat(90) } })],
  ["/relay", "invalid JSON syntax", "{\"intent\": {"],
  ["/relay", "oversized body (>32kb)", JSON.stringify({ pad: "x".repeat(40_000) })],
];
for (const [path, label, body, ct] of malformed) {
  r = await raw(path, body, ct);
  const clean = r.status >= 400 && r.status < 500 && !/\bat \S+\.(ts|js)|node_modules|SyntaxError|<pre>/i.test(r.text);
  check("S5", `${path} ${label} → clean 4xx`, clean, `${r.status} ${r.text.slice(0, 110)}`);
}
const health2 = await fetch(API + "/health").then((x) => x.json()).catch(() => null);
check("S5", "server still alive after all malformed requests", health2?.ok === true);

done();
