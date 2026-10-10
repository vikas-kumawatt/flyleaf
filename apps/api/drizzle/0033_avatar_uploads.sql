-- Audit 10 (A-07-032): avatars use the PV-02 presigned upload path with
-- purpose 'avatar' (policy in uploads/index.ts: JPEG/PNG/WebP, 2 MB, magic
-- bytes checked at complete). The purpose check allowed 'import' only.
--
-- uploads is small (rows expire after an hour unless consumed), so the
-- constraint is replaced and validated in place. Idempotent: it is rebuilt
-- only while it does not yet allow 'avatar'.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'uploads_purpose_ck' AND pg_get_constraintdef(oid) LIKE '%avatar%'
  ) THEN
    ALTER TABLE "uploads" DROP CONSTRAINT IF EXISTS "uploads_purpose_ck";
    ALTER TABLE "uploads" ADD CONSTRAINT "uploads_purpose_ck" CHECK ("purpose" IN ('import', 'avatar'));
  END IF;
END $$;
