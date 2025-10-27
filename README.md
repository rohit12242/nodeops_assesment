## 🏗️ Staking + Cross-Chain Governance — Full Demo

This project demonstrates a **multi-chain liquid staking + governance protocol**:

- **Chain A** → Liquid staking vault + proposal publishing + execution  
- **Chain B** → Off-chain vote verification (EIP-712 + Merkle proofs)  
- **Relayer** → Bridges governance result back to Chain A

Users stake ASSET → receive LST (Liquid Staking Token) that **appreciates over time**.  
Governance uses:  
📌 **Voting Power = ASSET + LST * ER_snapshot**

This walkthrough covers:
✅ Staking ➝ NFT Withdrawal ➝ Off-chain voting ➝ Cross-chain execution ✅

---

## 🚀 One-Command Full Demo

```bash
./scripts/run_demo.sh

```

## Requirements

```bash
npm install
npx hardhat compile
chmod +x scripts/run_demo.sh
```

## Tests

```bash
npx hardhat test
```


