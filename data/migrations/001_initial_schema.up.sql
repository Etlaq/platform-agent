CREATE TABLE runs (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  input JSONB,
  provider TEXT,
  model TEXT,
  workspace_backend TEXT,
  output TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX events_run_id_idx ON events(run_id);
CREATE UNIQUE INDEX events_run_seq_uidx ON events(run_id, seq);

CREATE TABLE jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX jobs_run_uidx ON jobs(run_id);
CREATE INDEX jobs_status_idx ON jobs(status);
CREATE INDEX jobs_status_next_run_idx ON jobs(status, next_run_at);

CREATE TABLE artifacts (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  size BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
