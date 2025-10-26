# nodeops_assesment
NodeOps senior evm challenge assesment


🏗️ Staking + Cross-Chain Governance — Full Demo

This project demonstrates a multi-chain liquid staking + governance protocol:

Chain A → Liquid staking vault + proposal publishing + execution

Chain B → Off-chain vote verification via EIP-712 + Merkle proofs

Relayer → Bridges governance result back to Chain A

Users stake ASSET → receive LST (Liquid Staking Token) that appreciates over time.
Governance uses voting power = ASSET + LST * ER_snapshot.

This README section walks through the entire system:
staking → appreciating shares → withdrawal NFT → voting → proposal execution.

✅ One-Command Demo
./scripts/run_demo.sh


✅ Automatically performs:

Stage	Description
⛓️ Start 2 local chains	ChainA @ 8545, ChainB @ 8546
💰 Staking	Users deposit ASSET into LiquidStakingVault
📈 Yield distribution	LST exchange rate increases
🎫 NFT Withdrawal	InitiateWithdraw → WithdrawalNFT minted
🔐 Time-lock	Claim only after unbonding period
📸 Snapshot	Snapshot block + exchange rate captured
🌳 Merkle tree	Voting power root generated off-chain
✍️ Off-chain voting	EIP-712 sign → power verified via Merkle proofs
✅ VoteVerifier	Tallies votes on ChainB
🚀 Relayer execution	Proposal executed on ChainA via GovernanceExecutor

✅ Expected final output:

✅ SUCCESS: End-to-end (staking + governance) demo completed.
Final check: vault.unbondingPeriod = 172800 (expected 172800)

🔒 Staking Flow — What’s Happening?
Action	Result
Deposit ASSET	Receive LST shares at ER = 1.0 initially
distributeRewards	Vault assets ↑ → LST exchange rate ↑
initiateWithdraw	Burn shares + mint Withdrawal NFT
claim	Only after availableAt (time-locked redeem)

📌 LST stakes appreciate automatically — more rewards → higher ER → voting power grows

🗳️ Governance Flow

1️⃣ Proposal published on Chain A with:

actionDataHash (keccak256(actionData))

snapshotBlock

ER_snapshot

Merkle root of (account, power, nonce)

2️⃣ Voters sign EIP-712 messages:

Vote(uint256 proposalId, uint8 support, uint256 nonce, uint256 deadline)


3️⃣ Relayer submits:
✅ Signatures
✅ Merkle proofs
✅ Power amounts
→ to VoteVerifier on Chain B

4️⃣ When forVotes >= threshold:
→ emits ProposalPassed

5️⃣ Relayer calls:
→ GovernanceExecutor.executeIfAuthorized() on Chain A
→ Executes encoded governance action (e.g. update unbondingPeriod)

🧠 Architecture Diagram
flowchart TD

    subgraph ChainA["Chain A — Stake & Execute"]
        VAULT["LiquidStakingVault\nStake ASSET → Mint LST\nTime-Locked Redeem"]
        PUBLISH["GovernanceRootPublisher\nSnapshot + Merkle Root Commit"]
        EXEC["GovernanceExecutor\nVerifier-Authorized Execution"]
    end

    subgraph ChainB["Chain B — Vote Verification"]
        VERIFY["VoteVerifier\nEIP-712 + Merkle Proofs\nTally Voting Power"]
    end

    subgraph OffChain["Off-Chain Processes"]
        SNAPSHOT["Snapshot Builder\nBlock, ER, Balances"]
        MERKLE["Merkle Tree Generator\n(account,power,nonce)"]
        SIGN["Users Sign Votes (EIP-712)"]
        RELAYER["Relayer Observes ProposalPassed\nto trigger execute on ChainA"]
    end

    USERS["Users"] --> VAULT
    VAULT -->|SnapshotBlock, ER_snapshot| SNAPSHOT
    SNAPSHOT --> MERKLE
    MERKLE --> PUBLISH
    SIGN --> VERIFY
    MERKLE --> VERIFY
    VERIFY -->|ProposalPassed| RELAYER
    RELAYER --> EXEC
    EXEC -->|setUnbondingPeriod| VAULT

🔧 Requirements
npm install
npx hardhat compile
chmod +x scripts/run_demo.sh   # ensure script is executable

🧪 Run tests
npx hardhat test
