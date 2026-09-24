import {
  BaseError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  type Address,
  type Hex,
} from "viem";
import { kurirRelayerAbi } from "./abi.js";
import { account, env, publicClient, walletClient } from "./config.js";

export interface SendIntent {
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
  fee: bigint;
  relayer: Address;
  nonce: bigint;
  deadline: bigint;
}

export interface PermitData {
  value: bigint;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

export type RelayResult =
  | { ok: true; txHash: Hex; status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint }
  | { ok: false; code: string; message: string };

/** Plain-language messages for every revert the contract (or token) can throw. Raw revert data never leaves the server. */
const ERROR_MESSAGES: Record<string, string> = {
  NotDesignatedRelayer: "Intent ini ditandatangani untuk relayer lain, jadi nggak bisa dikirim lewat sini.",
  IntentExpired: "Tanda tangannya udah kedaluwarsa. Coba kirim ulang ya.",
  InvalidRecipient: "Alamat tujuannya nggak valid (alamat nol, kontrak token, atau kontrak Kurir).",
  InvalidSignature: "Tanda tangannya nggak cocok sama isi transaksi — mungkin datanya berubah. Coba tanda tangan ulang.",
  ZeroAmount: "Jumlah kirim harus lebih dari 0.",
  InvalidAccountNonce: "Transaksi ini udah pernah diproses atau urutannya nggak pas. Refresh lalu coba lagi.",
  ERC20InsufficientBalance: "Saldo token kamu nggak cukup buat nominal + fee.",
  ERC20InsufficientAllowance: "Izin (permit) token kurang atau nggak valid. Coba tanda tangan ulang.",
  SafeERC20FailedOperation: "Transfer token gagal di kontrak token-nya.",
};

export function submitRelay(intent: SendIntent, signature: Hex): Promise<RelayResult> {
  return submit("relay", [intent, signature]);
}

export function submitRelayWithPermit(intent: SendIntent, signature: Hex, permit: PermitData): Promise<RelayResult> {
  return submit("relayWithPermit", [intent, signature, permit]);
}

async function submit(
  functionName: "relay" | "relayWithPermit",
  args: readonly [SendIntent, Hex] | readonly [SendIntent, Hex, PermitData],
): Promise<RelayResult> {
  try {
    // Simulate first: a revert here costs the relayer nothing.
    const { request } = await publicClient.simulateContract({
      address: env.KURIR_RELAYER_ADDRESS,
      abi: kurirRelayerAbi,
      functionName,
      args: args as never,
      account,
    });
    const txHash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    return {
      ok: true,
      txHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
    };
  } catch (err) {
    return mapError(err);
  }
}

function mapError(err: unknown): RelayResult {
  console.error("[relay] submit failed:", err instanceof Error ? err.message.split("\n")[0] : err);
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? "UnknownRevert";
      return { ok: false, code: name, message: ERROR_MESSAGES[name] ?? "Transaksi ditolak kontrak." };
    }
    if (err.walk((e) => e instanceof InsufficientFundsError)) {
      return { ok: false, code: "RelayerOutOfGas", message: "Relayer lagi kehabisan BNB buat gas. Coba lagi nanti." };
    }
  }
  return { ok: false, code: "RelayFailed", message: "Relayer gagal kirim transaksi. Coba lagi sebentar." };
}
