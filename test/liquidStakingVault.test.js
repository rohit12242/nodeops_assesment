import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
const WAD = ethers.parseEther("1"); // BigInt for 1e18

describe("LiquidStakingVault", function () {
  let MockERC20;
  let VaultFactory;
  let mockAsset;
  let vault;
  let owner, alice, bob, relayer;
  let vaultAddr;

  const initialSupply = ethers.parseEther("1000000"); // 1,000,000 tokens

  beforeEach(async function () {
    [owner, alice, bob, relayer] = await ethers.getSigners();

    // Deploy MockERC20
    MockERC20 = await ethers.getContractFactory("MockERC20");
    mockAsset = await MockERC20.deploy("Mock Asset", "MCK");
    await mockAsset.waitForDeployment();

    // Mint tokens to test accounts
    await mockAsset.mint(await owner.getAddress(), initialSupply);
    await mockAsset.mint(await alice.getAddress(), ethers.parseEther("10000"));
    await mockAsset.mint(await bob.getAddress(), ethers.parseEther("10000"));

    // Deploy Vault (LiquidStakingVault contract)
    VaultFactory = await ethers.getContractFactory("LiquidStakingVault");
    // set unbonding period: 1 day (86400 seconds)
    vault = await VaultFactory.deploy(await mockAsset.getAddress(), "LST Shares", "LSTS", 86400);
    await vault.waitForDeployment();

    // cache address (ethers v6 uses getAddress())
    vaultAddr = await vault.getAddress();
  });

  it("initial deposit mints shares 1:1 and exchangeRate = 1e18", async function () {
    // Alice approves and deposits 1000 tokens
    const depositAmount = ethers.parseEther("1000");
    await mockAsset.connect(alice).approve(vaultAddr, depositAmount);
    const tx = await vault.connect(alice).deposit(depositAmount);
    await tx.wait();

    // Shares minted to Alice equal deposit (initial deposit 1:1)
    const aliceShares = await vault.balanceOf(await alice.getAddress());
    expect(aliceShares).to.equal(depositAmount);

    // Exchange rate should be 1e18 (WAD)
    const er = await vault.exchangeRate();
    expect(er).to.equal(WAD);
  });

  it("distributeRewards increases exchange rate (LST appreciates)", async function () {
    // Alice deposits 1000
    const depositAmount = ethers.parseEther("1000");
    await mockAsset.connect(alice).approve(vaultAddr, depositAmount);
    await vault.connect(alice).deposit(depositAmount);

    // Check initial ER
    const er0 = await vault.exchangeRate();
    expect(er0).to.equal(WAD);

    // Owner transfers 100 reward tokens to vault and calls distributeRewards
    const reward = ethers.parseEther("100");
    await mockAsset.connect(owner).approve(vaultAddr, reward);
    await vault.connect(owner).distributeRewards(reward);



    // After rewards, exchangeRate should increase: available = 1000 + 100 = 1100
    // ER = available * WAD / totalShares = 1100 * WAD / 1000 = 1.1 * WAD
    const er1 = await vault.exchangeRate();

    // Expected ER using BigInt arithmetic
    const expected = (1100n * WAD) / 1000n;
    expect(er1).to.equal(expected);

    // sharesToAssets for 1 share should increase:
    const one = 1n;
    const assetsFor1Share = await vault.sharesToAssets(one); // returns BigInt
    const expectedAssetsFor1Share = (one * expected) / WAD;
    expect(assetsFor1Share).to.equal(expectedAssetsFor1Share);
  });

  it("initiateWithdraw locks assets and claim works after unbondingPeriod", async function () {
    // Alice deposits 1000
    const depositAmount = ethers.parseEther("1000");
    await mockAsset.connect(alice).approve(vaultAddr, depositAmount);
    await vault.connect(alice).deposit(depositAmount);

    // Distribute some rewards so ER > 1
    const reward = ethers.parseEther("100");
    await mockAsset.connect(owner).approve(vaultAddr, reward);
    await vault.connect(owner).distributeRewards(reward);

    // Verify available assets and lockedAssets before withdraw
    const totalAssetBalanceBefore = await mockAsset.balanceOf(vaultAddr);
    const lockedBefore = await vault.lockedAssets();
    expect(lockedBefore).to.equal(0n);

    // Alice initiates withdraw of 500 shares
    const sharesToBurn = ethers.parseEther("500");
    const tx = await vault.connect(alice).initiateWithdraw(sharesToBurn);
    const rcpt = await tx.wait();

    // Parse logs to find InitiatedWithdraw event 
    let initiatedLog = null;
    for (const log of rcpt.logs) {
      try {
        const parsed = vault.interface.parseLog(log);
        if (parsed.name === "InitiatedWithdraw") {
          initiatedLog = parsed;
          break;
        }
      } catch (e) {
        
      }
    }
    expect(initiatedLog).to.not.be.null;
    // event args depend on contract; adapt indexing if names differ
    // Example: (owner, receiver, assetsOwed, withdrawalId, availableAt)
    const args = initiatedLog.args;
    const assetsOwed = args.assetsOwed ?? args[2];
    const withdrawalId = args.withdrawalId ?? args[3];
    const availableAt = args.availableAt ?? args[4];

    // lockedAssets should have increased by assetsOwed
    const lockedAfter = await vault.lockedAssets();
    expect(lockedAfter).to.equal(assetsOwed);

    // Attempt to claim immediately should revert (not yet matured)
    await expect(vault.connect(alice).claim(withdrawalId)).to.be.revertedWith("not yet available");

    // Fast-forward time beyond unbondingPeriod
    const unbonding = Number(await vault.unbondingPeriod());
    await ethers.provider.send("evm_increaseTime", [unbonding + 10]);
    await ethers.provider.send("evm_mine");

    // Claim should succeed
    await vault.connect(alice).claim(withdrawalId);

    // After claim, lockedAssets should decrease accordingly (expect 0)
    const lockedFinal = await vault.lockedAssets();
    expect(lockedFinal).to.equal(0n);
  });

  it("share token value increases over time as rewards are distributed (monotonic appreciation)", async function () {
    // Alice deposits 1000
    const depositAmount = ethers.parseEther("100");
    await mockAsset.connect(alice).approve(vaultAddr, depositAmount);
    await vault.connect(alice).deposit(depositAmount);

    // Record assets per share for 1 share initially
    const initialAssetsPerShare = await vault.sharesToAssets(1n);


    // Do repeated reward distributions and ensure assetsPerShare increases each time
    let prev = initialAssetsPerShare;

    // We'll do 5 reward rounds; reward will be 10 tokens each time
    for (let i = 0; i < 5; i++) {
      const reward = ethers.parseEther("100");
      await mockAsset.connect(owner).approve(vaultAddr, reward);
      await vault.connect(owner).distributeRewards(reward);

      const current = await vault.sharesToAssets(1n);
      
      // current must be >= prev (monotonic non-decreasing)
      expect(current >= prev).to.be.true;

      // Strictly greater after any positive reward distribution
      expect(current > prev).to.be.true;

      prev = current;
    }

    // As a sanity check, final assets per share should be > initial
    expect(prev > initialAssetsPerShare).to.be.true;
  });

  it("sharesToAssets floors fractional values correctly", async function () {
    // Alice deposits 1000
    const depositAmount = ethers.parseEther("1000");
    await mockAsset.connect(alice).approve(vaultAddr, depositAmount);
    await vault.connect(alice).deposit(depositAmount);

    // Owner distributes 234 reward -> totalAssets = 1234, totalShares = 1000 => ER = 1.234
    const reward = ethers.parseEther("234");
    await mockAsset.connect(owner).approve(vaultAddr, reward);
    await vault.connect(owner).distributeRewards(reward);

    // Compute expected ER in wad
    const totalAssets = 1234n * 10n ** 18n; // 1234 * 1e18 (representational)
    // Instead of constructing totalAssets this way, reuse on-chain ER read
    const er = await vault.exchangeRate(); // BigInt

    // Choose shares = 3 -> true value = 3 * 1.234 = 3.702 -> floor => 3
    const shares = 3n;
    const assetsOwed = await vault.sharesToAssets(shares);

    // expectedAssets = floor(shares * er / WAD)
    const expectedAssets = (shares * er) / WAD;
    expect(assetsOwed).to.equal(expectedAssets);
    
  });
});
