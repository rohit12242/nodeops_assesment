// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title GovernanceRootPublisher
/// @notice Publishes governance proposals on Chain A by storing:
///  - actionDataHash (keccak256 of the actionData to be executed later)
///  - snapshotBlock (block number used to sample balances)
///  - ER_snapshot  (exchange rate at snapshot, WAD scaled = 1e18)
///  - powerRoot    (Merkle root containing per-account voting power for snapshot)
///  -  metadata ()


contract GovernanceRootPublisher{

    enum ProposalState { Unknown, Published }

    struct Proposal {
        address proposer;      // who published
        bytes32 actionDataHash; // keccak256(actionData)
        uint256 snapshotBlock; // block number for snapshot
        uint256 ER_snapshot;   // exchange rate at snapshot (WAD-scaled)
        bytes32 powerRoot;     // merkle root of (account, power, nonce) leaves
        string metadata;       // optional IPFS/metadata URI
        uint256 createdAt;     // timestamp of publish
        ProposalState state;
    }

    /// @notice proposalId => Proposal
    mapping(uint256 => Proposal) public proposals;

    /// @notice Emitted when a proposal is published and frozen on-chain.
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        bytes32 indexed actionDataHash,
        uint256 snapshotBlock,
        uint256 ER_snapshot,
        bytes32 powerRoot,
        string metadata,
        uint256 createdAt
    );

    /// @notice Emitted when proposer updates metadata (non critical)
    event ProposalMetadataUpdated(uint256 indexed proposalId, string metadata);

    constructor() {}

    /// @notice Publish (freeze) a proposal.
    /// @param proposalId Unique ID for the proposal (must not be used before).
    /// @param actionDataHash keccak256(actionData) - commitment to the execution payload
    /// @param snapshotBlock Block number at which balances were sampled for the Merkle leaves
    /// @param ER_snapshot Exchange rate at snapshot (WAD scaled, 1e18). Caller should read from vault at snapshot (off-chain).
    /// @param powerRoot Merkle root of (account, uint256 power, uint256 nonce) leaves representing voting power.
    /// @param metadata Optional metadata URI (IPFS link or JSON).
    function publishProposal(
        uint256 proposalId,
        bytes32 actionDataHash,
        uint256 snapshotBlock,
        uint256 ER_snapshot,
        bytes32 powerRoot,
        string calldata metadata
    ) external {
        require(proposalId != 0, "proposalId=0");
        require(actionDataHash != bytes32(0), "actionDataHash=0");
        require(powerRoot != bytes32(0), "powerRoot=0");
        // snapshotBlock should reference a real block (allow equal to current block, or past block)
        require(snapshotBlock <= block.number, "snapshotBlock must be <= current block");

        Proposal storage p = proposals[proposalId];
        require(p.state == ProposalState.Unknown, "proposal exists");

        p.proposer = msg.sender;
        p.actionDataHash = actionDataHash;
        p.snapshotBlock = snapshotBlock;
        p.ER_snapshot = ER_snapshot; // expected to be WAD scaled (1e18)
        p.powerRoot = powerRoot;
        p.metadata = metadata;
        p.createdAt = block.timestamp;
        p.state = ProposalState.Published;

        emit ProposalCreated(
            proposalId,
            msg.sender,
            actionDataHash,
            snapshotBlock,
            ER_snapshot,
            powerRoot,
            metadata,
            block.timestamp
        );
    }

    /// @notice Returns whether a proposal is published.
    function isPublished(uint256 proposalId) external view returns (bool) {
        return proposals[proposalId].state == ProposalState.Published;
    }

    /// @notice Getter for core proposal fields.
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
        )
    {
        Proposal storage p = proposals[proposalId];
        require(p.state == ProposalState.Published, "proposal not published");
        return (
            p.proposer,
            p.actionDataHash,
            p.snapshotBlock,
            p.ER_snapshot,
            p.powerRoot,
            p.metadata,
            p.createdAt
        );
    }

    /// @notice Allow the proposer to update non-critical metadata (e.g., point to IPFS JSON).
    /// Does not allow changing snapshot/ER/action hash/power root.
    function updateMetadata(uint256 proposalId, string calldata metadata) external {
        Proposal storage p = proposals[proposalId];
        require(p.state == ProposalState.Published, "proposal not published");
        require(p.proposer == msg.sender, "only proposer");
        p.metadata = metadata;
        emit ProposalMetadataUpdated(proposalId, metadata);
    }

}
