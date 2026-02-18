CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latest_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO projects (id, name)
SELECT DISTINCT project_id, project_id
FROM runs
WHERE project_id IS NOT NULL
ON CONFLICT (id)
DO NOTHING;

ALTER TABLE runs
  ADD COLUMN run_index INT,
  ADD COLUMN writable BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN parent_run_id UUID REFERENCES runs(id) ON DELETE SET NULL;

WITH ranked AS (
  SELECT
    id,
    project_id,
    ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at ASC, id ASC) AS rn,
    ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at DESC, id DESC) AS rev_rn
  FROM runs
)
UPDATE runs r
SET
  run_index = ranked.rn,
  writable = (ranked.rev_rn = 1)
FROM ranked
WHERE ranked.id = r.id;

ALTER TABLE runs
  ALTER COLUMN run_index SET NOT NULL;

CREATE INDEX runs_project_run_index_idx ON runs(project_id, run_index DESC);

CREATE UNIQUE INDEX runs_project_writable_uidx
ON runs(project_id)
WHERE writable = TRUE;

ALTER TABLE runs
  ADD CONSTRAINT runs_project_fk
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

UPDATE projects p
SET latest_run_id = r.id,
    updated_at = NOW()
FROM runs r
WHERE r.project_id = p.id
  AND r.writable = TRUE;

ALTER TABLE projects
  ADD CONSTRAINT projects_latest_run_fk
  FOREIGN KEY (latest_run_id) REFERENCES runs(id) ON DELETE SET NULL;

CREATE TABLE run_messages (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  input JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX run_messages_project_created_idx ON run_messages(project_id, created_at ASC, id ASC);
CREATE INDEX run_messages_run_created_idx ON run_messages(run_id, created_at ASC, id ASC);
