// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
VoteVerifier.sol 

✔ EIP-712 typed vote verification
✔ Merkle proof verification of (account, power, nonce) leaf
✔ Batch submission via array of VoteData structs 
✔ Emits ProposalPassed when forVotes >= threshold

Each vote struct includes:
    - support: 0 = Against, 1 = For, 2 = Abstain
    - nonce: unique value used in both leaf and EIP712 message
    - deadline: timestamp until which vote is valid
    - power: voting weight proven in the Merkle leaf
    - signature: EIP-712 signature over Vote(proposalId,support,nonce,deadline)
    - merkleProof: proof showing (account,power,nonce) is in Merkle tree rooted at powerRoot
*/

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract VoteVerifier is Ownable, ReentrancyGuard {
    using ECDSA for bytes32;

    // -------------------------------
    // EIP-712 Domain Constants
    // -------------------------------
    string public constant NAME = "LST Governance";
    string public constant VERSION = "1";
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant VOTE_TYPEHASH =
        keccak256("Vote(uint256 proposalId,uint8 support,uint256 nonce,uint256 deadline)");

    enum Support {
        Against,
        For,
        Abstain
    }

    struct ProposalInfo {
        bytes32 powerRoot; // Merkle root of (account,power,nonce)
        bytes32 actionDataHash; // keccak256(actionData)
        uint256 threshold; // forVotes threshold to consider passed
        bool exists;
        bool passed;
    }

    struct VoteData {
        uint8 support;
        uint256 nonce;
        uint256 deadline;
        uint256 power;
        bytes signature;
        bytes32[] merkleProof;
    }

    mapping(uint256 => ProposalInfo) public proposals;
    mapping(uint256 => mapping(uint8 => uint256)) public proposalVotes; // proposalId -> support -> power
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event ProposalRegistered(
        uint256 indexed proposalId,
        bytes32 powerRoot,
        bytes32 actionDataHash,
        uint256 threshold
    );
    event VoteCounted(
        uint256 indexed proposalId,
        address indexed voter,
        uint8 support,
        uint256 power
    );
    event ProposalPassed(
        uint256 indexed proposalId,
        bytes32 actionDataHash,
        uint256 forVotes,
        uint256 threshold
    );

    constructor(uint256 chainId) Ownable(msg.sender) {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                chainId,
                address(this)
            )
        );
    }

    // -----------------------------------------------------------------------
    //  Governance proposal registration
    // -----------------------------------------------------------------------

    function registerProposal(
        uint256 proposalId,
        bytes32 powerRoot,
        bytes32 actionDataHash,
        uint256 threshold
    ) external onlyOwner {
        require(proposalId != 0, "proposalId=0");
        require(powerRoot != bytes32(0), "powerRoot=0");
        require(actionDataHash != bytes32(0), "actionDataHash=0");
        ProposalInfo storage p = proposals[proposalId];
        require(!p.exists, "proposal exists");

        p.powerRoot = powerRoot;
        p.actionDataHash = actionDataHash;
        p.threshold = threshold;
        p.exists = true;
        p.passed = false;

        emit ProposalRegistered(proposalId, powerRoot, actionDataHash, threshold);
    }

    // -----------------------------------------------------------------------
    //  Vote verification and tallying
    // -----------------------------------------------------------------------

    /**
     * @notice Submit a batch of votes for a proposal.
     * @param proposalId The ID of the proposal being voted on.
     * @param votes Array of VoteData structs; each element fully describes one voter's submission.
     *
     * Each VoteData includes:
     *   - support: (0=Against, 1=For, 2=Abstain)
     *   - nonce: unique per-snapshot value matching the leaf
     *   - deadline: timestamp until which this vote is valid
     *   - power: voting weight at snapshot
     *   - signature: EIP-712 signature for Vote(proposalId,support,nonce,deadline)
     *   - merkleProof: proof showing leaf (signer,power,nonce) is in Merkle tree with root powerRoot
     */
    function submitVotes(uint256 proposalId, VoteData[] calldata votes)
        external
        nonReentrant
    {
        ProposalInfo storage p = proposals[proposalId];
        require(p.exists, "proposal not registered");
        require(!p.passed, "proposal already passed");

        uint256 len = votes.length;
        for (uint256 i = 0; i < len; ++i) {
            VoteData calldata v = votes[i];
            require(block.timestamp <= v.deadline, "vote expired");

            // Compute EIP-712 hash
            bytes32 structHash = keccak256(
                abi.encode(VOTE_TYPEHASH, proposalId, v.support, v.nonce, v.deadline)
            );
            bytes32 digest = keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
            );

            address signer = ECDSA.recover(digest, v.signature);
            require(signer != address(0), "invalid signature"); 

            // Verify Merkle proof of (signer,power,nonce)
            bytes32 leaf = keccak256(abi.encodePacked(signer, v.power, v.nonce));
            require(
                MerkleProof.verify(v.merkleProof, p.powerRoot, leaf),
                "invalid merkle proof"
            );

            require(!hasVoted[proposalId][signer], "already voted");
            hasVoted[proposalId][signer] = true;

            // Tally votes
            proposalVotes[proposalId][v.support] += v.power;
            emit VoteCounted(proposalId, signer, v.support, v.power);

            // Check threshold
            if (
                proposalVotes[proposalId][uint8(Support.For)] >= p.threshold
            ) {
                p.passed = true;
                emit ProposalPassed(
                    proposalId,
                    p.actionDataHash,
                    proposalVotes[proposalId][uint8(Support.For)],
                    p.threshold
                );
                return; // stop early once threshold reached
            }
        }
    }

    // -----------------------------------------------------------------------
    //  Views and admin helpers
    // -----------------------------------------------------------------------

    function getTally(uint256 proposalId)
        external
        view
        returns (
            uint256 forVotes,
            uint256 againstVotes,
            uint256 abstainVotes
        )
    {
        ProposalInfo storage p = proposals[proposalId];
        require(p.exists, "proposal not registered");
        forVotes = proposalVotes[proposalId][uint8(Support.For)];
        againstVotes = proposalVotes[proposalId][uint8(Support.Against)];
        abstainVotes = proposalVotes[proposalId][uint8(Support.Abstain)];
    }

    function isPassed(uint256 proposalId) external view returns (bool) {
        return proposals[proposalId].passed;
    }

    /// @notice Owner emergency helper for testing or recovery.
    function adminMarkPassed(uint256 proposalId) external onlyOwner {
        ProposalInfo storage p = proposals[proposalId];
        require(p.exists, "proposal not registered");
        require(!p.passed, "already passed");
        p.passed = true;
        emit ProposalPassed(
            proposalId,
            p.actionDataHash,
            proposalVotes[proposalId][uint8(Support.For)],
            p.threshold
        );
    }
}
