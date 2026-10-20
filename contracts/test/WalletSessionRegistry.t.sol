// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../WalletSessionRegistry.sol";

contract SessionOwner {
    function revoke(WalletSessionRegistry registry, address agent, bytes32 context) external {
        registry.revoke(agent, context);
    }
}

contract WalletSessionRegistryTest {
    bytes32 constant CONTEXT = keccak256("Trading Agent Mpu Gandring:testnet");
    address constant AGENT = address(0x1234);

    function testRenewAndRevoke() external {
        WalletSessionRegistry registry = new WalletSessionRegistry();
        registry.authorize(AGENT, CONTEXT, uint64(block.timestamp + 1 hours));
        require(registry.isAuthorized(address(this), AGENT, CONTEXT), "authorization missing");
        registry.authorize(AGENT, CONTEXT, uint64(block.timestamp + 2 hours));
        (uint64 expiry,) = registry.sessions(address(this), AGENT, CONTEXT);
        require(expiry == block.timestamp + 2 hours, "renewal missing");
        registry.revoke(AGENT, CONTEXT);
        require(!registry.isAuthorized(address(this), AGENT, CONTEXT), "revocation missing");
    }

    function testOwnerAndContextIsolation() external {
        WalletSessionRegistry registry = new WalletSessionRegistry();
        registry.authorize(AGENT, CONTEXT, uint64(block.timestamp + 1 hours));
        new SessionOwner().revoke(registry, AGENT, CONTEXT);
        require(registry.isAuthorized(address(this), AGENT, CONTEXT), "another owner revoked session");
        require(!registry.isAuthorized(address(0x9999), AGENT, CONTEXT), "owner leak");
        require(!registry.isAuthorized(address(this), AGENT, bytes32(uint256(1))), "context leak");
    }

    function testRevokeAllAndReauthorize() external {
        WalletSessionRegistry registry = new WalletSessionRegistry();
        registry.authorize(AGENT, CONTEXT, uint64(block.timestamp + 1 hours));
        registry.revokeAll();
        require(!registry.isAuthorized(address(this), AGENT, CONTEXT), "epoch not invalidated");
        registry.authorize(AGENT, CONTEXT, uint64(block.timestamp + 1 hours));
        require(registry.isAuthorized(address(this), AGENT, CONTEXT), "cannot reauthorize");
    }

    function testRejectInvalidSessions() external {
        WalletSessionRegistry registry = new WalletSessionRegistry();
        _reject(registry, address(0), CONTEXT, uint64(block.timestamp + 1));
        _reject(registry, address(this), CONTEXT, uint64(block.timestamp + 1));
        _reject(registry, address(registry), CONTEXT, uint64(block.timestamp + 1));
        _reject(registry, AGENT, bytes32(0), uint64(block.timestamp + 1));
        _reject(registry, AGENT, CONTEXT, uint64(block.timestamp));
        _reject(registry, AGENT, CONTEXT, uint64(block.timestamp + 7 days + 1));
    }

    function _reject(WalletSessionRegistry registry, address agent, bytes32 context, uint64 expiry) private {
        (bool ok,) = address(registry).call(abi.encodeCall(registry.authorize, (agent, context, expiry)));
        require(!ok, "invalid session accepted");
    }
}
