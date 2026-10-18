/**
 * End-to-end walkthrough on the in-process Hardhat network.
 *   USE_SOLCJS=true npx hardhat run scripts/demo-local.js     (USE_SOLCJS only if the compiler download is blocked)
 */
const { ethers } = require("hardhat");

const fmt = (n) => ethers.formatUnits(n, 6);

async function main() {
  const [owner, merchant, customer] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
  const gateway = await (
    await ethers.getContractFactory("PaymentGateway")
  ).deploy(owner.address, [usdc.target, usdt.target], 50);

  await usdc.connect(customer).faucet(ethers.parseUnits("500", 6));
  await usdt.connect(customer).faucet(ethers.parseUnits("500", 6));

  // 1. Merchant creates a 120 USDT invoice that expires in one hour
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  await gateway.connect(merchant).createInvoice(usdt.target, ethers.parseUnits("120", 6), expiresAt, ethers.id("order-1001"));
  const id = await gateway.invoiceCount();
  console.log(`Invoice #${id} created for 120 mUSDT`);

  // 2. Customer approves and pays
  await usdt.connect(customer).approve(gateway.target, ethers.parseUnits("120", 6));
  await gateway.connect(customer).pay(id);
  console.log(`Invoice #${id} paid. Merchant balance: ${fmt(await gateway.merchantBalance(merchant.address, usdt.target))} mUSDT`);
  console.log(`Protocol fee accrued: ${fmt(await gateway.feeBalance(usdt.target))} mUSDT`);

  // 3. Merchant withdraws
  const balance = await gateway.merchantBalance(merchant.address, usdt.target);
  await gateway.connect(merchant).withdraw(usdt.target, merchant.address, balance);
  console.log(`Merchant wallet now holds ${fmt(await usdt.balanceOf(merchant.address))} mUSDT`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
