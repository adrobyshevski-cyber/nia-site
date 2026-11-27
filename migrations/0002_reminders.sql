-- Напоминания по сделкам: отметка «уже напомнили».
-- Сбрасывается в NULL, когда оператор меняет next_step_at (см. lib/crm.js → updateDeal).

ALTER TABLE deals ADD COLUMN reminded_at TEXT;

CREATE INDEX IF NOT EXISTS idx_deals_remind ON deals(next_step_at) WHERE reminded_at IS NULL;
