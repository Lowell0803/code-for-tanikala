const hre = require("hardhat");

async function main() {
  const AdminCandidates = await hre.ethers.getContractFactory("AdminCandidates");
  const contract = await AdminCandidates.deploy();

  await contract.waitForDeployment();
  console.log(`AdminCandidates deployed at: ${contract.target}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
