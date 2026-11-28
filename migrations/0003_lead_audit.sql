-- Ручной аудит из карточки лида: идентификатор задачи в AUDIT_KV.
-- Нужен, чтобы статус можно было получить заново (после закрытия браузера,
-- в cron) и чтобы по готовности привязать отчёт к этому лиду.

ALTER TABLE leads ADD COLUMN audit_job TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_audit_job ON leads(audit_job);
