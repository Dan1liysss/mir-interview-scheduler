/**
 * mir-interview-scheduler — Cloudflare Worker
 *
 * Концепт-система записи на собеседование при поступлении в школу «Мир».
 * Заявки обрабатывает СЕКРЕТАРЬ приёмной комиссии (не сам директор) —
 * он согласовывает время, ориентируясь на график директора, который
 * непосредственно проводит собеседования.
 *
 * ВАЖНО: это демонстрационный прототип, не подключённый к реальной приёмной
 * комиссии школы. Все данные (пароль, база) — тестовые/учебные.
 *
 * Роуты:
 *   POST /api/requests                       — родитель подаёт заявку
 *   GET  /api/status/:token                   — родитель смотрит статус своей заявки
 *   POST /api/status/:token/respond            — confirm / decline / counter (пока предложено время),
 *                                                 cancel / reschedule (когда уже подтверждено)
 *
 *   POST /api/secretary/login                   — вход секретаря по паролю
 *   GET  /api/secretary/requests                 — список всех заявок (нужен Bearer-токен сессии)
 *   GET  /api/secretary/requests/:id             — детали одной заявки (помечает как "просмотрено")
 *   POST /api/secretary/requests/:id/decide       — approve / propose / reject
 *   DELETE /api/secretary/requests/:id              — удалить (rejected / cancelled / expired)
 *   GET  /api/secretary/export.csv                — выгрузка всех заявок в CSV
 *
 * Статусы requests.status:
 *   pending / confirmed / proposed_alternative / rejected / expired /
 *   cancelled — родитель сам отменил уже подтверждённую запись.
 *
 * Всё остальное (статика) отдаётся биндингом ASSETS из ./public автоматически.
 */

const MAX_ROUNDS = 3; // сколько раз родитель и секретарь могут перепредлагать время, прежде чем заявка "протухнет"
const SESSION_TTL_HOURS = 12;
const RATE_LIMIT_MAX = 5;              // не больше стольки заявок
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // за час с одного IP

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken(byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const REQUIRED_FIELDS = [
  "child_last_name", "child_first_name", "birth_date", "grade",
  "parent_name", "phone", "email", "why_school", "why_you",
  "preferred_date", "preferred_time",
];

// Предпочтение по напоминанию — предпочтение для демонстрации, письмо реально
// не отправляется (см. README: решили не подключать email-сервис).
const REMINDER_OFFSETS = ["1_hour", "3_hours", "1_day", "3_days"];
const DEFAULT_REMINDER_OFFSET = "1_day";

function validateRequestBody(body) {
  for (const f of REQUIRED_FIELDS) {
    if (!body[f] || typeof body[f] !== "string" || !body[f].trim()) {
      return `Поле "${f}" обязательно.`;
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.preferred_date)) return "Некорректный формат даты.";
  if (!/^\d{2}:\d{2}$/.test(body.preferred_time)) return "Некорректный формат времени.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.birth_date)) return "Некорректный формат даты рождения.";
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email);
  if (!emailOk) return "Некорректный email.";
  if (body.reminder_offset && !REMINDER_OFFSETS.includes(body.reminder_offset)) {
    return "Некорректное значение напоминания.";
  }
  return null;
}

function publicRequestView(row) {
  // То, что можно безопасно показать родителю по его личной ссылке.
  return {
    id: row.id,
    status: row.status,
    grade: row.grade,
    child_last_name: row.child_last_name,
    child_first_name: row.child_first_name,
    preferred_date: row.preferred_date,
    preferred_time: row.preferred_time,
    proposed_date: row.proposed_date,
    proposed_time: row.proposed_time,
    secretary_note: row.secretary_note,
    round: row.round,
    max_rounds: MAX_ROUNDS,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// --------------------------------------------------------------------------
// Secretary auth
// --------------------------------------------------------------------------

async function requireSecretary(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const token = m[1];
  const row = await env.DB.prepare(
    "SELECT token, expires_at FROM secretary_sessions WHERE token = ?"
  )
    .bind(token)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return token;
}

// --------------------------------------------------------------------------
// Public: заявка родителя
// --------------------------------------------------------------------------

async function handleCreateRequest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Некорректный JSON.");
  }

  // Honeypot: невидимое обычным пользователям поле. Боты, заполняющие все
  // поля формы подряд, попадаются на нём — заявку молча "принимаем" (не
  // выдавая боту, что его вычислили), но в базу не пишем.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ status_token: randomToken(24) });
  }

  const validationError = validateRequestBody(body);
  if (validationError) return err(validationError);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (ip !== "unknown") {
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const recentCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM requests WHERE ip_address = ? AND created_at > ?"
    )
      .bind(ip, windowStart)
      .first();
    if ((recentCount?.n || 0) >= RATE_LIMIT_MAX) {
      return err("Слишком много заявок с этого адреса за последний час. Попробуйте позже.", 429);
    }
  }

  const statusToken = randomToken(24);
  const ts = nowIso();

  const reminderOffset = REMINDER_OFFSETS.includes(body.reminder_offset)
    ? body.reminder_offset
    : DEFAULT_REMINDER_OFFSET;

  await env.DB.prepare(
    `INSERT INTO requests
      (status_token, child_last_name, child_first_name, birth_date, grade, current_school,
       parent_name, phone, email, why_school, why_you, reminder_offset, ip_address,
       preferred_date, preferred_time,
       status, round, seen_by_secretary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)`
  )
    .bind(
      statusToken,
      body.child_last_name.trim(),
      body.child_first_name.trim(),
      body.birth_date,
      body.grade.trim(),
      (body.current_school || "").trim(),
      body.parent_name.trim(),
      body.phone.trim(),
      body.email.trim(),
      body.why_school.trim(),
      body.why_you.trim(),
      reminderOffset,
      ip,
      body.preferred_date,
      body.preferred_time,
      ts,
      ts
    )
    .run();

  return json({ status_token: statusToken });
}

async function handleGetStatus(token, env) {
  const row = await env.DB.prepare("SELECT * FROM requests WHERE status_token = ?")
    .bind(token)
    .first();
  if (!row) return err("Заявка не найдена. Проверьте ссылку.", 404);
  return json(publicRequestView(row));
}

async function handleRespond(token, request, env) {
  const row = await env.DB.prepare("SELECT * FROM requests WHERE status_token = ?")
    .bind(token)
    .first();
  if (!row) return err("Заявка не найдена.", 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Некорректный JSON.");
  }

  const ts = nowIso();

  // Действия над уже подтверждённой заявкой — планы могли поменяться и после
  // того, как секретарь подтвердил время.
  if (body.action === "cancel") {
    if (row.status !== "confirmed") return err("Отменить можно только подтверждённую запись.", 409);
    await env.DB.prepare(`UPDATE requests SET status='cancelled', updated_at=? WHERE status_token=?`)
      .bind(ts, token)
      .run();
    return json({ status: "cancelled" });
  }

  if (body.action === "reschedule") {
    if (row.status !== "confirmed") return err("Перенести можно только подтверждённую запись.", 409);
    if (row.round >= MAX_ROUNDS) {
      await env.DB.prepare(`UPDATE requests SET status='expired', updated_at=? WHERE status_token=?`)
        .bind(ts, token)
        .run();
      return err("Лимит согласований исчерпан. Пожалуйста, свяжитесь со школой напрямую.", 409);
    }
    if (!body.new_date || !body.new_time) return err("Укажите новые дату и время.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.new_date)) return err("Некорректный формат даты.");
    if (!/^\d{2}:\d{2}$/.test(body.new_time)) return err("Некорректный формат времени.");

    await env.DB.prepare(
      `UPDATE requests SET status='pending', preferred_date=?, preferred_time=?,
       round=round+1, seen_by_secretary=0, updated_at=? WHERE status_token=?`
    )
      .bind(body.new_date, body.new_time, ts, token)
      .run();
    return json({ status: "pending" });
  }

  // Остальные действия — только пока секретарь предложил своё время и ждёт ответа.
  if (row.status !== "proposed_alternative") {
    return err("Сейчас нет предложенного времени, на которое можно ответить.", 409);
  }

  if (body.action === "confirm") {
    await env.DB.prepare(
      `UPDATE requests SET status='confirmed', preferred_date=proposed_date, preferred_time=proposed_time,
       proposed_date=NULL, proposed_time=NULL, updated_at=? WHERE status_token=?`
    )
      .bind(ts, token)
      .run();
    return json({ status: "confirmed" });
  }

  if (body.action === "decline") {
    await env.DB.prepare(`UPDATE requests SET status='rejected', updated_at=? WHERE status_token=?`)
      .bind(ts, token)
      .run();
    return json({ status: "rejected" });
  }

  if (body.action === "counter") {
    if (row.round >= MAX_ROUNDS) {
      await env.DB.prepare(`UPDATE requests SET status='expired', updated_at=? WHERE status_token=?`)
        .bind(ts, token)
        .run();
      return err("Лимит предложений по времени исчерпан. Пожалуйста, свяжитесь со школой напрямую.", 409);
    }
    if (!body.counter_date || !body.counter_time) return err("Укажите дату и время.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.counter_date)) return err("Некорректный формат даты.");
    if (!/^\d{2}:\d{2}$/.test(body.counter_time)) return err("Некорректный формат времени.");

    await env.DB.prepare(
      `UPDATE requests SET status='pending', preferred_date=?, preferred_time=?,
       proposed_date=NULL, proposed_time=NULL, round=round+1, seen_by_secretary=0, updated_at=?
       WHERE status_token=?`
    )
      .bind(body.counter_date, body.counter_time, ts, token)
      .run();
    return json({ status: "pending" });
  }

  return err("Неизвестное действие.");
}

// --------------------------------------------------------------------------
// Secretary API
// --------------------------------------------------------------------------

async function handleSecretaryLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Некорректный JSON.");
  }
  const password = body.password || "";
  const expected = env.SECRETARY_PASSWORD || "";
  if (!expected || !constantTimeEqual(password, expected)) {
    return err("Неверный пароль.", 401);
  }

  const token = randomToken(32);
  const ts = new Date();
  const expiresAt = new Date(ts.getTime() + SESSION_TTL_HOURS * 3600 * 1000);

  await env.DB.prepare(
    "INSERT INTO secretary_sessions (token, created_at, expires_at) VALUES (?, ?, ?)"
  )
    .bind(token, ts.toISOString(), expiresAt.toISOString())
    .run();

  return json({ session_token: token, expires_at: expiresAt.toISOString() });
}

async function handleSecretaryListRequests(request, env) {
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status");

  let query = "SELECT * FROM requests";
  const params = [];
  if (statusFilter) {
    query += " WHERE status = ?";
    params.push(statusFilter);
  }
  query += " ORDER BY created_at DESC";

  const { results } = await env.DB.prepare(query)
    .bind(...params)
    .all();

  return json({ requests: results });
}

async function handleSecretaryGetOne(id, env) {
  const row = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
  if (!row) return err("Заявка не найдена.", 404);

  if (!row.seen_by_secretary) {
    await env.DB.prepare("UPDATE requests SET seen_by_secretary = 1 WHERE id = ?").bind(id).run();
    row.seen_by_secretary = 1;
  }
  return json(row);
}

async function handleSecretaryDecide(id, request, env) {
  const row = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
  if (!row) return err("Заявка не найдена.", 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Некорректный JSON.");
  }

  const ts = nowIso();

  if (body.action === "approve") {
    await env.DB.prepare(
      "UPDATE requests SET status='confirmed', secretary_note=?, updated_at=? WHERE id=?"
    )
      .bind(body.note || null, ts, id)
      .run();
    return json({ status: "confirmed" });
  }

  if (body.action === "propose") {
    if (!body.date || !body.time) return err("Укажите предлагаемые дату и время.");
    if (row.round >= MAX_ROUNDS) {
      await env.DB.prepare("UPDATE requests SET status='expired', updated_at=? WHERE id=?")
        .bind(ts, id)
        .run();
      return err("Лимит согласований исчерпан — свяжитесь с родителем напрямую.", 409);
    }
    await env.DB.prepare(
      `UPDATE requests SET status='proposed_alternative', proposed_date=?, proposed_time=?,
       secretary_note=?, round=round+1, updated_at=? WHERE id=?`
    )
      .bind(body.date, body.time, body.note || null, ts, id)
      .run();
    return json({ status: "proposed_alternative" });
  }

  if (body.action === "reject") {
    await env.DB.prepare("UPDATE requests SET status='rejected', secretary_note=?, updated_at=? WHERE id=?")
      .bind(body.note || null, ts, id)
      .run();
    return json({ status: "rejected" });
  }

  // Секретарь тоже может отменить уже подтверждённое собеседование — не только
  // родитель (см. respond действия cancel/reschedule). "propose" выше уже
  // отрабатывает и для confirmed — это и есть "перенести время" со стороны школы.
  if (body.action === "cancel") {
    if (row.status !== "confirmed") return err("Отменить можно только подтверждённое собеседование.", 409);
    await env.DB.prepare("UPDATE requests SET status='cancelled', secretary_note=?, updated_at=? WHERE id=?")
      .bind(body.note || null, ts, id)
      .run();
    return json({ status: "cancelled" });
  }

  return err("Неизвестное действие.");
}

async function handleSecretaryDelete(id, env) {
  const row = await env.DB.prepare("SELECT status FROM requests WHERE id = ?").bind(id).first();
  if (!row) return err("Заявка не найдена.", 404);

  // Удалять можно только заявки с "завершённым" отрицательным исходом —
  // так проще случайно не стереть что-то активное или подтверждённое.
  if (!["rejected", "cancelled", "expired"].includes(row.status)) {
    return err("Удалять можно только отклонённые, отменённые или истёкшие заявки.", 409);
  }

  await env.DB.prepare("DELETE FROM requests WHERE id = ?").bind(id).run();
  return json({ deleted: true });
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function handleSecretaryExportCsv(env) {
  const { results } = await env.DB.prepare("SELECT * FROM requests ORDER BY created_at DESC").all();
  const cols = [
    "id", "status", "child_last_name", "child_first_name", "birth_date", "grade", "current_school",
    "parent_name", "phone", "email", "why_school", "why_you", "reminder_offset",
    "preferred_date", "preferred_time", "proposed_date", "proposed_time", "secretary_note",
    "round", "created_at", "updated_at",
  ];
  const lines = [cols.join(",")];
  for (const row of results) {
    lines.push(cols.map((c) => csvEscape(row[c])).join(","));
  }
  const csv = "﻿" + lines.join("\r\n"); // BOM для корректной кириллицы в Excel

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="interview-requests.csv"',
    },
  });
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/api/requests" && method === "POST") {
        return await handleCreateRequest(request, env);
      }

      let m;

      if ((m = path.match(/^\/api\/status\/([^/]+)$/)) && method === "GET") {
        return await handleGetStatus(m[1], env);
      }

      if ((m = path.match(/^\/api\/status\/([^/]+)\/respond$/)) && method === "POST") {
        return await handleRespond(m[1], request, env);
      }

      if (path === "/api/secretary/login" && method === "POST") {
        return await handleSecretaryLogin(request, env);
      }

      if (path.startsWith("/api/secretary/")) {
        const sessionToken = await requireSecretary(request, env);
        if (!sessionToken) return err("Требуется вход в панель секретаря.", 401);

        if (path === "/api/secretary/requests" && method === "GET") {
          return await handleSecretaryListRequests(request, env);
        }
        if ((m = path.match(/^\/api\/secretary\/requests\/(\d+)$/)) && method === "GET") {
          return await handleSecretaryGetOne(Number(m[1]), env);
        }
        if ((m = path.match(/^\/api\/secretary\/requests\/(\d+)\/decide$/)) && method === "POST") {
          return await handleSecretaryDecide(Number(m[1]), request, env);
        }
        if ((m = path.match(/^\/api\/secretary\/requests\/(\d+)$/)) && method === "DELETE") {
          return await handleSecretaryDelete(Number(m[1]), env);
        }
        if (path === "/api/secretary/export.csv" && method === "GET") {
          return await handleSecretaryExportCsv(env);
        }
      }

      if (path.startsWith("/api/")) return err("Не найдено.", 404);

      // Всё остальное — статика (public/) через ASSETS-биндинг
      return env.ASSETS.fetch(request);
    } catch (e) {
      return err("Внутренняя ошибка сервера: " + (e && e.message ? e.message : String(e)), 500);
    }
  },
};
