#!/usr/bin/env bash
#
# Single command demo runner:
# 1) launches ChainA & ChainB nodes
# 2) runs demo.js automatically
# 3) auto-kills child processes on exit
#

set -e

CHAINA_PORT=8545
CHAINB_PORT=8546

CHAIN_ID_1=31337
CHAIN_ID_2=31338

echo ""
echo "🚀 Starting Governance End-to-End Demo"
echo "------------------------------------"
echo ""

cleanup() {
  echo ""
  echo "🛑 Stopping networks..."
  if [ ! -z "$PID_A" ]; then kill $PID_A 2>/dev/null || true; fi
  if [ ! -z "$PID_B" ]; then kill $PID_B 2>/dev/null || true; fi
  echo "✅ Cleanup done!"
}
trap cleanup EXIT

########################################
# 1️⃣ Start Two Hardhat Nodes
########################################

echo "👉 Starting Chain A (stake chain) on port $CHAINA_PORT... with chain id $CHAIN_ID_1"
npx hardhat node --port $CHAINA_PORT --chain-id $CHAIN_ID_1 > nodeA.log 2>&1 &
PID_A=$!
sleep 2

echo "👉 Starting Chain B (verify chain) on port $CHAINB_PORT... with chain id $CHAIN_ID_2"
npx hardhat node --port $CHAINB_PORT --chain-id $CHAIN_ID_2 > nodeB.log 2>&1 &
PID_B=$!
sleep 2

echo "✅ Local networks running:"
echo "  🔹 ChainA (Stake):      http://127.0.0.1:$CHAINA_PORT"
echo "  🔹 ChainB (Verifier):   http://127.0.0.1:$CHAINB_PORT"
echo ""

########################################
# 2️⃣ Run Governance Demo Script
########################################

echo "▶ Running demo script..."
echo "------------------------------------"
echo ""

node scripts/demo.js || {
  echo "❌ Demo failed!"
  exit 1
}

echo ""
echo "🎯 Demo completed successfully!"
echo "------------------------------------"
echo "📌 Vault unbonding period should be updated on ChainA"
echo ""
