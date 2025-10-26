import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

const WAD = ethers.parseEther("1"); // BigInt 1e18

// --- Helper: Merkle tree builder compatible with OpenZeppelin's MerkleProof (sorted pairs) ---
function keccak256Bytes(data) {
    return ethers.keccak256(data);
}

function hashPacked(address, power, nonce) {
    // abi.encodePacked(address,uint256,uint256)
    const packed = ethers.solidityPacked(
        ["address", "uint256", "uint256"],
        [address, power.toString(), nonce.toString()]
    );
    return keccak256Bytes(packed);
}

// sort pair as OpenZeppelin's _hashPair does: keccak256(a < b ? a|b : b|a)
function hashPair(a, b) {
    // a, b are hex strings (0x...)
    if (a === b) {
        return keccak256Bytes(ethers.concat([a, b]));
    }
    const aBytes = ethers.getBytes(a);
    const bBytes = ethers.getBytes(b);
    for (let i = 0; i < Math.min(aBytes.length, bBytes.length); i++) {
        if (aBytes[i] < bBytes[i]) {
            return keccak256Bytes(ethers.concat([a, b]));
        } else if (aBytes[i] > bBytes[i]) {
            return keccak256Bytes(ethers.concat([b, a]));
        }
    }
    return keccak256Bytes(ethers.concat([a, b]));
}

// Build merkle tree layers and return {root, layers}, where layers[0] = leaves
function buildMerkleTree(leaves) {
    if (leaves.length === 0) {
        return { root: ethers.HashZero, layers: [leaves] };
    }
    let layers = [];
    layers.push(leaves);

    while (layers[layers.length - 1].length > 1) {
        const cur = layers[layers.length - 1];
        const next = [];
        for (let i = 0; i < cur.length; i += 2) {
            if (i + 1 === cur.length) {
                // duplicate last element (common)
                next.push(hashPair(cur[i], cur[i]));
            } else {
                next.push(hashPair(cur[i], cur[i + 1]));
            }
        }
        layers.push(next);
    }
    const root = layers[layers.length - 1][0];
    return { root, layers };
}

// generate proof for leafIndex given layers as above
function getProofForIndex(layers, index) {
    const proof = [];
    let idx = index;
    for (let i = 0; i < layers.length - 1; i++) {
        const layer = layers[i];
        const pairIndex = idx ^ 1; // sibling
        if (pairIndex < layer.length) {
            proof.push(layer[pairIndex]);
        } else {
            proof.push(layer[idx]);
        }
        idx = Math.floor(idx / 2);
    }
    return proof;
}
// --- End helpers ---

describe("Governance end-to-end flow ", function () {
    let deployer, alice, bob, relayer;
    let MockERC20, Vault, Publisher, Verifier, Executor;
    let mockAsset, vault, publisher, verifier, executor;
    let deployerAddr, aliceAddr, bobAddr, relayerAddr;

    beforeEach(async function () {
        [deployer, alice, bob, relayer] = await ethers.getSigners();
        deployerAddr = await deployer.getAddress();
        aliceAddr = await alice.getAddress();
        bobAddr = await bob.getAddress();
        relayerAddr = await relayer.getAddress();

        // Deploy MockERC20
        MockERC20 = await ethers.getContractFactory("MockERC20");
        mockAsset = await MockERC20.deploy("Mock Asset", "MCK");
        await mockAsset.waitForDeployment();

        // Mint tokens (parseEther returns BigInt)
        await mockAsset.mint(deployerAddr, ethers.parseEther("1000000"));
        await mockAsset.mint(aliceAddr, ethers.parseEther("10000"));
        await mockAsset.mint(bobAddr, ethers.parseEther("10000"));

        // Deploy Vault with 1 day unbonding period
        Vault = await ethers.getContractFactory("LiquidStakingVault");
        vault = await Vault.deploy(await mockAsset.getAddress(), "LST Shares", "LSTS", 86400);
        await vault.waitForDeployment();

        // Deploy GovernanceRootPublisher
        Publisher = await ethers.getContractFactory("GovernanceRootPublisher");
        publisher = await Publisher.deploy();
        await publisher.waitForDeployment();

        // Deploy VoteVerifier (needs chainId)
        //TODO: is VoteVerifier is getting deployed to different chain than other contracts?
        const net = await ethers.provider.getNetwork();
        console.log("Deploying VoteVerifier to chainId", net.chainId);
        
        Verifier = await ethers.getContractFactory("VoteVerifier");
        verifier = await Verifier.deploy(net.chainId);
        await verifier.waitForDeployment();

        // Deploy GovernanceExecutor with publisher address and relayer initial
        Executor = await ethers.getContractFactory("GovernanceExecutor");
        executor = await Executor.deploy(await publisher.getAddress(), relayerAddr);
        await executor.waitForDeployment();

        // Set governanceExecutor in vault
        await vault.connect(deployer).setGovernanceExecutor(await executor.getAddress());

    });

    it("full flow: publish -> off-chain votes -> verify -> relay -> execute", async function () {
        // Alice approves and deposits 2000 ASSET into vault
        const depositAlice = ethers.parseEther("2000");
        await mockAsset.connect(alice).approve(await vault.getAddress(), depositAlice);
        await vault.connect(alice).deposit(depositAlice);

        // Confirm Bob's balance (already minted)
        expect(await mockAsset.balanceOf(bobAddr)).to.equal(ethers.parseEther("10000"));

        // Distribute reward to increase ER (deployer gives 1000 tokens to vault)
        const reward = ethers.parseEther("1000");
        await mockAsset.connect(deployer).approve(await vault.getAddress(), reward);
        await vault.connect(deployer).distributeRewards(reward);

        // Snapshot block
        const snapshotBlock = await ethers.provider.getBlockNumber();

        // Read ER_snapshot at snapshotBlock (call override)
        const ER_snapshot = await vault.exchangeRate({ blockTag: snapshotBlock });

        // Voters
        const voters = [aliceAddr, bobAddr];
        const nonces = [0, 0];
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const proposalId = 123;

        // Get balances at snapshot block (returns BigInt)
        const balancesAtSnapshot = [];
        const sharesAtSnapshot = [];
        for (const v of voters) {
            const b = await mockAsset.balanceOf(v, { blockTag: snapshotBlock });
            balancesAtSnapshot.push(b);
            const s = await vault.balanceOf(v, { blockTag: snapshotBlock });
            sharesAtSnapshot.push(s);
        }

        // Compute powers (BigInt arithmetic): asset + floor(shares * ER_snapshot / WAD)
        const powers = [];
        for (let i = 0; i < voters.length; i++) {
            const assetBal = balancesAtSnapshot[i]; // BigInt
            const shareBal = sharesAtSnapshot[i]; // BigInt
            const lstEquivalent = (shareBal * ER_snapshot) / WAD; // BigInt
            const power = assetBal + lstEquivalent;
            powers.push(power);
        }

        // Build leaves (hex strings)
        const leaves = [];
        for (let i = 0; i < voters.length; i++) {
            const leaf = hashPacked(voters[i], powers[i], nonces[i]);
            leaves.push(leaf);
        }

        const { root: powerRoot, layers } = buildMerkleTree(leaves);

        // Publish proposal on Chain A (action: vault.setUnbondingPeriod(2 days))
        const newUnbonding = 2 * 86400;
        const ifaceVault = new ethers.Interface(["function setUnbondingPeriod(uint256)"]);
        const vaultCalldata = ifaceVault.encodeFunctionData("setUnbondingPeriod", [newUnbonding]);
        const abiCoder = new ethers.AbiCoder();

        const actionData = abiCoder.encode(
            ["address", "bytes"],
            [await vault.getAddress(), vaultCalldata]
        );
        const actionDataHash = ethers.keccak256(actionData);

        await expect(
            publisher.connect(deployer).publishProposal(
                proposalId,
                actionDataHash,
                snapshotBlock,
                ER_snapshot,
                powerRoot,
                "ipfs://proposal-meta"
            )
        ).to.emit(publisher, "ProposalCreated");

        // Register proposal on Chain B (VoteVerifier)
        const totalPower = powers[0] + powers[1];
        const threshold = totalPower / 2n;
        await expect(
            verifier.connect(deployer).registerProposal(proposalId, powerRoot, actionDataHash, threshold)
        ).to.emit(verifier, "ProposalRegistered");

        // EIP-712 domain and types
        const network = await ethers.provider.getNetwork();
        const domain = {
            name: "LST Governance",
            version: "1",
            chainId: network.chainId,
            verifyingContract: await verifier.getAddress()
        };

        const types = {
            Vote: [
                { name: "proposalId", type: "uint256" },
                { name: "support", type: "uint8" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" }
            ]
        };

        // Prepare votes: both alice and bob vote FOR (support = 1)
        const supports = [1, 1];
        const noncesArr = nonces;
        const deadlinesArr = [deadline, deadline];

        // Sign messages off-chain with each voter
        const signatures = [];
        for (let i = 0; i < voters.length; i++) {
            const signer = i === 0 ? alice : bob;
            const value = {
                proposalId: proposalId,
                support: supports[i],
                nonce: noncesArr[i],
                deadline: deadlinesArr[i]
            };
            const sig = await signer.signTypedData(domain, types, value);
            signatures.push(sig);
        }

        // Build Merkle proofs for each voter
        const proofs = [];
        for (let i = 0; i < voters.length; i++) {
            const proof = getProofForIndex(layers, i);
            proofs.push(proof);
        }

        const voteDatas = [];
        for (let i = 0; i < voters.length; i++) {
            voteDatas.push({
                support: supports[i],
                nonce: noncesArr[i],
                deadline: deadlinesArr[i],
                power: powers[i],            // BigInt (or BigNumber) is fine for ethers v6
                signature: signatures[i],    // hex string
                merkleProof: proofs[i]       // array of hex32 strings
            });
        }

        // Submit votes to verifier
        await expect(
            verifier.connect(deployer).submitVotes(proposalId, voteDatas)
        ).to.emit(verifier, "ProposalPassed");

        // Confirm proposal is passed
        const passed = await verifier.isPassed(proposalId);
        expect(passed).to.equal(true);

        // Relay: relayer marks proposal passed on chain A
        await expect(executor.connect(relayer).markProposalPassed(proposalId, actionDataHash)).to.emit(
            executor,
            "ProposalAttested"
        );

        // Execute
        await expect(executor.connect(deployer).executeIfAuthorized(proposalId, actionData)).to.emit(
            executor,
            "Executed"
        );

        // Verify that vault unbondingPeriod updated
        const unbondingNow = await vault.unbondingPeriod();
        expect(unbondingNow).to.equal(BigInt(newUnbonding)); // contract returns BigInt
    });
});
