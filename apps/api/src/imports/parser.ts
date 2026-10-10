// Pure TypeScript RFC 4180 compliant CSV parser (Architecture §3.7, PRD §6.8).
//
// Supports:
//   - Multi-line quoted values (e.g. user reviews containing paragraphs)
//   - Escaped quotes ("" -> ")
//   - CRLF, LF and CR newlines
//   - Byte Order Marks, UTF-16 and Windows-1252 files (decodeCsvBytes)
//   - Blank line skipping
//   - An unclosed quote spoils one row, not the rest of the file (audit 12)

export interface ParsedCsvRow {
  rowNo: number;
  data: Record<string, string>;
  /** The row had an unclosed quote; its fields were split literally. Reported, never matched. */
  malformed?: boolean;
}

export interface ParsedCsvResult {
  headers: string[];
  rows: ParsedCsvRow[];
  totalRows: number;
}

/**
 * The text of an uploaded export. Exports made on Windows are often not
 * UTF-8 (audit 12, A-12-004): Excel's "Unicode text" is UTF-16 with a BOM,
 * and older Goodreads/LibraryThing files are Windows-1252. A BOM decides;
 * otherwise strict UTF-8, and Windows-1252 when that fails (every byte
 * sequence is valid Windows-1252, and real UTF-8 is almost never valid
 * Windows-1252 that also fails UTF-8).
 */
export function decodeCsvBytes(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return decodeWindows1252(buf);
  }
}

/**
 * 0x80–0x9F of Windows-1252 (WHATWG encoding table); the rest is Latin-1.
 * By hand because Node's TextDecoder('windows-1252') decodes this range as
 * Latin-1 control characters, turning ’ – € into invisible C1 codes.
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

export function decodeWindows1252(buf: Buffer): string {
  let out = '';
  for (let i = 0; i < buf.length; i += 8192) {
    const codes = Array.from(buf.subarray(i, i + 8192), (b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b));
    out += String.fromCharCode(...codes);
  }
  return out;
}

/**
 * Splits text into rows of fields. A quote opens a quoted field only at the
 * start of a field; anywhere else it is a literal character (`5" single`).
 * When a quoted field is still open at the end of the input, the row it
 * started on is taken as one literal line, marked malformed, and parsing
 * resumes on the next line.
 */
function splitRows(text: string): { fields: string[]; malformed: boolean }[] {
  const out: { fields: string[]; malformed: boolean }[] = [];
  const len = text.length;
  let i = 0;

  const push = (fields: string[], malformed: boolean) => {
    if (fields.some((f) => f.trim().length > 0)) out.push({ fields, malformed });
  };

  while (i < len) {
    const rowStart = i;
    let row: string[] = [];
    let field = '';
    let quoted = false; // inside a quoted section
    let fieldStarted = false; // any character of this field seen
    let quoteOpenedAt = -1;
    let ended = false;

    while (i < len) {
      const ch = text[i]!;
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          quoted = false;
          i++;
          continue;
        }
        field += ch;
        i++;
        continue;
      }
      if (ch === '"' && !fieldStarted) {
        quoted = true;
        fieldStarted = true;
        quoteOpenedAt = i;
        i++;
        continue;
      }
      if (ch === ',') {
        row.push(field);
        field = '';
        fieldStarted = false;
        i++;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
        row.push(field);
        ended = true;
        break;
      }
      field += ch;
      fieldStarted = true;
      i++;
    }

    if (quoted) {
      // End of input inside quotes: the quote never closed. Take the physical
      // line it opened on literally, and carry on after it.
      const nl = text.slice(quoteOpenedAt).search(/\r\n|\r|\n/);
      const lineEnd = nl === -1 ? len : quoteOpenedAt + nl;
      push(text.slice(rowStart, lineEnd).split(','), true);
      i = lineEnd;
      if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
      else if (i < len) i += 1;
      continue;
    }
    if (!ended) row.push(field);
    push(row, false);
    row = [];
  }
  return out;
}

/**
 * Parses raw CSV string or Buffer into structured records mapped by column headers.
 */
export function parseCsv(input: string | Buffer): ParsedCsvResult {
  let text = typeof input === 'string' ? input : decodeCsvBytes(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rawRows = splitRows(text);
  if (rawRows.length === 0) {
    return { headers: [], rows: [], totalRows: 0 };
  }

  // First row is the header row
  const headers = rawRows[0]!.fields.map((h) => h.trim());

  const rows: ParsedCsvRow[] = [];
  for (let r = 1; r < rawRows.length; r++) {
    const { fields, malformed } = rawRows[r]!;
    const data: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (!header) continue;
      data[header] = fields[c] ?? '';
    }
    rows.push(malformed ? { rowNo: r, data, malformed: true } : { rowNo: r, data });
  }

  return { headers, rows, totalRows: rows.length };
}
