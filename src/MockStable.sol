// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockStable (tUSD)
/// @notice Testnet-only ERC-20 with EIP-2612 permit and a public faucet.
/// @dev `faucet(to)` takes a recipient so a funded wallet can top up a 0-BNB demo
///      wallet without that wallet ever needing gas.
contract MockStable is ERC20, ERC20Permit {
    uint256 public constant FAUCET_AMOUNT = 1_000e18;

    constructor() ERC20("Kurir Test USD", "tUSD") ERC20Permit("Kurir Test USD") {}

    function faucet(address to) external {
        _mint(to, FAUCET_AMOUNT);
    }
}
