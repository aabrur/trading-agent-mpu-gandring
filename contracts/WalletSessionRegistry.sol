// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Trading Agent Mpu Gandring wallet session registry
/// @notice Records consent only. It cannot trade, hold funds, approve tokens or grant venue permissions.
/// @dev Browser logout and venue agent revocation remain separate operations.
contract WalletSessionRegistry {
    uint64 public constant MAX_SESSION_DURATION = 7 days;

    struct Session {
        uint64 expiresAt;
        uint256 epoch;
    }

    mapping(address owner => uint256 epoch) public epochs;
    mapping(address owner => mapping(address agent => mapping(bytes32 context => Session))) public sessions;

    error InvalidAgent();
    error InvalidContext();
    error InvalidExpiry();

    event Authorized(address indexed owner, address indexed agent, bytes32 indexed context, uint64 expiresAt, uint256 epoch);
    event Revoked(address indexed owner, address indexed agent, bytes32 indexed context);
    event RevokedAll(address indexed owner, uint256 epoch);

    /// @notice Create or renew a session. Context should hash the venue, network and application origin.
    /// @dev Only msg.sender's sessions can be changed; no relayer signatures or reusable permits are accepted.
    function authorize(address agent, bytes32 context, uint64 expiresAt) external {
        if (agent == address(0) || agent == msg.sender || agent == address(this)) revert InvalidAgent();
        if (context == bytes32(0)) revert InvalidContext();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_SESSION_DURATION) revert InvalidExpiry();
        sessions[msg.sender][agent][context] = Session(expiresAt, epochs[msg.sender]);
        emit Authorized(msg.sender, agent, context, expiresAt, epochs[msg.sender]);
    }

    function revoke(address agent, bytes32 context) external {
        delete sessions[msg.sender][agent][context];
        emit Revoked(msg.sender, agent, context);
    }

    function revokeAll() external {
        uint256 epoch = ++epochs[msg.sender];
        emit RevokedAll(msg.sender, epoch);
    }

    function isAuthorized(address owner, address agent, bytes32 context) external view returns (bool) {
        Session memory session = sessions[owner][agent][context];
        return session.expiresAt > block.timestamp && session.epoch == epochs[owner];
    }
}
