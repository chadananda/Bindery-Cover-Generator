-- Spend tracking: the estimated $ cost of each logged model call (core/pricing.js, from Gemini's usageMetadata) and the
-- model that served it. Rows before this were backfilled with per-call estimates.
ALTER TABLE logs ADD COLUMN cost REAL;
ALTER TABLE logs ADD COLUMN model TEXT;
