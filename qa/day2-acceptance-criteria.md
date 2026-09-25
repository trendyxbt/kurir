# Kurir — Day 2 QA Test Plan & Acceptance Criteria

**Scope:** `backend/src/guard.ts`, `llmExplain.ts`, `relay.ts`, `server.ts`.
Contracts are out of scope here (already covered by
`qa/day1-acceptance-criteria.md` — this doc assumes that one is already
Accepted). Frontend is out of scope (not built yet).

**Why this matters more than Day 1's doc:** the contracts are the last line of
defense — they'll revert on a bad transaction no matter what. The backend is
the *first* line of defense, and it's the part a judge (or a real user) will
actually see and trust. If the guard is wrong, the demo either blocks a
legitimate send in front of everyone, or worse, waves through the poisoned
address it exists to catch. Test this one skeptically.

---

## 1. Environment & startup verification

| ID | Criterion | Pass condition | Evidence to capture |
|----|-----------|-----------------|---------------------|
| E1 | Config loads and validates | `npm run dev` starts with no zod validation errors | Startup log |
| E2 | Fails loudly on bad config | Deliberately blank `RELAYER_PRIVATE_KEY` or a malformed address in `.env` → server refuses to start with a clear error, not a silent crash later on first request | Two intentional bad-config runs, both output |
| E3 | Relayer wallet is funded | `walletClient` account has nonzero testnet BNB before any `/relay` test runs | `cast balance <relayer-address> --rpc-url bsc_testnet` output |

## 2. `guard.ts` — deterministic checks (test these BEFORE any LLM involvement)

| ID | Input | Expected verdict | Why this must be deterministic, not AI-judged |
|----|-------|-------------------|-----------------------------------------------|
| G1 | `to == token` (send to the token's own contract) | `block` | This is the single most common real-world fund-loss mistake — must never depend on an API call succeeding |
| G2 | `to == 0x0` | `block` | Same reasoning |
| G3 | `to` on the scam list (`SCAM_LIST` env) | `block` | A curated blocklist should never be second-guessed by an LLM |
| G4 | `to` is a near-miss of an address in `history` (differs only in the middle characters) | `warn`, not `block` | Could be legitimate — a hard block here would itself be a usability failure; this is the one case that's genuinely a judgment call |
| G5 | `to` has no on-chain history and `amount` is large relative to the sender's typical send | `warn` | Same — plausibly fine, worth a second look |
| G6 | `to` is a contract the sender hasn't interacted with before | `warn` | Same |
| G7 | Ordinary previously-used address, ordinary amount | `ok` | Must not over-flag — a guard that warns on everything trains users to click through it, defeating the purpose |
| G8 | `to` identical to an address in `history` (not a near-miss — an exact match) | `ok` | Confirm exact matches are never mistaken for poisoning |

**Acceptance for Section 2:** all 8 cases produce the exact verdict specified —
QA should call `guard.ts` directly (unit-level, not through the HTTP layer) for
this section, so a server bug can't mask a guard bug or vice versa.

## 3. `llmExplain.ts`

| ID | Criterion | Pass condition |
|----|-----------|-----------------|
| L1 | No API key configured | With `OPENAI_API_KEY` blank, a `warn`-level finding still returns a usable Indonesian sentence — confirm it's the template fallback, not a thrown error or an empty string |
| L2 | API key configured (if you choose to test this before the demo) | Returns a sentence, not a JSON blob or an English fallback |
| L3 | Never called for `block` or `ok` | Instrument or log-check that `llmExplain` is not invoked when the guard verdict is `block` or `ok` — this is a design invariant from CLAUDE.md ("rules block, AI explains"), not just a nice-to-have |
| L4 | Voice check | Explanation reads as casual Bahasa (Jaksel-style per ways-of-working voice notes), not a stiff literal translation — subjective, but worth a human read before the demo, not just an automated pass |

## 4. `relay.ts`

| ID | Criterion | Pass condition |
|----|-----------|-----------------|
| R1 | `submitRelay` happy path | Tokens move on testnet; returns `{ txHash, status: "success" }` |
| R2 | `submitRelayWithPermit` happy path | Same, using the permit path |
| R3 | Each contract custom error maps to a plain message | Force each of `NotDesignatedRelayer`, `IntentExpired`, `InvalidRecipient`, `InvalidSignature`, and OZ's `InvalidAccountNonce` (replay) — confirm the function returns/throws a human-readable message for each, not a raw revert selector or ABI-encoded data |
| R4 | Unknown revert doesn't crash the process | Simulate an unexpected revert (e.g. insufficient balance) — server logs it and returns a clean error response, doesn't take the whole backend down |

## 5. `server.ts` — the security-critical row is R5, don't skip it

| ID | Criterion | Pass condition |
|----|-----------|-----------------|
| S1 | `POST /guard` with a normal address | Returns `ok`, no findings |
| S2 | `POST /guard` with a send to the token contract | Returns `block` |
| S3 | `POST /relay` happy path end-to-end | Tokens move, BscScan-verifiable tx hash returned |
| **S4** | **`POST /relay` re-runs the guard server-side** | **Send an intent whose `to` is the token contract address directly to `/relay`, skipping `/guard` entirely (simulate a client that never called it, or lied about the result). This MUST be blocked server-side. If it isn't — if `/relay` trusts the client's prior `/guard` call or trusts the `intent` blindly — that's a critical finding, not a minor one: it means the guard is decorative.** |
| S5 | Malformed request body | `/guard` and `/relay` both return a clean 4xx, not a stack trace, on missing/malformed fields |
| S6 | CORS is intentionally open for the demo | Confirm this is a documented, deliberate choice (per CLAUDE.md) and not an oversight — flag in the sign-off notes as an accepted risk for a hackathon demo, not something to silently ship past this stage |

**S4 is the one finding that should stop the whole sign-off if it fails.**
Everything else in this doc is about the guard giving good advice; S4 is about
whether the guard's advice can be bypassed entirely by skipping a step. A demo
where the frontend "always calls /guard first" is not a real defense — anyone
with curl can skip it.

## 6. End-to-end curl walkthrough (matches the build prompt's Day 2 step 6)

Run these in order, capture actual output for each:

1. `curl -X POST localhost:8787/guard` with a normal recipient → expect `ok`
2. `curl -X POST localhost:8787/guard` with the token contract as recipient → expect `block`
3. Build and sign a real `SendIntent` (+ permit) with viem, submit via
   `curl -X POST localhost:8787/relay` → expect a real BscScan-verifiable tx
4. Repeat step 3 with the *same* signed intent a second time → expect a clean
   replay-rejection message (this exercises R3 + F5 from Day 1 together)

## 7. Sign-off

| Section | Result | Notes |
|---|---|---|
| 1. Environment | ☒ Pass ☐ Fail | E1–E3 pass. Minor: a bad `SCAM_LIST` entry exits 1 but prints a raw stack trace instead of the "Invalid backend/.env" format. |
| 2. Guard (8 cases) | ☒ Pass ☐ Fail | 8/8 plus 11 extra edges, unit level (19/19). Hard blocks still hold with the RPC dead. **But see finding QA2-2:** on-chain history only reaches back ~37 min on testnet, so poisoning detection without client history misses real lookalikes. |
| 3. LLM explain | ☐ Pass ☐ Fail ☒ **Pending** | L1 and L3 pass (L3 proven with a fetch spy in the live server: 0 calls for ok/block, exactly 1 per warn). L2 not run (needs a real OpenAI key = API spend). L4: QA read done, voice passes; poisoning sentence needs a content fix (QA2-4); final tick is Daviga's. |
| 4. Relay | ☒ Pass ☐ Fail | R1–R4 pass (13/13 on anvil). R1, R2 and replay also on testnet. |
| 5. Server (S4 critical) | ☐ Pass ☒ Fail | **S4 passes, decisively** (see QA2-1). **S5 fails:** invalid JSON, a `null` body and a >32 kb body return **500**, not 4xx (QA2-3). |
| 6. E2E curl walkthrough | ☒ Pass ☐ Fail | Steps 1–4 on BSC testnet, tx verified on chain independently. |
| **Overall Day 2** | ☐ **Accepted** ☒ **Rejected** | Rejected on S5 (a 500 on malformed JSON) and pending L4. The S5 fix is small. QA2-2 does not fail a row but is the most important thing in this report for the demo. |

Day 2 is accepted only when every section passes **and** S4 specifically has
been tested, not assumed. A green server that's never had its guard
deliberately bypassed hasn't actually been tested for the thing that matters
most in this architecture.

---

## QA results — 2026-09-25 (QA: Claude, separate session from the backend's author)

Code under test: `main` at `517bf77` (backend unchanged since `7c8076d`). All QA tests are new and
live in `backend/scripts/qa/`. The developer's checkpoint scripts (`guard-check.ts`,
`relay-errors-check.ts`, `sign-intent.ts`) were **not** used as evidence. Signing is built from the
EIP-712 spec, not from backend code.

**Environments**
- **Local:** anvil `--chain-id 97` on :8546, fresh MockStable + KurirRelayer, backend on :8788 with `SCAM_LIST=0x…dEaD`.
- **Testnet:** the real deployment, backend on :8789 via `npm run dev`.
- **Your :8787 instance** was left untouched.

**Scripts** (all in `backend/scripts/qa/`)

| Script | What it does |
|---|---|
| `lib.ts` | Spec-derived signing helpers, fixed test addresses, `check()` |
| `setup-local.ts` | QA user (0 BNB) gets tUSD, plus two 10 tUSD relays to `P` as on-chain history |
| `guard-unit.ts` | Section 2 + L1, direct `runGuard()` calls. `QA_MODE=degraded` points at a dead RPC |
| `relay-unit.ts` | Section 4, direct `submitRelay`/`submitRelayWithPermit` calls |
| `llm-spy.mjs` | Preloaded into the server. Intercepts and counts every `api.openai.com` call (L3); nothing leaves the machine |
| `http.ts` | Section 5 + L3 over real HTTP |
| `testnet-sign.ts`, `apply-permit.ts` | Section 6 and R1 on testnet |

### QA-1 · Environment

| ID | Result | Evidence |
|---|---|---|
| E1 | Pass | `PORT=8789 npm run dev` → no zod errors. Log: relayer `0xa0Dd…B002`, KurirRelayer `0x9342…5370`, token `0xf993…13cc`, "templates (no API key)". |
| E2 | Pass | Blank `RELAYER_PRIVATE_KEY` → `RELAYER_PRIVATE_KEY: must be a 0x-prefixed 32-byte hex key`, exit 1. `TOKEN_ADDRESS=0x1234notanaddress` → `TOKEN_ADDRESS: not a valid address`, exit 1. Extra: `RPC_URL=not-a-url` → `RPC_URL: Invalid URL`, exit 1. Extra: bad `SCAM_LIST` entry → exit 1, but as an uncaught `Error` with a stack trace (minor). |
| E3 | Pass | `cast balance 0xa0DdF566…B002` = 0.2998 tBNB before the testnet runs. |

### QA-2 · Guard (unit level, `runGuard()` called directly)

The QA user's on-chain history is two 10 tUSD sends to `P`, so the median is 10 and "large" means > 30.

| ID | Input | Result |
|---|---|---|
| G1 | `to == token` (and lowercase) | `block [RECIPIENT_IS_TOKEN]` ✅ |
| G2 | `to == 0x0` | `block [RECIPIENT_IS_ZERO]` ✅ |
| G3 | `to` on `SCAM_LIST` (and lowercase) | `block [SCAM_LIST]` ✅ |
| G4 | Lookalike of `P` (same first/last 4, 29 middle chars differ) | `warn [ADDRESS_POISONING]`, `similarTo = P` ✅. Also passes for a lookalike of a client-`history` address and of the sender's own address. |
| G5 | Fresh address, 100 tUSD | `warn [FRESH_ADDRESS_LARGE_SEND]` ✅. Control: same address, 5 tUSD → `ok`. |
| G6 | Freshly deployed contract | `warn [UNKNOWN_CONTRACT]` ✅ |
| G7 | `P` (on-chain history), 10 and 25 tUSD | `ok`, no findings ✅ |
| G8 | `to` exactly equals a `history` entry (and in different case) | `ok`, no findings ✅ |
| extra | `to == KurirRelayer` | `block [RECIPIENT_IS_RELAYER]` ✅ |
| extra | **RPC dead** (`RPC_URL=http://127.0.0.1:1`) | All hard blocks still `block`. A normal send → `warn [CHECKS_DEGRADED]`, never a silent `ok` ✅ |

### QA-3 · LLM explain

| ID | Result | Evidence |
|---|---|---|
| L1 | Pass | No key: `explainWarn()` returns exactly `templateExplain()`, e.g. *"Alamat ini mirip banget sama 0x7A3c…9b2e yang pernah kamu pakai, tapi 29 karakter tengahnya beda — cek lagi sebelum lanjut."* `runGuard()` never sets a warn explanation itself. |
| L2 | Not run | Needs a real OpenAI key (API spend). The plan marks it optional. Daviga's call. |
| L3 | Pass | Live server with a fake key and `llm-spy.mjs`. `ok` → 0 calls. 3 × `block` (token, scam, zero) → 0 calls. Each `warn` → exactly 1 call, and the response's `explanation` is the spy's sentence (so the LLM path really ran for warns). |
| L4 | **QA read done: voice passes, 1 content finding; final tick pending Daviga** | See *L4 voice review* below. All 10 rendered sentences are 13–23 words and read as casual Jaksel. **QA2-4:** the poisoning warning shows the real address as `0x7A3c…9b2e`, which is exactly the part a lookalike copies, so the only concrete detail can't help the user spot the difference. |

### QA-4 · Relay (`relay.ts` called directly, local anvil)

| ID | Result | Evidence |
|---|---|---|
| R1 | Pass | Local: `submitRelay` after the relayer applied the user's permit → `success`. **Testnet:** permit tx `0x8c1f093d…c49bd`, then `/relay` without permit → [`0x90d0585d…27365`](https://testnet.bscscan.com/tx/0x90d0585d9004ad5e57b0a2c7e8e0d57bcae4449ae0a3804cf92704ded5a27365), 69,611 gas. |
| R2 | Pass | `submitRelayWithPermit` → `{ txHash, status: "success" }`. Recipient +3, relayer +0.5 fee, KurirRelayer 0, user 0 BNB. Testnet: see Section 6. |
| R3 | Pass | Each forced revert returns the exact code plus a plain Bahasa message with no hex or "revert" text: `NotDesignatedRelayer`, `IntentExpired`, `InvalidRecipient`, `InvalidSignature`, `InvalidAccountNonce` (replay), plus `ZeroAmount`. |
| R4 | Pass | Insufficient balance → `ERC20InsufficientBalance`, clean. Undecodable revert (token = a contract without `transferFrom`) → `UnknownRevert: Transaksi ditolak kontrak.` Relayer at 0 BNB → `RelayerOutOfGas`. No throw in any case, and over HTTP `/health` stays `ok` afterwards. Minor: the server log line is `The contract function "relay" reverted.` without the decoded error name, which is less useful when debugging live. |

### QA-5 · Server

| ID | Result | Evidence |
|---|---|---|
| S1 | Pass | `/guard` to `P`, 10 tUSD → `{"verdict":"ok","findings":[]}` |
| S2 | Pass | `/guard` to token → `block [RECIPIENT_IS_TOKEN]` (also scam and zero → `block`) |
| S3 | Pass | Local: 200 with `txHash`, `explorerUrl`, tokens moved. Testnet: Section 6 step 3. |
| **S4** | **Pass** | See QA2-1 below. |
| S5 | **Fail** | 13 of 17 malformed bodies → clean 400 with zod issues. **4 → 500** `{"error":"Internal"}`: invalid JSON on `/guard` and `/relay`, a literal `null` body, and a >32 kb body. No stack trace leaks and the server stays up. See QA2-3. Also minor: `amount` > uint256 max passes the schema and returns 422 `RelayFailed` *"coba lagi sebentar"*, which tells the user to retry something that can never succeed. |
| S6 | Pass (accepted risk) | `cors()` is deliberate. It is documented in `server.ts:70`, `README.md:105` and CLAUDE.md. Accepted for the hackathon demo; it must be locked to the frontend origin before any real deployment. |

### QA-6 · E2E curl walkthrough (BSC testnet, backend :8789)

1. `/guard` to a fresh address, 5 tUSD → `{"verdict":"ok","findings":[]}` ✅
2. `/guard` to the token contract → `block [RECIPIENT_IS_TOKEN]` with the Bahasa template ✅
3. `testnet-sign.ts` (viem, QA user `0x2B40…8E53`, 0 BNB) → `curl /relay` → HTTP 200 in 1.76 s,
   [`0x08e3fca1…0ec4d`](https://testnet.bscscan.com/tx/0x08e3fca13c513ca0772d56d5eeb26cf8a0f52450fd6af09d6544a604cb60ec4d), block 133056532, 137,938 gas ✅.
   **Checked on chain, not taken from the API response:**
   - receipt status 1, and the `Relayed` event topic is present
   - recipient holds 5 tUSD
   - QA user: 0 BNB, **tx count 0**
   - KurirRelayer holds 0 tUSD
4. Same body again → HTTP 422 `{"error":"InvalidAccountNonce","message":"Transaksi ini udah pernah diproses…"}` ✅

The faucet tx that funded the QA user was `0x5a9c73ef…254dd`, paid by the relayer.

### Findings

**QA2-1 · S4: the guard cannot be bypassed (critical row, PASS).**
Valid signatures were posted straight to `/relay` with no `/guard` call:
- to the token contract, the zero address or KurirRelayer → 422 `GuardBlocked`. This holds locally and on testnet, where the relayer's tx count stayed at 10 before and after.
- **the decisive case:** a send to a **scam-list address**. QA first confirmed the *contract alone would accept it* (`simulateContract` succeeds), so the server guard is the only thing that can stop it. `/relay` → 422 `GuardBlocked [SCAM_LIST]`. Scam balance, user nonce and relayer tx count were all unchanged.
- a lowercase variant is blocked too.

The guard is not decorative.

**QA2-2 · Poisoning detection only covers the last ~37 minutes of on-chain history (high for the demo, not a row failure).**
- `LOG_LOOKBACK_BLOCKS=5000`, and BSC testnet blocks now average 0.45 s, so 5000 blocks ≈ 37 min.
- Measured on testnet: a lookalike of `0xa0Dd…B002`, which the demo wallet really sent to in demo moment 1 (23,572 blocks ago), → `/guard` with no client history → **`{"verdict":"ok","findings":[]}`**. The same request with `history: [0xa0Dd…B002]` → `warn [ADDRESS_POISONING]`.
- **In practice** the check works only through the frontend's localStorage history: same browser, same wallet, storage not cleared. The "Demo: isi alamat yang mirip" helper only appears when that storage has entries. So demo moment 2 works *if* moment 1 is done first in the same browser. It silently turns into `ok` in a fresh browser or profile. `/relay` gets no client history at all, so its re-run guard can never see a lookalike older than ~37 min (warns don't block there anyway, by design).
- **Suggested fix:** scan from the deploy block (`fromBlock = max(DEPLOY_BLOCK, latest - N)`, with a new `KURIR_DEPLOY_BLOCK=133031061`) instead of a fixed window. QA confirmed publicnode returns all 25,638 blocks since deployment in one `eth_getLogs` call in 0.9 s. At minimum, rehearse the demo in the exact browser used for moment 1.

**QA2-3 · S5: body-parser errors become 500s (fail, small fix).**
`express.json()` raises a `SyntaxError` (status 400) or a `PayloadTooLargeError` (status 413). The catch-all handler in `server.ts:166` ignores `err.status` and always answers 500. Fix: in that handler, return `err.status` with a clean `{ error: "BadRequest" }` when `err.type` is `entity.parse.failed` / `entity.too.large` (or any 4xx `err.status`), and keep 500 for everything else.

### Must fix before Day 2 can be accepted

1. **QA2-3 / S5:** 4xx for malformed JSON and oversized bodies.
2. **L4:** fix QA2-4 (poisoning sentence), then Daviga gives the final read and tick.
3. **L2:** decide whether to test with a real key before the demo, or record it as not tested (templates only).

**Strongly recommended before recording the demo:** QA2-2 (deploy-block lookback).
**Minor:** clean error for a bad `SCAM_LIST` entry; reject `amount`/`fee` > uint256 max in the zod schema; include the decoded error name in `[relay] submit failed` logs.

**Per this plan's own ground rule:** whoever fixes these should not be the one to re-test them. Run a fresh QA pass afterwards.

---

## L4 voice review — 2026-09-25 (QA read, against the CLAUDE.md voice spec)

No separate "ways-of-working" voice notes exist in the repo or on this machine. The benchmark is CLAUDE.md:
*one short Bahasa sentence, Gen Z Jaksel, casual, punchy, English mixed in naturally*, plus its example sentence.
Every template was rendered through `templateExplain()` with realistic data, as the user sees it.

| Finding | Rendered (words) | QA read |
|---|---|---|
| RECIPIENT_IS_TOKEN | "Alamat tujuannya itu kontrak token-nya sendiri — kalau dikirim ke sini, dana kamu literally nyangkut selamanya. Diblok ya." (18) | ✅ Strong, exactly the target register |
| SCAM_LIST | "Alamat ini ada di daftar scam yang udah kita tandain. No way, transaksinya diblok." (14) | ✅ Strong |
| RECIPIENT_IS_ZERO | "Ini alamat nol alias burn address — apa pun yang dikirim ke sini hilang permanen. Diblok." (16) | ✅ Good |
| FRESH_ADDRESS_LARGE_SEND | "Alamat ini masih fresh banget (belum ada aktivitas on-chain) dan nominalnya gede — pastiin alamatnya bener, mending test kirim kecil dulu." (21) | ✅ Good, gives a concrete action |
| UNKNOWN_CONTRACT | "Tujuannya smart contract yang belum pernah kamu kirimin sebelumnya — bisa aja aman, tapi double-check dulu ya." (17) | ✅ Good. Nit: *belum pernah … sebelumnya* is redundant |
| ADDRESS_POISONING (own) | "Alamat ini mirip banget sama alamat wallet kamu sendiri, tapi 30 karakter tengahnya beda — ini modus address poisoning, cek lagi sebelum lanjut." (23) | ✅ Nearly the spec's own example |
| RECIPIENT_IS_RELAYER | "Itu alamat kontrak Kurir, bukan wallet penerima — dikirim ke sini dananya nyangkut. Diblok." (14) | ⚠️ Stiffest. A bare "Diblok." → suggest "Diblok ya." as in the others |
| CHECKS_DEGRADED | "Sebagian pengecekan lagi nggak jalan karena node-nya susah dihubungi — hati-hati ekstra ya." (13) | ⚠️ "node" is jargon for a first-time user, and there's no concrete action. Suggest e.g. "…mending tunggu bentar terus cek lagi." |
| ADDRESS_POISONING (history) | "Alamat ini mirip banget sama 0x7A3c…9b2e yang pernah kamu pakai, tapi 30 karakter tengahnya beda — cek lagi sebelum lanjut." (20) | ❌ Voice fine, content fails: see QA2-4 |
| Combined | "…cek lagi sebelum lanjut. (+1 catatan lain)" | ⚠️ The "other note" is shown only as a raw code (`CHECKS_DEGRADED`) in the frontend list |

**QA2-4 · The poisoning warning shows exactly the part of the address the attacker copied (demo moment 2).**
`short()` renders the real address as first 4 + last 4 (`0x7A3c…9b2e`). A lookalike matches those characters by definition,
so the pasted address also reads `0x7a3c…9b2e`. The sentence's one concrete detail shows two identical-looking
addresses and never shows the middle it says differs. Fix: show the differing middle characters (e.g. "yang lama
tengahnya `5d1E2F…`, yang ini `ffffff…`"), or have the frontend show both full addresses with the difference highlighted.

**Other observations (optional):**
- The frontend lists raw finding codes (`ADDRESS_POISONING`) under the Bahasa sentence (`frontend/index.html:296`).
- 7 of 10 sentences use an em dash (" — "), which reads slightly written rather than chat-typed. Subjective.
- Block templates are two sentences ("… Diblok."). The one-sentence rule in the spec is for LLM warn output, so this is fine.

**Verdict:** the voice passes. Fix QA2-4 before recording demo moment 2. The final L4 tick is Daviga's, as a native-speaker read that QA cannot replace.
