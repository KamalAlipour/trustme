// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract TrustCouponEscrow {
    error NotOwner();
    error NotSettler();
    error InvalidAddress();
    error InvalidAmount();
    error InsufficientLocked();
    error ReferenceAlreadyUsed();
    error LengthMismatch();
    error TokenTransferFailed();

    IERC20 public immutable token;
    address public owner;
    address public settler;
    address public vault;
    mapping(address => uint256) public locked;
    mapping(bytes32 => bool) public usedRef;

    event Deposited(address indexed user, uint256 amount, uint256 lockedAmount);
    event Settled(address indexed user, uint256 amount, bytes32 indexed ref);
    event Unloaded(address indexed user, address indexed to, uint256 amount, bytes32 indexed ref);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SettlerUpdated(address indexed settler);
    event VaultUpdated(address indexed vault);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlySettler() {
        if (msg.sender != settler) revert NotSettler();
        _;
    }

    constructor(address token_, address vault_) {
        if (token_ == address(0) || vault_ == address(0)) revert InvalidAddress();
        token = IERC20(token_);
        owner = msg.sender;
        vault = vault_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit VaultUpdated(vault_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        owner = newOwner;
        emit OwnershipTransferred(msg.sender, newOwner);
    }

    function setSettler(address newSettler) external onlyOwner {
        if (newSettler == address(0)) revert InvalidAddress();
        settler = newSettler;
        emit SettlerUpdated(newSettler);
    }

    function setVault(address newVault) external onlyOwner {
        if (newVault == address(0)) revert InvalidAddress();
        vault = newVault;
        emit VaultUpdated(newVault);
    }

    function deposit(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TokenTransferFailed();
        locked[msg.sender] += amount;
        emit Deposited(msg.sender, amount, locked[msg.sender]);
    }

    function settle(address user, uint256 amount, bytes32 ref) external onlySettler {
        _settle(user, amount, ref);
    }

    function settleBatch(address[] calldata users, uint256[] calldata amounts, bytes32[] calldata refs) external onlySettler {
        if (users.length != amounts.length || users.length != refs.length) revert LengthMismatch();
        for (uint256 i = 0; i < users.length; i++) {
            _settle(users[i], amounts[i], refs[i]);
        }
    }

    function unloadFor(address user, uint256 amount, bytes32 ref) external onlySettler {
        _unload(user, amount, ref);
    }

    function unload(uint256 amount) external {
        _unload(msg.sender, amount, bytes32(0));
    }

    function _settle(address user, uint256 amount, bytes32 ref) internal {
        if (usedRef[ref]) revert ReferenceAlreadyUsed();
        if (amount == 0) revert InvalidAmount();
        if (locked[user] < amount) revert InsufficientLocked();
        usedRef[ref] = true;
        locked[user] -= amount;
        if (!token.transfer(vault, amount)) revert TokenTransferFailed();
        emit Settled(user, amount, ref);
    }

    function _unload(address user, uint256 amount, bytes32 ref) internal {
        if (ref != bytes32(0) && usedRef[ref]) revert ReferenceAlreadyUsed();
        if (amount == 0) revert InvalidAmount();
        if (locked[user] < amount) revert InsufficientLocked();
        if (ref != bytes32(0)) usedRef[ref] = true;
        locked[user] -= amount;
        if (!token.transfer(user, amount)) revert TokenTransferFailed();
        emit Unloaded(user, user, amount, ref);
    }
}
