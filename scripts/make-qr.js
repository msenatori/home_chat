#!/usr/bin/env node
// Genera el código QR de la dirección de la app (corre en la Mac, offline):
//   npm install && npm run qr
// La dirección sale de QR_URL o de https://$BASE_DOMAIN (entorno o .env en la raíz, ver
// .env.example). Escribe qr/qr-chat.png (gitignored: codifica tu dominio).
// Usa la librería `qrcode`; no llama a ningún servicio externo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qr');

// Lee KEY=valor del .env sin ejecutarlo; el entorno tiene prioridad.
function fromDotEnv(key) {
  try {
    const lines = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n');
    const hit = lines.map((l) => l.match(new RegExp(`^\\s*${key}=(.*)$`))).filter(Boolean).pop();
    return hit ? hit[1].trim().replace(/^['"]|['"]$/g, '') : '';
  } catch { return ''; }
}
const env = (k) => process.env[k] || fromDotEnv(k);

const baseDomain = env('BASE_DOMAIN');
const url = env('QR_URL') || (baseDomain ? `https://${baseDomain}` : '');
if (!url) {
  console.error('Falta QR_URL o BASE_DOMAIN (en el entorno o en .env; ver .env.example).');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, 'qr-chat.png');
await QRCode.toFile(file, url, {
  errorCorrectionLevel: 'M', margin: 2, width: 512, color: { dark: '#000000', light: '#ffffff' },
});
console.log(`${path.relative(ROOT, file)} -> ${url}`);
