-- Keep who uploaded each previous document version, so a rollback restores
-- arsip_dokumen.uploaded_by instead of setting it to NULL (audit trail).
-- Additive and nullable: existing rows keep NULL.
ALTER TABLE arsip_dokumen_versi ADD COLUMN uploaded_by INTEGER;
