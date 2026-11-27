-- CRM: лиды, сделки, лента активностей.
-- Применение: npx wrangler d1 migrations apply nia-crm --remote (и --local для разработки)

CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  source       TEXT NOT NULL,
  name         TEXT,
  email        TEXT,
  phone        TEXT,
  site         TEXT,
  event        TEXT,
  report_token TEXT UNIQUE,
  status       TEXT NOT NULL DEFAULT 'new',
  consent_at   TEXT,
  notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_email   ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);

CREATE TABLE IF NOT EXISTS deals (
  id           TEXT PRIMARY KEY,
  lead_id      TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  service      TEXT NOT NULL,
  stage        TEXT NOT NULL DEFAULT 'new',
  next_step    TEXT,
  next_step_at TEXT,
  amount       INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deals_lead ON deals(lead_id);
CREATE INDEX IF NOT EXISTS idx_deals_next ON deals(next_step_at);

CREATE TABLE IF NOT EXISTS activities (
  id      TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  text    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id, at DESC);
