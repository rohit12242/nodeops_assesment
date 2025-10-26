// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
LiquidStakingVault.sol

Features:
- ERC20 shares token (no rebasing). Shares represent claim on underlying assets.
- exchangeRate = (totalAssetsAvailable * WAD) / totalShares  (WAD = 1e18)
- deposit: user transfers underlying asset -> mints shares
- mint: user supplies shares -> receives assets (optional; not implemented separately to avoid confusion)
- distributeRewards: pushes assets into vault (increases exchange rate)
- initiateWithdraw: burns shares, computes assetsOwed (floor), mints Withdrawal NFT with availableAt = now + unbondingPeriod
- claim: after availableAt, owner claims assetsOwed, NFT burned
- lockedAssets tracks assets reserved for pending withdrawals (excluded from exchangeRate)
*/

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract LiquidStakingVault is ERC20, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // Underlying asset (staked token)
    IERC20 public immutable asset;

    // WAD fixed point scaling for exchange rate calculations
    uint256 public constant WAD = 1e18;

    // Assets that have been reserved for pending withdrawals (not part of exchange rate)
    uint256 public lockedAssets;

    // Unbonding period (seconds) for withdrawals
    uint256 public unbondingPeriod;

    // Withdrawal NFT contract
    WithdrawalNFT public withdrawalNFT;

    address public governanceExecutor;

    // Events
    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event DistributedRewards(address indexed by, uint256 assets);
    event InitiatedWithdraw(address indexed user, uint256 sharesBurned, uint256 assetsOwed, uint256 withdrawalId, uint256 availableAt);
    event Claimed(address indexed user, uint256 withdrawalId, uint256 assetsPaid);
    event UnbondingPeriodUpdated(uint256 oldPeriod, uint256 newPeriod);

    constructor(
        address _asset,
        string memory _sharesName,
        string memory _sharesSymbol,
        uint256 _unbondingPeriod
    ) ERC20(_sharesName, _sharesSymbol) Ownable(msg.sender){
        require(_asset != address(0), "asset=0");
        asset = IERC20(_asset);
        unbondingPeriod = _unbondingPeriod;
        withdrawalNFT = new WithdrawalNFT("LST-Withdraw", "LSTW");
    }

    modifier onlyGovernanceExecutor() {
        require(msg.sender == governanceExecutor, "only governance");
        _;
    }

    // ---------------------
    // Public / External API
    // ---------------------

    /// @notice Deposit underlying assets and receive shares.
    /// @param assets Amount of underlying token to deposit.
    /// @return shares Minted shares.
    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        require(assets > 0, "zero assets");
        // Transfer assets in
        asset.safeTransferFrom(msg.sender, address(this), assets);

        uint256 _sharesTotal = totalSupply();
        uint256 sharesToMint;
        if (_sharesTotal == 0) {
            // initial deposit: 1:1 => shares = assets (shares decimals same as ERC20 decimals)
            // We will treat both token decimals as consistent in tests (commonly 18).
            sharesToMint = assets;
        } else {
            // shares = floor(assets * WAD / exchangeRate)
            uint256 er = exchangeRate(); // WAD scaled
            // shares = floor( assets * WAD / er )
            sharesToMint = Math.mulDiv(assets, WAD, er);
            require(sharesToMint > 0, "insufficient assets to mint shares");
        }

        _mint(msg.sender, sharesToMint);
        emit Deposited(msg.sender, assets, sharesToMint);
        return sharesToMint;
    }

    /// @notice Push rewards into the vault. Caller must approve asset transfer beforehand.
    /// This increases the assets available to share holders and therefore increases exchangeRate.
    function distributeRewards(uint256 assets) external nonReentrant {
        require(assets > 0, "zero assets");
        asset.safeTransferFrom(msg.sender, address(this), assets);
        emit DistributedRewards(msg.sender, assets);
    }

    /// @notice Initiate a withdrawal by burning shares and receiving a Withdrawal NFT.
    /// The NFT contains `assetsOwed` and `availableAt = now + unbondingPeriod`.
    /// @param shares Amount of shares to redeem.
    /// @return withdrawalId NFT id minted for the withdrawal.
    function initiateWithdraw(uint256 shares) external nonReentrant returns (uint256) {
        require(shares > 0, "zero shares");
        uint256 senderBalance = balanceOf(msg.sender);
        require(senderBalance >= shares, "insufficient shares");

        // Compute assetsOwed at current exchange rate (floor)
        uint256 assetsOwed = sharesToAssets(shares);

        // Burn shares
        _burn(msg.sender, shares);

        // Reserve the assets -- they belong to the withdrawal and shouldn't be counted in ER
        lockedAssets += assetsOwed;
        require(lockedAssets <= asset.balanceOf(address(this)), "insufficient asset balance after lock"); 
        // Mint withdrawal NFT to caller recording assetsOwed and availableAt
        uint256 availableAt = block.timestamp + unbondingPeriod;
        uint256 withdrawalId = withdrawalNFT.mintWithdrawal(msg.sender, assetsOwed, availableAt);

        emit InitiatedWithdraw(msg.sender, shares, assetsOwed, withdrawalId, availableAt);
        return withdrawalId;
    }

    /// @notice Claim a matured withdrawal after its unbonding period.
    /// Burns the Withdrawal NFT and transfers assets to the owner.
    /// @param withdrawalId NFT id.
    function claim(uint256 withdrawalId) external nonReentrant {
        require(withdrawalNFT.ownerOf(withdrawalId) == msg.sender, "not owner");
        (uint256 assetsOwed, uint256 availableAt) = withdrawalNFT.getWithdrawal(withdrawalId);
        require(block.timestamp >= availableAt, "not yet available");
        require(assetsOwed > 0, "nothing owed");

        // Mark as paid by burning NFT and updating lockedAssets
        withdrawalNFT.burnWithdrawal(withdrawalId);

        // Decrease locked assets and transfer
        require(lockedAssets >= assetsOwed, "lockedAssets underflow");
        lockedAssets -= assetsOwed;

        asset.safeTransfer(msg.sender, assetsOwed);
        emit Claimed(msg.sender, withdrawalId, assetsOwed);
    }

    // ---------------------
    // Views & Conversions
    // ---------------------

    /// @notice Returns the exchange rate as WAD (1e18). ER = totalAssetsAvailable * WAD / totalShares.
    /// totalAssetsAvailable = asset.balanceOf(this) - lockedAssets
    function exchangeRate() public view returns (uint256) {
        uint256 totalShares_ = totalSupply();
        if (totalShares_ == 0) {
            return WAD; // 1:1 if no shares exist
        }
        uint256 totalAssetsAvailable = asset.balanceOf(address(this));
        if (totalAssetsAvailable <= lockedAssets) {
            // If all assets are locked (rare), ER should be 0? To be safe we'll return 0 to avoid division by zero.
            return 0;
        }
        uint256 available = totalAssetsAvailable - lockedAssets;
        // ER = available * WAD / totalShares
        return Math.mulDiv(available, WAD, totalShares_);
    }

    /// @notice Convert shares to assets using current exchange rate (floor).
    function sharesToAssets(uint256 shares) public view returns (uint256) {
        uint256 er = exchangeRate(); // WAD
        if (er == 0) return 0;
        return Math.mulDiv(shares, er, WAD);
    }

    /// @notice Convert assets to shares using current exchange rate (floor).
    function assetsToShares(uint256 assets) public view returns (uint256) {
        uint256 totalShares_ = totalSupply();
        if (totalShares_ == 0) {
            // initial deposit: 1:1
            return assets;
        }
        uint256 er = exchangeRate(); // WAD
        if (er == 0) return 0;
        return Math.mulDiv(assets, WAD, er);
    }

    // ---------------------
    // Governance helpers
    // ---------------------

    function setGovernanceExecutor(address _governanceExecutor) external onlyOwner {
        require(_governanceExecutor != address(0), "governance=0");
        governanceExecutor = _governanceExecutor;
    }

    /// @notice Only owner can update unbonding period (can be later updated via GovernanceExecutor)
    function setUnbondingPeriod(uint256 newPeriod) external onlyGovernanceExecutor() {
        emit UnbondingPeriodUpdated(unbondingPeriod, newPeriod);
        unbondingPeriod = newPeriod;
    }

}

/*
WithdrawalNFT contract - minimal ERC721 to record withdrawals.

It provides:
- mintWithdrawal(owner, assetsOwed, availableAt) -> returns id
- getWithdrawal(id) -> (assetsOwed, availableAt)
- burnWithdrawal(id)
- ownerOf from ERC721

Note: NFT ownership controls claim permission.
*/
contract WithdrawalNFT is ERC721, Ownable {
    uint256 tokenId = 0;

    struct Withdrawal {
        uint256 assetsOwed;
        uint256 availableAt;
    }

    mapping(uint256 => Withdrawal) private _withdrawals;

    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) Ownable(msg.sender) {}

    /// @notice Only vault (owner) can mint a withdrawal NFT to `to`.
    function mintWithdrawal(address to, uint256 assetsOwed, uint256 availableAt) external onlyOwner returns (uint256) {
        tokenId += 1;
        uint256 id = tokenId;
        _withdrawals[id] = Withdrawal({assetsOwed: assetsOwed, availableAt: availableAt});
        _safeMint(to, id);
        return id;
    }

    /// @notice Returns (assetsOwed, availableAt) for withdrawal id.
    function getWithdrawal(uint256 id) external view returns (uint256 assetsOwed, uint256 availableAt) {
        Withdrawal memory w = _withdrawals[id];
        return (w.assetsOwed, w.availableAt);
    }

    /// @notice Burn withdrawal. Only owner (vault) may burn entries on successful claim.
    function burnWithdrawal(uint256 id) external onlyOwner {
        // Clear storage and burn NFT
        delete _withdrawals[id];
        _burn(id);
    }

    // The vault (LiquidStakingVault) should be set as owner of this contract upon deployment.
    // In our design, LiquidStakingVault deploys WithdrawalNFT in its constructor and is therefore owner.
}
