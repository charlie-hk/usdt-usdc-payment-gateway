/**
 * Re-runs Etherscan verification from a saved deployment record.
 *   npx hardhat run scripts/verify.js --network sepolia
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { verifyAll } = require("./deploy");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment record at ${file}. Deploy first.`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  await verifyAll(record);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
