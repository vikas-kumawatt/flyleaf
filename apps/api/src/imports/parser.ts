// Pure TypeScript RFC 4180 compliant CSV parser (Architecture §3.7, PRD §6.8).
//
// Supports:
//   - Multi-line quoted values (e.g. user reviews containing paragraphs)
//   - Escaped quotes ("" -> ")
//   - CRLF and LF newlines
//   - UTF-8 Byte Order Mark (\uFEFF) stripping
//   - Blank line skipping

export interface ParsedCsvResult {
  headers: string[];
  rows: { rowNo: number; data: Record<string, string> }[];
  totalRows: number;
}

/**
 * Parses raw CSV string or Buffer into structured records mapped by column headers.
 */
export function parseCsv(input: string | Buffer): ParsedCsvResult {
  let text = typeof input === 'string' ? input : input.toString('utf8');

  // Strip Byte Order Mark if present
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const rawRows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        // Look ahead for escaped quote ("")
        if (i + 1 < len && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        inQuotes = false;
        i++;
        continue;
      }
      // Any character inside quotes (including \n, \r, commas) is literal
      currentField += char;
      i++;
      continue;
    }

    // Outside quotes
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === ',') {
      currentRow.push(currentField);
      currentField = '';
      i++;
      continue;
    }

    if (char === '\r') {
      // Handle \r\n or standalone \r
      if (i + 1 < len && text[i + 1] === '\n') {
        i++;
      }
      currentRow.push(currentField);
      currentField = '';
      if (currentRow.some((field) => field.trim().length > 0)) {
        rawRows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    if (char === '\n') {
      currentRow.push(currentField);
      currentField = '';
      if (currentRow.some((field) => field.trim().length > 0)) {
        rawRows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  // Trailing field and row
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some((field) => field.trim().length > 0)) {
      rawRows.push(currentRow);
    }
  }

  if (rawRows.length === 0) {
    return { headers: [], rows: [], totalRows: 0 };
  }

  // First row is the header row
  const rawHeaders = rawRows[0]!;
  const headers = rawHeaders.map((h) => h.trim());

  const rows: { rowNo: number; data: Record<string, string> }[] = [];
  for (let r = 1; r < rawRows.length; r++) {
    const rawRow = rawRows[r]!;
    const data: Record<string, string> = {};

    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (!header) continue;
      data[header] = rawRow[c] ?? '';
    }

    rows.push({
      rowNo: r,
      data,
    });
  }

  return {
    headers,
    rows,
    totalRows: rows.length,
  };
}
