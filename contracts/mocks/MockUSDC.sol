// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice TEST TOKEN ONLY. 6 decimals and EIP-2612 permit like Circle's USDC, with an open faucet.
contract MockUSDC is ERC20, ERC20Permit {
    uint256 public constant MAX_FAUCET_AMOUNT = 10_000e6;

    error FaucetAmountTooHigh();

    constructor() ERC20("Mock USD Coin (test)", "mUSDC") ERC20Permit("Mock USD Coin (test)") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(uint256 amount) external {
        if (amount > MAX_FAUCET_AMOUNT) revert FaucetAmountTooHigh();
        _mint(msg.sender, amount);
    }

    /// @dev Unrestricted mint used by the test-suite.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
