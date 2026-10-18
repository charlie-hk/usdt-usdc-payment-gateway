// Order labels typed by the merchant are only ever stored on-chain as a hash.
// To show them again in the dashboard they are kept in this browser's localStorage.
// Purely a convenience: everything works without it.

const key = (chainId: number, gateway: string, id: bigint) => `pg:label:${chainId}:${gateway.toLowerCase()}:${id}`;

export function saveLabel(chainId: number, gateway: string, id: bigint, label: string): void {
  try {
    if (label) localStorage.setItem(key(chainId, gateway, id), label);
  } catch {
    /* storage unavailable */
  }
}

export function loadLabel(chainId: number, gateway: string, id: bigint): string {
  try {
    return localStorage.getItem(key(chainId, gateway, id)) ?? '';
  } catch {
    return '';
  }
}
