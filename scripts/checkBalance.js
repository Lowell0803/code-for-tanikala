require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const provider = new ethers.JsonRpcProvider("https://rpc-amoy.polygon.technology");
  const balance = await provider.getBalance(process.env.PRIVATE_KEY);

  console.log(`Balance: ${ethers.formatEther(balance)} MATIC`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
