import { formatUnits, parseUnits } from 'viem';

/** 1234567890n with 6 decimals -> "1,234.56789" (trailing zeros trimmed, at least 2 fraction digits kept). */
export function formatAmount(value: bigint, decimals: number): string {
  const [whole, frac = ''] = formatUnits(value, decimals).split('.');
  const trimmed = frac.replace(/0+$/, '').padEnd(2, '0');
  return `${BigInt(whole).toLocaleString('en-US')}.${trimmed}`;
}

/**
 * Parses a user-typed decimal amount. Returns null for anything that is not a positive number
 * with at most `decimals` fraction digits.
 */
export function parseAmount(input: string, decimals: number): bigint | null {
  const text = input.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [, frac = ''] = text.split('.');
  if (frac.length > decimals) return null;
  const value = parseUnits(text, decimals);
  return value > 0n ? value : null;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0s';
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
