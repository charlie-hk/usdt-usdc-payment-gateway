// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST TOKEN ONLY. Burns 1% of every transfer, to prove the gateway rejects fee-on-transfer tokens.
contract MockFeeToken is ERC20 {
    constructor() ERC20("Mock Fee Token", "FEE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 burnt = value / 100;
            super._update(from, address(0), burnt);
            super._update(from, to, value - burnt);
        } else {
            super._update(from, to, value);
        }
    }
}
