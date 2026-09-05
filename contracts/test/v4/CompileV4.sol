// SPDX-License-Identifier: MIT
pragma solidity =0.8.26;

// This file exists only to make forge compile Uniswap's real PoolManager
// into an artifact. Nothing imports this file.
//
// The tests cannot import PoolManager directly: it pins =0.8.26 and every
// contract in src/ pins 0.8.28, and a single compilation unit has to
// satisfy one solc version. Compiling it here in its own unit and then
// deploying it by artifact name (vm.deployCode) sidesteps that entirely,
// and means the graduation tests run against the genuine v4 singleton
// rather than a mock written to agree with our own assumptions.
import {PoolManager} from "v4-core/PoolManager.sol";
