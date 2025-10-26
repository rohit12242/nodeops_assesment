// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
GovernanceExecutor.sol

Responsibilities:
- Accept a relayer attestation that a proposal passed on the verifier chain (markProposalPassed).
- Execute the action committed earlier on GovernanceRootPublisher if:
  1) the relayer attested the proposal passed,
  2) the provided actionData matches the previously published actionDataHash,
  3) the proposal hasn't been executed before.

ActionData format:
abi.encode(address target, bytes data)

This allows executing arbitrary encoded calls on the `target` contract (for example, vault.setUnbondingPeriod(...)).
Use with caution — ensure actions are safe and the relayer is trusted (or replaced with stronger attestation).
*/

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IGovernanceRootPublisher {
    // getProposalCore returns:
    // (address proposer, bytes32 actionDataHash, uint256 snapshotBlock, uint256 ER_snapshot, bytes32 powerRoot, string memory metadata, uint256 createdAt)
    function getProposalCore(uint256 proposalId)
        external
        view
        returns (
            address proposer,
            bytes32 actionDataHash,
            uint256 snapshotBlock,
            uint256 ER_snapshot,
            bytes32 powerRoot,
            string memory metadata,
            uint256 createdAt
        );
}

contract GovernanceExecutor is Ownable, ReentrancyGuard {
    IGovernanceRootPublisher public governancePublisher;

    // Authorized relayer address (off-chain service)
    address public relayer;

    // proposalId => attested (true if relayer observed ProposalPassed and called markProposalPassed)
    mapping(uint256 => bool) public attestedPassed;

    // proposalId => executed
    mapping(uint256 => bool) public executed;

    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);
    event GovernancePublisherUpdated(address indexed oldPub, address indexed newPub);
    event ProposalAttested(uint256 indexed proposalId, bytes32 actionDataHash, address indexed attestedBy);
    event Executed(uint256 indexed proposalId, address indexed target, bytes result);

    constructor(address _governancePublisher, address _relayer) Ownable(msg.sender) {
        require(_governancePublisher != address(0), "publisher=0");
        governancePublisher = IGovernanceRootPublisher(_governancePublisher);
        relayer = _relayer;
    }

    /// @notice Owner can update the relayer address
    function setRelayer(address _relayer) external onlyOwner {
        emit RelayerUpdated(relayer, _relayer);
        relayer = _relayer;
    }

    /// @notice Owner can update the governance publisher address (emergency/admin)
    function setGovernancePublisher(address _publisher) external onlyOwner {
        require(_publisher != address(0), "publisher=0");
        emit GovernancePublisherUpdated(address(governancePublisher), _publisher);
        governancePublisher = IGovernanceRootPublisher(_publisher);
    }

    /// @notice Called by the relayer after observing ProposalPassed on the verifier chain.
    /// @param proposalId Proposal identifier.
    /// @param actionDataHash The actionDataHash observed in the ProposalPassed event (for safety/consistency).
    function markProposalPassed(uint256 proposalId, bytes32 actionDataHash) external {
        require(msg.sender == relayer, "only relayer");
        require(!attestedPassed[proposalId], "already attested");

        // Optionally, sanity-check: the stored actionDataHash in GovernanceRootPublisher should match provided hash.
        // We call governancePublisher.getProposalCore, which reverts if proposal not published.
        (, bytes32 storedHash, , , , , ) = governancePublisher.getProposalCore(proposalId);
        require(storedHash == actionDataHash, "actionDataHash mismatch with publisher");

        attestedPassed[proposalId] = true;
        emit ProposalAttested(proposalId, actionDataHash, msg.sender);
    }

    /// @notice Execute the action if the proposal was attested as passed and actionData matches the committed hash.
    /// @param proposalId Proposal identifier
    /// @param actionData abi.encode(address target, bytes data)
    function executeIfAuthorized(uint256 proposalId, bytes calldata actionData) external nonReentrant returns (bytes memory) {
        require(attestedPassed[proposalId], "proposal not attested as passed");
        require(!executed[proposalId], "already executed");

        // Fetch committed action data hash from publisher
        (, bytes32 storedHash, , , , , ) = governancePublisher.getProposalCore(proposalId);
        bytes32 providedHash = keccak256(actionData);
        require(storedHash == providedHash, "actionData hash mismatch");

        // Decode actionData: (address target, bytes data)
        (address target, bytes memory data) = abi.decode(actionData, (address, bytes));

        require(target != address(0), "invalid target");

        // Execute low-level call
        (bool ok, bytes memory result) = target.call(data);
        require(ok, "execution failed");

        executed[proposalId] = true;

        emit Executed(proposalId, target, result);
        return result;
    }

    /// @notice Emergency: owner can mark executed or attested flags (only for admin/testing).
    function adminSetAttested(uint256 proposalId, bool val) external onlyOwner {
        attestedPassed[proposalId] = val;
    }

    function adminSetExecuted(uint256 proposalId, bool val) external onlyOwner {
        executed[proposalId] = val;
    }
}
