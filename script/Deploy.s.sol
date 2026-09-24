// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockStable} from "../src/MockStable.sol";
import {KurirRelayer} from "../src/KurirRelayer.sol";

/// forge script script/Deploy.s.sol --rpc-url bsc_testnet --broadcast --account <your-key>
/// Optional: DEMO_WALLET=0x... to faucet 1,000 tUSD into the 0-BNB demo wallet.
contract Deploy is Script {
    function run() external {
        address demoWallet = vm.envOr("DEMO_WALLET", address(0));

        vm.startBroadcast();
        MockStable token = new MockStable();
        KurirRelayer relayer = new KurirRelayer();
        if (demoWallet != address(0)) token.faucet(demoWallet);
        vm.stopBroadcast();

        console.log("TOKEN_ADDRESS=%s", address(token));
        console.log("KURIR_RELAYER_ADDRESS=%s", address(relayer));
    }
}
