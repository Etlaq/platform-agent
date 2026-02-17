ALTER TABLE runs
  ADD COLUMN project_id TEXT;

UPDATE runs
SET project_id = 'default'
WHERE project_id IS NULL;

ALTER TABLE runs
  ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE runs
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN attempt INT NOT NULL DEFAULT 0,
  ADD COLUMN max_attempts INT NOT NULL DEFAULT 3,
  ADD COLUMN sandbox_id TEXT,
  ADD COLUMN estimated_cost_usd NUMERIC(18, 8),
  ADD COLUMN cost_currency TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN pricing_version TEXT;

UPDATE runs r
SET max_attempts = j.max_attempts
FROM jobs j
WHERE j.run_id = r.id;

CREATE UNIQUE INDEX runs_project_idempotency_uidx
ON runs(project_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE TABLE model_pricing (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  input_cost_per_1k NUMERIC(18, 8) NOT NULL DEFAULT 0,
  output_cost_per_1k NUMERIC(18, 8) NOT NULL DEFAULT 0,
  cached_input_cost_per_1k NUMERIC(18, 8) NOT NULL DEFAULT 0,
  reasoning_output_cost_per_1k NUMERIC(18, 8) NOT NULL DEFAULT 0,
  pricing_version TEXT NOT NULL DEFAULT 'seed:v1',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, model)
);

INSERT INTO model_pricing (
  provider,
  model,
  currency,
  input_cost_per_1k,
  output_cost_per_1k,
  cached_input_cost_per_1k,
  reasoning_output_cost_per_1k,
  pricing_version,
  active
)
VALUES
  ('openai', 'gpt-5', 'USD', 0.01000000, 0.03000000, 0.00100000, 0.00000000, 'seed:v1', TRUE),
  ('openai', 'gpt-5-mini', 'USD', 0.00150000, 0.00600000, 0.00015000, 0.00000000, 'seed:v1', TRUE),
  ('openai', 'gpt-4.1', 'USD', 0.01000000, 0.03000000, 0.00100000, 0.00000000, 'seed:v1', TRUE),
  ('anthropic', 'claude-3-7-sonnet-latest', 'USD', 0.00300000, 0.01500000, 0.00030000, 0.00000000, 'seed:v1', TRUE),
  ('xai', 'grok-3', 'USD', 0.00500000, 0.01500000, 0.00050000, 0.00000000, 'seed:v1', TRUE),
  ('zai', 'glm-4.5', 'USD', 0.00300000, 0.00900000, 0.00030000, 0.00000000, 'seed:v1', TRUE)
ON CONFLICT (provider, model)
DO UPDATE SET
  currency = EXCLUDED.currency,
  input_cost_per_1k = EXCLUDED.input_cost_per_1k,
  output_cost_per_1k = EXCLUDED.output_cost_per_1k,
  cached_input_cost_per_1k = EXCLUDED.cached_input_cost_per_1k,
  reasoning_output_cost_per_1k = EXCLUDED.reasoning_output_cost_per_1k,
  pricing_version = EXCLUDED.pricing_version,
  active = EXCLUDED.active,
  updated_at = NOW();
