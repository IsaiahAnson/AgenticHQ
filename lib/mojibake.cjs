'use strict';
// Undo UTF-8 text that was decoded as code page 437, the Windows console's OEM code page: "ΓÇö" back to "—".
// deepseek-ask.ps1 did this to DeepSeek replies until 2026-11-01 and AI Radar stored the result; the repair tool is
// tools/radar-fix-mojibake.mjs. A string changes only when it holds a sequence that only mojibake makes (three or four
// UTF-8 bytes, or a C2/C3 lead byte), so box drawing and accents that were never mangled stay as they are.

// CP437 bytes 0x80-0xFF in order (matches .NET's code page 437, checked 2026-11-01). 0x00-0x7F is ASCII.
const HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const BYTE = new Map([...HIGH].map((ch, i) => [ch, 0x80 + i]));
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Continuation bytes a UTF-8 lead byte takes; 0 when it is not a lead.
const tailOf = b => (b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0);

// What the console did: UTF-8 bytes read back as CP437 characters.
function asCp437(text) {
  return [...Buffer.from(String(text), 'utf8')].map(b => (b < 0x80 ? String.fromCharCode(b) : HIGH[b - 0x80])).join('');
}

function fixCp437(text) {
  const s = String(text), chars = [...s];
  let out = '', strong = false;
  for (let i = 0; i < chars.length;) {
    const lead = BYTE.get(chars[i]), tail = lead ? tailOf(lead) : 0, bytes = [lead];
    for (let j = 1; j <= tail && BYTE.get(chars[i + j]) <= 0xbf; j++) bytes.push(BYTE.get(chars[i + j]));
    let ch = null;
    if (tail && bytes.length === tail + 1) { try { ch = utf8.decode(Uint8Array.from(bytes)); } catch (_) { } }
    if (ch && !/[\u0080-\u009f]/.test(ch)) {
      out += ch; i += tail + 1;
      if (tail > 1 || lead <= 0xc3) strong = true;
    } else { out += chars[i]; i++; }
  }
  return strong ? out : s;
}

// Repairs every string in a JSON value (object keys stay as they are), leaving anything under a key in `skip` alone.
// onFix(path, before, after) hears about each change. Returns a repaired copy.
function fixDeep(value, { skip = [], onFix = () => { } } = {}, at = []) {
  if (typeof value === 'string') {
    const fixed = fixCp437(value);
    if (fixed !== value) onFix(at.join('.'), value, fixed);
    return fixed;
  }
  if (Array.isArray(value)) return value.map((x, i) => fixDeep(x, { skip, onFix }, [...at, i]));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, x] of Object.entries(value)) out[k] = skip.includes(k) ? x : fixDeep(x, { skip, onFix }, [...at, k]);
  return out;
}

module.exports = { asCp437, fixCp437, fixDeep };
