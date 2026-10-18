/**
 * End-to-end check of the frontend's contract layer (src/lib) against a real local chain.
 * It exercises the same functions the browser UI calls, with viem accounts instead of a browser wallet.
 *
 *   # terminal 1 (repo root)
 *   npx hardhat node
 *   # terminal 2 (repo root)
 *   npx hardhat run scripts/deploy.js --network localhost
 *   # terminal 3
 *   cd frontend && npm run e2e
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, erc20Abi, http, keccak256, parseUnits, toHex, zeroHash, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { localChain } from '../src/lib/chains';
import { formatAmount, parseAmount } from '../src/lib/format';
import {
  buildRows,
  cancelInvoice,
  createInvoice,
  faucet,
  friendlyError,
  payInvoice,
  readInvoice,
  readMerchantBalance,
  readTokenState,
  scanMerchantEvents,
  withdraw,
  type PayStep,
} from '../src/lib/gateway';
import { InvoiceStatus, type Deployment, type TokenInfo } from '../src/lib/types';

// Hardhat's well-known development accounts #1 and #2. Public test keys, never use them on a real network.
const MERCHANT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CUSTOMER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

const deployment = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../deployments/localhost.json', import.meta.url)), 'utf8'),
) as Deployment;
assert(deployment.gateway, 'deployments/localhost.json has no gateway');
const gateway = deployment.gateway.address;
const deployBlock = BigInt(deployment.gateway.blockNumber);
const usdc = deployment.tokens.find((t) => t.key === 'USDC') as TokenInfo;
const usdt = deployment.tokens.find((t) => t.key === 'USDT') as TokenInfo;

const transport = http(localChain.rpcUrls.default.http[0]);
const publicClient = createPublicClient({ chain: localChain, transport }) as PublicClient;
const merchant = privateKeyToAccount(MERCHANT_KEY);
const customer = privateKeyToAccount(CUSTOMER_KEY);
const merchantWallet = createWalletClient({ account: merchant, chain: localChain, transport });
const customerWallet = createWalletClient({ account: customer, chain: localChain, transport });

const merchantCtx = { publicClient, walletClient: merchantWallet, chain: localChain, account: merchant.address, gateway };
const customerCtx = { publicClient, walletClient: customerWallet, chain: localChain, account: customer.address, gateway };

let passed = 0;
const ok = (name: string) => {
  passed += 1;
  console.log(`  ok  ${name}`);
};

async function advanceTime(seconds: number) {
  await publicClient.request({ method: 'evm_increaseTime' as never, params: [seconds] as never });
  await publicClient.request({ method: 'evm_mine' as never, params: [] as never });
}

async function main() {
  console.log(`Gateway ${gateway} on chain ${deployment.chainId}`);

  // ---- pure helpers
  assert.equal(parseAmount('25.5', 6), 25_500_000n);
  assert.equal(parseAmount('0', 6), null);
  assert.equal(parseAmount('1.1234567', 6), null);
  assert.equal(parseAmount('abc', 6), null);
  assert.equal(parseAmount('-3', 6), null);
  assert.equal(formatAmount(1_234_567_890n, 6), '1,234.56789');
  assert.equal(formatAmount(5_000_000n, 6), '5.00');
  ok('amount parsing and formatting');

  // ---- USDT (non-standard token, needs the allowance reset path)
  await faucet({ ...customerCtx, token: usdt, amount: parseUnits('500', 6) });
  const expiresAt = (await publicClient.getBlock()).timestamp + 3600n;
  const created = await createInvoice({
    ...merchantCtx,
    token: usdt.address,
    amount: parseUnits('120', 6),
    expiresAt,
    orderRef: keccak256(toHex('order-1001')),
  });
  const first = await readInvoice(publicClient, gateway, created.id);
  assert(first);
  assert.equal(first.status, InvoiceStatus.Pending);
  assert.equal(first.amount, parseUnits('120', 6));
  assert.equal(first.merchant.toLowerCase(), merchant.address.toLowerCase());
  ok(`merchant created invoice #${created.id} and it reads back as pending`);

  assert.equal(await readInvoice(publicClient, gateway, 9_999n), null);
  ok('unknown invoice reads as null');

  // Leave a stale non-zero allowance so USDT's "reset to zero first" rule is actually hit.
  await customerWallet.writeContract({ address: usdt.address, abi: erc20Abi, functionName: 'approve', args: [gateway, parseUnits('1', 6)], chain: localChain, account: customer });
  const steps: PayStep[] = [];
  await payInvoice({ ...customerCtx, invoice: first, token: usdt, onStep: (s) => steps.push(s) });
  assert.deepEqual(steps.filter((s, i) => steps.indexOf(s) === i), ['reset-allowance', 'approve', 'pay']);
  ok('USDT payment went through reset-allowance, approve, pay');

  const afterPay = await readInvoice(publicClient, gateway, created.id);
  assert.equal(afterPay?.status, InvoiceStatus.Paid);
  assert.equal(afterPay?.payer.toLowerCase(), customer.address.toLowerCase());
  const tokenState = await readTokenState(publicClient, usdt.address, customer.address, gateway);
  assert.equal(tokenState.balance, parseUnits('380', 6));
  assert.equal(tokenState.allowance, 0n, 'allowance is fully consumed by the exact-amount approval');
  ok('invoice is paid, customer balance and allowance are exact');

  // ---- the same invoice cannot be paid twice, and the error is readable
  await assert.rejects(
    () => payInvoice({ ...customerCtx, invoice: first, token: usdt }),
    (error) => {
      assert.match(friendlyError(error), /already been paid or was cancelled/);
      return true;
    },
  );
  ok('paying a paid invoice fails with a readable message');

  // ---- merchant dashboard data
  const events = await scanMerchantEvents(publicClient, gateway, merchant.address, deployBlock);
  const rows = buildRows(events.created, events.paid, events.cancelled, Number((await publicClient.getBlock()).timestamp));
  const row = rows.find((r) => r.id === created.id);
  assert.equal(row?.status, 'paid');
  assert.equal(row?.fee, parseUnits('0.6', 6)); // 0.50% of 120
  ok('dashboard rows: paid invoice with the 0.50% fee');

  const balance = await readMerchantBalance(publicClient, gateway, merchant.address, usdt.address);
  assert.equal(balance, parseUnits('119.4', 6));
  await withdraw({ ...merchantCtx, token: usdt.address, to: merchant.address, amount: balance });
  assert.equal(await readMerchantBalance(publicClient, gateway, merchant.address, usdt.address), 0n);
  const merchantUsdt = await publicClient.readContract({ address: usdt.address, abi: erc20Abi, functionName: 'balanceOf', args: [merchant.address] });
  assert.equal(merchantUsdt, parseUnits('119.4', 6));
  ok('merchant withdrew 119.4 USDT');

  // ---- USDC (standard token, no reset needed) with an expiry that passes
  await faucet({ ...customerCtx, token: usdc, amount: parseUnits('500', 6) });
  const short = await createInvoice({
    ...merchantCtx,
    token: usdc.address,
    amount: parseUnits('10', 6),
    expiresAt: (await publicClient.getBlock()).timestamp + 60n,
    orderRef: zeroHash,
  });
  const shortInvoice = (await readInvoice(publicClient, gateway, short.id))!;
  await advanceTime(120);
  await assert.rejects(
    () => payInvoice({ ...customerCtx, invoice: shortInvoice, token: usdc }),
    (error) => {
      assert.match(friendlyError(error), /expired/i);
      return true;
    },
  );
  ok('expired invoice is rejected with a readable message');

  const ok2 = await createInvoice({ ...merchantCtx, token: usdc.address, amount: parseUnits('42.5', 6), expiresAt: 0n, orderRef: zeroHash });
  const usdcSteps: PayStep[] = [];
  await payInvoice({ ...customerCtx, invoice: (await readInvoice(publicClient, gateway, ok2.id))!, token: usdc, onStep: (s) => usdcSteps.push(s) });
  assert.deepEqual(usdcSteps.filter((s, i) => usdcSteps.indexOf(s) === i), ['approve', 'pay']);
  ok('USDC payment went through approve, pay');

  // ---- cancel
  const toCancel = await createInvoice({ ...merchantCtx, token: usdc.address, amount: parseUnits('5', 6), expiresAt: 0n, orderRef: zeroHash });
  await cancelInvoice({ ...merchantCtx, invoiceId: toCancel.id });
  assert.equal((await readInvoice(publicClient, gateway, toCancel.id))?.status, InvoiceStatus.Cancelled);
  const cancelledInvoice = (await readInvoice(publicClient, gateway, toCancel.id))!;
  await assert.rejects(() => payInvoice({ ...customerCtx, invoice: cancelledInvoice, token: usdc }));
  ok('cancelled invoice cannot be paid');

  const all = await scanMerchantEvents(publicClient, gateway, merchant.address, deployBlock);
  const finalRows = buildRows(all.created, all.paid, all.cancelled, Number((await publicClient.getBlock()).timestamp));
  assert.deepEqual(
    finalRows.map((r) => [Number(r.id), r.status]),
    [
      [Number(toCancel.id), 'cancelled'],
      [Number(ok2.id), 'paid'],
      [Number(short.id), 'expired'],
      [Number(created.id), 'paid'],
    ],
  );
  ok('final dashboard rows: cancelled, paid, expired, paid');

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error('\nE2E FAILED');
  console.error(error);
  process.exit(1);
});
