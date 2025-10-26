// scripts/demo.js
// Demo script that deploys on two local Hardhat nodes (ChainA @ 8545, ChainB @ 8546)
// and runs the entire flow: stake -> publish proposal -> snapshot & Merkle -> off-chain signing -> verify votes -> relay -> execute.

import fs from "fs";
import { fileURLToPath } from "url";
import path,{dirname} from "path";
import { ethers,NonceManager } from "ethers";

const WAD = ethers.parseEther("1");
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Configuration ---
const CHAIN_A_RPC = "http://127.0.0.1:8545"; // Chain A (stake chain)
const CHAIN_B_RPC = "http://127.0.0.1:8546"; // Chain B (verify chain)

// Default Hardhat mnemonic (used by local nodes) - ensures same addresses on both chains
const MNEMONIC = "test test test test test test test test test test test junk";

const NUM_USERS = 4; // number of demo users to create / use

// Helper paths to compiled artifacts (Hardhat outputs)
function artifactPath(contractName) {
  return path.join(__dirname, "..", "artifacts", "contracts", `${contractName}.sol`, `${contractName}.json`);
}

// --- Merkle helpers (same logic as tests) ---
function keccak256Bytes(hex) {
  return ethers.keccak256(hex);
}

function leafHash(address, powerBN, nonce) {
  // abi.encodePacked(address, uint256 power, uint256 nonce)
  return keccak256Bytes(
    ethers.solidityPacked(["address", "uint256", "uint256"], [address, powerBN.toString(), nonce.toString()])
  );
}

// Lexicographic pair sort (OpenZeppelin MerkleProof._hashPair behaviour)
function hashPair(a, b) {
  if (a === b) {
    return keccak256Bytes(ethers.concat([a, b]));
  }
  const aBytes = ethers.getBytes(a);
  const bBytes = ethers.getBytes(b);
  const len = Math.min(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    if (aBytes[i] < bBytes[i]) {
      return keccak256Bytes(ethers.concat([a, b]));
    } else if (aBytes[i] > bBytes[i]) {
      return keccak256Bytes(ethers.concat([b, a]));
    }
  }
  return keccak256Bytes(ethers.concat([a, b]));
}

function buildMerkleTree(leaves) {
  if (leaves.length === 0) return { root: ethers.ZeroHash, layers: [leaves] };
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 === cur.length) {
        next.push(hashPair(cur[i], cur[i]));
      } else {
        next.push(hashPair(cur[i], cur[i + 1]));
      }
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], layers };
}

function getProof(layers, index) {
  const proof = [];
  let idx = index;
  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i];
    const pairIndex = idx ^ 1;
    if (pairIndex < layer.length) proof.push(layer[pairIndex]);
    else proof.push(layer[idx]); // duplicated sibling
    idx = Math.floor(idx / 2);
  }
  return proof;
}

// --- Main flow ---
async function main() {
  console.log("\n--- demo.js starting ---\n");

  // Connect to providers for both chains
  const providerA = new ethers.JsonRpcProvider(CHAIN_A_RPC);
  const providerB = new ethers.JsonRpcProvider(CHAIN_B_RPC);

  const networkA = await providerA.getNetwork();
  const networkB = await providerB.getNetwork();
  console.log(`Connected: ChainA chainId=${networkA.chainId}n, ChainB chainId=${networkB.chainId}n`);

  // Create wallets from mnemonic: keep same set of addresses for both chains
  const wallets = [];
  for (let i = 0; i < NUM_USERS; i++) {
    const wallet = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
    wallets.push({
      index: i,
      address: wallet.address,
      walletA: new NonceManager(wallet.connect(providerA)),
      walletB: new NonceManager(wallet.connect(providerB)),
    });
  }

  // Also set deployer and relayer as wallets[0] and wallets[1] (for demo)
  const deployer = wallets[0];
  const relayer = wallets[1];

  console.log("Demo accounts:");
  wallets.forEach(w => console.log(`  [${w.index}] ${w.address}`));
  console.log("");

  // Load artifacts
  const MockERC20Artifact = JSON.parse(fs.readFileSync(artifactPath("MockERC20")));
  const VaultArtifact = JSON.parse(fs.readFileSync(artifactPath("LiquidStakingVault")));
  const PublisherArtifact = JSON.parse(fs.readFileSync(artifactPath("GovernanceRootPublisher")));
  const VerifierArtifact = JSON.parse(fs.readFileSync(artifactPath("VoteVerifier")));
  const ExecutorArtifact = JSON.parse(fs.readFileSync(artifactPath("GovernanceExecutor")));

  // Deploy contracts on Chain A: MockERC20, Vault, Publisher, Executor
  console.log("Deploying contracts on Chain A (stake chain)...");
  const MockFactory = new ethers.ContractFactory(MockERC20Artifact.abi, MockERC20Artifact.bytecode, deployer.walletA);
  const mockAsset = await MockFactory.deploy("Mock Asset", "MCK");
  await mockAsset.waitForDeployment();
  console.log("  MockERC20:", await mockAsset.getAddress());

  // Mint some tokens to users on Chain A
  const mintAmount = ethers.parseEther("10000");
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const tx = await mockAsset.connect(deployer.walletA).mint(w.address, mintAmount);
    await tx.wait(); // ensure nonce increments before next send

  }
  console.log("  Minted tokens to demo users on Chain A");

  // Deploy Vault
  const VaultFactory = new ethers.ContractFactory(VaultArtifact.abi, VaultArtifact.bytecode, deployer.walletA);
  const UNBONDING_PERIOD = 86400; // 1 day
  const vault = await VaultFactory.deploy(await mockAsset.getAddress(), "LST Shares", "LSTS", UNBONDING_PERIOD);
  await vault.waitForDeployment();
  console.log("  LiquidStakingVault:", await vault.getAddress());

  // Deploy GovernanceRootPublisher
  const PubFactory = new ethers.ContractFactory(PublisherArtifact.abi, PublisherArtifact.bytecode, deployer.walletA);
  const publisher = await PubFactory.deploy();
  await publisher.waitForDeployment();
  console.log("  GovernanceRootPublisher:", await publisher.getAddress());

  // Deploy GovernanceExecutor with relayer address
  const ExecFactory = new ethers.ContractFactory(ExecutorArtifact.abi, ExecutorArtifact.bytecode, deployer.walletA);
  const executor = await ExecFactory.deploy(await publisher.getAddress(), relayer.address);
  await executor.waitForDeployment();
  console.log("  GovernanceExecutor:", await executor.getAddress());

  // Set governanceExecutor in vault
  await vault.connect(deployer.walletA).setGovernanceExecutor(await executor.getAddress());

  // Deploy VoteVerifier on Chain B
  console.log("\nDeploying VoteVerifier on Chain B (verify chain)...");
  const VerifierFactory = new ethers.ContractFactory(VerifierArtifact.abi, VerifierArtifact.bytecode, deployer.walletB);
  const verifier = await VerifierFactory.deploy(networkB.chainId);
  await verifier.waitForDeployment();
  console.log("  VoteVerifier:", await verifier.getAddress());

  console.log("\n--- staking step ---");
  // Users approve and deposit stakes into the Vault (on Chain A)
  const depositAmount = ethers.parseEther("1000");
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    console.log(`  User[${i}] approving & depositing ${ethers.formatEther(depositAmount)} tokens`);
    await mockAsset.connect(w.walletA).approve(await vault.getAddress(), depositAmount);
    const tx = await vault.connect(w.walletA).deposit(depositAmount);
    await tx.wait();
  }
  console.log("  All users deposited into LST.");

  // Give Vault some rewards to appreciate LST
  const reward = ethers.parseEther("2000");
  await mockAsset.connect(deployer.walletA).approve(await vault.getAddress(), reward);
  await vault.connect(deployer.walletA).distributeRewards(reward);
  console.log("  Distributed rewards to vault to cause LST appreciation.");

  // Snapshot: read block number and exchange rate at that block
  const snapshotBlock = await providerA.getBlockNumber();
  const ER_snapshot = await vault.exchangeRate({ blockTag: snapshotBlock });

  console.log("");
  console.log("Snapshot taken:");
  console.log(`  snapshotBlock = ${snapshotBlock}`);
  console.log(`  ER_snapshot (wad) = ${ER_snapshot.toString()}`);
  console.log("");

  // Compute voting power for each user at snapshot: ASSET_balance + floor(LST_shares * ER_snapshot / 1e18)
  console.log("--- computing voting powers and building Merkle tree ---");
  const voters = wallets.map(w => w.address);
  const nonces = Array(voters.length).fill(0);
  const leaves = [];
  const powers = [];
  for (let i = 0; i < voters.length; i++) {
    const addr = voters[i];
    // Read balances at snapshot block
    const assetBal = await mockAsset.balanceOf(addr, { blockTag: snapshotBlock }); // bigint
    const sharesBal = await vault.balanceOf(addr, { blockTag: snapshotBlock });    // bigint

    // LST equivalent assets = floor(sharesBal * ER_snapshot / 1e18)
    const lstEquivalent = (sharesBal * ER_snapshot) / WAD;
    const power = assetBal + lstEquivalent;
    powers.push(power);
    const leaf = leafHash(addr, power, 0);
    leaves.push(leaf);

    console.log(
      `  voter ${i} ${addr} -> assetBal=${ethers.formatEther(assetBal)}, shares=${ethers.formatEther(
        sharesBal
      )}, lstEq=${ethers.formatEther(lstEquivalent)}, power=${ethers.formatEther(power)}`
    );
  }

  const { root: powerRoot, layers } = buildMerkleTree(leaves);
  console.log("\n  Built Merkle root for snapshot (powerRoot):", powerRoot);

  // Prepare proposal: update unbonding period to 2 days
  const newUnbonding = 2 * 86400; // 2 days
  const vaultIface = new ethers.Interface(["function setUnbondingPeriod(uint256)"]);
  const vaultCalldata = vaultIface.encodeFunctionData("setUnbondingPeriod", [newUnbonding]);

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actionData = coder.encode(["address", "bytes"], [await vault.getAddress(), vaultCalldata]);
  const actionDataHash = ethers.keccak256(actionData);
  const proposalId = 777n;

  console.log("\nPublishing proposal on Chain A (GovernanceRootPublisher)...");
  // publishProposal(proposalId, actionDataHash, snapshotBlock, ER_snapshot, powerRoot, metadata)
  const pubTx = await publisher
    .connect(deployer.walletA)
    .publishProposal(proposalId, actionDataHash, snapshotBlock, ER_snapshot, powerRoot, "ipfs://demo-proposal");
  await pubTx.wait();
  console.log("  Proposal published (id:", proposalId.toString(), ") actionDataHash:", actionDataHash);

  // Register proposal on Chain B (VoteVerifier) with threshold small enough to pass with all votes (sum/2)
  console.log("\nRegistering proposal on Chain B (VoteVerifier)...");
  const totalPower = powers.reduce((acc, p) => acc + p, 0n);
  const threshold = totalPower / 2n;
  await (await verifier.connect(deployer.walletB).registerProposal(proposalId, powerRoot, actionDataHash, threshold)).wait();
  console.log("  Registered on verifier with threshold:", ethers.formatEther(threshold));

  // Off-chain signing: EIP-712 Vote typed data with domain (verifier contract, chainId)
  console.log("\nCollecting EIP-712 signatures off-chain (simulated)...");
  const networkB2 = await providerB.getNetwork();
  const domain = {
    name: "LST Governance",
    version: "1",
    chainId: Number(networkB2.chainId),
    verifyingContract: await verifier.getAddress(),
  };
  const types = {
    Vote: [
      { name: "proposalId", type: "uint256" },
      { name: "support", type: "uint8" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  // Both/All users vote FOR (1)
  const supports = [];
  const noncesArr = [];
  const deadlines = [];
  const sigs = [];
  const proofList = [];

  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

  for (let i = 0; i < wallets.length; i++) {
    supports.push(1);
    noncesArr.push(0);
    deadlines.push(deadline);

    const signerWallet = wallets[i].walletB;
    const value = {
      proposalId, // bigint OK
      support: 1,
      nonce: 0,
      deadline,
    };
    const signature = await signerWallet.signTypedData(domain, types, value);
    sigs.push(signature);

    // Build proof for this leaf
    const proof = getProof(layers, i);
    proofList.push(proof);
  }

   const voteDatas = [];
        for (let i = 0; i < wallets.length; i++) {
            voteDatas.push({
                support: supports[i],
                nonce: noncesArr[i],
                deadline: deadlines[i],
                power: powers[i],            // BigInt (or BigNumber) is fine for ethers v6
                signature: sigs[i],    // hex string
                merkleProof: proofList[i]       // array of hex32 strings
            });
        }

  console.log("  Collected signatures and proofs for votes.");

  // Submit votes to VoteVerifier on Chain B
  console.log("\nSubmitting votes to VoteVerifier (Chain B)...");
  const submitTx = await verifier.connect(deployer.walletB).submitVotes(
    proposalId,
    voteDatas
  );
  const submitR = await submitTx.wait();
  console.log("  submitVotes transaction mined. Gas used:", submitR.gasUsed.toString());

  // Check proposal passed
  const passed = await verifier.isPassed(proposalId);
  console.log("  Proposal passed on Chain B?:", passed);
  if (!passed) {
    console.log("  Something went wrong: proposal not passed. Exiting.");
    process.exit(1);
  }

  // Relay: relayer observes ProposalPassed event (simulated here) and calls executor.markProposalPassed on Chain A
  console.log("\nRelaying ProposalPassed -> markProposalPassed on Chain A by relayer:", relayer.address);
  await (await executor.connect(relayer.walletA).markProposalPassed(proposalId, actionDataHash)).wait();
  console.log("  markProposalPassed called.");

  // Execute authorized action on Chain A: executor.executeIfAuthorized(proposalId, actionData)
  console.log("\nExecuting authorized action on Chain A via GovernanceExecutor...");
  const execTx = await executor.connect(deployer.walletA).executeIfAuthorized(proposalId, actionData);
  const execR = await execTx.wait();
  console.log("  executeIfAuthorized mined. Gas:", execR.gasUsed.toString());

  // Confirm the vault's unbonding period changed
  const newUnbondingValue = await vault.unbondingPeriod();
  console.log("\nFinal check: vault.unbondingPeriod =", newUnbondingValue.toString(), "(expected", newUnbonding, ")");
  if (newUnbondingValue.toString() === newUnbonding.toString()) {
    console.log("\nSUCCESS: End-to-end governance flow completed and executed on Chain A.");
  } else {
    console.log("\nERROR: final unbonding period did not update correctly.");
  }

  console.log("\n--- demo.js finished ---\n");
}

// Run script
main().catch(err => {
  console.error("Demo script error:", err);
  process.exit(1);
});
