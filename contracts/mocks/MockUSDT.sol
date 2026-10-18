// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice TEST TOKEN ONLY. Reproduces the two behaviours of mainnet USDT that break naive ERC-20 integrations:
 *   1. transfer / transferFrom / approve do NOT return a bool.
 *   2. approve reverts when changing a non-zero allowance to another non-zero value
 *      (the allowance must be set to 0 first).
 * It has 6 decimals and an open faucet.
 */
contract MockUSDT {
    string public constant name = "Mock Tether USD (test)";
    string public constant symbol = "mUSDT";
    uint8 public constant decimals = 6;
    uint256 public constant MAX_FAUCET_AMOUNT = 10_000e6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function transfer(address to, uint256 value) external {
        _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "USDT: insufficient allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external {
        require(!(value != 0 && allowance[msg.sender][spender] != 0), "USDT: reset allowance to 0 first");
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }

    function faucet(uint256 amount) external {
        require(amount <= MAX_FAUCET_AMOUNT, "USDT: faucet amount too high");
        _mint(msg.sender, amount);
    }

    /// @dev Unrestricted mint used by the test-suite.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _transfer(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "USDT: insufficient balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) private {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }
}
