/**
 * 用户设置：存在数据目录的 settings.json，改完立即生效（不用重启）。
 *
 *   { dailyTime: '08:00', retentionDays: 90, enabled: true }
 *
 * dailyTime 是**本机时区**的 HH:MM；retentionDays 是简报快照保留天数。
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = { dailyTime: '08:00', retentionDays: 90, enabled: true };

function fileOf(dataDir) {
  return path.join(dataDir, 'settings.json');
}

function normalizeTime(value) {
  const raw = String(value ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function readSettings(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
    return sanitize(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function sanitize(raw = {}) {
  const time = normalizeTime(raw.dailyTime) ?? DEFAULT_SETTINGS.dailyTime;
  const days = Number(raw.retentionDays);
  const retentionDays = Number.isFinite(days) ? Math.min(3650, Math.max(1, Math.round(days))) : DEFAULT_SETTINGS.retentionDays;
  return { dailyTime: time, retentionDays, enabled: raw.enabled !== false };
}

export function writeSettings(dataDir, patch = {}) {
  const next = sanitize({ ...readSettings(dataDir), ...patch });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = fileOf(dataDir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}
