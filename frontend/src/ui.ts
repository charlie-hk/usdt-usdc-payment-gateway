import type { Address, Chain } from 'viem';
import { h, copyText } from './dom';
import { WALLETCONNECT_PROJECT_ID, type AppContext } from './config';
import { addressUrl, txUrl } from './lib/chains';
import { friendlyError } from './lib/gateway';
import { shortAddress, shortHash } from './lib/format';
import type { RowStatus } from './lib/types';
import { qrDataUrl } from './qr';
import { connectInjected, connectWalletConnect, disconnect, ensureChain, hasInjectedWallet, wallet } from './wallet';

export function notice(kind: 'info' | 'error' | 'success' | 'warn', ...content: (Node | string)[]): HTMLElement {
  return h('div', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, ...content);
}

export function statusBadge(status: RowStatus | 'unknown'): HTMLElement {
  return h('span', { class: `badge ${status}` }, status);
}

export function explorerLink(chain: Chain, kind: 'tx' | 'address', value: string): Node {
  const text = kind === 'tx' ? shortHash(value) : shortAddress(value);
  const href = kind === 'tx' ? txUrl(chain, value) : addressUrl(chain, value);
  if (!href) return h('code', { title: value }, text);
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', title: value }, h('code', null, text));
}

export function notDeployedNotice(): HTMLElement {
  return notice(
    'warn',
    h('strong', null, 'Contracts are not deployed yet. '),
    'Run the deployment script (see the README), which fills in ',
    h('code', null, 'frontend/public/deployment.json'),
    ', then reload this page.',
  );
}

/** Buttons to connect a wallet. Calls `onError` with a readable message when a connection fails. */
export function connectPanel(ctx: AppContext, onError: (message: string) => void): HTMLElement {
  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      onError(friendlyError(error));
    }
  };

  const injectedButton = h(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      disabled: !hasInjectedWallet(),
      title: hasInjectedWallet() ? '' : 'No browser wallet detected',
      onclick: () => run(() => connectInjected(ctx.chain)),
    },
    'Browser wallet',
  );

  const walletConnectUsable = Boolean(WALLETCONNECT_PROJECT_ID) && ctx.chain.id !== 31337;
  const walletConnectButton = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      disabled: !walletConnectUsable,
      title: walletConnectUsable ? '' : 'Set VITE_WALLETCONNECT_PROJECT_ID to enable WalletConnect',
      onclick: () => run(() => connectWalletConnect(ctx.chain, WALLETCONNECT_PROJECT_ID, ctx.rpcUrl)),
    },
    'WalletConnect',
  );

  return h('div', { class: 'row gap' }, injectedButton, walletConnectButton);
}

/** Shows a "wrong network" prompt when the wallet is not on the deployment's chain. */
export function networkGuard(ctx: AppContext, onError: (message: string) => void): HTMLElement | null {
  if (!wallet.account || wallet.chainId === ctx.chain.id) return null;
  return notice(
    'warn',
    `Your wallet is on a different network. This gateway runs on ${ctx.chain.name}. `,
    h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        onclick: async () => {
          try {
            await ensureChain(ctx.chain);
          } catch (error) {
            onError(friendlyError(error));
          }
        },
      },
      `Switch to ${ctx.chain.name}`,
    ),
  );
}

export function walletBar(ctx: AppContext, onError: (message: string) => void): HTMLElement {
  const network = h('span', { class: 'pill' }, ctx.chain.name);
  if (!wallet.account) {
    return h('div', { class: 'row gap center' }, network, connectPanel(ctx, onError));
  }
  return h(
    'div',
    { class: 'row gap center' },
    network,
    h('span', { class: 'pill mono', title: wallet.account }, shortAddress(wallet.account)),
    h('button', { class: 'btn small', type: 'button', onclick: () => void disconnect() }, 'Disconnect'),
  );
}

/** A QR code plus the link it encodes, with a copy button. */
export function qrBlock(url: string, caption?: string): HTMLElement {
  const img = h('img', { class: 'qr', alt: 'QR code for the checkout link', width: 264, height: 264 });
  void qrDataUrl(url).then((src) => img.setAttribute('src', src));

  const copyButton = h('button', { class: 'btn small', type: 'button' }, 'Copy link');
  copyButton.addEventListener('click', async () => {
    const ok = await copyText(url);
    copyButton.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => (copyButton.textContent = 'Copy link'), 1500);
  });

  return h(
    'div',
    { class: 'qr-block' },
    img,
    caption ? h('p', { class: 'muted center-text' }, caption) : null,
    h('a', { class: 'link-line mono', href: url, target: '_blank', rel: 'noopener noreferrer' }, url),
    copyButton,
  );
}

export function showQrDialog(title: string, url: string): void {
  const dialog = h('dialog', { class: 'dialog' });
  dialog.append(
    h('h3', null, title),
    qrBlock(url, 'Scan with a phone camera or wallet app to open the checkout.'),
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Close')),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

export function addressText(address: Address | undefined): string {
  return address ? shortAddress(address) : '—';
}
