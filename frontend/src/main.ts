import './styles.css';
import { loadContext, type AppContext } from './config';
import { h } from './dom';
import { notice, walletBar } from './ui';
import { onWalletChange } from './wallet';
import { renderMerchant } from './views/merchant';
import { renderPay } from './views/pay';

const app = document.getElementById('app') as HTMLElement;

function parseRoute(): { name: 'merchant' } | { name: 'pay'; id: string } {
  const match = window.location.hash.match(/^#\/pay\/([^/?#]+)/);
  return match ? { name: 'pay', id: decodeURIComponent(match[1]) } : { name: 'merchant' };
}

async function start() {
  let ctx: AppContext;
  try {
    ctx = await loadContext();
  } catch (error) {
    app.replaceChildren(h('main', { class: 'container' }, notice('error', `Could not start the app: ${(error as Error).message}`)));
    return;
  }

  const headerSlot = h('div', { class: 'header-wallet' });
  const headerError = h('div', { class: 'header-error' });
  const main = h('main', { class: 'container' });

  const showHeaderError = (message: string) => {
    headerError.replaceChildren(notice('error', message));
    window.setTimeout(() => headerError.replaceChildren(), 8000);
  };
  const drawHeader = () => headerSlot.replaceChildren(walletBar(ctx, showHeaderError));

  app.replaceChildren(
    h(
      'header',
      { class: 'site-header' },
      h(
        'div',
        { class: 'container header-inner' },
        h('a', { class: 'brand', href: '#/' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, '✓'), 'StablePay'),
        headerSlot,
      ),
    ),
    h('div', { class: 'container' }, headerError),
    main,
    h(
      'footer',
      { class: 'site-footer container' },
      h('p', { class: 'muted small-text' }, `Testnet demo on ${ctx.chain.name}. Never send real funds to these contracts.`),
    ),
  );

  drawHeader();
  onWalletChange(drawHeader);

  let cleanup: (() => void) | null = null;
  const route = () => {
    cleanup?.();
    const r = parseRoute();
    cleanup = r.name === 'pay' ? renderPay(main, ctx, r.id) : renderMerchant(main, ctx);
    window.scrollTo({ top: 0 });
  };
  window.addEventListener('hashchange', route);
  route();
}

void start();
