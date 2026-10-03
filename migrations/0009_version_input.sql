-- versions.inputKey: the image a generation edited (null = a fresh generation), so "try again" can re-send the exact
-- same request (prompt + input image).
ALTER TABLE versions ADD COLUMN inputKey TEXT;
