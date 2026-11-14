// A library export chosen as a file (PRD §6.8), checked before it is read or
// uploaded. The server's import policy is 10 MB of CSV/text (uploads/index.ts);
// saying so here spares a reader a slow upload that is refused at the end.

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

/** Why this file cannot be imported, or null when it can be read. */
export function pickedFileProblem(file: { name: string; size?: number | null }): string | null {
  if (!/\.(csv|txt)$/i.test(file.name.trim())) {
    return 'Choose the .csv file your reading app exported.';
  }
  if (file.size !== undefined && file.size !== null && file.size > IMPORT_MAX_BYTES) {
    return `This file is ${formatBytes(file.size)}. Imports can be up to 10 MB.`;
  }
  return null;
}

/** The text without a UTF-8 byte-order mark (Excel and some exporters add one). */
export function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 840 B, 12 KB, 1.4 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
