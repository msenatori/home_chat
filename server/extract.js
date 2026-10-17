// Server-side text extraction for attached documents. The assistant itself has
// no file tools (see llm.js), so we read the files here and inline the text.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export const MAX_CHARS_PER_FILE = 60_000;

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.yml', '.yaml',
  '.ini', '.toml', '.log', '.srt', '.vtt', '.rtf', '.tex', '.svg', '.js', '.ts', '.py', '.java',
  '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.sql', '.css', '.kt', '.swift',
]);

export const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function classify(name, mime) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_MIME.has(mime)) return 'image';
  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf';
  if (['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods'].includes(ext)) return 'office';
  if (TEXT_EXT.has(ext) || mime.startsWith('text/') || mime === 'application/json') return 'text';
  return 'other';
}

/** Returns { text, note } — text may be '' with a note explaining why. */
export async function extractText(file, name, mime) {
  const kind = classify(name, mime);
  try {
    let text = '';
    if (kind === 'text') text = decodeText(await fs.readFile(file));
    else if (kind === 'pdf') text = await pdfText(file);
    else if (kind === 'office') text = officeText(await fs.readFile(file), path.extname(name).toLowerCase());
    else return { text: '', note: 'Tipo de archivo que no sé leer.' };
    text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) {
      return { text: '', note: kind === 'pdf' ? 'El PDF no tiene texto (puede ser una foto escaneada). Probá mandarlo como imagen.' : 'El archivo está vacío.' };
    }
    if (text.length > MAX_CHARS_PER_FILE) {
      return { text: text.slice(0, MAX_CHARS_PER_FILE), note: `Archivo largo: se usaron los primeros ${MAX_CHARS_PER_FILE.toLocaleString('es-AR')} caracteres.` };
    }
    return { text, note: null };
  } catch (e) {
    console.warn(`[extract] ${name}: ${e.message}`);
    return { text: '', note: 'No pude leer el archivo (¿está dañado o protegido con contraseña?).' };
  }
}

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  // Many replacement chars → probably latin1 (old Windows files)
  const bad = (utf8.match(/�/g) || []).length;
  return bad > 10 && bad > utf8.length / 200 ? new TextDecoder('latin1').decode(buf) : utf8.replace(/^﻿/, '');
}

// ------------------------------------------------------------------ PDF
let pdfjs;
async function pdfText(file) {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(file));
  const doc = await pdfjs.getDocument({
    data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
  }).promise;
  const out = [];
  let chars = 0;
  try {
    for (let i = 1; i <= Math.min(doc.numPages, 300) && chars < MAX_CHARS_PER_FILE; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      for (const item of content.items) {
        line += item.str ?? '';
        if (item.hasEOL) line += '\n';
        else if (item.str && !item.str.endsWith(' ')) line += ' ';
      }
      out.push(`--- Página ${i} ---\n${line.trim()}`);
      chars += line.length;
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  const text = out.join('\n\n');
  return text.replace(/--- Página \d+ ---\n?/g, '').trim() ? text : '';
}

// ------------------------------------------------------------------ Office (zip + XML)
function readZip(buf) {
  // Find End Of Central Directory record
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data.toString('utf8');
      if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 50 * 1024 * 1024 }).toString('utf8');
      throw new Error('unsupported compression');
    },
  };
}

function xmlToText(xml) {
  return xml
    .replace(/<w:tab\/>|<text:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>|<text:line-break\/>|<a:br[^>]*\/>/g, '\n')
    .replace(/<\/(w:p|a:p|text:p|text:h|row|table:table-row)>/g, '\n')
    .replace(/<\/(c|table:table-cell)>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

function officeText(buf, ext) {
  const zip = readZip(buf);
  if (ext === '.docx') {
    return ['word/document.xml', ...zip.names.filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n))]
      .map((n) => xmlToText(zip.read(n) || '')).join('\n\n');
  }
  if (ext === '.pptx') {
    return zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(natural)
      .map((n, i) => `--- Diapositiva ${i + 1} ---\n${xmlToText(zip.read(n))}`).join('\n\n');
  }
  if (ext === '.xlsx') {
    const shared = [];
    const ss = zip.read('xl/sharedStrings.xml');
    if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlToText(m[1]));
    return zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(natural).map((n, i) => {
      const xml = zip.read(n);
      const rows = [];
      for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const c of r[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1], inner = c[2] || '';
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          if (/t="s"/.test(attrs) && v != null) cells.push(shared[+v] ?? '');
          else if (/t="inlineStr"/.test(attrs)) cells.push(xmlToText(inner));
          else cells.push(v != null ? xmlToText(v) : '');
        }
        if (cells.some((x) => x !== '')) rows.push(cells.join('\t'));
      }
      return `--- Hoja ${i + 1} ---\n${rows.join('\n')}`;
    }).join('\n\n');
  }
  // OpenDocument (.odt/.ods/.odp)
  return xmlToText(zip.read('content.xml') || '');
}
