// The Download button on the import/export screen (IM-10, audit 12).
//
// The API stopped returning the emailed link (A-12-016: its token is stored
// only as a hash), so the button no longer keys off `download_url`. It shows
// for a completed export whose 48-hour window is still open, and asks
// GET /v1/exports/:id/link for a 5-minute URL when pressed.

export function isExportDownloadable(
  exp: { state: string; expires_at?: string | null },
  now: number = Date.now(),
): boolean {
  if (exp.state !== 'completed') return false;
  if (!exp.expires_at) return true;
  const until = Date.parse(exp.expires_at);
  return Number.isNaN(until) || until > now;
}
