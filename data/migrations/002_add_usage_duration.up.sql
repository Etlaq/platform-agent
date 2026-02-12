ALTER TABLE runs
  ADD COLUMN input_tokens INT,
  ADD COLUMN output_tokens INT,
  ADD COLUMN total_tokens INT,
  ADD COLUMN duration_ms INT;
