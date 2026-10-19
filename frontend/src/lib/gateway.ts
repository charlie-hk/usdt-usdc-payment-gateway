// Contract interaction layer. DOM-free on purpose so the same code runs in the browser UI
// and in the Node end-to-end script (e2e/local-e2e.ts).
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  erc20Abi,
  getAbiItem,
  parseEventLogs,
  type Abi,
  type AbiEvent,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import gatewayAbiJson from '../abi/PaymentGateway.json';
import {
  InvoiceStatus,
  type CancelledEvent,
  type CreatedEvent,
  type Invoice,
  type InvoiceRow,
  type PaidEvent,
  type TokenInfo,
} from './types';

export const gatewayAbi = gatewayAbiJson as Abi;

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/* -------------------------------------------------------------------------- */
/*                                   Errors                                   */
/* -------------------------------------------------------------------------- */

const ERROR_TEXT: Record<string, string> = {
  InvoiceExpired: 'This invoice has expired.',
  InvoiceNotPending: 'This invoice has already been paid or was cancelled.',
  InvoiceNotFound: 'This invoice does not exist.',
  TokenNotSupported: 'This token is not accepted by the gateway.',
  EnforcedPause: 'The gateway is paused right now. Try again later.',
  UnexpectedTransferAmount: 'The token delivered a different amount than expected (fee-on-transfer tokens are not supported).',
  InsufficientBalance: 'The requested amount is more than the available balance.',
  NotMerchant: 'Only the merchant who created the invoice can do this.',
  ZeroAmount: 'The amount must be greater than zero.',
  InvalidExpiry: 'The expiry must be in the future.',
};

export function revertName(error: unknown): string | undefined {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName;
  }
  return undefined;
}

export function friendlyError(error: unknown): string {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) {
      return 'You rejected the request in your wallet.';
    }
    const name = revertName(error);
    if (name && ERROR_TEXT[name]) return ERROR_TEXT[name];
    if (name) return `The contract rejected the call (${name}).`;
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

type ReplayCall = {
  account: Address;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
};

/**
 * Waits for a transaction to be mined. When it was mined but reverted, the receipt carries no reason,
 * so the same call is replayed against that block to recover the contract's error. The thrown error is
 * then a normal viem revert error, which `friendlyError` already turns into readable text.
 */
async function waitForSuccess(publicClient: PublicClient, hash: Hash, replay: ReplayCall): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === 'success') return;
  // Throws the decoded revert error when the failure can be reproduced.
  await publicClient.simulateContract({ ...replay, blockNumber: receipt.blockNumber } as never);
  throw new Error(`The transaction reverted on-chain and the reason could not be recovered (${hash}).`);
}

/* -------------------------------------------------------------------------- */
/*                                    Reads                                   */
/* -------------------------------------------------------------------------- */

export async function readInvoice(client: PublicClient, gateway: Address, id: bigint): Promise<Invoice | null> {
  try {
    const raw = (await client.readContract({
      address: gateway,
      abi: gatewayAbi,
      functionName: 'getInvoice',
      args: [id],
    })) as {
      merchant: Address;
      expiresAt: bigint | number;
      status: number;
      token: Address;
      paidAt: bigint | number;
      payer: Address;
      amount: bigint;
    };
    return {
      id,
      merchant: raw.merchant,
      expiresAt: BigInt(raw.expiresAt),
      status: Number(raw.status) as InvoiceStatus,
      token: raw.token,
      paidAt: BigInt(raw.paidAt),
      payer: raw.payer,
      amount: raw.amount,
    };
  } catch (error) {
    if (revertName(error) === 'InvoiceNotFound') return null;
    throw error;
  }
}

export async function readMerchantBalance(
  client: PublicClient,
  gateway: Address,
  merchant: Address,
  token: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: gateway,
    abi: gatewayAbi,
    functionName: 'merchantBalance',
    args: [merchant, token],
  })) as bigint;
}

export async function readTokenState(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<{ balance: bigint; allowance: bigint }> {
  const [balance, allowance] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }),
  ]);
  return { balance, allowance };
}

/* -------------------------------------------------------------------------- */
/*                                   Writes                                   */
/* -------------------------------------------------------------------------- */

interface WriteContext {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chain: Chain;
  account: Address;
  gateway: Address;
}

export async function createInvoice(
  ctx: WriteContext & { token: Address; amount: bigint; expiresAt: bigint; orderRef: Hex },
): Promise<{ id: bigint; hash: Hash }> {
  const args = [ctx.token, ctx.amount, ctx.expiresAt, ctx.orderRef] as const;

  // Simulating first turns reverts into readable errors before the wallet pops up.
  await ctx.publicClient.simulateContract({
    account: ctx.account,
    address: ctx.gateway,
    abi: gatewayAbi,
    functionName: 'createInvoice',
    args,
  });

  const hash = await ctx.walletClient.writeContract({
    account: ctx.account,
    chain: ctx.chain,
    address: ctx.gateway,
    abi: gatewayAbi,
    functionName: 'createInvoice',
    args,
  });
  await waitForSuccess(ctx.publicClient, hash, {
    account: ctx.account,
    address: ctx.gateway,
    abi: gatewayAbi,
    functionName: 'createInvoice',
    args,
  });
  const receipt = await ctx.publicClient.getTransactionReceipt({ hash });

  const logs = parseEventLogs({ abi: gatewayAbi, eventName: 'InvoiceCreated', logs: receipt.logs }).filter((log) =>
    sameAddress(log.address, ctx.gateway),
  );
  if (logs.length === 0) throw new Error('Invoice was created but the event could not be found in the receipt.');
  const { invoiceId } = logs[0].args as unknown as { invoiceId: bigint };
  return { id: invoiceId, hash };
}

export async function cancelInvoice(ctx: WriteContext & { invoiceId: bigint }): Promise<Hash> {
  const hash = await ctx.walletClient.writeContract({
    account: ctx.account,
    chain: ctx.chain,
    address: ctx.gateway,
    abi: gatewayAbi,
    functionName: 'cancelInvoice',
    args: [ctx.invoiceId],
  });
  await waitForSuccess(ctx.publicClient, hash, {
    account: ctx.account,
    address: ctx.gateway,
    abi: gatewayAbi,
    functionName: 'cancelInvoice',
    args: [ctx.invoiceId],
  });
  return hash;
}

export async function withdraw(ctx: WriteContext & { token: Address; to: Address; amount: bigint }): Promise<Hash> {
  const hash = await ctx.walletClient.writeContract({
    account: ctx.account,
    chain: ctx.chain,
    address: ctx.gateway,
    abi: gatewayAbi,
    functionName: 'withdraw',
    args: [ctx.token, ctx.to, ctx.amount],
  });
  await waitForSuccess(ctx.publicClient, hash, {
    account: ctx.account,
    address: ctx.gateway,
    abi: gatewayAbi,
    functionName: 'withdraw',
    args: [ctx.token, ctx.to, ctx.amount],
  });
  return hash;
}

export async function faucet(ctx: WriteContext & { token: TokenInfo; amount: bigint }): Promise<Hash> {
  const faucetAbi = [{ type: 'function', name: 'faucet', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] }] as const;
  const hash = await ctx.walletClient.writeContract({
    account: ctx.account,
    chain: ctx.chain,
    address: ctx.token.address,
    abi: faucetAbi,
    functionName: 'faucet',
    args: [ctx.amount],
  });
  await waitForSuccess(ctx.publicClient, hash, {
    account: ctx.account,
    address: ctx.token.address,
    abi: faucetAbi as unknown as Abi,
    functionName: 'faucet',
    args: [ctx.amount],
  });
  return hash;
}

export type PayStep = 'reset-allowance' | 'approve' | 'pay';

/**
 * Pays an invoice: approve (resetting to zero first for USDT-style tokens when needed), then `pay`.
 * Skips the approval entirely when the existing allowance already covers the amount.
 */
export async function payInvoice(
  ctx: WriteContext & {
    invoice: Invoice;
    token: TokenInfo;
    onStep?: (step: PayStep, hash?: Hash) => void;
  },
): Promise<Hash> {
  const { publicClient, walletClient, chain, account, gateway, invoice, token } = ctx;

  const { balance, allowance } = await readTokenState(publicClient, token.address, account, gateway);
  if (balance < invoice.amount) {
    throw new Error(`Your ${token.symbol} balance is lower than the invoice amount.`);
  }

  const approve = async (value: bigint) => {
    const hash = await walletClient.writeContract({
      account,
      chain,
      address: token.address,
      abi: erc20Abi,
      functionName: 'approve',
      args: [gateway, value],
    });
    await waitForSuccess(publicClient, hash, {
      account,
      address: token.address,
      abi: erc20Abi as unknown as Abi,
      functionName: 'approve',
      args: [gateway, value],
    });
    return hash;
  };

  if (allowance < invoice.amount) {
    if (token.requiresAllowanceReset && allowance > 0n) {
      ctx.onStep?.('reset-allowance');
      await approve(0n);
    }
    ctx.onStep?.('approve');
    await approve(invoice.amount); // exact amount, never unlimited
  }

  ctx.onStep?.('pay');
  const simulate = () =>
    publicClient.simulateContract({
      account,
      address: gateway,
      abi: gatewayAbi,
      functionName: 'pay',
      args: [invoice.id],
    });
  try {
    await simulate();
  } catch (first) {
    // A load-balanced RPC can briefly serve state from before the approval block; retry once.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      await simulate();
    } catch {
      throw first;
    }
  }

  const hash = await walletClient.writeContract({
    account,
    chain,
    address: gateway,
    abi: gatewayAbi,
    functionName: 'pay',
    args: [invoice.id],
  });
  ctx.onStep?.('pay', hash);
  await waitForSuccess(publicClient, hash, {
    account,
    address: gateway,
    abi: gatewayAbi,
    functionName: 'pay',
    args: [invoice.id],
  });
  return hash;
}

/* -------------------------------------------------------------------------- */
/*                               Event scanning                               */
/* -------------------------------------------------------------------------- */

const eventItem = (name: string) => getAbiItem({ abi: gatewayAbi, name }) as AbiEvent;

/** getLogs over a long block range, shrinking the window when the RPC provider rejects it. */
async function getLogsChunked(
  client: PublicClient,
  params: { address: Address; event: AbiEvent; args: Record<string, unknown>; fromBlock: bigint; toBlock: bigint },
) {
  const out: Awaited<ReturnType<PublicClient['getLogs']>> = [];
  let from = params.fromBlock;
  let step = 50_000n;
  while (from <= params.toBlock) {
    const to = from + step - 1n > params.toBlock ? params.toBlock : from + step - 1n;
    try {
      const logs = await client.getLogs({
        address: params.address,
        event: params.event,
        args: params.args,
        fromBlock: from,
        toBlock: to,
      });
      out.push(...logs);
      from = to + 1n;
    } catch (error) {
      if (step <= 500n) throw error;
      step = step / 2n;
    }
  }
  return out;
}

export interface MerchantEvents {
  created: CreatedEvent[];
  paid: PaidEvent[];
  cancelled: CancelledEvent[];
  toBlock: bigint;
}

export async function scanMerchantEvents(
  client: PublicClient,
  gateway: Address,
  merchant: Address,
  fromBlock: bigint,
  toBlock?: bigint,
): Promise<MerchantEvents> {
  // cacheTime: 0 because viem otherwise reuses the block number for ~4s, which would hide a
  // transaction the user confirmed a moment ago when they press Refresh.
  const latest = toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  if (fromBlock > latest) return { created: [], paid: [], cancelled: [], toBlock: latest };

  const base = { address: gateway, fromBlock, toBlock: latest };
  const [createdLogs, paidLogs, cancelledLogs] = await Promise.all([
    getLogsChunked(client, { ...base, event: eventItem('InvoiceCreated'), args: { merchant } }),
    getLogsChunked(client, { ...base, event: eventItem('InvoicePaid'), args: { merchant } }),
    getLogsChunked(client, { ...base, event: eventItem('InvoiceCancelled'), args: { merchant } }),
  ]);

  type Args = Record<string, unknown>;
  return {
    toBlock: latest,
    created: createdLogs.map((log) => {
      const a = (log as unknown as { args: Args }).args;
      return {
        id: a.invoiceId as bigint,
        merchant: a.merchant as Address,
        token: a.token as Address,
        amount: a.amount as bigint,
        expiresAt: BigInt(a.expiresAt as bigint | number),
        orderRef: a.orderRef as Hex,
        txHash: log.transactionHash as Hash,
      };
    }),
    paid: paidLogs.map((log) => {
      const a = (log as unknown as { args: Args }).args;
      return {
        id: a.invoiceId as bigint,
        merchant: a.merchant as Address,
        payer: a.payer as Address,
        token: a.token as Address,
        amount: a.amount as bigint,
        fee: a.fee as bigint,
        txHash: log.transactionHash as Hash,
      };
    }),
    cancelled: cancelledLogs.map((log) => {
      const a = (log as unknown as { args: Args }).args;
      return { id: a.invoiceId as bigint, txHash: log.transactionHash as Hash };
    }),
  };
}

/** Folds raw events into one row per invoice, newest first. `nowSec` decides pending vs expired. */
export function buildRows(
  created: CreatedEvent[],
  paid: PaidEvent[],
  cancelled: CancelledEvent[],
  nowSec: number,
): InvoiceRow[] {
  const paidById = new Map(paid.map((p) => [p.id, p]));
  const cancelledIds = new Set(cancelled.map((c) => c.id));

  return created
    .map((c): InvoiceRow => {
      const p = paidById.get(c.id);
      let status: InvoiceRow['status'] = 'pending';
      if (p) status = 'paid';
      else if (cancelledIds.has(c.id)) status = 'cancelled';
      else if (c.expiresAt !== 0n && BigInt(nowSec) > c.expiresAt) status = 'expired';
      return {
        id: c.id,
        token: c.token,
        amount: c.amount,
        expiresAt: c.expiresAt,
        orderRef: c.orderRef,
        status,
        createdTx: c.txHash,
        payer: p?.payer,
        fee: p?.fee,
        paidTx: p?.txHash,
      };
    })
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}
