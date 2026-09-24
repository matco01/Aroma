// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockUsdg
/// @notice Test-only stand-in for Robinhood Chain's real USDG. The
/// pool-usdg/club contracts trade a plain ERC-20, unlike the native-value
/// original system, so tests need a mintable token rather than `vm.deal`.
/// @dev Test-only: never deployed anywhere real. 6 decimals and EIP-2612
/// permit, matching the real USDG's own contract (confirmed on Etherscan and
/// against Paxos's `usdg-contract` README respectively) rather than assumed.
contract MockUsdg is ERC20, ERC20Permit {
    constructor() ERC20("Mock USDG", "USDG") ERC20Permit("Mock USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
