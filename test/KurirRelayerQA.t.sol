// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Day 1 QA — independent gap tests (qa/day1-acceptance-criteria.md, Section 3).
// Written by QA, separate from the developer suite in KurirRelayer.t.sol.
// Every revert is asserted by exact selector (+ args where the error has them).

import {Test} from "forge-std/Test.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MockStable} from "../src/MockStable.sol";
import {KurirRelayer} from "../src/KurirRelayer.sol";

/// Malicious token that is also the designated relayer: during transferFrom it
/// re-enters KurirRelayer with the *same* signed intent. If the nonce were consumed
/// after the transfers, the inner call would succeed (double-spend).
contract ReentrantToken {
    KurirRelayer public immutable kurir;
    KurirRelayer.SendIntent internal stored;
    bytes internal storedSig;
    bool internal entered;
    bytes public innerRevert;
    bool public innerSucceeded;

    constructor(KurirRelayer k) {
        kurir = k;
    }

    function arm(KurirRelayer.SendIntent calldata i, bytes calldata sig) external {
        stored = i;
        storedSig = sig;
    }

    function go() external {
        kurir.relay(stored, storedSig);
    }

    function transferFrom(address, address, uint256) external returns (bool) {
        if (!entered) {
            entered = true;
            try kurir.relay(stored, storedSig) {
                innerSucceeded = true;
            } catch (bytes memory err) {
                innerRevert = err;
            }
        }
        return true;
    }
}

contract KurirRelayerQATest is Test {
    // Independent copies of the spec strings (README / CLAUDE.md), NOT read from the contract.
    bytes32 constant SPEC_SEND_INTENT_TYPEHASH = keccak256(
        "SendIntent(address token,address from,address to,uint256 amount,uint256 fee,address relayer,uint256 nonce,uint256 deadline)"
    );
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    MockStable token;
    KurirRelayer kurir;
    uint256 userKey = 0xA11CE;
    address user;
    address relayerBot = makeAddr("relayerBot");
    address recipient = makeAddr("recipient");

    function setUp() public {
        vm.warp(1_750_000_000); // realistic timestamp so "deadline in the past" is expressible
        token = new MockStable();
        kurir = new KurirRelayer();
        user = vm.addr(userKey);
        token.faucet(user); // 1,000 tUSD
    }

    // ---------- helpers (spec-derived, independent of contract getters) ----------

    function _intent(uint256 amount, uint256 fee) internal view returns (KurirRelayer.SendIntent memory) {
        return KurirRelayer.SendIntent({
            token: address(token),
            from: user,
            to: recipient,
            amount: amount,
            fee: fee,
            relayer: relayerBot,
            nonce: kurir.nonces(user),
            deadline: block.timestamp + 10 minutes
        });
    }

    function _domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Kurir"),
                keccak256("1"),
                block.chainid,
                address(kurir)
            )
        );
    }

    function _sign(KurirRelayer.SendIntent memory i, uint256 key) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                SPEC_SEND_INTENT_TYPEHASH, i.token, i.from, i.to, i.amount, i.fee, i.relayer, i.nonce, i.deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", _domain(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _permit(uint256 value) internal view returns (KurirRelayer.PermitData memory p) {
        p.value = value;
        p.deadline = block.timestamp + 10 minutes;
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, user, address(kurir), value, token.nonces(user), p.deadline));
        (p.v, p.r, p.s) = vm.sign(userKey, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }

    // ---------- Section 4: encoding matches spec ----------

    function test_QA_TypehashAndDomainMatchSpec() public view {
        assertEq(kurir.SEND_INTENT_TYPEHASH(), SPEC_SEND_INTENT_TYPEHASH, "typehash string drifted from spec");
        assertEq(kurir.DOMAIN_SEPARATOR(), _domain(), "domain (name/version/chainId/contract) drifted from spec");
    }

    // ---------- F7 extended: every one of the 8 signed fields is bound ----------

    function test_QA_EveryFieldIsSignatureBound() public {
        KurirRelayer.SendIntent memory base = _intent(10e18, 1e18);
        bytes memory sig = _sign(base, userKey);
        vm.prank(user);
        token.approve(address(kurir), type(uint256).max);

        for (uint256 f = 0; f < 8; f++) {
            // abi round-trip = a real copy; plain `t = base` would alias the same memory struct
            KurirRelayer.SendIntent memory t = abi.decode(abi.encode(base), (KurirRelayer.SendIntent));
            if (f == 0) t.token = address(new MockStable());
            if (f == 1) t.from = makeAddr("otherFrom");
            if (f == 2) t.to = makeAddr("otherTo");
            if (f == 3) t.amount += 1;
            if (f == 4) t.fee += 1;
            if (f == 5) t.relayer = makeAddr("otherRelayer");
            if (f == 6) t.nonce += 1;
            if (f == 7) t.deadline += 1;

            vm.prank(t.relayer); // submit as whichever relayer the tampered intent names
            vm.expectRevert(KurirRelayer.InvalidSignature.selector);
            kurir.relay(t, sig);
        }
        // and the untampered one still works, so the reverts above weren't for another reason
        vm.prank(relayerBot);
        kurir.relay(base, sig);
        assertEq(token.balanceOf(recipient), 10e18);
    }

    // ---------- G1: zero-amount send ----------

    function test_QA_G1_ZeroAmount_Reverts() public {
        // Re-test after fix: was "succeeds and relayer still collects fee".
        KurirRelayer.SendIntent memory i = _intent(0, 0.5e18);
        bytes memory sig = _sign(i, userKey);
        KurirRelayer.PermitData memory p = _permit(0.5e18);

        vm.prank(relayerBot);
        vm.expectRevert(KurirRelayer.ZeroAmount.selector);
        kurir.relayWithPermit(i, sig, p);
        assertEq(token.balanceOf(relayerBot), 0);
        assertEq(kurir.nonces(user), 0);
    }

    // ---------- G2: fee > amount ----------

    function test_QA_G2_FeeGreaterThanAmount_Succeeds() public {
        KurirRelayer.SendIntent memory i = _intent(1e18, 5e18);
        bytes memory sig = _sign(i, userKey);
        KurirRelayer.PermitData memory p = _permit(6e18);

        vm.prank(relayerBot);
        kurir.relayWithPermit(i, sig, p);

        // Actual behavior: contract honours whatever the user signed — relayer takes 5x the send.
        assertEq(token.balanceOf(recipient), 1e18);
        assertEq(token.balanceOf(relayerBot), 5e18);
    }

    // ---------- G3: deadline already past at signing time ----------

    function test_QA_G3_DeadlineAlreadyPastAtSigning() public {
        KurirRelayer.SendIntent memory i = _intent(10e18, 0.5e18);
        i.deadline = block.timestamp - 1;
        bytes memory sig = _sign(i, userKey);
        KurirRelayer.PermitData memory p = _permit(10.5e18);

        vm.prank(relayerBot);
        vm.expectRevert(abi.encodeWithSelector(KurirRelayer.IntentExpired.selector, i.deadline));
        kurir.relayWithPermit(i, sig, p);
    }

    function test_QA_G3b_DeadlineEqualsNow_IsStillValid() public {
        KurirRelayer.SendIntent memory i = _intent(10e18, 0.5e18);
        i.deadline = block.timestamp; // boundary: contract uses `>`, so == is allowed
        bytes memory sig = _sign(i, userKey);
        KurirRelayer.PermitData memory p = _permit(10.5e18);

        vm.prank(relayerBot);
        kurir.relayWithPermit(i, sig, p);
        assertEq(token.balanceOf(recipient), 10e18);
    }

    // ---------- G4: insufficient balance / allowance surface cleanly ----------

    function test_QA_G4_InsufficientBalance_RevertsWithExactError() public {
        KurirRelayer.SendIntent memory i = _intent(2_000e18, 0.5e18); // user holds 1,000
        bytes memory sig = _sign(i, userKey);
        KurirRelayer.PermitData memory p = _permit(2_000.5e18); // permit itself is valid

        vm.prank(relayerBot);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, user, 1_000e18, 2_000e18)
        );
        kurir.relayWithPermit(i, sig, p);

        // The successful permit inside try/catch is rolled back with the rest of the tx.
        assertEq(token.allowance(user, address(kurir)), 0);
        assertEq(kurir.nonces(user), 0);
    }

    function test_QA_G4b_InsufficientAllowance_RevertsWithExactError() public {
        KurirRelayer.SendIntent memory i = _intent(10e18, 0.5e18);
        bytes memory sig = _sign(i, userKey);

        vm.prank(relayerBot);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(kurir), 0, 10e18)
        );
        kurir.relay(i, sig);
    }

    function test_QA_G4c_PermitCoversAmountButNotFee_ExactError() public {
        // Tightens test_Revert_PermitTooSmall, which only uses a bare vm.expectRevert().
        KurirRelayer.SendIntent memory i = _intent(100e18, 0.5e18);
        bytes memory sig = _sign(i, userKey);
        KurirRelayer.PermitData memory p = _permit(100e18);

        vm.prank(relayerBot);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(kurir), 0, 0.5e18)
        );
        kurir.relayWithPermit(i, sig, p);
    }

    // ---------- G5: try/catch on permit must not swallow a bad intent ----------

    function test_QA_G5_BadPermitAndBadIntentSig_RevertsInvalidSignature() public {
        KurirRelayer.SendIntent memory i = _intent(10e18, 0.5e18);
        bytes memory badSig = _sign(i, 0xBAD);
        KurirRelayer.PermitData memory garbage =
            KurirRelayer.PermitData({value: 10.5e18, deadline: block.timestamp + 600, v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(2))});

        vm.prank(relayerBot);
        vm.expectRevert(KurirRelayer.InvalidSignature.selector);
        kurir.relayWithPermit(i, badSig, garbage);
    }

    function test_QA_G5b_BadPermitGoodIntent_DoesNotSilentlyProceed() public {
        KurirRelayer.SendIntent memory i = _intent(10e18, 0.5e18);
        bytes memory sig = _sign(i, userKey);
        KurirRelayer.PermitData memory garbage =
            KurirRelayer.PermitData({value: 10.5e18, deadline: block.timestamp + 600, v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(2))});

        vm.prank(relayerBot);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(kurir), 0, 10e18)
        );
        kurir.relayWithPermit(i, sig, garbage);
        assertEq(token.balanceOf(recipient), 0);
    }

    // ---------- G6: nonce is consumed before the external transfer calls ----------

    function test_QA_G6_ReentrancyWithSameIntentIsBlockedByNonce() public {
        ReentrantToken evil = new ReentrantToken(kurir);
        KurirRelayer.SendIntent memory i = KurirRelayer.SendIntent({
            token: address(evil),
            from: user,
            to: recipient,
            amount: 10e18,
            fee: 0,
            relayer: address(evil),
            nonce: 0,
            deadline: block.timestamp + 600
        });
        evil.arm(i, _sign(i, userKey));
        evil.go();

        assertFalse(evil.innerSucceeded(), "re-entrant replay went through");
        assertEq(evil.innerRevert(), abi.encodeWithSelector(Nonces.InvalidAccountNonce.selector, user, 1));
        assertEq(kurir.nonces(user), 1);
    }

    // ---------- S1: permit() is never called for an intent that fails validation ----------

    function test_QA_S1_InvalidIntentNeverReachesPermit() public {
        KurirRelayer.SendIntent memory i = _intent(10e18, 0.5e18);
        bytes memory badSig = _sign(i, 0xBAD);
        KurirRelayer.PermitData memory p = _permit(10.5e18);

        vm.expectCall(address(token), abi.encodeWithSelector(token.permit.selector), 0);
        vm.prank(relayerBot);
        vm.expectRevert(KurirRelayer.InvalidSignature.selector);
        kurir.relayWithPermit(i, badSig, p);
    }

    function test_QA_S1b_ValidIntentStillCallsPermit() public {
        KurirRelayer.SendIntent memory i = _intent(10e18, 0.5e18);
        bytes memory sig = _sign(i, userKey);
        KurirRelayer.PermitData memory p = _permit(10.5e18);

        vm.expectCall(address(token), abi.encodeWithSelector(token.permit.selector), 1);
        vm.prank(relayerBot);
        kurir.relayWithPermit(i, sig, p);
        assertEq(token.balanceOf(recipient), 10e18);
    }

    // ---------- G7: faucet has no per-address cap (accepted, testnet only) ----------

    function test_QA_G7_FaucetIsUncapped() public {
        address anyone = makeAddr("anyone");
        for (uint256 k = 0; k < 5; k++) {
            vm.prank(anyone);
            token.faucet(anyone);
        }
        assertEq(token.balanceOf(anyone), 5 * token.FAUCET_AMOUNT());
    }
}
