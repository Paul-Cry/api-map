import { getDb } from "../db.js";

export function findUserByEmail(email) {
  return getDb()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email);
}

export function findUserById(id) {
  return getDb()
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(id);
}

export function insertUser(user) {
  getDb()
    .prepare(`
      INSERT INTO users (id, email, password_hash, salt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(user.id, user.email, user.passwordHash, user.salt, user.createdAt);
}

export function insertSession(session) {
  getDb()
    .prepare(`
      INSERT INTO sessions (id, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(session.id, session.userId, session.createdAt, session.expiresAt);
}

export function deleteSession(id) {
  getDb()
    .prepare("DELETE FROM sessions WHERE id = ?")
    .run(id);
}

export function findSession(id) {
  return getDb()
    .prepare(`
      SELECT sessions.*, users.email
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ?
    `)
    .get(id);
}

export function deleteExpiredSessions(now) {
  getDb()
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .run(now);
}
