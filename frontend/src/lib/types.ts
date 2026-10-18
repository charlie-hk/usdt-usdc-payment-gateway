import type { Address, Hash, Hex } from 'viem';

export interface TokenInfo {
  key: string;
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  /** A test token deployed by this project (as opposed to Circle's official USDC). */
  mock: boolean;
  /** The token has an open `faucet(uint256)` for testing. */
  faucet: boolean;
  /** USDT-style approve: the allowance must be set to 0 before it can change to another non-zero value. */
  requiresAllowanceReset: boolean;
  permit: boolean;
}

export interface Deployment {
  network?: string;
  chainId: number;
  gateway: null | {
    address: Address;
    txHash?: Hash;
    blockNumber: number;
  };
  feeBps?: number;
  tokens: TokenInfo[];
}

/** Mirrors the contract's `Status` enum. */
export enum InvoiceStatus {
  None = 0,
  Pending = 1,
  Paid = 2,
  Cancelled = 3,
}

export interface Invoice {
  id: bigint;
  merchant: Address;
  expiresAt: bigint; // unix seconds, 0 = no expiry
  status: InvoiceStatus;
  token: Address;
  paidAt: bigint;
  payer: Address;
  amount: bigint;
}

export type RowStatus = 'pending' | 'paid' | 'cancelled' | 'expired';

export interface InvoiceRow {
  id: bigint;
  token: Address;
  amount: bigint;
  expiresAt: bigint;
  orderRef: Hex;
  status: RowStatus;
  createdTx: Hash;
  payer?: Address;
  fee?: bigint;
  paidTx?: Hash;
}

export interface CreatedEvent {
  id: bigint;
  merchant: Address;
  token: Address;
  amount: bigint;
  expiresAt: bigint;
  orderRef: Hex;
  txHash: Hash;
}
export interface PaidEvent {
  id: bigint;
  merchant: Address;
  payer: Address;
  token: Address;
  amount: bigint;
  fee: bigint;
  txHash: Hash;
}
export interface CancelledEvent {
  id: bigint;
  txHash: Hash;
}
