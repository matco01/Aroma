// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title AramToken
/// @notice The token every launch on aram deploys. Fixed supply, no owner,
/// no admin function of any kind — the entire trust model rests on this
/// contract being unable to do anything after construction except move
/// balances around. Permit (EIP-2612) support exists specifically so a
/// `sell` can be one signed transaction instead of approve-then-sell,
/// since native-USDC buys already skip the equivalent step on the way in.
/// @dev Deliberately minimal. This deploys once per token launch, so its
/// bytecode size is a real, recurring gas cost across every launch on the
/// platform — every byte here is a byte every creator pays for.
contract AramToken is ERC20, ERC20Permit {
    /// @param name_ Display name, chosen by the creator.
    /// @param symbol_ Ticker, chosen by the creator.
    /// @param totalSupply_ Minted in full to `curveManager` at construction.
    /// There is no mint function anywhere in this contract — this
    /// constructor argument is the only place supply is ever created.
    /// @param curveManager Receives the entire minted supply. This is the
    /// shared curve contract, not a per-token contract — see CurveManager's
    /// NatSpec for why one shared contract holds every launched token's
    /// reserves rather than one curve contract per token.
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address curveManager
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        _mint(curveManager, totalSupply_);
    }
}
