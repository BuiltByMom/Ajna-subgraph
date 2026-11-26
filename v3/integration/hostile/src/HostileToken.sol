// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @notice An ERC20 for attacking an indexer. It is an ordinary token where a pool needs it to be:
///         balances, allowances and transfers work. Its owner can replace its answer to any other
///         call, which is where an indexer reads `name`, `symbol` and `decimals`, with arbitrary
///         return data, a revert, an empty answer or text of any length. `balanceOf` can be made
///         to revert.
/// @dev    Used by integration/hostile.js only. It has no access control: never deploy it for value.
contract HostileToken {
    uint8 internal constant RETURN  = 0; // return the data stored for the call
    uint8 internal constant REVERT  = 1; // revert
    uint8 internal constant NOTHING = 2; // return no data
    uint8 internal constant LONG    = 3; // return a string as long as the number stored for the call

    mapping(address => uint256) internal balances;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    mapping(bytes4 => bytes) internal answers;
    mapping(bytes4 => uint8) internal modes;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 decimals_) {
        answers[0x313ce567] = abi.encode(decimals_);  // decimals()
        answers[0x06fdde03] = abi.encode("Hostile");  // name()
        answers[0x95d89b41] = abi.encode("HOSTILE");  // symbol()
    }

    /// @notice Sets what the token answers to calls of `selector_` from now on.
    function setAnswer(bytes4 selector_, bytes calldata data_, uint8 mode_) external {
        answers[selector_] = data_;
        modes[selector_]   = mode_;
    }

    function mint(address to_, uint256 amount_) external {
        balances[to_] += amount_;
        totalSupply   += amount_;
        emit Transfer(address(0), to_, amount_);
    }

    function balanceOf(address account_) external view returns (uint256) {
        if (modes[msg.sig] == REVERT) revert("hostile");
        return balances[account_];
    }

    function approve(address spender_, uint256 amount_) external returns (bool) {
        allowance[msg.sender][spender_] = amount_;
        emit Approval(msg.sender, spender_, amount_);
        return true;
    }

    function transfer(address to_, uint256 amount_) external returns (bool) {
        balances[msg.sender] -= amount_;
        balances[to_]        += amount_;
        emit Transfer(msg.sender, to_, amount_);
        return true;
    }

    function transferFrom(address from_, address to_, uint256 amount_) external returns (bool) {
        if (allowance[from_][msg.sender] != type(uint256).max) allowance[from_][msg.sender] -= amount_;
        balances[from_] -= amount_;
        balances[to_]   += amount_;
        emit Transfer(from_, to_, amount_);
        return true;
    }

    /// @dev Answers every call the token does not implement, as `setAnswer` last said to.
    fallback() external {
        uint8 mode = modes[msg.sig];
        if (mode == REVERT) revert("hostile");
        if (mode == NOTHING) return;

        bytes memory data = answers[msg.sig];
        if (mode == LONG) {
            // a string of the stored length, every byte "A", built in memory
            uint256 length = abi.decode(data, (uint256));
            assembly {
                let start := mload(0x40)
                mstore(start, 0x20)
                mstore(add(start, 0x20), length)
                let words := div(add(length, 31), 32)
                for { let i := 0 } lt(i, words) { i := add(i, 1) } {
                    mstore(add(add(start, 0x40), mul(i, 32)), 0x4141414141414141414141414141414141414141414141414141414141414141)
                }
                return(start, add(0x40, mul(words, 32)))
            }
        }
        assembly { return(add(data, 32), mload(data)) }
    }
}
