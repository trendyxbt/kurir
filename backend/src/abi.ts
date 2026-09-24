import { parseAbi } from "viem";

/**
 * KurirRelayer ABI, plus the token/OZ errors that can bubble up through it,
 * so viem can decode every revert into a named error.
 */
export const kurirRelayerAbi = parseAbi([
  "struct SendIntent { address token; address from; address to; uint256 amount; uint256 fee; address relayer; uint256 nonce; uint256 deadline; }",
  "struct PermitData { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "function relay(SendIntent intent, bytes signature)",
  "function relayWithPermit(SendIntent intent, bytes signature, PermitData permit)",
  "function nonces(address owner) view returns (uint256)",
  "function hashIntent(SendIntent intent) view returns (bytes32)",
  "event Relayed(address indexed from, address indexed to, address indexed token, uint256 amount, uint256 fee, address relayer, uint256 nonce)",
  "error NotDesignatedRelayer(address expected, address actual)",
  "error IntentExpired(uint256 deadline)",
  "error InvalidRecipient(address to)",
  "error InvalidSignature()",
  "error ZeroAmount()",
  "error InvalidAccountNonce(address account, uint256 currentNonce)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error SafeERC20FailedOperation(address token)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
]);
