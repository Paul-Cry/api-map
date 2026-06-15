import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { SESSION_TTL_MS } from "../config.js";
import { HttpError } from "../errors.js";
import {
  deleteExpiredSessions,
  deleteSession,
  findSession,
  findUserByEmail,
  findUserById,
  insertSession,
  insertUser,
} from "../repositories/usersRepository.js";

export function registerUser(email, password) {
  const normalizedEmail = normalizeEmail(email);
  validatePassword(password);
  if (findUserByEmail(normalizedEmail)) {
    throw new HttpError("User already exists", 409);
  }

  const salt = randomBytes(16).toString("hex");
  const user = {
    id: randomBytes(16).toString("hex"),
    email: normalizedEmail,
    passwordHash: hashPassword(password, salt),
    salt,
    createdAt: new Date().toISOString(),
  };

  insertUser(user);
  return publicUser(user);
}

export function loginUser(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const user = findUserByEmail(normalizedEmail);
  if (!user || !checkPassword(password, user)) {
    throw new HttpError("Invalid email or password", 401);
  }
  return publicUser(user);
}

export function createSession(userId) {
  const now = Date.now();
  const session = {
    id: randomBytes(32).toString("hex"),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  insertSession(session);
  return session;
}

export function destroySession(sessionId) {
  if (sessionId) deleteSession(sessionId);
}

export function getUserBySession(sessionId) {
  if (!sessionId) return null;
  const now = new Date().toISOString();
  deleteExpiredSessions(now);
  const session = findSession(sessionId);
  if (!session || session.expires_at <= now) return null;
  const user = findUserById(session.user_id);
  return user ? publicUser(user) : null;
}

export function publicUser(user) {
  return { id: user.id, email: user.email };
}

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HttpError("Enter a valid email", 400);
  return value;
}

function validatePassword(password) {
  if (String(password || "").length < 6) throw new HttpError("Password must be at least 6 characters", 400);
}

function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 64).toString("hex");
}

function checkPassword(password, user) {
  const expected = Buffer.from(user.password_hash, "hex");
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
