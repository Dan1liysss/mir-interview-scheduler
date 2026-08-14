-- Схема D1 для системы записи на собеседование.
-- Обрабатывает заявки секретарь приёмной комиссии (не сам директор) —
-- он согласовывает время, ориентируясь на график директора.
--
-- Состояния requests.status:
--   pending               — заявка подана, ждёт секретаря
--   confirmed             — секретарь подтвердил именно то время, что просил родитель
--   proposed_alternative  — секретарь предложил другое время, ждём ответа родителя
--   rejected              — отклонено (секретарём или родителем)
--   expired               — лимит раундов согласования исчерпан

CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status_token TEXT UNIQUE NOT NULL,
    child_last_name TEXT NOT NULL,
    child_first_name TEXT NOT NULL,
    birth_date TEXT NOT NULL,
    grade TEXT NOT NULL,
    current_school TEXT,
    parent_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    why_school TEXT NOT NULL,
    why_you TEXT NOT NULL,
    preferred_date TEXT NOT NULL,
    preferred_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    proposed_date TEXT,
    proposed_time TEXT,
    secretary_note TEXT,
    round INTEGER NOT NULL DEFAULT 0,
    seen_by_secretary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secretary_sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_token ON requests(status_token);
