# Trading Agent Mpu Gandring wallet sessions

`WalletSessionRegistry.sol` is an optional, non-custodial consent registry. It is not deployed or connected to the office. No transaction is sent by the office to this contract.

An owner can authorize a separate agent for a context, renew it for up to seven days, revoke one session, or invalidate all sessions. Contexts should be `keccak256(abi.encode(venue, network, applicationOrigin))`. A consumer must check `isAuthorized` on the expected chain and deployed contract before treating a session as valid. This repository does not yet have such a consumer.

Authorization uses `msg.sender`, so another wallet cannot renew or revoke the owner's sessions. There are no relayed signatures, token approvals, transfers, external calls, administrator privileges, or withdrawal methods. Normal payments to the contract are rejected. Do not send assets to its address.

Screening here means rejecting zero, self, registry-agent addresses, empty contexts, and invalid expiry windows. It does not assess whether a wallet or agent is malicious, compromised, sanctioned, or trustworthy. Browser address validation is also not an identity or reputation check.

The office reconnects only after confirming the saved account through `eth_accounts`. Account, chain, or provider disconnection invalidates the local session. Disconnect clears the local session and requests permission revocation when supported by the wallet. It does not stop trading or revoke an exchange agent. Use the venue's official agent page for revocation.

Deployment, gas costs, chain selection, an independent security review, and an application consumer are separate steps. The registry must not be treated as an exchange safety gate.
