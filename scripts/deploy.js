/**
 * Deploys PaymentGateway (and test tokens where needed), records the result, and verifies on Etherscan.
 *
 *   npx hardhat run scripts/deploy.js --network sepolia
 *   npx hardhat run scripts/deploy.js --network localhost
 *
 * Environment (see .env.example):
 *   OWNER_ADDRESS     owner of the gateway (default: the deployer)
 *   FEE_BPS           protocol fee in basis points, max 500 (default: 50 = 0.50%)
 *   USDC_ADDRESS      use an existing USDC instead of deploying one
 *   USDT_ADDRESS      use an existing USDT instead of deploying MockUSDT
 *   USE_MOCK_USDC     "true" to deploy MockUSDC on Sepolia instead of using Circle's USDC
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const { ethers, network } = hre;

// Circle's USDC on Ethereum Sepolia, from https://developers.circle.com/stablecoins/usdc-contract-addresses
const CIRCLE_SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const SEPOLIA_CHAIN_ID = 11155111n;

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
];

async function describeExistingToken(address, label) {
  if (!ethers.isAddress(address)) throw new Error(`${label}: "${address}" is not a valid address`);
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${label}: no contract at ${address} on ${network.name}`);
  const token = new ethers.Contract(address, ERC20_ABI, ethers.provider);
  const [symbol, name, decimals] = await Promise.all([token.symbol(), token.name(), token.decimals()]);
  return { symbol, name, decimals: Number(decimals) };
}

async function deployMock(name) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return contract;
}

async function verifyContract(address, constructorArguments = []) {
  try {
    await hre.run("verify:verify", { address, constructorArguments });
    console.log(`  verified ${address}`);
  } catch (error) {
    if (/already verified/i.test(error.message)) {
      console.log(`  already verified ${address}`);
    } else {
      console.log(`  verification failed for ${address}: ${error.message.split("\n")[0]}`);
      console.log("  retry later with: npx hardhat run scripts/verify.js --network " + network.name);
    }
  }
}

async function verifyAll(record) {
  console.log("Verifying on Etherscan...");
  await verifyContract(record.gateway.address, record.gateway.constructorArgs);
  for (const token of record.tokens) {
    if (token.mock) await verifyContract(token.address, []);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. Set DEPLOYER_PRIVATE_KEY in .env");

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Network:  ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address} (${ethers.formatEther(balance)} ETH)`);
  if (balance === 0n) throw new Error("Deployer has no ETH for gas");

  const owner = process.env.OWNER_ADDRESS || deployer.address;
  const feeBps = Number(process.env.FEE_BPS ?? 50);
  if (!ethers.isAddress(owner)) throw new Error("OWNER_ADDRESS is not a valid address");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 500) throw new Error("FEE_BPS must be an integer 0..500");

  const tokens = [];

  // ---- USDC
  const onSepolia = chainId === SEPOLIA_CHAIN_ID;
  let usdcAddress = process.env.USDC_ADDRESS || (onSepolia && process.env.USE_MOCK_USDC !== "true" ? CIRCLE_SEPOLIA_USDC : "");
  if (usdcAddress) {
    const info = await describeExistingToken(usdcAddress, "USDC");
    console.log(`USDC:     existing ${info.symbol} at ${usdcAddress} (${info.decimals} decimals)`);
    tokens.push({ key: "USDC", address: usdcAddress, ...info, mock: false, faucet: false, requiresAllowanceReset: false, permit: true });
  } else {
    const usdc = await deployMock("MockUSDC");
    usdcAddress = await usdc.getAddress();
    console.log(`USDC:     deployed MockUSDC at ${usdcAddress}`);
    tokens.push({ key: "USDC", address: usdcAddress, symbol: "mUSDC", name: "Mock USD Coin (test)", decimals: 6, mock: true, faucet: true, requiresAllowanceReset: false, permit: true });
  }

  // ---- USDT
  let usdtAddress = process.env.USDT_ADDRESS || "";
  if (usdtAddress) {
    const info = await describeExistingToken(usdtAddress, "USDT");
    console.log(`USDT:     existing ${info.symbol} at ${usdtAddress} (${info.decimals} decimals)`);
    tokens.push({ key: "USDT", address: usdtAddress, ...info, mock: false, faucet: false, requiresAllowanceReset: true, permit: false });
  } else {
    const usdt = await deployMock("MockUSDT");
    usdtAddress = await usdt.getAddress();
    console.log(`USDT:     deployed MockUSDT at ${usdtAddress}`);
    tokens.push({ key: "USDT", address: usdtAddress, symbol: "mUSDT", name: "Mock Tether USD (test)", decimals: 6, mock: true, faucet: true, requiresAllowanceReset: true, permit: false });
  }

  // ---- Gateway
  const constructorArgs = [owner, [usdcAddress, usdtAddress], feeBps];
  const gateway = await (await ethers.getContractFactory("PaymentGateway")).deploy(...constructorArgs);
  const deployTx = gateway.deploymentTransaction();
  await gateway.waitForDeployment();
  const receipt = await deployTx.wait();
  const gatewayAddress = await gateway.getAddress();
  console.log(`Gateway:  ${gatewayAddress} (block ${receipt.blockNumber}, fee ${feeBps} bps, owner ${owner})`);

  const record = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    owner,
    feeBps,
    gateway: {
      address: gatewayAddress,
      txHash: deployTx.hash,
      blockNumber: receipt.blockNumber,
      constructorArgs,
    },
    tokens,
  };

  if (network.name === "hardhat") {
    // The in-process network disappears when the script exits, so there is nothing worth recording.
    console.log("In-process hardhat network: not writing deployment files. Use --network localhost or sepolia.");
    return;
  }

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(path.join(deploymentsDir, `${network.name}.json`), JSON.stringify(record, null, 2) + "\n");
  console.log(`Wrote deployments/${network.name}.json`);

  // The frontend loads this file at runtime, so it can be re-pointed without a rebuild.
  const frontendPublic = path.join(__dirname, "..", "frontend", "public");
  if (fs.existsSync(frontendPublic)) {
    fs.writeFileSync(path.join(frontendPublic, "deployment.json"), JSON.stringify(record, null, 2) + "\n");
    console.log("Wrote frontend/public/deployment.json");
  }

  if (onSepolia && process.env.ETHERSCAN_API_KEY) {
    console.log("Waiting for 5 confirmations before verifying...");
    await deployTx.wait(5);
    await verifyAll(record);
  } else if (onSepolia) {
    console.log("ETHERSCAN_API_KEY not set: skipping verification. Run scripts/verify.js once it is.");
  }
}

module.exports = { verifyAll };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
