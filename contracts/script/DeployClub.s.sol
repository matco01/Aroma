// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ClubAuction} from "../src/club/ClubAuction.sol";

/// @notice Deploys `ClubAuction` in front of an already-deployed
/// `PoolFactoryUsdg` (run `DeployPoolUsdg.s.sol` first). Opens the first
/// 24-hour Club as part of construction — see `ClubAuction`'s NatSpec.
contract DeployClub is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address owner = vm.envOr("PROTOCOL_OWNER", deployer);
        address poolFactory = vm.envAddress("POOL_FACTORY_USDG");
        address usdg = vm.envAddress("USDG_ADDRESS");
        address treasury = vm.envAddress("CLUB_TREASURY");

        // Defaults match the product spec (24h rounds, 5-minute anti-snipe
        // extension); the bid-size defaults are placeholders the team should
        // tune before mainnet use, not derived from anything.
        uint64 roundDuration = uint64(vm.envOr("CLUB_ROUND_DURATION_SECONDS", uint256(24 hours)));
        uint256 minOpeningBid = vm.envOr("CLUB_MIN_OPENING_BID", uint256(100e6)); // 100 USDG
        uint256 minBidIncrementBps = vm.envOr("CLUB_MIN_BID_INCREMENT_BPS", uint256(500)); // 5%
        uint64 antiSnipeExtension =
            uint64(vm.envOr("CLUB_ANTI_SNIPE_EXTENSION_SECONDS", uint256(5 minutes)));

        console.log("deployer:            ", deployer);
        console.log("owner:               ", owner);
        console.log("pool factory (usdg): ", poolFactory);
        console.log("usdg:                ", usdg);
        console.log("treasury:            ", treasury);
        console.log("round duration (s):  ", roundDuration);
        console.log("min opening bid:     ", minOpeningBid);
        console.log("min increment (bps): ", minBidIncrementBps);
        console.log("anti-snipe ext (s):  ", antiSnipeExtension);

        require(poolFactory != address(0), "POOL_FACTORY_USDG not set");
        require(poolFactory.code.length > 0, "POOL_FACTORY_USDG has no code on this chain");
        require(usdg != address(0), "USDG_ADDRESS not set");
        require(treasury != address(0), "CLUB_TREASURY not set");

        vm.startBroadcast(pk);

        ClubAuction club = new ClubAuction(
            poolFactory,
            usdg,
            treasury,
            deployer, // nominate owner below, same two-step reasoning as DeployPoolUsdg
            roundDuration,
            minOpeningBid,
            minBidIncrementBps,
            antiSnipeExtension
        );

        if (owner != deployer) {
            club.transferOwnership(owner);
        }

        vm.stopBroadcast();

        console.log("");
        console.log("ClubAuction:         ", address(club));
        ClubAuction.Club memory current = club.getCurrentClub();
        console.log("first club id:       ", current.id);
        console.log("first club ends at:  ", current.endsAt);
        console.log("owner now:           ", club.owner());
        console.log("owner pending:       ", club.pendingOwner());

        if (club.pendingOwner() != address(0)) {
            console.log("");
            console.log("ACTION REQUIRED: ownership is nominated, not transferred.");
            console.log("From the wallet above, call acceptOwnership() on:");
            console.log("  ", address(club));
            console.log("Until then the deployer's key is the one finalize() must be called from.");
        }
    }
}
