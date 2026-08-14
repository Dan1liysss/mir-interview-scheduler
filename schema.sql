-- Схема D1 для системы записи на собеседование.
-- Состояния requests.status:
--   pending               — заявка подана, ждёт директора
--   confirmed             — директор подтвердил именно то время, что просил родитель
--   proposed_alternative  — директор предложил другое время, ждём ответа родителя
--   rejected              — отклонено (директором или родителем)
--   expired               — лимит раундов согласования исчерпан

CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status_token TEXT UNIQUE NOT NULL,
    grade TEXT NOT NULL,
    child_name TEXT NOT NULL,
    parent_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    comment TEXT,
    preferred_date TEXT NOT NULL,
    preferred_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    proposed_date TEXT,
    proposed_time TEXT,
    director_note TEXT,
    round INTEGER NOT NULL DEFAULT 0,
    seen_by_director INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS director_sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_token ON requests(status_token);
