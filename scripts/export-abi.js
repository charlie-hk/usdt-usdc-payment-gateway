/**
 * Copies the compiled PaymentGateway ABI into the frontend so both always match.
 *   npx hardhat compile && node scripts/export-abi.js
 */
const fs = require("fs");
const path = require("path");

const artifact = path.join(__dirname, "..", "artifacts", "contracts", "PaymentGateway.sol", "PaymentGateway.json");
const target = path.join(__dirname, "..", "frontend", "src", "abi", "PaymentGateway.json");

const { abi } = JSON.parse(fs.readFileSync(artifact, "utf8"));
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(abi, null, 2) + "\n");
console.log(`Wrote ${abi.length} ABI entries to ${path.relative(process.cwd(), target)}`);
