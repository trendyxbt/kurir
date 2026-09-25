# Kurir — Day 1 QA Test Plan & Acceptance Criteria

**Scope:** `src/KurirRelayer.sol`, `src/MockStable.sol`, `test/KurirRelayer.t.sol`,
`script/Deploy.s.sol` — contracts only. Backend and frontend are out of scope
(not built yet).

**Why a separate QA pass:** The build prompt asked Claude Code to fix the
contracts until its own tests pass. That's self-testing — the same agent that
wrote the fix also judges whether the fix worked. QA's job is to be the second,
independent check: verify the claims, don't just re-trust them. A test suite
that was quietly loosened to get to green is worse than no test suite, because
it looks done and isn't.

**Ground rule for the QA pass:** if a test had to change from what's documented
below to pass, that's a finding to report, not a detail to silently accept.

---

## 1. Build verification

| ID | Criterion | Pass condition | Evidence to capture |
|----|-----------|-----------------|---------------------|
| B1 | Clean compile | `forge build` exits 0, zero errors | Full command output |
| B2 | No silenced warnings | Any warning present is individually justified (e.g. unused param) — not blanket-suppressed | List of warnings + justification for each |
| B3 | Dependency versions match spec | `openzeppelin-contracts` is v5.1.0, not a different tag silently substituted to make something compile | `git -C lib/openzeppelin-contracts describe --tags` output |

## 2. Functional test verification — one row per test, mapped to what it's actually proving

| ID | Test | Claim being verified | Pass condition |
|----|------|----------------------|-----------------|
| F1 | `test_GaslessSendWithPermit` | A wallet holding **zero BNB** can complete a send | Assertion on `user.balance == 0` is present and the test passes with it; recipient and relayer balances end correct; relayer contract balance stays `0` |
| F2 | `test_SendWithPriorApproval` | Fallback path for tokens without `permit` works | Passes; confirms fee=0 sponsored-send variant also works |
| F3 | `test_PermitFrontrunDoesNotBlockSend` | A griefer copying the permit signature from the mempool can't break the flow | Passes; the permit is submitted by `attacker`, not the relayer, before the relay call |
| F4 | `test_RevertWhen_FrontrunnerSubmits` | Only the address named in the signed intent can submit it (fee can't be stolen) | Reverts with `NotDesignatedRelayer` specifically — not a generic revert |
| F5 | `test_RevertWhen_Replayed` | A signed intent can't be submitted twice | Second call reverts with `Nonces.InvalidAccountNonce`, first call succeeded |
| F6 | `test_RevertWhen_Expired` | Stale signatures are rejected | Reverts with `IntentExpired` after `vm.warp` past deadline |
| F7 | `test_RevertWhen_AmountTampered` | The signature cryptographically binds every field, not just some | Changing `amount` after signing reverts with `InvalidSignature` |
| F8 | `test_RevertWhen_SendingToTokenContract` | On-chain backstop against the classic "sent to the contract, not a wallet" mistake | Reverts with `InvalidRecipient` |
| F9 | `test_UserCanCancelSignedIntent` | User can invalidate a signed-but-unsent intent unilaterally | After `invalidateNonce()`, the previously-valid signature now reverts |

**Acceptance for Section 2 as a whole:** all 9 pass, **and** QA has independently
read each test body (not just the pass/fail output) to confirm the assertion
actually matches the claim in the "Claim being verified" column. A test that
passes for the wrong reason (e.g. it reverts, but on the wrong error selector)
is a fail for this checklist even though `forge test` shows green.

## 3. Gaps the existing suite does NOT cover — QA should add or explicitly flag as accepted risk

| ID | Gap | Why it matters | Action |
|----|-----|-----------------|--------|
| G1 | Zero-amount send (`amount = 0`) | Should this succeed (no-op transfer) or revert? Undefined in the current spec. | Write a test, confirm actual behavior matches intent, document it |
| G2 | `fee > amount` | Could a malicious relayer-signed intent drain more in fee than the send itself, if the *user* signed it carelessly? | Write a test; the contract should let the signer decide (it's their signature) but QA should confirm the frontend will never construct such an intent |
| G3 | `deadline` in the past at signing time | Not currently tested — only "expired after time passes" | Add test: intent signed with an already-past deadline |
| G4 | Insufficient allowance / balance | `safeTransferFrom` should revert on insufficient funds — confirm the revert surfaces cleanly and isn't swallowed by the `try/catch` around `permit()` | Add test with insufficient balance |
| G5 | `relayWithPermit` where permit signature is invalid/malformed | The `try/catch` around `permit()` swallows failures by design (so a front-run permit doesn't block the flow) — confirm it does NOT also swallow the case where the intent signature itself is bad | Add test: bad permit + bad intent signature → must still revert on `InvalidSignature`, not silently proceed |
| G6 | Reentrancy | Both `safeTransferFrom` calls happen after state checks but before any state write (no state written by `_relay` besides the nonce, which is consumed before transfers) — confirm nonce consumption happens **before** external calls | Static review, not just a test — check call ordering in `_relay` |
| G7 | `MockStable.faucet` abuse | Anyone can call `faucet` repeatedly up to the per-call limit, with no per-address cap — fine for a testnet demo, but confirm this is intentional and won't be mistaken for the real deployment's behavior | Document as accepted (testnet-only), not a bug |

## 4. Static / manual review checklist (independent of `forge test`)

- [done] Read `_relay` line by line against the checks-effects-interactions pattern:
      nonce consumed → transfers happen. Confirm no external call precedes a
      state-changing check.
- [done] Confirm `SignatureChecker.isValidSignatureNow` is called with the correct
      digest (`hashIntent`, which itself must match `SEND_INTENT_TYPEHASH` field
      order exactly — a single reordered field silently breaks all signatures).
- [done] Confirm every custom error (`NotDesignatedRelayer`, `IntentExpired`,
      `InvalidRecipient`, `InvalidSignature`) is actually reachable and actually
      used at the point the README/CLAUDE.md claims it is.
- [done] Confirm `MockStable` is clearly testnet-only in naming/comments so it can
      never be mistaken for a real asset in a later demo recording or screenshot.

## 5. Deployment verification

| ID | Criterion | Pass condition | Evidence to capture |
|----|-----------|-----------------|---------------------|
| D1 | Both contracts deployed to BSC testnet (chain id 97) | Deploy tx confirmed | Both contract addresses + deploy tx hashes |
| D2 | Contracts visible on BscScan testnet | Address resolves, shows contract creation | Screenshot or link |
| D3 | Constructor state correct | `MockStable.name()/symbol()` and `KurirRelayer` domain separator match spec | `cast call` output for both |
| D4 | Deployer used a throwaway key | Confirm the private key used is not reused elsewhere | Verbal confirmation from Daviga — QA cannot verify this technically |

## 6. Sign-off

Day 1 is **accepted** only when Sections 1, 2, and 5 are 100% pass, Section 3's
gaps are each either fixed-and-tested or explicitly logged as an accepted risk
with a reason, and Section 4's checklist is fully checked. Partial completion
(e.g. "8 of 9 tests pass") is a **reject** — go back to the build, not to Day 2.

| Section | Result | Notes |
|---|---|---|
| 1. Build | ☒ Pass ☐ Fail | Clean build, OZ v5.1.0, lint warnings justified (see QA-1 + re-test). |
| 2. Functional tests | ☒ Pass ☐ Fail | **Re-test:** F9 now implemented (`invalidateNonce()`) and tested with exact error. F1–F8 unchanged and passing. |
| 3. Gap coverage | ☒ Pass ☐ Fail ☒ Accepted risk (see notes) | **Re-test:** G1 fixed (contract reverts `ZeroAmount`). G2 fixed off-chain (frontend + `/relay` reject `fee > amount`; the contract still honours the signature, by design). G3–G6 pass. G7 accepted risk (testnet only). |
| 4. Static review | ☒ Pass ☐ Fail | **Re-test:** S1 fixed. The intent is fully validated and its nonce consumed before `permit()`, and `Relayed` is emitted before any state-changing external call. Proven by `test_QA_S1_*` (`expectCall` count 0 on an invalid intent). |
| 5. Deployment | ☒ Pass ☐ Fail | **Deployed 2026-09-25.** D1–D4 pass (D4 confirmed verbally by Daviga). See QA-5 update. |
| **Overall Day 1** | ☒ **Accepted** ☐ **Not yet accepted** | All five sections pass. The open condition (independent re-check of the fixes) was closed by a separate QA session on 2026-09-25. See "Independent re-check" at the end of this file. |

Original first-pass result (kept for the record): 2 Fail (F9), 3 Fail (G1/G2 open), 4 Fail (S1), 5 Fail. Overall Rejected.

---

## QA results — 2026-09-25 (QA: Claude, independent pass)

Commit under test: `a4a388d`, plus QA's own tests in `test/KurirRelayerQA.t.sol` (13 tests).
Final run: `forge test` → **29 passed, 0 failed** (16 developer + 13 QA).

### QA-1 · Build

| ID | Result | Evidence |
|---|---|---|
| B1 | Pass | `forge clean && forge build` → "Compiler run successful!", exit 0 |
| B2 | Pass | 0 compiler warnings. forge-lint: (a) `arbitrary-send-erc20` ×2: by design, `from` is authorised by its own EIP-712 signature. (b) `block-timestamp`: deadline granularity is 10 min, and validator drift of seconds is irrelevant. (c) `reentrancy-events`: `Relayed` is emitted after the token calls. Acceptable (nonce already consumed, see G6), but moving the `emit` before the transfers is a free fix. |
| B3 | Pass | `git -C lib/openzeppelin-contracts describe --tags` → `v5.1.0` |

### QA-2 · Functional tests (test bodies read against each claim)

**The claim doesn't match the repo:** there are 16 developer tests, and none carry the names in this plan. Each claim below is mapped to the test that actually covers it.

| ID | Actual test | Result | Notes |
|---|---|---|---|
| F1 | `test_RelayWithPermit_Gasless` | Pass | Asserts `user.balance == 0`, recipient +amount, relayer +fee, `balanceOf(kurir) == 0`, nonce 1. The 0-BNB assertion holds by construction (the user never sends a tx), which is the point. |
| F2 | `test_Relay_WithExistingAllowance`, `test_Relay_ZeroFee` | Pass | Both exist and assert balances. |
| F3 | `test_PermitFrontRun_DoesNotGrief` | Pass | `vm.prank(attacker)` submits the permit first; relay then succeeds. |
| F4 | `test_Revert_FrontRunByOtherRelayer` | Pass | Exact `NotDesignatedRelayer(relayerBot, attacker)` selector and args. |
| F5 | `test_Revert_Replay` | Pass | Second call: exact `InvalidAccountNonce(user, 1)`. The first call's success is only implicit (no balance assertion); minor. |
| F6 | `test_Revert_Expired` | Pass | `vm.warp(deadline + 1)`, exact `IntentExpired(deadline)`. |
| F7 | `test_Revert_TamperedAmount` (+ Fee, Recipient) | Pass | Exact `InvalidSignature`. The claim says *every* field, but the dev suite tampers only 3 of 8. QA added `test_QA_EveryFieldIsSignatureBound`, which covers all 8 and passes. |
| F8 | `test_Revert_SendToTokenContract` | Pass | Exact `InvalidRecipient(token)`. |
| F9 | — | **Fail** | **No test and no feature.** `KurirRelayer` has no `invalidateNonce()` or any other cancel path. OZ `Nonces` exposes only `nonces()`. A user cannot unilaterally void a signed-but-unsent intent before its deadline. |

Extra finding: `test_Revert_PermitTooSmall` uses a bare `vm.expectRevert()`, which is the "reverts for any reason" anti-pattern this plan warns about. QA's `test_QA_G4c` covers the same case with the exact `ERC20InsufficientAllowance(kurir, 0, 0.5e18)`. Tighten the dev test.

Extra finding: the dev helper `_signIntent` reads `kurir.SEND_INTENT_TYPEHASH()` from the contract under test, so a typo in the typehash string would not be caught. QA's `test_QA_TypehashAndDomainMatchSpec` checks it against the spec string and an independently computed domain. Passes.

### QA-3 · Gaps (actual behaviour)

| ID | Test | Actual behaviour | Status |
|---|---|---|---|
| G1 | `test_QA_G1_ZeroAmount_SucceedsAndStillPaysFee` | **Succeeds.** Recipient gets 0, relayer still collects the fee, nonce burned. The frontend blocks amount ≤ 0; the contract and backend `/relay` do not. | **Open.** Owner must decide: revert on `amount == 0` in the contract (recommended), or log as accepted risk. |
| G2 | `test_QA_G2_FeeGreaterThanAmount_Succeeds` | **Succeeds** (1 tUSD send, 5 tUSD fee). Contract honours the signature, as intended. **Frontend check fails:** fee is a fixed `/config.fee` (0.5) and amount is only checked `> 0`, so sending 0.1 tUSD builds `fee > amount`. | **Open.** Frontend (and ideally `/relay`) should reject or warn when `fee > amount`. |
| G3 | `test_QA_G3_DeadlineAlreadyPastAtSigning`, `…G3b_DeadlineEqualsNow` | Past deadline → exact `IntentExpired`. Boundary: `deadline == block.timestamp` is accepted (`>` comparison). | Pass |
| G4 | `test_QA_G4_…`, `G4b`, `G4c` | Exact `ERC20InsufficientBalance(user, 1000e18, 2000e18)`. The successful permit inside try/catch is rolled back (allowance 0, nonce 0). Allowance shortfalls surface as exact `ERC20InsufficientAllowance`. Nothing swallowed. | Pass |
| G5 | `test_QA_G5_…`, `G5b` | Bad permit + bad intent sig → exact `InvalidSignature`. Bad permit + good sig → exact `ERC20InsufficientAllowance`, recipient gets 0 (does not silently proceed). | Pass |
| G6 | `test_QA_G6_ReentrancyWithSameIntentIsBlockedByNonce` + static read | A malicious token (also the named relayer) re-enters `relay` with the same intent during `transferFrom`. The inner call reverts `InvalidAccountNonce(user, 1)`. Static: `_useCheckedNonce` (line 113) runs before both `safeTransferFrom` calls (lines 116–117). | Pass (but see S1) |
| G7 | `test_QA_G7_FaucetIsUncapped` | Confirmed: `faucet(to)` has no per-address or per-call cap beyond the fixed 1,000 tUSD per call; the same caller got 5,000 in 5 calls. | Accepted risk: testnet-only demo token, never the real asset. |

### QA-4 · Static review

- [x] **`_relay` checks-effects-interactions:** relayer check → deadline → recipient → signature (`SignatureChecker`; for contract wallets this is a *staticcall*, so it can't change state) → **nonce consumed** → transfer to `to` → transfer fee → emit. Correct.
- [ ] **S1: `relayWithPermit` violates "no external call precedes a state-changing check".** `IERC20Permit(intent.token).permit(...)` (line 75) is a state-changing external call to a user-chosen token, made **before** any `_relay` check. G6 shows the nonce still prevents a replay, and a malicious token can only affect intents that name it. Severity **low**, but the item is not met. Fix: split `_relay` into `_validate` (checks + signature + nonce) and `_execute` (transfers), and call `permit` between them.
- [x] **Digest:** `isValidSignatureNow(intent.from, hashIntent(intent), sig)`. The `hashIntent` field order (token, from, to, amount, fee, relayer, nonce, deadline) matches `SEND_INTENT_TYPEHASH` exactly, independently verified against the spec string.
- [x] **Custom errors reachable where claimed:** `NotDesignatedRelayer` (F4), `IntentExpired` (F6, G3), `InvalidRecipient` (F8, zero/relayer test), `InvalidSignature` (F7, G5, all-fields test). All hit with exact selectors.
- [x] **MockStable is clearly testnet-only:** name "Kurir Test USD", NatSpec "Testnet-only". Note: the symbol `tUSD` reads like TrueUSD's ticker `TUSD` in a screenshot; consider `ktUSD`.

### QA-5 · Deployment

Not deployed, so QA stopped here per instructions. Nothing was deployed by QA. D4 (throwaway deployer key) needs verbal confirmation from Daviga.

### Must fix before Day 2

1. **F9:** add a user cancel path (e.g. `function invalidateNonce() external { _useNonce(msg.sender); }`) plus a test showing a previously valid signature then reverts `InvalidAccountNonce`. Note that the user needs BNB to call it, which is worth deciding on.
2. **G2:** frontend (and `/relay`) must reject or warn when `fee > amount`.
3. **G1:** decide on zero-amount sends; recommended `if (intent.amount == 0) revert` on-chain plus a test.
4. **S1:** validate the intent before calling `permit()` in `relayWithPermit`; move `emit Relayed` before the transfers while you're there.
5. Tighten `test_Revert_PermitTooSmall` to an exact selector.
6. **Deploy to BSC testnet** (Section 5), then have QA verify the addresses on BscScan and run the D3 `cast call` checks.

---

## Re-test after fixes — 2026-09-25

**Caveat, per this plan's own ground rule:** the fixes and this re-test were done by the same agent
that did the first QA pass. Treat this as a developer re-test. A fresh independent pass should
re-verify before sign-off.

| Finding | Fix | Evidence |
|---|---|---|
| F9 no cancel path | `invalidateNonce()` burns the caller's next nonce and emits `NonceInvalidated`. Needs gas from the user (gasless alternatives: let the deadline pass, or relay any intent with that nonce). | `test_UserCanCancelSignedIntent`: after cancel, the old signature reverts with exact `InvalidAccountNonce(user, 1)` and the recipient gets 0 |
| G1 zero amount | `if (intent.amount == 0) revert ZeroAmount()` in the contract; `/relay` also rejects it (400 `ZeroAmount`) | `test_Revert_ZeroAmount`, `test_QA_G1_ZeroAmount_Reverts` (fee not paid, nonce not burned); e2e "zero amount rejected" |
| G2 fee > amount | Frontend blocks before any signature ("Minimal kirim 0.5 tUSD"); `/relay` rejects with 422 `FeeExceedsAmount`. The contract intentionally still honours a signed fee > amount. | UI check with 0.1 tUSD → block verdict, no signature requested; e2e "fee > amount rejected" |
| S1 permit before checks | `_relay` split into `_validateAndConsume` (checks → signature → nonce → event) and `_execute` (transfers). `relayWithPermit` = validate → permit → execute. | `test_QA_S1_InvalidIntentNeverReachesPermit` (`expectCall(permit, 0)`), `test_QA_S1b_ValidIntentStillCallsPermit`, G6 reentrancy still passes |
| Loose `expectRevert()` | `test_Revert_PermitTooSmall` now expects exact `ERC20InsufficientAllowance(kurir, 0, FEE)` | green |
| Lint `reentrancy-events` | Event moved before `permit`/transfers. The warning remains, but the only preceding external call is `SignatureChecker`'s ERC-1271 **staticcall**, which cannot change state or re-enter with effects. Justified false positive. | `forge lint` |

Found during re-test, also fixed (backend, outside Day 1 scope): `guard.ts` read history with a
~4 s cached block number, so a send relayed moments earlier was invisible to the poisoning check.
Now uses `getBlockNumber({ cacheTime: 0 })`. e2e passed 17/17 on two consecutive fast runs.

**Run results:** `forge test` → 33 passed, 0 failed. `backend/scripts/e2e-local.ts` (local anvil) → 17/17.
Frontend verified in the browser pane: the fee > amount block works and a normal 5 tUSD gasless send succeeds.

**Remaining before Day 1 can be accepted:** Section 5 (BSC testnet deploy, BscScan verification,
D3 `cast call` checks) and D4 verbal confirmation from Daviga.

---

## QA-5 update — BSC testnet deployment, 2026-09-25

Verified directly against chain 97 via RPC (`cast receipt` / `cast call`), not taken from the deploy log.

| ID | Result | Evidence |
|---|---|---|
| D1 | **Pass** | MockStable `0xf9931457bdcf76bbfb957283a3ca2307e11813cc`, tx `0x25c55f9480e2a99d4ba64873b98c834c4c1f80d6c93fd86f2f014ca4d83d192d`, block 133031060, status 1, gas 957,452. KurirRelayer `0x9342dbb1e87ebef78b34fb0fbe9c2d06a3825370`, tx `0x759e63b3b1fa7afa2a96100715e2ab09e67301eb642a9277cbdc5293b5c9768f`, block 133031061, status 1, gas 967,826. Deployer `0xa0DdF5669C3F11CF6c5131509a5271C94708B002`. Total deploy cost 0.0001925 tBNB. |
| D2 | **Pass** | Daviga provided BscScan testnet screenshots (2026-09-25). MockStable page: creator `0xa0DdF566…94708B002`, token tracker "Kurir Test USD (tUSD)", 1 tx (`Faucet`, block 133032008). KurirRelayer page: creator `0xa0DdF566…94708B002`, 1 tx `0xbad8eb9b…` (block 133033066) with method `0x37bf820c` = `relayWithPermit` selector (checked with `cast sig`). Both match the RPC evidence. Note: source code is not verified on BscScan (the method shows as a raw selector), which is not required by D2. *Earlier note (resolved by the screenshots above):* testnet.bscscan.com returned a bot-verification page to QA, and QA does not bypass bot checks. Contract creation is confirmed via RPC receipts (`contractAddress` field) and non-zero code size (3,905 / 4,171 bytes). Links: [MockStable](https://testnet.bscscan.com/address/0xf9931457bdcf76bbfb957283a3ca2307e11813cc), [KurirRelayer](https://testnet.bscscan.com/address/0x9342dbb1e87ebef78b34fb0fbe9c2d06a3825370). |
| D3 | **Pass** | `name()` = "Kurir Test USD", `symbol()` = "tUSD", `decimals()` = 18. `DOMAIN_SEPARATOR()` = `0x04ec8f9e…db07b00`, matching an independently computed EIP712Domain("Kurir", "1", 97, KurirRelayer). `SEND_INTENT_TYPEHASH()` matches the spec string. KurirRelayer tUSD balance = 0. |
| D4 | **Pass** | **Daviga confirmed verbally (2026-09-25): the key is used only for Kurir testnet, nowhere else.** Supporting observation: QA observed the deployer key being created fresh with `cast wallet new ~/.foundry/keystores deployer` on 2026-09-25, and it is stored encrypted. The same key is the relayer bot key in `backend/.env` (gitignored; confirmed absent from all committed files). |

### Live end-to-end on testnet (demo moment 1)

Tx [`0xbad8eb9bb97e2dc6820ec683fb6e6ce1ae0f1b5db70e389984cc1fb812430f97`](https://testnet.bscscan.com/tx/0xbad8eb9bb97e2dc6820ec683fb6e6ce1ae0f1b5db70e389984cc1fb812430f97), block 133033066, status 1.

- Submitted by the relayer `0xa0Dd…B002` to KurirRelayer. The `Relayed` event names `from` = demo wallet `0xE4ca0B609C94CDC7C3E8Ae33A53E95dcc2909b33`.
- Permit `Approval` = exactly 10.5 tUSD (amount 10 + fee 0.5), no open-ended approval.
- Demo wallet afterwards: 989.5 tUSD, **0 tBNB, transaction count 0** (it has never sent a tx).
- KurirRelayer tUSD balance afterwards: **0**.
- **Measured:** gas used 133,306 at 0.1003 gwei, so **0.0000134 tBNB** paid by the relayer. Confirmation latency was not measured (the backend does not log request receipt time).
- Note: the recipient in this run was the relayer's own address, so the relayer received both the 10 and the 0.5 fee.

### Issue found during testnet bring-up (fixed)

The default RPC (`data-seed-prebsc-1-s1.bnbchain.org`) refuses `eth_getLogs` even for 100-block ranges (`-32005 limit exceeded`). Every `/guard` call therefore came back `CHECKS_DEGRADED` (a warning on every send) and the on-chain poisoning history was unavailable. The backend now defaults to `https://bsc-testnet-rpc.publicnode.com`, which served 5,000-block log queries in testing. The guard returns a clean `ok` on testnet.

---

## Independent re-check of the Day 1 fixes — 2026-09-25 (separate QA session)

A new session that did not write the fixes or the earlier re-test. Everything below was
re-run or re-derived from source and chain. Nothing was taken from the earlier notes.

| Check | Result | Evidence |
|---|---|---|
| Build | Pass | `forge clean && forge build` exit 0. Lint warnings are the same three justified kinds (`arbitrary-send-erc20` ×2, `reentrancy-events`). OZ tag `v5.1.0`. |
| Full suite | Pass | `forge test` → 33 passed, 0 failed (18 dev + 15 QA). |
| **Were tests loosened to get green?** | **No** | `git diff a4a388d HEAD -- test/`: the only change to an existing assertion *tightens* `test_Revert_PermitTooSmall` (bare `expectRevert()` → exact `ERC20InsufficientAllowance(kurir, 0, FEE)`). One narrowing: `testFuzz_NeverHoldsFunds` now assumes `amount > 0`. That is justified: zero amount now reverts by design, and `test_Revert_ZeroAmount` + `test_QA_G1_ZeroAmount_Reverts` cover it. |
| F9 fix | Pass | `invalidateNonce()` calls `_useNonce(msg.sender)`, so it can only burn the caller's own nonce. The test asserts the event, `nonces == 1`, exact `InvalidAccountNonce(user, 1)` on the old signature, and recipient 0. |
| G1 fix | Pass | `ZeroAmount` check runs before the signature check and nonce use. The test asserts the relayer got no fee and the nonce was not burned. |
| G2 fix (off-chain) | Pass (code review) | `server.ts` rejects `fee > amount` (422 `FeeExceedsAmount`) and `amount == 0` (400). `amount`/`fee` are zod-parsed to `bigint`, so `=== 0n` is a real comparison. Frontend blocks `fee > amount` before any signature. Backend `tsc --noEmit` clean. The e2e script was **not** re-run in this pass (backend is outside the Day 1 contract scope). |
| S1 fix | Pass | `relayWithPermit` = `_validateAndConsume` → `permit` (try/catch) → `_execute`. The only external call before the nonce write is `SignatureChecker` (ecrecover precompile, or ERC-1271 `staticcall`). `test_QA_S1_*` uses `expectCall` counts 0/1. |
| **Deployed = fixed code** | **Pass** | Runtime bytecode on chain 97 matches `forge inspect … deployedBytecode` byte for byte outside the immutable slots, for both contracts (KurirRelayer 4,171 B, MockStable 3,905 B, 0 differing bytes outside the 224 immutable bytes). The CBOR metadata hash matches too, so the deployed source is exactly the current `src/`. Read-only `eth_call` of `relay` with `amount = 0` from the relayer → reverts `0x1f2a2005` = `ZeroAmount()`. `invalidateNonce()` selector `0x5a57b46f` is present. |
| Custody | Pass | `balanceOf(KurirRelayer)` on testnet = 0. |

**New observations (none block acceptance):**

1. **`invalidateNonce()` cancels one intent, not all of them.** Nonces are sequential. If a user
   has signed intents with nonce N and N+1, burning N makes N+1 the next valid nonce, so it
   becomes relayable. The frontend only ever signs one pending intent at a time, so this can't
   happen in the demo. The NatSpec already says "your next" intent. If a "cancel all" is ever needed, loop
   or add `invalidateNonces(uint256 upTo)`. Informational.
2. Section 2's test names (`test_GaslessSendWithPermit` etc.) still don't exist in the repo. The QA-2
   mapping table remains the source of truth. Consider renaming the plan rows for Day 2.
3. The QA doc edits (D2/D4 → Pass, sign-off) were uncommitted at the time of this check.

**Verdict: the fixes hold up under independent review. Day 1 accepted.**
