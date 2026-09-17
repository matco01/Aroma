// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice The smallest honest stand-in for a Safe: a contract with no key of
/// its own, which approves a signature under ERC-1271 when its owner signed it,
/// and which can make calls. Exists to prove club invites work for contract
/// wallets through the fallback branch, since no key can recover to its address.
contract MockContractWallet {
    address public immutable owner;
    bool public refuse;

    constructor(address owner_) {
        owner = owner_;
    }

    function setRefuse(bool refuse_) external {
        refuse = refuse_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        bool ok = !refuse && err == ECDSA.RecoverError.NoError && recovered == owner;
        return ok ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function execute(address target, uint256 value, bytes calldata data)
        external
        returns (bytes memory)
    {
        require(msg.sender == owner, "not owner");
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        require(ok, "call failed");
        return ret;
    }

    receive() external payable {}
}
