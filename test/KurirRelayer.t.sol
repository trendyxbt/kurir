// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {MockStable} from "../src/MockStable.sol";
import {KurirRelayer} from "../src/KurirRelayer.sol";

contract KurirRelayerTest is Test {
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    MockStable token;
    KurirRelayer kurir;

    uint256 userKey = 0xA11CE;
    address user;
    address relayerBot = makeAddr("relayerBot");
    address attacker = makeAddr("attacker");
    address recipient = makeAddr("recipient");

    uint256 constant AMOUNT = 100e18;
    uint256 constant FEE = 0.5e18;

    function setUp() public {
        token = new MockStable();
        kurir = new KurirRelayer();
        user = vm.addr(userKey);
        token.faucet(user); // 1,000 tUSD, 0 BNB
        vm.deal(user, 0);
    }

    // ---------- helpers ----------

    function _intent(uint256 nonce) internal view returns (KurirRelayer.SendIntent memory) {
        return KurirRelayer.SendIntent({
            token: address(token),
            from: user,
            to: recipient,
            amount: AMOUNT,
            fee: FEE,
            relayer: relayerBot,
            nonce: nonce,
            deadline: block.timestamp + 10 minutes
        });
    }

    function _signIntent(KurirRelayer.SendIntent memory i, uint256 key) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                kurir.SEND_INTENT_TYPEHASH(), i.token, i.from, i.to, i.amount, i.fee, i.relayer, i.nonce, i.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", kurir.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signPermit(uint256 value) internal view returns (KurirRelayer.PermitData memory p) {
        p.value = value;
        p.deadline = block.timestamp + 10 minutes;
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, user, address(kurir), value, token.nonces(user), p.deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (p.v, p.r, p.s) = vm.sign(userKey, digest);
    }

    // ---------- happy paths ----------

    function test_RelayWithPermit_Gasless() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        bytes memory sig = _signIntent(i, userKey);
        KurirRelayer.PermitData memory p = _signPermit(AMOUNT + FEE);

        vm.expectEmit(true, true, true, true, address(kurir));
        emit KurirRelayer.Relayed(user, recipient, address(token), AMOUNT, FEE, relayerBot, 0);
        vm.prank(relayerBot);
        kurir.relayWithPermit(i, sig, p);

        assertEq(token.balanceOf(recipient), AMOUNT);
        assertEq(token.balanceOf(relayerBot), FEE);
        assertEq(token.balanceOf(user), 1_000e18 - AMOUNT - FEE);
        assertEq(token.balanceOf(address(kurir)), 0, "non-custodial: relayer contract holds nothing");
        assertEq(user.balance, 0, "user never needed BNB");
        assertEq(kurir.nonces(user), 1);
    }

    function test_Relay_WithExistingAllowance() public {
        vm.prank(user);
        token.approve(address(kurir), type(uint256).max);

        KurirRelayer.SendIntent memory i = _intent(0);
        bytes memory sig = _signIntent(i, userKey);
        vm.prank(relayerBot);
        kurir.relay(i, sig);

        assertEq(token.balanceOf(recipient), AMOUNT);
        assertEq(token.balanceOf(relayerBot), FEE);
    }

    function test_Relay_ZeroFee() public {
        vm.prank(user);
        token.approve(address(kurir), AMOUNT);

        KurirRelayer.SendIntent memory i = _intent(0);
        i.fee = 0;
        bytes memory sig = _signIntent(i, userKey);
        vm.prank(relayerBot);
        kurir.relay(i, sig);

        assertEq(token.balanceOf(recipient), AMOUNT);
        assertEq(token.balanceOf(relayerBot), 0);
    }

    function test_SequentialNonces() public {
        vm.prank(user);
        token.approve(address(kurir), type(uint256).max);

        for (uint256 n = 0; n < 3; n++) {
            KurirRelayer.SendIntent memory i = _intent(n);
            bytes memory sig = _signIntent(i, userKey);
            vm.prank(relayerBot);
            kurir.relay(i, sig);
        }
        assertEq(token.balanceOf(recipient), 3 * AMOUNT);
    }

    // ---------- attack cases ----------

    function test_Revert_FrontRunByOtherRelayer() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        bytes memory sig = _signIntent(i, userKey);
        KurirRelayer.PermitData memory p = _signPermit(AMOUNT + FEE);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(KurirRelayer.NotDesignatedRelayer.selector, relayerBot, attacker));
        kurir.relayWithPermit(i, sig, p);
    }

    function test_PermitFrontRun_DoesNotGrief() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        bytes memory sig = _signIntent(i, userKey);
        KurirRelayer.PermitData memory p = _signPermit(AMOUNT + FEE);

        // Attacker lifts the permit from the mempool and submits it first.
        vm.prank(attacker);
        token.permit(user, address(kurir), p.value, p.deadline, p.v, p.r, p.s);

        // Relay still goes through: permit() reverts inside try/catch, allowance already set.
        vm.prank(relayerBot);
        kurir.relayWithPermit(i, sig, p);
        assertEq(token.balanceOf(recipient), AMOUNT);
    }

    function test_Revert_Replay() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        bytes memory sig = _signIntent(i, userKey);
        vm.prank(user);
        token.approve(address(kurir), type(uint256).max);

        vm.prank(relayerBot);
        kurir.relay(i, sig);

        vm.prank(relayerBot);
        vm.expectRevert(abi.encodeWithSelector(Nonces.InvalidAccountNonce.selector, user, 1));
        kurir.relay(i, sig);
    }

    function test_Revert_TamperedAmount() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        bytes memory sig = _signIntent(i, userKey);
        i.amount = 900e18;
        KurirRelayer.PermitData memory p = _signPermit(1_000e18);

        vm.prank(relayerBot);
        vm.expectRevert(KurirRelayer.InvalidSignature.selector);
        kurir.relayWithPermit(i, sig, p);
    }

    function test_Revert_TamperedRecipient() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        bytes memory sig = _signIntent(i, userKey);
        i.to = attacker;
        KurirRelayer.PermitData memory p = _signPermit(AMOUNT + FEE);

        vm.prank(relayerBot);
        vm.expectRevert(KurirRelayer.InvalidSignature.selector);
        kurir.relayWithPermit(i, sig, p);
    }

    function test_Revert_TamperedFee() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        bytes memory sig = _signIntent(i, userKey);
        i.fee = 50e18;
        KurirRelayer.PermitData memory p = _signPermit(1_000e18);

        vm.prank(relayerBot);
        vm.expectRevert(KurirRelayer.InvalidSignature.selector);
        kurir.relayWithPermit(i, sig, p);
    }

    function test_Revert_WrongSigner() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        bytes memory sig = _signIntent(i, 0xBAD);

        vm.prank(relayerBot);
        vm.expectRevert(KurirRelayer.InvalidSignature.selector);
        kurir.relay(i, sig);
    }

    function test_Revert_Expired() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        bytes memory sig = _signIntent(i, userKey);
        vm.warp(i.deadline + 1);

        vm.prank(relayerBot);
        vm.expectRevert(abi.encodeWithSelector(KurirRelayer.IntentExpired.selector, i.deadline));
        kurir.relay(i, sig);
    }

    function test_Revert_SendToTokenContract() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        i.to = address(token);
        bytes memory sig = _signIntent(i, userKey);
        KurirRelayer.PermitData memory p = _signPermit(AMOUNT + FEE);

        vm.prank(relayerBot);
        vm.expectRevert(abi.encodeWithSelector(KurirRelayer.InvalidRecipient.selector, address(token)));
        kurir.relayWithPermit(i, sig, p);
    }

    function test_Revert_SendToZeroOrRelayerContract() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        i.to = address(0);
        bytes memory sig = _signIntent(i, userKey);
        vm.prank(relayerBot);
        vm.expectRevert(abi.encodeWithSelector(KurirRelayer.InvalidRecipient.selector, address(0)));
        kurir.relay(i, sig);

        i.to = address(kurir);
        sig = _signIntent(i, userKey);
        vm.prank(relayerBot);
        vm.expectRevert(abi.encodeWithSelector(KurirRelayer.InvalidRecipient.selector, address(kurir)));
        kurir.relay(i, sig);
    }

    function test_Revert_PermitTooSmall() public {
        KurirRelayer.SendIntent memory i = _intent(0);
        bytes memory sig = _signIntent(i, userKey);
        KurirRelayer.PermitData memory p = _signPermit(AMOUNT);

        vm.prank(relayerBot);
        vm.expectRevert(); // ERC20InsufficientAllowance on the fee transfer
        kurir.relayWithPermit(i, sig, p);
        assertEq(token.balanceOf(recipient), 0, "atomic: nothing moved");
    }

    function testFuzz_NeverHoldsFunds(uint96 amount, uint96 fee) public {
        vm.assume(uint256(amount) + fee <= 1_000e18);
        KurirRelayer.SendIntent memory i = _intent(0);
        i.amount = amount;
        i.fee = fee;
        bytes memory sig = _signIntent(i, userKey);
        KurirRelayer.PermitData memory p = _signPermit(uint256(amount) + fee);

        vm.prank(relayerBot);
        kurir.relayWithPermit(i, sig, p);
        assertEq(token.balanceOf(address(kurir)), 0);
        assertEq(token.balanceOf(recipient) + token.balanceOf(relayerBot) + token.balanceOf(user), 1_000e18);
    }
}
