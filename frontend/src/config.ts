import type { Chain } from 'viem';
import { createPublicClient, http, type PublicClient } from 'viem';
import { chainById } from './lib/chains';
import type { Deployment, TokenInfo } from './lib/types';

export const WALLETCONNECT_PROJECT_ID: string = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ?? '';
const SEPOLIA_RPC_URL: string = (import.meta.env.VITE_SEPOLIA_RPC_URL as string | undefined) ?? '';

export interface AppContext {
  deployment: Deployment;
  chain: Chain;
  rpcUrl: string;
  publicClient: PublicClient;
  tokens: TokenInfo[];
  /** Undefined until the contracts have been deployed and public/deployment.json filled in. */
  gateway: Deployment['gateway'];
}

export async function loadContext(): Promise<AppContext> {
  const response = await fetch(`${import.meta.env.BASE_URL}deployment.json`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load deployment.json (HTTP ${response.status})`);
  const deployment = (await response.json()) as Deployment;

  const chain = chainById(deployment.chainId);
  if (!chain) throw new Error(`deployment.json uses chain ${deployment.chainId}, which this app does not support.`);

  const rpcUrl = chain.id === 11155111 && SEPOLIA_RPC_URL ? SEPOLIA_RPC_URL : chain.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;

  return { deployment, chain, rpcUrl, publicClient, tokens: deployment.tokens, gateway: deployment.gateway };
}

/** Link that the QR code encodes. Hash routing keeps it working on any static host. */
export function checkoutUrl(invoiceId: bigint): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#/pay/${invoiceId}`;
}
