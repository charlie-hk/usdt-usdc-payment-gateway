import { keccak256, toHex, zeroHash, type Address } from 'viem';
import { checkoutUrl, type AppContext } from '../config';
import { compact, h } from '../dom';
import {
  buildRows,
  cancelInvoice,
  friendlyError,
  readMerchantBalance,
  scanMerchantEvents,
  withdraw,
  createInvoice,
} from '../lib/gateway';
import { formatAmount, parseAmount } from '../lib/format';
import { loadLabel, saveLabel } from '../lib/labels';
import type { CancelledEvent, CreatedEvent, InvoiceRow, PaidEvent, TokenInfo } from '../lib/types';
import {
  addressText,
  connectPanel,
  explorerLink,
  networkGuard,
  notDeployedNotice,
  notice,
  qrBlock,
  showQrDialog,
  statusBadge,
} from '../ui';
import { ensureChain, onWalletChange, wallet } from '../wallet';

const EXPIRY_OPTIONS: { label: string; seconds: number }[] = [
  { label: '15 minutes', seconds: 900 },
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 86_400 },
  { label: '7 days', seconds: 604_800 },
  { label: 'No expiry', seconds: 0 },
];

export function renderMerchant(root: HTMLElement, ctx: AppContext): () => void {
  let disposed = false;
  let stopDashboard: (() => void) | null = null;
  let lastKey = '';

  const mount = () => {
    stopDashboard?.();
    stopDashboard = null;
    root.replaceChildren();
    lastKey = `${wallet.account}:${wallet.chainId}`;

    root.append(
      h(
        'section',
        { class: 'intro' },
        h('h1', null, 'Merchant console'),
        h(
          'p',
          { class: 'muted' },
          'Create an invoice, show the QR code to your customer, and watch the payment arrive. Funds are held by the contract and you withdraw them whenever you like.',
        ),
      ),
    );

    if (!ctx.gateway) {
      root.append(notDeployedNotice());
      return;
    }

    const errorSlot = h('div');
    const showError = (message: string) => errorSlot.replaceChildren(notice('error', message));

    if (!wallet.account) {
      root.append(
        h(
          'section',
          { class: 'card' },
          h('h2', null, 'Connect your wallet'),
          h('p', { class: 'muted' }, 'The connected address becomes the merchant: it owns the invoices you create and can withdraw their proceeds.'),
          connectPanel(ctx, showError),
          errorSlot,
        ),
      );
      return;
    }

    const merchant = wallet.account;
    const guard = networkGuard(ctx, showError);
    if (guard) root.append(guard);

    const resultSlot = h('div');
    const dashboardSlot = h('section', { class: 'card' });

    const dashboard = mountDashboard(dashboardSlot, ctx, merchant, showError);
    stopDashboard = dashboard.stop;

    root.append(buildCreateForm(ctx, merchant, resultSlot, errorSlot, dashboard.refresh), errorSlot, resultSlot, dashboardSlot);
  };

  mount();

  const unsubscribe = onWalletChange(() => {
    if (disposed) return;
    const key = `${wallet.account}:${wallet.chainId}`;
    if (key !== lastKey) mount();
  });

  return () => {
    disposed = true;
    unsubscribe();
    stopDashboard?.();
  };
}

/* -------------------------------------------------------------------------- */
/*                               Create invoice                               */
/* -------------------------------------------------------------------------- */

function buildCreateForm(
  ctx: AppContext,
  merchant: Address,
  resultSlot: HTMLElement,
  errorSlot: HTMLElement,
  refreshDashboard: () => Promise<void>,
): HTMLElement {
  const gateway = ctx.gateway!.address;

  const tokenSelect = h(
    'select',
    { id: 'token', name: 'token' },
    ...ctx.tokens.map((t) => h('option', { value: t.address }, `${t.symbol}${t.mock ? ' (test token)' : ''}`)),
  );
  const amountInput = h('input', {
    id: 'amount',
    name: 'amount',
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    placeholder: '25.00',
    required: true,
  });
  const expirySelect = h(
    'select',
    { id: 'expiry', name: 'expiry' },
    ...EXPIRY_OPTIONS.map((o, i) => h('option', { value: String(o.seconds), selected: i === 1 }, o.label)),
  );
  const labelInput = h('input', {
    id: 'label',
    name: 'label',
    type: 'text',
    maxlength: 80,
    autocomplete: 'off',
    placeholder: 'Order #1042 (optional)',
  });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create invoice');

  const form = h(
    'form',
    { class: 'card form', novalidate: true },
    h('h2', null, 'New invoice'),
    h('div', { class: 'grid2' },
      h('label', { for: 'token' }, 'Token', tokenSelect),
      h('label', { for: 'amount' }, 'Amount', amountInput),
      h('label', { for: 'expiry' }, 'Payable for', expirySelect),
      h('label', { for: 'label' }, 'Reference', labelInput),
    ),
    h('p', { class: 'muted small-text' }, 'The reference is stored on-chain only as a hash; the readable text stays in this browser.'),
    h('div', { class: 'row' }, submit),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorSlot.replaceChildren();

    const token = ctx.tokens.find((t) => t.address === tokenSelect.value) as TokenInfo;
    const amount = parseAmount(amountInput.value, token.decimals);
    if (amount === null) {
      errorSlot.replaceChildren(notice('error', `Enter a positive amount with at most ${token.decimals} decimal places.`));
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Waiting for wallet…';
    try {
      await ensureChain(ctx.chain);
      const walletClient = wallet.walletClient!;
      const seconds = BigInt(expirySelect.value);
      const block = await ctx.publicClient.getBlock();
      const expiresAt = seconds === 0n ? 0n : block.timestamp + seconds;
      const label = labelInput.value.trim();
      const orderRef = label ? keccak256(toHex(label)) : zeroHash;

      const { id } = await createInvoice({
        publicClient: ctx.publicClient,
        walletClient,
        chain: ctx.chain,
        account: merchant,
        gateway,
        token: token.address,
        amount,
        expiresAt,
        orderRef,
      });
      saveLabel(ctx.chain.id, gateway, id, label);

      const url = checkoutUrl(id);
      resultSlot.replaceChildren(
        h(
          'section',
          { class: 'card success-card' },
          h('h2', null, `Invoice #${id} is ready`),
          h('p', { class: 'amount-line' }, `${formatAmount(amount, token.decimals)} ${token.symbol}`),
          qrBlock(url, 'Show this to your customer. The page flips to “Paid” the moment the payment confirms.'),
          h('div', { class: 'row center-row' }, h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open checkout page')),
        ),
      );
      amountInput.value = '';
      labelInput.value = '';
      void refreshDashboard();
    } catch (error) {
      errorSlot.replaceChildren(notice('error', friendlyError(error)));
    } finally {
      submit.disabled = false;
      submit.textContent = 'Create invoice';
    }
  });

  return form;
}

/* -------------------------------------------------------------------------- */
/*                                  Dashboard                                 */
/* -------------------------------------------------------------------------- */

function mountDashboard(
  container: HTMLElement,
  ctx: AppContext,
  merchant: Address,
  showError: (message: string) => void,
): { stop: () => void; refresh: () => Promise<void> } {
  const gateway = ctx.gateway!.address;
  const created: CreatedEvent[] = [];
  const paid: PaidEvent[] = [];
  const cancelled: CancelledEvent[] = [];
  let scannedTo = BigInt(ctx.gateway!.blockNumber) - 1n;
  let balances = new Map<string, bigint>();
  let loading = true;
  let loadError = '';
  let busyAction = '';
  let stopped = false;
  let inFlight = false;

  const tokenFor = (address: string): TokenInfo | undefined =>
    ctx.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
  const money = (value: bigint, address: string) => {
    const token = tokenFor(address);
    return token ? `${formatAmount(value, token.decimals)} ${token.symbol}` : `${value} (unknown token)`;
  };

  const refresh = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const events = await scanMerchantEvents(ctx.publicClient, gateway, merchant, scannedTo + 1n);
      created.push(...events.created);
      paid.push(...events.paid);
      cancelled.push(...events.cancelled);
      scannedTo = events.toBlock;

      const next = new Map<string, bigint>();
      await Promise.all(
        ctx.tokens.map(async (t) => {
          next.set(t.address, await readMerchantBalance(ctx.publicClient, gateway, merchant, t.address));
        }),
      );
      balances = next;
      loadError = '';
    } catch (error) {
      loadError = friendlyError(error);
    } finally {
      loading = false;
      inFlight = false;
      if (!stopped) render();
    }
  };

  const act = async (label: string, action: () => Promise<unknown>) => {
    busyAction = label;
    render();
    try {
      await ensureChain(ctx.chain);
      await action();
    } catch (error) {
      showError(friendlyError(error));
    } finally {
      busyAction = '';
      await refresh();
    }
  };

  const writeCtx = () => ({
    publicClient: ctx.publicClient,
    walletClient: wallet.walletClient!,
    chain: ctx.chain,
    account: merchant,
    gateway,
  });

  const render = () => {
    const rows = buildRows(created, paid, cancelled, Math.floor(Date.now() / 1000));

    const head = h(
      'div',
      { class: 'row between center' },
      h('h2', null, 'Dashboard'),
      h('button', { class: 'btn small', type: 'button', onclick: () => void refresh(), disabled: inFlight }, inFlight ? 'Refreshing…' : 'Refresh'),
    );

    if (loading) {
      container.replaceChildren(head, h('p', { class: 'muted' }, 'Loading your invoices from the chain…'));
      return;
    }

    // Per-token tiles
    const tiles = ctx.tokens.map((token) => {
      const mine = rows.filter((r) => r.status === 'paid' && r.token.toLowerCase() === token.address.toLowerCase());
      const gross = mine.reduce((sum, r) => sum + r.amount, 0n);
      const fees = mine.reduce((sum, r) => sum + (r.fee ?? 0n), 0n);
      const withdrawable = balances.get(token.address) ?? 0n;
      const key = `withdraw:${token.address}`;
      return h(
        'div',
        { class: 'tile' },
        h('div', { class: 'tile-title' }, token.symbol),
        h('div', { class: 'tile-value' }, formatAmount(withdrawable, token.decimals)),
        h('div', { class: 'muted small-text' }, 'available to withdraw'),
        h('dl', { class: 'mini-stats' },
          h('dt', null, 'Paid invoices'), h('dd', null, String(mine.length)),
          h('dt', null, 'Received (gross)'), h('dd', null, formatAmount(gross, token.decimals)),
          h('dt', null, 'Fees'), h('dd', null, formatAmount(fees, token.decimals)),
        ),
        h(
          'button',
          {
            class: 'btn small primary',
            type: 'button',
            disabled: withdrawable === 0n || busyAction !== '',
            onclick: () => act(key, () => withdraw({ ...writeCtx(), token: token.address, to: merchant, amount: withdrawable })),
          },
          busyAction === key ? 'Withdrawing…' : 'Withdraw all',
        ),
      );
    });

    const tableBody = rows.map((row) => renderRow(row));
    const table =
      rows.length === 0
        ? h('p', { class: 'muted' }, 'No invoices yet. Create your first one above.')
        : h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              null,
              h('thead', null, h('tr', null, ...['#', 'Reference', 'Amount', 'Status', 'Payer', ''].map((t) => h('th', null, t)))),
              h('tbody', null, ...tableBody),
            ),
          );

    container.replaceChildren(
      ...compact([
        head,
        loadError ? notice('error', `Could not refresh: ${loadError}`) : null,
        h('div', { class: 'tiles' }, ...tiles),
        h('h3', null, 'Invoices'),
        table,
      ]),
    );
  };

  const renderRow = (row: InvoiceRow): HTMLElement => {
    const token = tokenFor(row.token);
    const label = loadLabel(ctx.chain.id, gateway, row.id);
    const cancelKey = `cancel:${row.id}`;
    const actions: Node[] = [
      h('button', { class: 'btn small', type: 'button', onclick: () => showQrDialog(`Invoice #${row.id}`, checkoutUrl(row.id)) }, 'QR'),
    ];
    if (row.status === 'pending') {
      actions.push(
        h(
          'button',
          {
            class: 'btn small danger',
            type: 'button',
            disabled: busyAction !== '',
            onclick: () => act(cancelKey, () => cancelInvoice({ ...writeCtx(), invoiceId: row.id })),
          },
          busyAction === cancelKey ? 'Cancelling…' : 'Cancel',
        ),
      );
    }
    return h(
      'tr',
      null,
      h('td', { class: 'mono' }, String(row.id)),
      h('td', null, label || (row.orderRef === zeroHash ? '—' : h('span', { class: 'muted', title: row.orderRef }, 'hash only'))),
      h('td', { class: 'nowrap' }, token ? `${formatAmount(row.amount, token.decimals)} ${token.symbol}` : money(row.amount, row.token)),
      h('td', null, statusBadge(row.status)),
      h(
        'td',
        null,
        row.payer ? explorerLink(ctx.chain, 'address', row.payer) : addressText(undefined),
        row.paidTx ? h('div', { class: 'muted small-text' }, 'tx ', explorerLink(ctx.chain, 'tx', row.paidTx)) : null,
      ),
      h('td', { class: 'actions' }, ...actions),
    );
  };

  render();
  void refresh();
  const timer = window.setInterval(() => void refresh(), 15_000);

  return {
    refresh,
    stop: () => {
      stopped = true;
      window.clearInterval(timer);
    },
  };
}
