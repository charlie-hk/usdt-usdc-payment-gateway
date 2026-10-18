const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const units = (n) => ethers.parseUnits(String(n), 6); // USDT / USDC use 6 decimals
const FEE_BPS = 50n; // 0.50%
const ZERO_REF = ethers.ZeroHash;

const Status = { None: 0n, Pending: 1n, Paid: 2n, Cancelled: 3n };

async function deployFixture() {
  const [owner, merchant, merchant2, customer, customer2, treasury, stranger] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
  const feeToken = await (await ethers.getContractFactory("MockFeeToken")).deploy();

  const gateway = await (
    await ethers.getContractFactory("PaymentGateway")
  ).deploy(owner.address, [usdc.target, usdt.target], FEE_BPS);

  for (const who of [customer, customer2]) {
    await usdc.mint(who.address, units(10_000));
    await usdt.mint(who.address, units(10_000));
    await feeToken.mint(who.address, units(10_000));
  }

  return { gateway, usdc, usdt, feeToken, owner, merchant, merchant2, customer, customer2, treasury, stranger };
}

async function newInvoice(gateway, merchant, token, amount, expiresAt = 0, ref = ZERO_REF) {
  await gateway.connect(merchant).createInvoice(token.target, amount, expiresAt, ref);
  return gateway.invoiceCount();
}

async function signPermit(token, owner, spender, value, deadline) {
  const { chainId } = await ethers.provider.getNetwork();
  const nonce = await token.nonces(owner.address);
  const domain = { name: await token.name(), version: "1", chainId, verifyingContract: token.target };
  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const signature = await owner.signTypedData(domain, types, {
    owner: owner.address,
    spender,
    value,
    nonce,
    deadline,
  });
  return ethers.Signature.from(signature);
}

describe("PaymentGateway", () => {
  describe("deployment", () => {
    it("sets owner, fee and supported tokens", async () => {
      const { gateway, usdc, usdt, feeToken, owner } = await loadFixture(deployFixture);
      expect(await gateway.owner()).to.equal(owner.address);
      expect(await gateway.feeBps()).to.equal(FEE_BPS);
      expect(await gateway.supportedToken(usdc.target)).to.equal(true);
      expect(await gateway.supportedToken(usdt.target)).to.equal(true);
      expect(await gateway.supportedToken(feeToken.target)).to.equal(false);
      expect(await gateway.invoiceCount()).to.equal(0n);
    });

    it("rejects a zero address, an EOA and an excessive fee in the constructor", async () => {
      const { usdc, owner, stranger } = await loadFixture(deployFixture);
      const Gateway = await ethers.getContractFactory("PaymentGateway");
      await expect(Gateway.deploy(owner.address, [ethers.ZeroAddress], 0)).to.be.revertedWithCustomError(
        Gateway,
        "ZeroAddress"
      );
      await expect(Gateway.deploy(owner.address, [stranger.address], 0))
        .to.be.revertedWithCustomError(Gateway, "NotAContract")
        .withArgs(stranger.address);
      await expect(Gateway.deploy(owner.address, [usdc.target], 501))
        .to.be.revertedWithCustomError(Gateway, "FeeTooHigh")
        .withArgs(501, 500);
    });
  });

  describe("createInvoice", () => {
    it("stores the invoice and emits InvoiceCreated", async () => {
      const { gateway, usdc, merchant } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 3600;
      const ref = ethers.id("order-1001");

      await expect(gateway.connect(merchant).createInvoice(usdc.target, units(25), expiresAt, ref))
        .to.emit(gateway, "InvoiceCreated")
        .withArgs(1, merchant.address, usdc.target, units(25), expiresAt, ref);

      const invoice = await gateway.getInvoice(1);
      expect(invoice.merchant).to.equal(merchant.address);
      expect(invoice.token).to.equal(usdc.target);
      expect(invoice.amount).to.equal(units(25));
      expect(invoice.expiresAt).to.equal(expiresAt);
      expect(invoice.status).to.equal(Status.Pending);
      expect(invoice.payer).to.equal(ethers.ZeroAddress);
      expect(await gateway.isPayable(1)).to.equal(true);
    });

    it("assigns sequential ids", async () => {
      const { gateway, usdc, usdt, merchant, merchant2 } = await loadFixture(deployFixture);
      expect(await newInvoice(gateway, merchant, usdc, units(1))).to.equal(1n);
      expect(await newInvoice(gateway, merchant2, usdt, units(2))).to.equal(2n);
      expect(await newInvoice(gateway, merchant, usdt, units(3))).to.equal(3n);
    });

    it("rejects unsupported tokens, zero amounts and expiries in the past", async () => {
      const { gateway, usdc, feeToken, merchant } = await loadFixture(deployFixture);
      await expect(gateway.connect(merchant).createInvoice(feeToken.target, units(1), 0, ZERO_REF))
        .to.be.revertedWithCustomError(gateway, "TokenNotSupported")
        .withArgs(feeToken.target);
      await expect(
        gateway.connect(merchant).createInvoice(usdc.target, 0, 0, ZERO_REF)
      ).to.be.revertedWithCustomError(gateway, "ZeroAmount");
      await expect(
        gateway.connect(merchant).createInvoice(usdc.target, units(1), (await time.latest()) - 1, ZERO_REF)
      ).to.be.revertedWithCustomError(gateway, "InvalidExpiry");
    });

    it("reverts while paused", async () => {
      const { gateway, usdc, merchant, owner } = await loadFixture(deployFixture);
      await gateway.connect(owner).pause();
      await expect(
        gateway.connect(merchant).createInvoice(usdc.target, units(1), 0, ZERO_REF)
      ).to.be.revertedWithCustomError(gateway, "EnforcedPause");
    });

    it("getInvoice reverts for an unknown id", async () => {
      const { gateway } = await loadFixture(deployFixture);
      await expect(gateway.getInvoice(42)).to.be.revertedWithCustomError(gateway, "InvoiceNotFound").withArgs(42);
      expect(await gateway.isPayable(42)).to.equal(false);
    });
  });

  describe("pay (USDC)", () => {
    it("moves funds, splits the fee and emits InvoicePaid", async () => {
      const { gateway, usdc, merchant, customer } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(1000));
      await usdc.connect(customer).approve(gateway.target, units(1000));

      const fee = units(1000) * FEE_BPS / 10_000n; // 5 USDC
      const tx = gateway.connect(customer).pay(id);
      await expect(tx)
        .to.emit(gateway, "InvoicePaid")
        .withArgs(id, merchant.address, customer.address, usdc.target, units(1000), fee);
      await expect(tx).to.changeTokenBalances(usdc, [customer, gateway], [-units(1000), units(1000)]);

      expect(await gateway.merchantBalance(merchant.address, usdc.target)).to.equal(units(1000) - fee);
      expect(await gateway.feeBalance(usdc.target)).to.equal(fee);
      expect(await gateway.totalHeld(usdc.target)).to.equal(units(1000));

      const invoice = await gateway.getInvoice(id);
      expect(invoice.status).to.equal(Status.Paid);
      expect(invoice.payer).to.equal(customer.address);
      expect(invoice.paidAt).to.equal(await time.latest());
      expect(await gateway.isPayable(id)).to.equal(false);
    });

    it("rounds the fee down and handles very small amounts", async () => {
      const { gateway, usdc, merchant, customer } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, 199n); // 199 * 50 / 10000 = 0.995 -> 0
      await usdc.connect(customer).approve(gateway.target, 199n);
      await gateway.connect(customer).pay(id);
      expect(await gateway.feeBalance(usdc.target)).to.equal(0n);
      expect(await gateway.merchantBalance(merchant.address, usdc.target)).to.equal(199n);
    });

    it("cannot be paid twice", async () => {
      const { gateway, usdc, merchant, customer, customer2 } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(10));
      await usdc.connect(customer).approve(gateway.target, units(10));
      await gateway.connect(customer).pay(id);

      await usdc.connect(customer2).approve(gateway.target, units(10));
      await expect(gateway.connect(customer2).pay(id))
        .to.be.revertedWithCustomError(gateway, "InvoiceNotPending")
        .withArgs(id, Status.Paid);
    });

    it("reverts for unknown and cancelled invoices", async () => {
      const { gateway, usdc, merchant, customer } = await loadFixture(deployFixture);
      await expect(gateway.connect(customer).pay(99)).to.be.revertedWithCustomError(gateway, "InvoiceNotFound");

      const id = await newInvoice(gateway, merchant, usdc, units(10));
      await gateway.connect(merchant).cancelInvoice(id);
      await expect(gateway.connect(customer).pay(id))
        .to.be.revertedWithCustomError(gateway, "InvoiceNotPending")
        .withArgs(id, Status.Cancelled);
    });

    it("accepts payment up to and including the expiry timestamp, and rejects after it", async () => {
      const { gateway, usdc, merchant, customer, customer2 } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 1000;
      const first = await newInvoice(gateway, merchant, usdc, units(10), expiresAt);
      const second = await newInvoice(gateway, merchant, usdc, units(10), expiresAt);
      await usdc.connect(customer).approve(gateway.target, units(20));
      await usdc.connect(customer2).approve(gateway.target, units(20));

      await time.setNextBlockTimestamp(expiresAt);
      await gateway.connect(customer).pay(first); // exactly at the deadline is still valid

      await time.setNextBlockTimestamp(expiresAt + 1);
      await expect(gateway.connect(customer2).pay(second))
        .to.be.revertedWithCustomError(gateway, "InvoiceExpired")
        .withArgs(second, expiresAt);
    });

    it("reports an expired invoice as not payable", async () => {
      const { gateway, usdc, merchant } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(10), (await time.latest()) + 60);
      expect(await gateway.isPayable(id)).to.equal(true);
      await time.increase(61);
      expect(await gateway.isPayable(id)).to.equal(false);
    });

    it("reverts without allowance or balance", async () => {
      const { gateway, usdc, merchant, customer, stranger } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(10));

      await expect(gateway.connect(customer).pay(id)).to.be.revertedWithCustomError(
        usdc,
        "ERC20InsufficientAllowance"
      );

      await usdc.connect(stranger).approve(gateway.target, units(10)); // has no tokens
      await expect(gateway.connect(stranger).pay(id)).to.be.revertedWithCustomError(
        usdc,
        "ERC20InsufficientBalance"
      );
      // state is untouched after the failed attempts
      expect((await gateway.getInvoice(id)).status).to.equal(Status.Pending);
    });

    it("reverts while paused and works again after unpause", async () => {
      const { gateway, usdc, merchant, customer, owner } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(10));
      await usdc.connect(customer).approve(gateway.target, units(10));

      await gateway.connect(owner).pause();
      await expect(gateway.connect(customer).pay(id)).to.be.revertedWithCustomError(gateway, "EnforcedPause");
      expect(await gateway.isPayable(id)).to.equal(false);

      await gateway.connect(owner).unpause();
      await gateway.connect(customer).pay(id);
      expect((await gateway.getInvoice(id)).status).to.equal(Status.Paid);
    });

    it("rejects payment if the token was delisted after the invoice was created", async () => {
      const { gateway, usdc, merchant, customer, owner } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(10));
      await usdc.connect(customer).approve(gateway.target, units(10));
      await gateway.connect(owner).setSupportedToken(usdc.target, false);
      await expect(gateway.connect(customer).pay(id))
        .to.be.revertedWithCustomError(gateway, "TokenNotSupported")
        .withArgs(usdc.target);
    });

    it("uses the fee in force at payment time", async () => {
      const { gateway, usdc, merchant, customer, owner } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(1000));
      await gateway.connect(owner).setFeeBps(100); // 1%
      await usdc.connect(customer).approve(gateway.target, units(1000));
      await gateway.connect(customer).pay(id);
      expect(await gateway.feeBalance(usdc.target)).to.equal(units(10));
    });

    it("works with a zero fee", async () => {
      const { gateway, usdc, merchant, customer, owner } = await loadFixture(deployFixture);
      await gateway.connect(owner).setFeeBps(0);
      const id = await newInvoice(gateway, merchant, usdc, units(40));
      await usdc.connect(customer).approve(gateway.target, units(40));
      await gateway.connect(customer).pay(id);
      expect(await gateway.merchantBalance(merchant.address, usdc.target)).to.equal(units(40));
      expect(await gateway.feeBalance(usdc.target)).to.equal(0n);
    });
  });

  describe("pay (USDT, non-standard ERC-20)", () => {
    it("the mock behaves like mainnet USDT: no return values and approve must be reset to zero", async () => {
      const { usdt, gateway, customer } = await loadFixture(deployFixture);
      await usdt.connect(customer).approve(gateway.target, units(5));
      await expect(usdt.connect(customer).approve(gateway.target, units(10))).to.be.revertedWith(
        "USDT: reset allowance to 0 first"
      );
      await usdt.connect(customer).approve(gateway.target, 0);
      await usdt.connect(customer).approve(gateway.target, units(10));
      expect(await usdt.allowance(customer.address, gateway.target)).to.equal(units(10));
    });

    it("pays an invoice despite the missing return values", async () => {
      const { gateway, usdt, merchant, customer } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdt, units(250));
      await usdt.connect(customer).approve(gateway.target, units(250));

      await expect(gateway.connect(customer).pay(id)).to.changeTokenBalances(
        usdt,
        [customer, gateway],
        [-units(250), units(250)]
      );
      expect((await gateway.getInvoice(id)).status).to.equal(Status.Paid);
    });

    it("lets the merchant withdraw USDT despite the missing return value", async () => {
      const { gateway, usdt, merchant, customer, treasury } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdt, units(250));
      await usdt.connect(customer).approve(gateway.target, units(250));
      await gateway.connect(customer).pay(id);

      const net = units(250) - (units(250) * FEE_BPS) / 10_000n;
      await expect(
        gateway.connect(merchant).withdraw(usdt.target, treasury.address, net)
      ).to.changeTokenBalances(usdt, [treasury, gateway], [net, -net]);
    });

    it("skips the permit silently for a token without permit support", async () => {
      const { gateway, usdt, merchant, customer } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdt, units(10));
      await usdt.connect(customer).approve(gateway.target, units(10));
      const deadline = (await time.latest()) + 600;
      await gateway.connect(customer).payWithPermit(id, deadline, 27, ethers.ZeroHash, ethers.ZeroHash);
      expect((await gateway.getInvoice(id)).status).to.equal(Status.Paid);
    });
  });

  describe("pay with a fee-on-transfer token", () => {
    it("reverts because the received amount differs from the invoice amount", async () => {
      const { gateway, feeToken, merchant, customer, owner } = await loadFixture(deployFixture);
      await gateway.connect(owner).setSupportedToken(feeToken.target, true);
      const id = await newInvoice(gateway, merchant, feeToken, units(100));
      await feeToken.connect(customer).approve(gateway.target, units(100));

      await expect(gateway.connect(customer).pay(id))
        .to.be.revertedWithCustomError(gateway, "UnexpectedTransferAmount")
        .withArgs(units(100), units(99));

      expect((await gateway.getInvoice(id)).status).to.equal(Status.Pending);
      expect(await gateway.totalHeld(feeToken.target)).to.equal(0n);
    });
  });

  describe("payWithPermit (EIP-2612)", () => {
    it("pays in a single transaction with a signed permit", async () => {
      const { gateway, usdc, merchant, customer } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(75));
      const deadline = (await time.latest()) + 600;
      const sig = await signPermit(usdc, customer, gateway.target, units(75), deadline);

      const tx = gateway.connect(customer).payWithPermit(id, deadline, sig.v, sig.r, sig.s);
      await expect(tx).to.emit(gateway, "InvoicePaid");
      await expect(tx).to.changeTokenBalances(usdc, [customer, gateway], [-units(75), units(75)]);

      expect(await usdc.allowance(customer.address, gateway.target)).to.equal(0n);
    });

    it("still succeeds if the permit was front-run by someone else", async () => {
      const { gateway, usdc, merchant, customer, stranger } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(75));
      const deadline = (await time.latest()) + 600;
      const sig = await signPermit(usdc, customer, gateway.target, units(75), deadline);

      // An attacker submits the customer's signature first, so the nonce is consumed.
      await usdc.connect(stranger).permit(customer.address, gateway.target, units(75), deadline, sig.v, sig.r, sig.s);

      await gateway.connect(customer).payWithPermit(id, deadline, sig.v, sig.r, sig.s);
      expect((await gateway.getInvoice(id)).status).to.equal(Status.Paid);
    });

    it("reverts for a signature from the wrong signer", async () => {
      const { gateway, usdc, merchant, customer, stranger } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(75));
      const deadline = (await time.latest()) + 600;
      // signed by `stranger` but claimed to be the customer's permit
      const sig = await signPermit(usdc, stranger, gateway.target, units(75), deadline);

      await expect(
        gateway.connect(customer).payWithPermit(id, deadline, sig.v, sig.r, sig.s)
      ).to.be.revertedWithCustomError(usdc, "ERC20InsufficientAllowance");
    });

    it("reverts for an expired permit deadline", async () => {
      const { gateway, usdc, merchant, customer } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(75));
      const deadline = (await time.latest()) + 60;
      const sig = await signPermit(usdc, customer, gateway.target, units(75), deadline);
      await time.increase(120);

      await expect(
        gateway.connect(customer).payWithPermit(id, deadline, sig.v, sig.r, sig.s)
      ).to.be.revertedWithCustomError(usdc, "ERC20InsufficientAllowance");
    });

    it("reverts for an unknown invoice", async () => {
      const { gateway, customer } = await loadFixture(deployFixture);
      await expect(
        gateway.connect(customer).payWithPermit(7, 0, 27, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(gateway, "InvoiceNotFound");
    });
  });

  describe("cancelInvoice", () => {
    it("lets the merchant cancel a pending invoice", async () => {
      const { gateway, usdc, merchant } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(5));
      await expect(gateway.connect(merchant).cancelInvoice(id))
        .to.emit(gateway, "InvoiceCancelled")
        .withArgs(id, merchant.address);
      expect((await gateway.getInvoice(id)).status).to.equal(Status.Cancelled);
    });

    it("only the merchant can cancel", async () => {
      const { gateway, usdc, merchant, stranger, owner } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(5));
      await expect(gateway.connect(stranger).cancelInvoice(id))
        .to.be.revertedWithCustomError(gateway, "NotMerchant")
        .withArgs(id, stranger.address);
      await expect(gateway.connect(owner).cancelInvoice(id)).to.be.revertedWithCustomError(gateway, "NotMerchant");
    });

    it("cannot cancel a paid, cancelled or unknown invoice", async () => {
      const { gateway, usdc, merchant, customer } = await loadFixture(deployFixture);
      const paid = await newInvoice(gateway, merchant, usdc, units(5));
      await usdc.connect(customer).approve(gateway.target, units(5));
      await gateway.connect(customer).pay(paid);
      await expect(gateway.connect(merchant).cancelInvoice(paid))
        .to.be.revertedWithCustomError(gateway, "InvoiceNotPending")
        .withArgs(paid, Status.Paid);

      const cancelled = await newInvoice(gateway, merchant, usdc, units(5));
      await gateway.connect(merchant).cancelInvoice(cancelled);
      await expect(gateway.connect(merchant).cancelInvoice(cancelled)).to.be.revertedWithCustomError(
        gateway,
        "InvoiceNotPending"
      );

      await expect(gateway.connect(merchant).cancelInvoice(999)).to.be.revertedWithCustomError(
        gateway,
        "InvoiceNotFound"
      );
    });

    it("works while the contract is paused", async () => {
      const { gateway, usdc, merchant, owner } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(5));
      await gateway.connect(owner).pause();
      await gateway.connect(merchant).cancelInvoice(id);
      expect((await gateway.getInvoice(id)).status).to.equal(Status.Cancelled);
    });
  });

  describe("withdraw", () => {
    async function paidFixture() {
      const base = await deployFixture();
      const { gateway, usdc, merchant, customer } = base;
      const id = await newInvoice(gateway, merchant, usdc, units(1000));
      await usdc.connect(customer).approve(gateway.target, units(1000));
      await gateway.connect(customer).pay(id);
      const net = units(1000) - (units(1000) * FEE_BPS) / 10_000n; // 995 USDC
      return { ...base, net };
    }

    it("pays out to any address the merchant chooses and updates accounting", async () => {
      const { gateway, usdc, merchant, treasury, net } = await loadFixture(paidFixture);
      const tx = gateway.connect(merchant).withdraw(usdc.target, treasury.address, units(100));
      await expect(tx)
        .to.emit(gateway, "Withdrawn")
        .withArgs(merchant.address, usdc.target, treasury.address, units(100));
      await expect(tx).to.changeTokenBalances(usdc, [treasury, gateway], [units(100), -units(100)]);

      expect(await gateway.merchantBalance(merchant.address, usdc.target)).to.equal(net - units(100));
      expect(await gateway.totalHeld(usdc.target)).to.equal(units(1000) - units(100));
    });

    it("can withdraw the full balance", async () => {
      const { gateway, usdc, merchant, net } = await loadFixture(paidFixture);
      await gateway.connect(merchant).withdraw(usdc.target, merchant.address, net);
      expect(await gateway.merchantBalance(merchant.address, usdc.target)).to.equal(0n);
    });

    it("rejects more than the balance, zero amounts and the zero address", async () => {
      const { gateway, usdc, merchant, treasury, net } = await loadFixture(paidFixture);
      await expect(gateway.connect(merchant).withdraw(usdc.target, treasury.address, net + 1n))
        .to.be.revertedWithCustomError(gateway, "InsufficientBalance")
        .withArgs(net + 1n, net);
      await expect(
        gateway.connect(merchant).withdraw(usdc.target, treasury.address, 0)
      ).to.be.revertedWithCustomError(gateway, "ZeroAmount");
      await expect(
        gateway.connect(merchant).withdraw(usdc.target, ethers.ZeroAddress, 1)
      ).to.be.revertedWithCustomError(gateway, "ZeroAddress");
    });

    it("cannot be used to take another merchant's funds", async () => {
      const { gateway, usdc, merchant2, stranger } = await loadFixture(paidFixture);
      await expect(gateway.connect(merchant2).withdraw(usdc.target, merchant2.address, 1))
        .to.be.revertedWithCustomError(gateway, "InsufficientBalance")
        .withArgs(1, 0);
      await expect(gateway.connect(stranger).withdraw(usdc.target, stranger.address, 1)).to.be.revertedWithCustomError(
        gateway,
        "InsufficientBalance"
      );
    });

    it("is not blocked by pause", async () => {
      const { gateway, usdc, merchant, owner, net } = await loadFixture(paidFixture);
      await gateway.connect(owner).pause();
      await gateway.connect(merchant).withdraw(usdc.target, merchant.address, net);
      expect(await gateway.merchantBalance(merchant.address, usdc.target)).to.equal(0n);
    });

    it("still works for a token that has been delisted", async () => {
      const { gateway, usdc, merchant, owner, net } = await loadFixture(paidFixture);
      await gateway.connect(owner).setSupportedToken(usdc.target, false);
      await gateway.connect(merchant).withdraw(usdc.target, merchant.address, net);
    });
  });

  describe("protocol fees", () => {
    async function feeFixture() {
      const base = await deployFixture();
      const { gateway, usdc, merchant, customer } = base;
      const id = await newInvoice(gateway, merchant, usdc, units(2000));
      await usdc.connect(customer).approve(gateway.target, units(2000));
      await gateway.connect(customer).pay(id);
      return { ...base, fee: units(10) }; // 0.5% of 2000
    }

    it("owner can withdraw accrued fees", async () => {
      const { gateway, usdc, owner, treasury, fee } = await loadFixture(feeFixture);
      const tx = gateway.connect(owner).withdrawFees(usdc.target, treasury.address, fee);
      await expect(tx).to.emit(gateway, "FeesWithdrawn").withArgs(usdc.target, treasury.address, fee);
      await expect(tx).to.changeTokenBalance(usdc, treasury, fee);
      expect(await gateway.feeBalance(usdc.target)).to.equal(0n);
    });

    it("rejects non-owners, over-withdrawals, zero amounts and the zero address", async () => {
      const { gateway, usdc, owner, stranger, treasury, fee } = await loadFixture(feeFixture);
      await expect(gateway.connect(stranger).withdrawFees(usdc.target, stranger.address, 1))
        .to.be.revertedWithCustomError(gateway, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
      await expect(gateway.connect(owner).withdrawFees(usdc.target, treasury.address, fee + 1n))
        .to.be.revertedWithCustomError(gateway, "InsufficientBalance")
        .withArgs(fee + 1n, fee);
      await expect(
        gateway.connect(owner).withdrawFees(usdc.target, treasury.address, 0)
      ).to.be.revertedWithCustomError(gateway, "ZeroAmount");
      await expect(
        gateway.connect(owner).withdrawFees(usdc.target, ethers.ZeroAddress, 1)
      ).to.be.revertedWithCustomError(gateway, "ZeroAddress");
    });

    it("the owner cannot reach merchant balances through the fee withdrawal", async () => {
      const { gateway, usdc, owner, treasury, fee } = await loadFixture(feeFixture);
      // available fees are only `fee`, even though the contract holds 2000 USDC
      await expect(
        gateway.connect(owner).withdrawFees(usdc.target, treasury.address, units(2000))
      ).to.be.revertedWithCustomError(gateway, "InsufficientBalance");
      expect(await usdc.balanceOf(gateway.target)).to.equal(units(2000));
      expect(fee).to.be.lessThan(units(2000));
    });
  });

  describe("sweepUnaccounted", () => {
    it("recovers tokens sent by mistake without touching merchant or fee balances", async () => {
      const { gateway, usdc, merchant, customer, owner, treasury } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(100));
      await usdc.connect(customer).approve(gateway.target, units(100));
      await gateway.connect(customer).pay(id);

      // customer sends 30 USDC straight to the contract by mistake
      await usdc.connect(customer).transfer(gateway.target, units(30));

      const tx = gateway.connect(owner).sweepUnaccounted(usdc.target, treasury.address);
      await expect(tx).to.emit(gateway, "UnaccountedSwept").withArgs(usdc.target, treasury.address, units(30));
      await expect(tx).to.changeTokenBalance(usdc, treasury, units(30));

      expect(await usdc.balanceOf(gateway.target)).to.equal(units(100));
      expect(await gateway.totalHeld(usdc.target)).to.equal(units(100));
    });

    it("reverts when there is nothing to sweep and for non-owners", async () => {
      const { gateway, usdc, merchant, customer, owner, treasury, stranger } = await loadFixture(deployFixture);
      const id = await newInvoice(gateway, merchant, usdc, units(100));
      await usdc.connect(customer).approve(gateway.target, units(100));
      await gateway.connect(customer).pay(id);

      await expect(
        gateway.connect(owner).sweepUnaccounted(usdc.target, treasury.address)
      ).to.be.revertedWithCustomError(gateway, "NothingToSweep");
      await expect(gateway.connect(stranger).sweepUnaccounted(usdc.target, stranger.address))
        .to.be.revertedWithCustomError(gateway, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
      await expect(
        gateway.connect(owner).sweepUnaccounted(usdc.target, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(gateway, "ZeroAddress");
    });
  });

  describe("admin", () => {
    it("only the owner can change tokens, fee and pause state", async () => {
      const { gateway, usdc, stranger } = await loadFixture(deployFixture);
      const denied = (p) =>
        expect(p).to.be.revertedWithCustomError(gateway, "OwnableUnauthorizedAccount").withArgs(stranger.address);
      await denied(gateway.connect(stranger).setSupportedToken(usdc.target, false));
      await denied(gateway.connect(stranger).setFeeBps(1));
      await denied(gateway.connect(stranger).pause());
      await denied(gateway.connect(stranger).unpause());
    });

    it("validates token and fee inputs", async () => {
      const { gateway, owner, stranger } = await loadFixture(deployFixture);
      await expect(gateway.connect(owner).setSupportedToken(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
        gateway,
        "ZeroAddress"
      );
      await expect(gateway.connect(owner).setSupportedToken(stranger.address, true))
        .to.be.revertedWithCustomError(gateway, "NotAContract")
        .withArgs(stranger.address);
      await expect(gateway.connect(owner).setFeeBps(501)).to.be.revertedWithCustomError(gateway, "FeeTooHigh");
      await expect(gateway.connect(owner).setFeeBps(500)).to.emit(gateway, "FeeBpsSet").withArgs(500);
    });

    it("ownership transfer is two-step and renouncing is disabled", async () => {
      const { gateway, owner, treasury } = await loadFixture(deployFixture);
      await gateway.connect(owner).transferOwnership(treasury.address);
      expect(await gateway.owner()).to.equal(owner.address); // unchanged until accepted
      expect(await gateway.pendingOwner()).to.equal(treasury.address);

      await gateway.connect(treasury).acceptOwnership();
      expect(await gateway.owner()).to.equal(treasury.address);

      await expect(gateway.connect(treasury).renounceOwnership()).to.be.revertedWithCustomError(
        gateway,
        "RenounceDisabled"
      );
    });

    it("quoteFee matches the fee charged", async () => {
      const { gateway } = await loadFixture(deployFixture);
      expect(await gateway.quoteFee(units(1000))).to.equal(units(5));
      expect(await gateway.quoteFee(0)).to.equal(0n);
    });
  });

  describe("accounting invariant", () => {
    it("contract balance always equals merchant balances + fees across many operations", async () => {
      const { gateway, usdc, usdt, merchant, merchant2, customer, customer2, treasury, owner } =
        await loadFixture(deployFixture);

      const tokens = [usdc, usdt];
      const merchants = [merchant, merchant2];
      const customers = [customer, customer2];

      for (const t of tokens) {
        for (const c of customers) {
          await t.connect(c).approve(gateway.target, units(5000));
        }
      }

      // 24 invoices across two merchants, two tokens, varied amounts; pay 2 of every 3, cancel every 6th
      for (let i = 0; i < 24; i++) {
        const token = tokens[i % 2];
        const m = merchants[(i >> 1) % 2];
        const payer = customers[(i >> 2) % 2];
        const amount = units(7 + i * 13) + BigInt(i); // include non-round amounts
        const id = await newInvoice(gateway, m, token, amount);

        if (i % 6 === 5) {
          await gateway.connect(m).cancelInvoice(id);
        } else if (i % 3 !== 2) {
          await gateway.connect(payer).pay(id);
        }
      }

      // partial withdrawals by both merchants and the owner
      for (const t of tokens) {
        for (const m of merchants) {
          const bal = await gateway.merchantBalance(m.address, t.target);
          if (bal > 0n) await gateway.connect(m).withdraw(t.target, treasury.address, bal / 3n + 1n);
        }
        const fees = await gateway.feeBalance(t.target);
        if (fees > 0n) await gateway.connect(owner).withdrawFees(t.target, treasury.address, fees / 2n + 1n);
      }

      for (const t of tokens) {
        const held =
          (await gateway.merchantBalance(merchant.address, t.target)) +
          (await gateway.merchantBalance(merchant2.address, t.target)) +
          (await gateway.feeBalance(t.target));
        expect(await gateway.totalHeld(t.target)).to.equal(held);
        expect(await t.balanceOf(gateway.target)).to.equal(held);
        expect(held).to.be.greaterThan(0n);
      }
    });
  });
});
