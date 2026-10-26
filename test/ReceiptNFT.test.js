const { expect } = require("chai");
const { ethers } = require("hardhat");

const units = (n) => ethers.parseUnits(String(n), 6);
const FEE_BPS = 50n;
const ZERO_REF = ethers.ZeroHash;

async function deployFixture() {
  const [owner, merchant, customer] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const gateway = await (
    await ethers.getContractFactory("PaymentGateway")
  ).deploy(owner.address, [usdc.target], FEE_BPS);

  await usdc.mint(customer.address, units(10_000));

  return { gateway, usdc, owner, merchant, customer };
}

async function newInvoice(gateway, merchant, token, amount) {
  await gateway.connect(merchant).createInvoice(token.target, amount, 0, ZERO_REF);
  return gateway.invoiceCount();
}

describe("receipt NFT", () => {
  it("mints a receipt to the payer, with tokenId == invoiceId, on pay()", async () => {
    const { gateway, usdc, merchant, customer } = await deployFixture();
    const invoiceId = await newInvoice(gateway, merchant, usdc, units(100));

    await usdc.connect(customer).approve(gateway.target, units(100));
    await gateway.connect(customer).pay(invoiceId);

    expect(await gateway.ownerOf(invoiceId)).to.equal(customer.address);
    expect(await gateway.balanceOf(customer.address)).to.equal(1n);
  });

  it("does not mint a receipt for an invoice that was never paid", async () => {
    const { gateway, usdc, merchant } = await deployFixture();
    const invoiceId = await newInvoice(gateway, merchant, usdc, units(100));

    await expect(gateway.ownerOf(invoiceId)).to.be.reverted;
  });

  it("tokenURI reverts for an unminted id and returns data for a paid one", async () => {
    const { gateway, usdc, merchant, customer } = await deployFixture();
    const invoiceId = await newInvoice(gateway, merchant, usdc, units(250));

    await expect(gateway.tokenURI(invoiceId)).to.be.reverted;

    await usdc.connect(customer).approve(gateway.target, units(250));
    await gateway.connect(customer).pay(invoiceId);

    const uri = await gateway.tokenURI(invoiceId);
    expect(uri).to.match(/^data:application\/json;base64,/);

    const json = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
    const meta = JSON.parse(json);
    expect(meta.name).to.equal(`Payment Receipt #${invoiceId}`);
    const amountAttr = meta.attributes.find((a) => a.trait_type === "Amount");
    expect(amountAttr.value).to.equal(units(250).toString());
  });

  it("mints independently for each invoice a customer pays, and the receipt is a separate asset from the invoice", async () => {
    const { gateway, usdc, merchant, customer } = await deployFixture();
    const id1 = await newInvoice(gateway, merchant, usdc, units(10));
    const id2 = await newInvoice(gateway, merchant, usdc, units(20));

    await usdc.connect(customer).approve(gateway.target, units(30));
    await gateway.connect(customer).pay(id1);
    await gateway.connect(customer).pay(id2);

    expect(await gateway.balanceOf(customer.address)).to.equal(2n);
    expect(await gateway.ownerOf(id1)).to.equal(customer.address);
    expect(await gateway.ownerOf(id2)).to.equal(customer.address);
  });
});
