import { defineChain, type Chain } from 'viem';
import { sepolia } from 'viem/chains';

export const localChain = defineChain({
  id: 31337,
  name: 'Hardhat Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

/** Chains this app knows how to talk to. */
export function chainById(id: number): Chain | null {
  if (id === sepolia.id) return sepolia;
  if (id === localChain.id) return localChain;
  return null;
}

export function explorerBase(chain: Chain): string | null {
  return chain.blockExplorers?.default.url ?? null;
}

export function txUrl(chain: Chain, hash: string): string | null {
  const base = explorerBase(chain);
  return base ? `${base}/tx/${hash}` : null;
}

export function addressUrl(chain: Chain, address: string): string | null {
  const base = explorerBase(chain);
  return base ? `${base}/address/${address}` : null;
}
