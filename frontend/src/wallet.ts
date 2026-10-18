import {
  createWalletClient,
  custom,
  getAddress,
  type Address,
  type Chain,
  type EIP1193Provider,
  type WalletClient,
} from 'viem';

export type WalletKind = 'injected' | 'walletconnect';

interface WalletState {
  account: Address | null;
  chainId: number | null;
  walletClient: WalletClient | null;
  provider: EIP1193Provider | null;
  kind: WalletKind | null;
}

export const wallet: WalletState = { account: null, chainId: null, walletClient: null, provider: null, kind: null };

const listeners = new Set<() => void>();
export function onWalletChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => listeners.forEach((fn) => fn());

export function hasInjectedWallet(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { ethereum?: unknown }).ethereum);
}

let detach: (() => void) | null = null;

async function attach(provider: EIP1193Provider, kind: WalletKind, chain: Chain, accounts?: readonly string[]) {
  detach?.();

  const granted = accounts ?? ((await provider.request({ method: 'eth_requestAccounts' })) as string[]);
  if (granted.length === 0) throw new Error('The wallet did not return an account.');
  const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as string;

  wallet.provider = provider;
  wallet.kind = kind;
  wallet.account = getAddress(granted[0]);
  wallet.chainId = Number(BigInt(chainIdHex));
  wallet.walletClient = createWalletClient({ account: wallet.account, chain, transport: custom(provider) });

  const onAccounts = (next: string[]) => {
    if (next.length === 0) {
      void disconnect();
      return;
    }
    wallet.account = getAddress(next[0]);
    wallet.walletClient = createWalletClient({ account: wallet.account, chain, transport: custom(provider) });
    emit();
  };
  const onChain = (hex: string) => {
    wallet.chainId = Number(BigInt(hex));
    emit();
  };
  const onDisconnect = () => void disconnect();

  provider.on('accountsChanged', onAccounts);
  provider.on('chainChanged', onChain);
  provider.on('disconnect', onDisconnect);
  detach = () => {
    provider.removeListener('accountsChanged', onAccounts);
    provider.removeListener('chainChanged', onChain);
    provider.removeListener('disconnect', onDisconnect);
  };

  emit();
}

export async function connectInjected(chain: Chain): Promise<void> {
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error('No browser wallet found. Install one, or use WalletConnect.');
  await attach(provider, 'injected', chain);
}

export async function connectWalletConnect(chain: Chain, projectId: string, rpcUrl: string): Promise<void> {
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  const provider = await EthereumProvider.init({
    projectId,
    chains: [chain.id],
    showQrModal: true,
    rpcMap: { [chain.id]: rpcUrl },
    metadata: {
      name: 'Stablecoin Payment Gateway',
      description: 'USDT / USDC invoice checkout (testnet demo)',
      url: window.location.origin,
      icons: [],
    },
  });
  if (!provider.session) await provider.connect();
  await attach(provider as unknown as EIP1193Provider, 'walletconnect', chain, provider.accounts);
}

export async function disconnect(): Promise<void> {
  detach?.();
  detach = null;
  const provider = wallet.provider as (EIP1193Provider & { disconnect?: () => Promise<void> }) | null;
  const kind = wallet.kind;
  wallet.account = null;
  wallet.chainId = null;
  wallet.walletClient = null;
  wallet.provider = null;
  wallet.kind = null;
  emit();
  if (kind === 'walletconnect') {
    try {
      await provider?.disconnect?.();
    } catch {
      /* session already closed */
    }
  }
}

/** Asks the wallet to switch to `chain`, adding it first if the wallet does not know it. */
export async function ensureChain(chain: Chain): Promise<void> {
  const client = wallet.walletClient;
  if (!client || !wallet.provider) throw new Error('Connect a wallet first.');
  if (wallet.chainId === chain.id) return;
  try {
    await client.switchChain({ id: chain.id });
  } catch (error) {
    const code = (error as { code?: number }).code;
    const unknown = code === 4902 || /unrecognized chain|unknown chain|not been added/i.test(String((error as Error).message));
    if (!unknown) throw error;
    await client.addChain({ chain });
    await client.switchChain({ id: chain.id });
  }
  const hex = (await wallet.provider.request({ method: 'eth_chainId' })) as string;
  wallet.chainId = Number(BigInt(hex));
  emit();
}
