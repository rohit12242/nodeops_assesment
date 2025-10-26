// scripts/utils.js
import fs from "fs";
import { ethers } from "ethers";
import keccak256 from "keccak256";
import dotenv from "dotenv";
dotenv.config();

export const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
export const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);

export function getProvider(rpc = RPC) {
  return new ethers.JsonRpcProvider(rpc);
}

export function getWallet(privateKey) {
  const pk = privateKey || process.env.PRIVATE_KEY;
  if (!pk) throw new Error("No private key provided (env PRIVATE_KEY)");
  return new ethers.Wallet(pk, getProvider());
}

// load artifact JSON created by Hardhat 
export function loadContractAbi(artifactPath) {
  const json = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return json.abi;
}

export function keccak(data) {
  // data: Buffer|string
  return Buffer.from(keccak256(data));
}

export function writeJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

export function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}
