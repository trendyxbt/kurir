# Kurir — Gasless Relayer for Any ERC-20 on BNB Chain

Hackathon: Indonesia Web3 Hackathon 2026 (#WhereBuildersBuild) — Finance & Commerce track
Builder: Daviga, solo, payments-infrastructure PM background (Indonesian rails: VA, BI-FAST, SNAP, QRIS)

## One-line pitch

A first-time crypto user almost always fails their first transaction for one of two
reasons: they have zero BNB for gas, or they send to the wrong address. Kurir fixes
both. The user signs a free off-chain message ("send X to Y"). A relayer bot submits
it and pays the gas, then gets repaid a small fee in the same token the user is
already sending — no BNB ever required. Before the relayer submits anything, a
pre-flight guard checks the transaction (wrong network patterns, lookalike/poisoned
addresses, sends to the token contract itself, unlimited approvals, scam-list hits)
and explains the verdict in plain Bahasa Indonesia.

**Key design principle: rules block, AI explains.** Hard failures (replay, expired
signature, tampered fields, send-to-token-contract) are deterministic on-chain
checks — never left to an LLM. The AI's job is judgment calls in gray areas and
turning the verdict into plain language. This is the line to say out loud in the
pitch; it's what separates this from "an LLM guards your money."

## Demo script (2 moments, ~90 seconds)

1. **Gasless send.** Wallet holds 0 BNB. User signs a send + permit (two signatures,
   no gas). Relayer bot submits it, pays gas, gets repaid its fee in tUSD. Show the
   BscScan tx: funds moved, relayer contract balance stayed at 0.
2. **Poisoned address blocked.** Paste an address that looks like one the user sent
   to before but differs in the middle characters. Guard flags it before signing;
   explanation in Bahasa. (Stretch: also show sending straight to the token
   contract address reverting on-chain via `InvalidRecipient`.)

## Architecture

```
kurir/
├── src/                      # Solidity contracts (Foundry)
│   ├── KurirRelayer.sol      # EIP-712 SendIntent, permit-based gasless relay, non-custodial
│   └── MockStable.sol        # Testnet ERC20 + EIP-2612 permit, public faucet
├── test/
│   └── KurirRelayer.t.sol    # Happy paths + attack cases (front-run, replay, tamper, token-contract send)
├── script/
│   └── Deploy.s.sol          # Deploys MockStable + KurirRelayer to BSC testnet
├── foundry.toml
├── backend/                  # Node/TypeScript relayer + guard service
│   ├── package.json / tsconfig.json / .env.example
│   ├── scripts/e2e-local.ts  # ✅ local rehearsal: 15 end-to-end checks against anvil
│   └── src/
│       ├── config.ts         # ✅ env validation (zod) + viem clients
│       ├── abi.ts            # ✅ KurirRelayer ABI incl. token/OZ errors for revert decoding
│       ├── guard.ts          # ✅ rule-based checks
│       ├── llmExplain.ts     # ✅ Bahasa explanation (templates; OpenAI only if key set)
│       ├── relay.ts          # ✅ simulate → submit → receipt, custom-error mapping
│       └── server.ts         # ✅ Express: GET /config, POST /guard, POST /relay
├── frontend/index.html       # ✅ single static page, viem via esm.sh
└── README.md                 # Setup + EIP-712 signing spec for the frontend
```

### Status (2026-09-25)

- **Contracts: done.** `forge test` → 33/33 pass (16 dev + 13 QA incl. fuzz, reentrancy, all-fields tamper). Day 1 QA findings F9/G1/G2/S1 fixed — see `qa/day1-acceptance-criteria.md`.
- **Backend: done.** Typechecks clean. `scripts/e2e-local.ts` passes 17/17 on local anvil (chain id 97).
- **Frontend: done.** Both demo moments verified through the UI on local anvil.
- **Not yet done:** BSC testnet deploy, OpenAI explanations (no key set — templates in use), demo recording, deck.

Extra rules added beyond the original spec (all deterministic): `to == KurirRelayer` is an
`InvalidRecipient`; `/relay` rejects a permit larger than `amount + fee`; `/relay` only accepts the
configured token, the bot's own address as `relayer`, and `fee >= RELAYER_FEE`; lookalike check also
compares against the sender's own address. `GET /config` added so the frontend knows fee + addresses.

## Immediate next steps, in order

1. ~~forge install~~ ✅  2. ~~forge test~~ ✅
3. `forge script script/Deploy.s.sol --rpc-url bsc_testnet --broadcast --account <your-key>`
   (get test BNB from the BNB Chain testnet faucet first) — save the two deployed
   addresses into `backend/.env`.
4. ~~backend~~ ✅  5. ~~frontend~~ ✅
6. Record the two demo moments; write the pitch deck.

## `guard.ts` spec

Input: `{ token: Address, from: Address, to: Address, amount: string, history?: Address[] }`
(`history` = addresses this `from` has sent to before, for poisoning checks — can
be read from `Relayed` event logs via `publicClient.getLogs`, or passed in from the
frontend's local storage for the demo).

Deterministic checks, run first, each one either passes or produces a finding:

- `to === token` or `to` is the zero address → **hard block** (mirrors the
  contract's own `InvalidRecipient` — catching it here saves the user a revert
  and a wasted signature).
- `to` is a known scam-list address (`scamList` from config) → **hard block**.
- `to` looks like address poisoning: same first N and last N hex characters as an
  address in `history` but not identical → **flag for AI review**, not an auto-block
  (could be a legitimate re-send).
- `to` has no on-chain history (`publicClient.getTransactionCount(to) === 0` and no
  code) and `amount` is large relative to the user's typical send → **flag**.
- `to` is a contract (`publicClient.getBytecode(to)` non-empty) the user hasn't
  interacted with before → **flag** (could be fine, could be a malicious contract).

Return shape: `{ verdict: "block" | "warn" | "ok", findings: Finding[], explanation?: string }`.
Hard blocks skip the LLM entirely (deterministic, fast, free). "warn" findings get
passed to `llmExplain.ts` for the Bahasa explanation. "ok" needs no explanation.

## `llmExplain.ts` spec

Only called for `warn`-level findings. Takes the findings array and produces one
short Bahasa Indonesia sentence in Daviga's Gen Z Jaksel voice (casual, punchy,
English terms mixed in naturally — see `ways-of-working` voice notes) — e.g.
*"Alamat ini mirip banget sama alamat yang kamu pakai kemarin, tapi 6 karakter
tengahnya beda — cek lagi sebelum lanjut."* If `OPENAI_API_KEY` is empty in
`.env`, return a template-based Indonesian sentence instead of calling the API, so
the guard still works with zero API cost during dev/demo rehearsal.

## `relay.ts` spec

Two exported functions, both using `walletClient` from `config.ts`:

- `submitRelay(intent, signature)` → calls `relay(intent, signature)` on
  `KurirRelayer`, waits for the receipt, returns `{ txHash, status }`.
- `submitRelayWithPermit(intent, signature, permit)` → calls `relayWithPermit`.

Both should catch a revert and map the contract's custom errors
(`NotDesignatedRelayer`, `IntentExpired`, `InvalidRecipient`, `InvalidSignature`,
plus OZ's `InvalidAccountNonce`) to plain messages for the API response — don't
leak raw revert data to the frontend.

## `server.ts` spec

Express app, two routes:

- `POST /guard` — body: `{ token, from, to, amount }`. Runs `guard.ts`. If a `warn`
  finding exists, calls `llmExplain.ts`. Returns the verdict JSON. This is called
  *before* the frontend asks the user to sign anything.
- `POST /relay` — body: `{ intent, signature, permit? }`. Re-runs the guard
  server-side on `intent.to`/`intent.amount` (never trust the client's earlier
  guard call), hard-blocks on any `block`-level finding, otherwise calls
  `relay.ts` and returns the tx result.

`cors()` open for the hackathon demo is fine; note in the README this needs
locking down before any real deployment.

## `frontend/` spec

One static HTML page (viem or ethers via CDN script tag, no build step — this
needs to demo reliably on a laptop with no npm install mid-presentation):

1. "Connect wallet" (any injected wallet — MetaMask is fine on BSC testnet).
2. Form: recipient address, amount. On submit, POST to `/guard` first.
3. Show the guard verdict. If `block`, stop. If `warn`, show the Bahasa
   explanation and a "lanjut aja" confirm button. If `ok`, proceed straight through.
4. Build the `SendIntent` (read `nonce` from `KurirRelayer.nonces(user)` via a
   read call), sign it (`signTypedData`), sign the `Permit` on the token, POST
   both to `/relay`.
5. Show the returned tx hash as a BscScan testnet link.

Keep styling minimal — this is a demo tool, not a product. A readable form and a
clear before/after balance display matter far more than visual polish.

## Constraints to respect

- **Non-custodial.** The relayer contract must never hold user funds — tokens move
  directly from `from` to `to` and to `relayer`. Don't introduce an intermediate
  holding step even for convenience.
- **Rules before AI, always.** Any new check must default to a deterministic rule.
  Only add an LLM call where the answer is genuinely a judgment call, and always
  say so explicitly in the pitch and the code comments.
- **No real funds, no real IDRX.** Everything is BSC testnet + `MockStable`. If
  real IDRX support comes up, check separately whether it implements EIP-2612
  `permit` before assuming the gasless flow works with it.
- Real, verified figures only for anything analytical (gas costs, tx times) —
  pull actual numbers from the testnet run rather than estimating them.

## Copy-paste prompt for Claude Code

```
I'm building Kurir, a gasless relayer for BNB Chain (contracts + backend + frontend
already scaffolded in this repo — see CLAUDE.md for the full spec). Start by running
`forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0` and
`forge test -vv` in the repo root, and fix anything that fails to compile or pass.
Then implement backend/src/guard.ts, llmExplain.ts, relay.ts, and server.ts per the
specs in CLAUDE.md. Then build frontend/ as a single static HTML page per its spec.
Ask me before deploying anything to testnet or spending any API budget.
```
