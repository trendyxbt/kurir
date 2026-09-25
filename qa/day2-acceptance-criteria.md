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
| 1. Environment | ☒ Pass ☐ Fail | E1–E3 pass (first pass). Not re-run on `2b4b4df`'s config changes (`emptyToUndefined`, `LLM_KEEP_ALIVE`), which don't touch the E2 cases. |
| 2. Guard (8 cases) | ☒ Pass ☐ Fail | 19/19 + dead-RPC 7/7 (re-run on `481fd7d`). QA2-2 and QA2-5 re-tested and **fixed** (see Re-test 2). |
| 3. LLM explain | ☐ Pass ☐ Fail ☒ **Pending** | L1, L3 pass (L3 re-verified with the custom-endpoint path). **L2 now tested** with local qwen3:4b-instruct: the `2b4b4df` prompt passes (the earlier `4adbae9` prompt invented risk). **L4 still pending:** QA2-4 unfixed, plus Daviga's tick. |
| 4. Relay | ☒ Pass ☐ Fail | Re-test 13/13. |
| 5. Server (S4 critical) | ☒ Pass ☐ Fail | **Re-test: S5 fixed** (37/37). S4 still holds. |
| 6. E2E curl walkthrough | ☒ Pass ☐ Fail | First pass on testnet. Not re-run: the relay path is unchanged in committed code. |
| **Overall Day 2** | ☐ **Accepted** ☒ **Not yet accepted** | Only **L4 / QA2-4** remains (poisoning sentence shows the copied characters; plus Daviga's final voice tick). Everything else passes on `481fd7d`. |

Day 2 is accepted only when every section passes **and** S4 specifically has
been tested, not assumed. A green server that's never had its guard
deliberately bypassed hasn't actually been tested for the thing that matters
most in this architecture.

---

## QA results — 2026-09-25 (QA: Claude, separate session from the backend's author)

Code under test: backend at `7c8076d` (*corrected in the re-test: this line first said `517bf77`, which was the commit before*). All QA tests are new and
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

---

## Re-test — 2026-09-25 late evening (same QA session as the first pass)

**What was tested.** Commits since the first pass:
- `35e0187` S5 fix + full poisoning history
- `f37d9f6` 50k-block chunked log scan
- `24893fb` / `2b4b4df` OpenAI-compatible LLM endpoint, local Ollama, warm-up

Another session was **editing the backend during the re-test**, so everything was run against a **pinned git worktree at `4adbae9`**, never the moving working tree. L2 was then also run against the new prompt, which was committed mid-run as `2b4b4df`.

**Not tested:** the history indexer (`guard.ts`, `relay.ts`, new `history.ts`), which was still uncommitted when QA finished.

**QA tooling changes**
- `llm-spy.mjs` now also intercepts `LLM_BASE_URL`'s host. An OpenAI-only spy would miss calls to a custom endpoint and make L3 pass falsely with 0 calls.
- New scripts: `history-modes.ts` (QA2-2 control / chunked / fallback) and `l2-llm.ts` (L2).

| Item | Result | Evidence |
|---|---|---|
| Regression: guard, relay, server | Pass | guard-unit 19/19, dead-RPC 7/7, relay-unit 13/13, http 37/37 (all on anvil) |
| **S5** | **Fixed** | Invalid JSON and `null` → 400 `{"error":"BadRequest","message":"Body request harus JSON object yang valid."}`. >32 kb → 413 `PayloadTooLarge`. Server stays up. |
| L3 (custom endpoint) | Pass | `LLM_BASE_URL=http://qa-llm.invalid/v1`: ok/block → 0 calls, each warn → 1 call (spy log shows host `qa-llm.invalid`) |
| QA2-2, local | Fix works | Same data, 2-block window. Control (no `KURIR_DEPLOY_BLOCK`) → lookalike **missed** (`ok`). Chunked (9 chunks of 3 blocks, 4 per batch) → `warn [ADDRESS_POISONING]`, and `P` is known. |
| **QA2-2, BSC testnet** | **Still open** | See below |
| **QA2-5 (new)** | **Open** | See below |
| L2 | Pass on `2b4b4df` prompt | See below |
| L4 / QA2-4 | Still open | `sentenceFor()` is unchanged: the poisoning warning still shows only `0xa0Dd…B002`, the part a lookalike copies. The LLM output inherits the same short form. |

**QA2-2 on testnet: history older than about 10.7 h cannot be read from publicnode.**
- The lookalike of `0xa0Dd…B002` from the demo wallet, with no client history, still returns **`{"verdict":"ok","findings":[]}`**. The server log shows `[guard] full-history getLogs failed, using recent window: RPC Request failed.` on every request.
- **Root cause:** publicnode is not an archive node. Probing it directly:
  - `[deploy .. deploy+49,999]` → `-32701 History has been pruned for this block`
  - `[deploy+50,000 .. latest]` → OK
  - a bisection puts the prune depth at **~86,000 blocks ≈ 10.7 h**.
- Deployment (block 133031061) passed that depth around 22:30. From then on, the first chunk always fails, the whole scan is thrown away, and the guard drops to the 5,000-block (~37 min) window. The fix was committed about 8.4 h after deployment, which is why it tested green then.
- **Side effect:** the failed scan's retries made `/guard` take 11 s and 21 s on two of three calls.
- **Direction:**
  1. The relayer submits every Kurir send itself, so record each successful relay (the in-progress `recordReceiptLogs` does this) **and save it to disk**. An in-memory index backfilled from publicnode after a restart still can't see sends older than ~10.7 h.
  2. Tolerate failed chunks: keep the chunks that succeed instead of discarding the whole scan.
  3. Or use an archive RPC.

**QA2-5 (new): when the full scan fails, the guard falls back silently.**
- `history-modes.ts` fallback mode (`LOG_MAX_CHUNKS=1`) → full scan refused → `{"verdict":"ok","findings":[]}` for a real lookalike.
- The `getLogs`-fails path adds `CHECKS_DEGRADED`, but the "full scan failed, fell back to the window" path does not, so the user gets a confident `ok` from partial data. On testnet this is currently every request (see QA2-2).
- Fix: set `degraded = true` on that path too, or on any skipped chunk.
- Also: `KURIR_DEPLOY_BLOCK=` (empty) is coerced to block `0`, i.e. scan from genesis, not "unset". `2b4b4df`'s `emptyToUndefined` is only applied to the LLM keys.

**L2, local Ollama `qwen3:4b-instruct`** (free, no API spend). 5 warn cases × 3 runs through the real `explainWarn()`. Every output was read by QA, not just regex-checked.

| Prompt | Format (Bahasa, one line, ≤30 words, no JSON/English/`<think>`) | Content | Latency (median / max) | Template fallbacks |
|---|---|---|---|---|
| `4adbae9` (old) | 14/15 | **Fails.** All 3 UNKNOWN_CONTRACT outputs invent risk: *"bisa jadi bocor"*, *"bisa jadi scam… jangan lanjutin"*, and *"jangan kirim ke orang yang mirip tapi beda 1 karakter"* (a poisoning claim with no poisoning finding). 3 say "jangan kirim". | 2.8 s / 10.0 s | 1/15 (timeout) |
| **`2b4b4df` (current)** | 15/15 | **Passes.** No invented risk and no "jangan kirim". *"biar aman"* ("to be safe") is fine; QA's regex was too strict there. Minor: it copies the template's literal "(+1 catatan lain)" instead of naming the second finding (so the new rule isn't followed), and says "belum pernah kamu cek" where the finding means "never sent to". | 4.2 s / 5.4 s | 0/15 |

With the LLM on, every `warn` in `/guard` takes ~3–5 s more (worst case up to the 10 s timeout, then the template). For the demo that's acceptable with the warm-up; templates stay the safe fallback.

### Still open before Day 2 acceptance / demo recording

1. **L4:** fix QA2-4 (show the differing middle of the address, in the template and in the LLM data), then Daviga's tick.
2. **QA2-2:** poisoning history on testnet. The persisted relay record from the in-progress indexer is the robust fix, and it needs a fresh QA pass once committed.
3. **QA2-5:** flag `CHECKS_DEGRADED` whenever history is partial.
4. Minor: empty `KURIR_DEPLOY_BLOCK=` → genesis; plus the minor items from the first pass.

---

## Re-test 2 — `481fd7d` (history index, QA2-5 fix)

**Tested** commit `481fd7d`, i.e. `f561a5a` (new `backend/src/history.ts`: in-memory index of every `Relayed` event, hedged RPC reads, failover RPC) plus the QA2-5 fix. Run against a pinned git worktree, because the working tree kept changing. Local anvil (chain id 97) plus the real BSC testnet deployment.

**New QA scripts:** `history-index.ts` (IX1–IX5, over HTTP). `history-modes.ts` was re-used.

| Check | Result | Evidence |
|---|---|---|
| Regression | Pass | guard-unit 19/19 and dead-RPC 7/7 (these exercise the *not-ready fallback* path: no indexer in that process), relay-unit 13/13, http 37/37 (index path), L3 spy count unchanged (ok/block → 0, each warn → 1) |
| IX1 backfill | Pass | Local: 3-block archive chunks over 9 blocks → 4 relays indexed. `/health` shows `ready`, `events`, `ageMs`. |
| IX2 history reaches the guard | Pass | Lookalike of an address sent to before server start → `warn ADDRESS_POISONING`, no client history |
| IX3 own relays recorded instantly, once | Pass | `/relay` → events 5→6 immediately and the lookalike of the new recipient is caught. After ≥2 poll ticks: still 6 (`txHash:logIndex` dedupe, no double count). |
| IX4 relays by others are polled in | Pass, with a caveat | A relay submitted from a separate process is picked up (events 6→7, lookalike caught). The poller got it before that relay call even returned, because viem's receipt wait outlasts the 4 s poll. So this proves pickup, not a tight latency bound. |
| IX5 latency | Pass | 30 `/guard` calls to a known address: median 1 ms, p95 1 ms (index path). Testnet `ok` paths: 0.06–0.16 s. |
| Restart rebuild | Pass | Local: 7 relays before and after. Testnet: 10 before and after, 3.1 s. |
| Stale index | Pass | `SIGSTOP` on anvil, `HISTORY_STALE_MS=5000`: after 9 s a `/guard` to a *known* address (so no RPC lookup can cause it) → `warn CHECKS_DEGRADED`. Block verdicts unaffected. `SIGCONT` → back to `ok` within one poll. |
| **QA2-5 (silent fallback)** | **Fixed** | Same scenario that returned `ok [none]` on `4adbae9` now returns `warn [CHECKS_DEGRADED]`. Control mode (old behaviour, no deploy block) still misses the lookalike, so the test can tell old from new. |
| **QA2-2 on BSC testnet** | **Fixed** | See below |

**QA2-2 on BSC testnet: fixed.**
- **Independent facts:**
  - The default `ARCHIVE_RPC_URL` (`bnb-testnet.api.onfinality.io/public`) returns the block-133,033,066 event that publicnode had pruned. Its range cap: 10,000 blocks accepted, 20,000 rejected (`-32602`). The default chunk is 5,000.
  - QA scanned every `Relayed` event since deployment on its own: **9 events, 3 distinct senders**.
- **Result:** the server's backfill covered blocks 133,031,061–133,128,990 in 3.5 s and reported **9 relays from 3 senders**. That matches the independent scan exactly.
- **The request that failed last time** (lookalike of `0xa0Dd…B002`, the address the demo wallet sent to 95,994 blocks earlier, past the ~86,000 where the previous fix broke, from the demo wallet, no client history) → **`warn [ADDRESS_POISONING]`** on 3/3 calls. Controls: the real address → `ok`; an unrelated fresh address → `ok`.
- **Live relay on testnet:** the lookalike of a new recipient → `ok` before, `/relay` [`0x50714c8b…6fb8`](https://testnet.bscscan.com/tx/0x50714c8b356b0f713319e3c44bde90c3299d962c17b991ad64ef507acd8e6fb8) (block 133129417, 103,930 gas) → events 9→10 **immediately**, lookalike → `warn`, and still 10 after the poller ran.
- **Latency:** warn responses took 3.6–6.1 s (median 4.6). That is the local `qwen3:4b-instruct` writing the explanation (the same request on `ok` paths takes 0.06–0.16 s). Consistent with L2's median of 4.2 s.
- **Dead archive RPC** (`ARCHIVE_RPC_URL=http://127.0.0.1:1`): backfill keeps retrying in the background (`ready:false`), and `/guard` answers `warn [CHECKS_DEGRADED]` in 5.9 s. It never claims a confident `ok`.

### Observations (none block acceptance)

1. **Dependency on a free third-party archive endpoint.** Full history now depends on OnFinality's public endpoint (rate limits and availability unknown). It's used once per server start (~20 requests). If it's down at demo time, the guard degrades honestly (above) and demo moment 2 loses its history, unless the client-side `history` from the frontend's localStorage covers it. Mitigation: start the server well before the demo and check `/health` says `"ready": true` and `events` matches expectations.
2. **The index is in memory only.** It rebuilds from chain on every start (3 s on testnet), so this is fine as long as an archive endpoint answers. If sends ever fall out of *every* free RPC's history, persist the relayer's own receipts to disk.
3. When the backfill hasn't finished (or failed), every `/guard` call retries the chunked scan itself, costing seconds. Acceptable, and honest about it, but slow.
4. `/health` now exposes `events`, `senders` and `indexedTo`, and CORS is open. Low risk on testnet; drop it from `/health` before any real deployment.
5. `HEDGE_AFTER_MS` (0.4 s) and the fail-fast RPC timeouts were not stress-tested beyond the runs above.

### Still open

1. **L4 / QA2-4:** show the differing middle characters in the poisoning warning (both the template and the LLM prompt data), then Daviga's final voice read.
2. Optional minor items from earlier: empty `KURIR_DEPLOY_BLOCK=` → genesis; `amount`/`fee` > uint256 max → 422 "retry" message; bad `SCAM_LIST` entry prints a stack trace.
