import QRCode from 'qrcode';

/** QR codes always render dark-on-white so every scanner can read them, in light and dark mode alike. */
export function qrDataUrl(text: string, size = 264): Promise<string> {
  return QRCode.toDataURL(text, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b1220', light: '#ffffff' },
  });
}
