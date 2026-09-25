# Kurir

Gasless relayer for any EIP-2612 ERC-20 on BNB Chain, with a pre-flight guard that
explains its verdict in Bahasa Indonesia. **Rules block, AI explains.**

- `src/` — `KurirRelayer` (EIP-712 `SendIntent`, non-custodial) and `MockStable` (tUSD, permit + faucet)
- `backend/` — Express relayer + guard (`/config`, `/guard`, `/relay`)
- `frontend/index.html` — single static page, viem from CDN, no build step

## Setup

```bash
# contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0   # already done in this repo
forge test -vv

# backend
cd backend && npm install && cp .env.example .env   # fill it in
npm start                                           # http://localhost:8787

# frontend — any static server works
python3 -m http.server 5174 -d frontend            # http://localhost:5174 (add ?api=http://host:port to point elsewhere)
```

### Local rehearsal (no testnet, no API spend)

```bash
anvil --chain-id 97                                  # chain id 97 so the backend treats it as BSC testnet
DEMO_WALLET=<0-BNB address> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key #0>
# backend/.env: RPC_URL=http://127.0.0.1:8545, RELAYER_PRIVATE_KEY=<anvil key #1>, addresses from the deploy output
cd backend && npm start
USERKEY=<demo wallet key> npx tsx scripts/e2e-local.ts   # 17 checks: gasless send, replay, tamper, excess permit, zero amount, fee > amount, guard rules
# ⚠ The backend requires chain id 97, so anvil must use 97 too. That is BSC testnet's id, and
# `forge script --broadcast` then OVERWRITES the tracked testnet record broadcast/Deploy.s.sol/97/run-latest.json.
# After any local rehearsal:   git checkout -- broadcast/ && git clean -fdq broadcast/
```

### BSC testnet

**Current deployment (chain 97):**
- MockStable (tUSD): `0xf9931457bdcf76bbfb957283a3ca2307e11813cc`
- KurirRelayer: `0x9342dbb1e87ebef78b34fb0fbe9c2d06a3825370`

To redeploy:

```bash
DEMO_WALLET=<0-BNB demo address> forge script script/Deploy.s.sol --rpc-url bsc_testnet --broadcast --account <your-key>
```

Copy `TOKEN_ADDRESS` / `KURIR_RELAYER_ADDRESS` from the output into `backend/.env`. The relayer bot
key (`RELAYER_PRIVATE_KEY`) needs test BNB; the demo wallet needs none. To top up tUSD for any wallet:
`cast send <TOKEN> "faucet(address)" <wallet> --rpc-url bsc_testnet --account <your-key>`.

## Flow

1. Frontend `GET /config` → chain id, contract addresses, relayer bot address, fee.
2. `POST /guard { token, from, to, amount, history? }` → `{ verdict: ok|warn|block, findings, explanation? }`.
   Called before any signature. `amount` is in base units (18 decimals).
3. User signs two EIP-712 messages (no gas): the `SendIntent` and the token's `Permit` for exactly `amount + fee`.
4. `POST /relay { intent, signature, permit }` → backend re-checks everything and submits → `{ txHash, status, explorerUrl, gasUsed }`.

## EIP-712 signing spec

**SendIntent** — domain `{ name: "Kurir", version: "1", chainId, verifyingContract: KurirRelayer }`

```
SendIntent(address token,address from,address to,uint256 amount,uint256 fee,address relayer,uint256 nonce,uint256 deadline)
```

| field | value |
|---|---|
| `token` | `TOKEN_ADDRESS` (only token the relayer accepts fees in) |
| `from` / `to` | sender / recipient |
| `amount` / `fee` | base units; `fee` ≥ `/config.fee` |
| `relayer` | `/config.relayer` — only this address can submit (front-run protection) |
| `nonce` | `KurirRelayer.nonces(from)` — sequential, replay-proof |
| `deadline` | unix seconds (frontend uses now + 10 min) |

**Permit** (standard EIP-2612) — domain `{ name: token.name(), version: "1", chainId, verifyingContract: token }`,
message `{ owner: from, spender: KurirRelayer, value: amount + fee, nonce: token.nonces(from), deadline }`.
Send it as `{ value, deadline, v, r, s }`.

## What blocks what

| Check | Where | Result |
|---|---|---|
| Wrong relayer, expired, tampered field, wrong signer, replay | contract | revert (`NotDesignatedRelayer`, `IntentExpired`, `InvalidSignature`, `InvalidAccountNonce`) |
| `to` = zero / token contract / KurirRelayer | contract **and** guard | revert `InvalidRecipient` / guard `block` |
| `amount == 0` | contract **and** `/relay` | revert `ZeroAmount` / rejected |
| `fee > amount` | frontend **and** `/relay` (contract honours the signature by design) | rejected before signing |
| `to` on scam list | guard | `block` |
| Permit value > amount + fee (open-ended approval) | backend `/relay` | rejected |
| Lookalike of a past recipient or of your own address | guard | `warn` |
| Fresh address (no txs, no code) + large amount | guard | `warn` |
| Contract you haven't sent to before | guard | `warn` |

Only `warn` explanations may use an LLM (OpenAI, if `OPENAI_API_KEY` is set); otherwise fixed
Indonesian templates are used. The LLM only writes the sentence — it never sets the verdict.

## History index and its snapshot

The poisoning check needs every past send by the sender. `backend/src/history.ts` keeps them in memory
(so `/guard` never waits on `eth_getLogs`) and also saves them to `backend/.cache/` (gitignored):

- **First start:** old history comes from `ARCHIVE_RPC_URL` (a free archive endpoint that rate-limits:
  a burst of ~3 requests, then ~1/s, so requests are throttled and retried), recent history from `RPC_URL`.
  Progress is saved as it goes, so an interrupted backfill resumes instead of restarting.
- **Restart:** loads the snapshot and only fetches the gap since it was written, from `RPC_URL`
  (≈0.5 s). The archive is not touched unless the gap is over ~60,000 blocks (~7.5 h on testnet).
- **Never trusted blindly:** a snapshot is used only if its chain id, contract and `KURIR_DEPLOY_BLOCK`
  match, every event parses, and a stored block hash still matches the chain (this rejects a reset
  local chain, which reuses chain id 97 and the same addresses). Otherwise it is ignored and rebuilt.
- **Honest when unsure:** until the index has caught up to the chain head, `/guard` still uses the saved
  history but adds `CHECKS_DEGRADED`. `GET /health` shows `synced`, `ageMs` and the snapshot state.
- Delete `backend/.cache/` to force a full rebuild; `HISTORY_CACHE_DIR=off` disables saving.

`scripts/history-snapshot-check.ts` probes it against testnet (set `ARCHIVE_RPC_URL`/`RPC_URL` to a dead
port to simulate an outage).

## Cancelling a signed intent

Call `KurirRelayer.invalidateNonce()` from the user's wallet. It burns the next nonce, so any intent
signed with it reverts `InvalidAccountNonce`. This one call needs gas. Without BNB, a signed intent
simply expires at its `deadline` (10 minutes in the frontend).

## Before any real deployment

- `cors()` is wide open for the hackathon demo — restrict it to the frontend origin.
- The relayer bot key is a hot key in `.env`; move it to a KMS/signer service.
- `inFlight` double-submit protection and the relayer's nonce handling are in-memory, single-process only.
