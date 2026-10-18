import { parseUnits, type Hash } from 'viem';
import { checkoutUrl, type AppContext } from '../config';
import { compact, h } from '../dom';
import { faucet, friendlyError, payInvoice, readInvoice, readTokenState, type PayStep } from '../lib/gateway';
import { formatAmount, formatDuration } from '../lib/format';
import { InvoiceStatus, type Invoice, type RowStatus, type TokenInfo } from '../lib/types';
import {
  connectPanel,
  explorerLink,
  networkGuard,
  notDeployedNotice,
  notice,
  qrBlock,
  statusBadge,
} from '../ui';
import { ensureChain, onWalletChange, wallet } from '../wallet';

const STEP_LABEL: Record<PayStep, string> = {
  'reset-allowance': 'Reset previous allowance',
  approve: 'Approve token spending',
  pay: 'Confirm payment',
};

const FAUCET_AMOUNT_UNITS = 1_000;

export function renderPay(root: HTMLElement, ctx: AppContext, idText: string): () => void {
  root.replaceChildren();

  if (!/^\d+$/.test(idText)) {
    root.append(h('section', { class: 'card' }, h('h1', null, 'Invalid invoice link'), notice('error', 'The invoice number in this link is not valid.')));
    return () => undefined;
  }
  if (!ctx.gateway) {
    root.append(notDeployedNotice());
    return () => undefined;
  }

  const gateway = ctx.gateway.address;
  const invoiceId = BigInt(idText);

  const state: {
    invoice: Invoice | null | undefined; // undefined = loading, null = does not exist
    loadError: string;
    balance?: bigint;
    allowance?: bigint;
    busy: boolean;
    plan: PayStep[];
    step?: PayStep;
    doneSteps: Set<PayStep>;
    error: string;
    paidTx?: Hash;
    faucetBusy: boolean;
  } = { invoice: undefined, loadError: '', busy: false, plan: [], doneSteps: new Set(), error: '', faucetBusy: false };

  let disposed = false;
  const view = h('div', { class: 'stack' });
  root.append(view);

  const tokenOf = (invoice: Invoice): TokenInfo | undefined =>
    ctx.tokens.find((t) => t.address.toLowerCase() === invoice.token.toLowerCase());

  const effectiveStatus = (invoice: Invoice): RowStatus => {
    if (invoice.status === InvoiceStatus.Paid) return 'paid';
    if (invoice.status === InvoiceStatus.Cancelled) return 'cancelled';
    if (invoice.expiresAt !== 0n && BigInt(Math.floor(Date.now() / 1000)) > invoice.expiresAt) return 'expired';
    return 'pending';
  };

  const loadInvoice = async () => {
    try {
      state.invoice = await readInvoice(ctx.publicClient, gateway, invoiceId);
      state.loadError = '';
    } catch (error) {
      state.loadError = friendlyError(error);
      if (state.invoice === undefined) state.invoice = null;
    }
    if (!disposed) render();
  };

  const loadTokenState = async () => {
    const invoice = state.invoice;
    if (!invoice || !wallet.account) return;
    try {
      const s = await readTokenState(ctx.publicClient, invoice.token, wallet.account, gateway);
      state.balance = s.balance;
      state.allowance = s.allowance;
    } catch {
      /* shown as unknown */
    }
    if (!disposed) render();
  };

  const startPayment = async (invoice: Invoice, token: TokenInfo) => {
    state.error = '';
    state.busy = true;
    state.doneSteps = new Set();
    const allowance = state.allowance ?? 0n;
    state.plan =
      allowance >= invoice.amount
        ? ['pay']
        : token.requiresAllowanceReset && allowance > 0n
          ? ['reset-allowance', 'approve', 'pay']
          : ['approve', 'pay'];
    state.step = state.plan[0];
    render();

    try {
      await ensureChain(ctx.chain);
      const hash = await payInvoice({
        publicClient: ctx.publicClient,
        walletClient: wallet.walletClient!,
        chain: ctx.chain,
        account: wallet.account!,
        gateway,
        invoice,
        token,
        onStep: (step, txHash) => {
          const index = state.plan.indexOf(step);
          state.plan.slice(0, index).forEach((s) => state.doneSteps.add(s));
          state.step = step;
          if (txHash) state.paidTx = txHash;
          if (!disposed) render();
        },
      });
      state.paidTx = hash;
      state.plan.forEach((s) => state.doneSteps.add(s));
      state.step = undefined;
    } catch (error) {
      state.error = friendlyError(error);
      state.step = undefined;
    } finally {
      state.busy = false;
      await loadInvoice();
      await loadTokenState();
    }
  };

  const getTestTokens = async (token: TokenInfo) => {
    state.faucetBusy = true;
    state.error = '';
    render();
    try {
      await ensureChain(ctx.chain);
      await faucet({
        publicClient: ctx.publicClient,
        walletClient: wallet.walletClient!,
        chain: ctx.chain,
        account: wallet.account!,
        gateway,
        token,
        amount: parseUnits(String(FAUCET_AMOUNT_UNITS), token.decimals),
      });
    } catch (error) {
      state.error = friendlyError(error);
    } finally {
      state.faucetBusy = false;
      await loadTokenState();
    }
  };

  const render = () => {
    const invoice = state.invoice;

    if (invoice === undefined) {
      view.replaceChildren(h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Loading invoice…')));
      return;
    }
    if (invoice === null) {
      view.replaceChildren(
        h(
          'section',
          { class: 'card' },
          h('h1', null, `Invoice #${invoiceId}`),
          state.loadError
            ? notice('error', `Could not read the invoice: ${state.loadError}`)
            : notice('error', 'No invoice with this number exists on this gateway.'),
        ),
      );
      return;
    }

    const token = tokenOf(invoice);
    const status = effectiveStatus(invoice);
    const amountText = token ? `${formatAmount(invoice.amount, token.decimals)} ${token.symbol}` : `${invoice.amount} (unknown token)`;

    const expiryLine =
      invoice.expiresAt === 0n
        ? 'No expiry'
        : status === 'pending'
          ? h('span', null, 'Expires in ', h('strong', { id: 'countdown' }, formatDuration(Number(invoice.expiresAt) - Math.floor(Date.now() / 1000))))
          : `Expiry: ${new Date(Number(invoice.expiresAt) * 1000).toLocaleString()}`;

    const summary = h(
      'section',
      { class: 'card' },
      h('div', { class: 'row between center' }, h('h1', null, `Invoice #${invoice.id}`), statusBadge(status)),
      h('p', { class: 'amount-hero' }, amountText),
      h('dl', { class: 'details' },
        h('dt', null, 'Pay to merchant'), h('dd', null, explorerLink(ctx.chain, 'address', invoice.merchant)),
        h('dt', null, 'Network'), h('dd', null, ctx.chain.name),
        h('dt', null, 'Validity'), h('dd', null, expiryLine),
      ),
      state.loadError ? notice('warn', `Could not refresh the invoice: ${state.loadError}`) : null,
    );

    const actions = h('section', { class: 'card' });
    if (status === 'paid') {
      actions.append(
        notice('success', h('strong', null, 'Payment received. '), 'This invoice has been paid. You can close this page.'),
        h('dl', { class: 'details' },
          invoice.payer ? h('dt', null, 'Paid by') : null, invoice.payer ? h('dd', null, explorerLink(ctx.chain, 'address', invoice.payer)) : null,
          state.paidTx ? h('dt', null, 'Transaction') : null, state.paidTx ? h('dd', null, explorerLink(ctx.chain, 'tx', state.paidTx)) : null,
        ),
      );
    } else if (status === 'cancelled') {
      actions.append(notice('error', 'The merchant cancelled this invoice. Do not pay it.'));
    } else if (status === 'expired') {
      actions.append(notice('error', 'This invoice has expired. Ask the merchant for a new one.'));
    } else if (!token) {
      actions.append(notice('error', 'This invoice uses a token this page does not know. Do not pay it from here.'));
    } else if (!wallet.account) {
      actions.append(
        h('h2', null, 'Pay with your wallet'),
        h('p', { class: 'muted' }, 'Connect a wallet that holds ' + token.symbol + ' on ' + ctx.chain.name + '.'),
        connectPanel(ctx, (message) => {
          state.error = message;
          render();
        }),
      );
    } else {
      const guard = networkGuard(ctx, (message) => {
        state.error = message;
        render();
      });
      const wrongNetwork = wallet.chainId !== ctx.chain.id;
      const insufficient = state.balance !== undefined && state.balance < invoice.amount;

      actions.append(
        ...compact([
        h('h2', null, 'Pay with your wallet'),
        h('p', { class: 'muted' },
          'Paying from ', explorerLink(ctx.chain, 'address', wallet.account),
          state.balance !== undefined && token ? ` · balance ${formatAmount(state.balance, token.decimals)} ${token.symbol}` : '',
        ),
        guard,
        insufficient ? notice('warn', `Your ${token.symbol} balance is lower than the invoice amount.`) : null,
        insufficient && token.faucet
          ? h(
              'button',
              { class: 'btn', type: 'button', disabled: state.faucetBusy || wrongNetwork, onclick: () => void getTestTokens(token) },
              state.faucetBusy ? 'Minting…' : `Get ${FAUCET_AMOUNT_UNITS.toLocaleString('en-US')} test ${token.symbol}`,
            )
          : null,
        insufficient && !token.faucet
          ? h('p', { class: 'muted small-text' }, 'Testnet USDC can be claimed from Circle’s faucet.')
          : null,
        state.plan.length > 0 && (state.busy || state.doneSteps.size > 0)
          ? h(
              'ol',
              { class: 'steps' },
              ...state.plan.map((step) =>
                h(
                  'li',
                  { class: state.doneSteps.has(step) ? 'done' : state.step === step ? 'active' : '' },
                  STEP_LABEL[step],
                  state.step === step && state.busy ? h('span', { class: 'muted' }, ' — confirm in your wallet') : null,
                ),
              ),
            )
          : null,
        h(
          'button',
          {
            class: 'btn primary wide',
            type: 'button',
            disabled: state.busy || wrongNetwork || insufficient || state.balance === undefined,
            onclick: () => void startPayment(invoice, token),
          },
          state.busy ? 'Processing…' : `Pay ${amountText}`,
        ),
        h('p', { class: 'muted small-text' }, 'You approve exactly this amount, never an unlimited allowance.'),
        ]),
      );
    }
    if (state.error) actions.append(notice('error', state.error));

    const phone = h(
      'details',
      { class: 'card phone' },
      h('summary', null, 'Open this checkout on another device'),
      qrBlock(checkoutUrl(invoice.id), 'Scan with a phone camera or wallet app.'),
    );

    view.replaceChildren(...(status === 'pending' ? [summary, actions, phone] : [summary, actions]));
  };

  // Keep the countdown ticking without rebuilding the whole view.
  const tick = window.setInterval(() => {
    const el = document.getElementById('countdown');
    const invoice = state.invoice;
    if (el && invoice && invoice.expiresAt !== 0n) {
      const left = Number(invoice.expiresAt) - Math.floor(Date.now() / 1000);
      if (left <= 0) render();
      else el.textContent = formatDuration(left);
    }
  }, 1000);

  // Pick up payments made from another device (e.g. the customer scanned the QR with a phone).
  const poll = window.setInterval(() => {
    if (!state.busy) void loadInvoice();
  }, 5000);

  const unsubscribe = onWalletChange(() => {
    state.balance = undefined;
    state.allowance = undefined;
    state.error = '';
    render();
    void loadTokenState();
  });

  void loadInvoice().then(loadTokenState);

  return () => {
    disposed = true;
    window.clearInterval(tick);
    window.clearInterval(poll);
    unsubscribe();
  };
}
