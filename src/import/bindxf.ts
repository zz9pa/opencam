/**
 * Binary DXF to ASCII DXF. A binary DXF holds the same records as an ASCII one (a group code, then a value) in a compact form,
 * so converting it back to text lets the ordinary reader do the rest.
 * Layout: the 22-byte sentinel "AutoCAD Binary DXF", CR, LF, SUB, NUL; then records of [group code][value]. The code is one byte
 * (255 = a two-byte code follows) in R12 files and always two bytes (little-endian) from R13 on. The value type follows from the code.
 */
const SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\x00';

export function isBinaryDxf(b: Uint8Array): boolean {
  if (b.length < SENTINEL.length) return false;
  for (let i = 0; i < SENTINEL.length; i++) if (b[i] !== SENTINEL.charCodeAt(i)) return false;
  return true;
}

type Kind = 'str' | 'f64' | 'i16' | 'i32' | 'i64' | 'i8' | 'bin';
function kindOf(c: number): Kind {
  if (c >= 1010 && c <= 1059) return 'f64';
  if (c >= 1060 && c <= 1070) return 'i16';
  if (c === 1071) return 'i32';
  if (c === 1004) return 'bin';
  if (c >= 1000 && c <= 1009) return 'str';
  if (c <= 9) return 'str';
  if (c >= 10 && c <= 59) return 'f64';
  if (c >= 60 && c <= 79) return 'i16';
  if (c >= 90 && c <= 99) return 'i32';
  if (c >= 100 && c <= 105) return 'str';
  if (c >= 110 && c <= 149) return 'f64';
  if (c >= 160 && c <= 169) return 'i64';
  if (c >= 170 && c <= 179) return 'i16';
  if (c >= 210 && c <= 239) return 'f64';
  if (c >= 270 && c <= 289) return 'i16';
  if (c >= 290 && c <= 299) return 'i8';
  if (c >= 300 && c <= 309) return 'str';
  if (c >= 310 && c <= 319) return 'bin';
  if (c >= 320 && c <= 369) return 'str';
  if (c >= 370 && c <= 389) return 'i16';
  if (c >= 390 && c <= 399) return 'str';
  if (c >= 400 && c <= 409) return 'i16';
  if (c >= 410 && c <= 419) return 'str';
  if (c >= 420 && c <= 429) return 'i32';
  if (c >= 430 && c <= 439) return 'str';
  if (c >= 440 && c <= 449) return 'i32';
  if (c >= 450 && c <= 459) return 'i64';
  if (c >= 460 && c <= 469) return 'f64';
  if (c >= 470 && c <= 481) return 'str';
  if (c === 999) return 'str';
  return 'str';
}

export function binaryDxfToAscii(b: Uint8Array): string {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dec = new TextDecoder('latin1');
  let p = SENTINEL.length;
  // R12 files use one-byte codes, later ones two: the first record is group 0 (SECTION), so a zero byte follows its first byte in the two-byte form
  const wide = b.length > p + 1 && b[p] === 0 && b[p + 1] === 0;
  const out: string[] = [];
  const need = (n: number) => { if (p + n > b.length) throw new Error('The binary DXF file ends unexpectedly.'); };
  while (p < b.length) {
    let code: number;
    if (wide) { need(2); code = dv.getUint16(p, true); p += 2; }
    else { need(1); code = b[p++]; if (code === 255) { need(2); code = dv.getUint16(p, true); p += 2; } }
    let v: string;
    switch (kindOf(code)) {
      case 'f64': need(8); v = String(dv.getFloat64(p, true)); p += 8; break;
      case 'i16': need(2); v = String(dv.getInt16(p, true)); p += 2; break;
      case 'i32': need(4); v = String(dv.getInt32(p, true)); p += 4; break;
      case 'i64': need(8); v = String(dv.getBigInt64(p, true)); p += 8; break;
      case 'i8': need(1); v = String(b[p]); p += 1; break;
      case 'bin': { need(1); const n = b[p]; need(1 + n); p += 1 + n; v = ''; break; }
      default: {
        let e = p; while (e < b.length && b[e] !== 0) e++;
        if (e >= b.length) throw new Error('The binary DXF file ends unexpectedly.');
        v = dec.decode(b.subarray(p, e)); p = e + 1;
      }
    }
    out.push(String(code), v);
  }
  return out.join('\n') + '\n';
}
