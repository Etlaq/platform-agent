ALTER TABLE runs
  ADD COLUMN cached_input_tokens INT,
  ADD COLUMN reasoning_output_tokens INT,
  ADD COLUMN model_source TEXT;

