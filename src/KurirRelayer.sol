// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title KurirRelayer
/// @notice Gasless, non-custodial relay for any EIP-2612 ERC-20. The user signs a
///         SendIntent off-chain; a designated relayer submits it, pays the gas, and is
///         repaid `fee` in the same token. Tokens move straight from `from` to `to`
///         and to the relayer — this contract never holds a balance.
/// @dev All hard failures here are deterministic rules. Nothing on-chain depends on
///      the off-chain AI guard.
contract KurirRelayer is EIP712, Nonces {
    using SafeERC20 for IERC20;

    struct SendIntent {
        address token;
        address from;
        address to;
        uint256 amount;
        uint256 fee;
        address relayer;
        uint256 nonce;
        uint256 deadline;
    }

    struct PermitData {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    bytes32 public constant SEND_INTENT_TYPEHASH = keccak256(
        "SendIntent(address token,address from,address to,uint256 amount,uint256 fee,address relayer,uint256 nonce,uint256 deadline)"
    );

    event Relayed(
        address indexed from,
        address indexed to,
        address indexed token,
        uint256 amount,
        uint256 fee,
        address relayer,
        uint256 nonce
    );

    /// @dev The intent names one relayer; anyone else copying it from the mempool is rejected.
    error NotDesignatedRelayer(address expected, address actual);
    error IntentExpired(uint256 deadline);
    /// @dev Zero address, the token contract itself, or this contract.
    error InvalidRecipient(address to);
    error InvalidSignature();

    constructor() EIP712("Kurir", "1") {}

    /// @notice Relay an intent whose token allowance to this contract already exists.
    function relay(SendIntent calldata intent, bytes calldata signature) external {
        _relay(intent, signature);
    }

    /// @notice Relay an intent, first applying the user's EIP-2612 permit.
    /// @dev The permit call is wrapped in try/catch: if someone front-runs the permit
    ///      itself, the allowance is already in place and the relay still succeeds.
    ///      If the permit was genuinely invalid, transferFrom fails below.
    function relayWithPermit(SendIntent calldata intent, bytes calldata signature, PermitData calldata permit)
        external
    {
        try IERC20Permit(intent.token).permit(
            intent.from, address(this), permit.value, permit.deadline, permit.v, permit.r, permit.s
        ) {} catch {}
        _relay(intent, signature);
    }

    function hashIntent(SendIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SEND_INTENT_TYPEHASH,
                    intent.token,
                    intent.from,
                    intent.to,
                    intent.amount,
                    intent.fee,
                    intent.relayer,
                    intent.nonce,
                    intent.deadline
                )
            )
        );
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _relay(SendIntent calldata intent, bytes calldata signature) internal {
        if (msg.sender != intent.relayer) revert NotDesignatedRelayer(intent.relayer, msg.sender);
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline);
        if (intent.to == address(0) || intent.to == intent.token || intent.to == address(this)) {
            revert InvalidRecipient(intent.to);
        }
        if (!SignatureChecker.isValidSignatureNow(intent.from, hashIntent(intent), signature)) {
            revert InvalidSignature();
        }
        // Reverts with InvalidAccountNonce on replay or out-of-order nonce.
        _useCheckedNonce(intent.from, intent.nonce);

        IERC20 token = IERC20(intent.token);
        token.safeTransferFrom(intent.from, intent.to, intent.amount);
        if (intent.fee > 0) token.safeTransferFrom(intent.from, msg.sender, intent.fee);

        emit Relayed(intent.from, intent.to, intent.token, intent.amount, intent.fee, msg.sender, intent.nonce);
    }
}
