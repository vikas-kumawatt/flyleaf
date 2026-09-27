-- Audit 08: the optional note of the DNF flow (PRD §6.18) was accepted by
-- POST /reads/:id/dnf and dropped: there was nowhere to put it. Nullable and
-- without a default, so adding it rewrites nothing. 280 characters, like a
-- progress note.

ALTER TABLE reads ADD COLUMN IF NOT EXISTS dnf_note text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reads_dnf_note_ck') THEN
    ALTER TABLE reads ADD CONSTRAINT reads_dnf_note_ck
      CHECK (dnf_note IS NULL OR char_length(dnf_note) <= 280) NOT VALID;
  END IF;
END $$;
