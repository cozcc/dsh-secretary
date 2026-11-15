/**
 * 看板落盘：~/.dsh/workbench/board.json。
 *
 * 纯文件、可读、可以直接用编辑器看。写入用「临时文件 + rename」保证原子性，
 * 读失败不会把已有数据清空。
 *
 * 并发：所有写操作走同一条 promise 队列，避免两个标签页同时拖便签时互相覆盖半个文件。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BOARD,
  normalizeBoard,
  addNote,
  updateNote,
  setDone,
  addUpdate,
  removeUpdate,
  removeNote,
} from './board.mjs';

export function defaultDataDir() {
  return path.join(os.homedir(), '.dsh', 'secretary');
}

export class BoardStore {
  constructor(dataDir) {
    this.dataDir = dataDir || defaultDataDir();
    this.file = path.join(this.dataDir, 'board.json');
    this.queue = Promise.resolve();
    this.warned = false;
  }

  /** 读盘。文件不存在 / 解析失败都给一个干净看板（不抛错，面板至少能打开）。 */
  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT' && !this.warned) {
        this.warned = true;
        console.warn(`[workbench] 读看板失败：${error?.message ?? error}`);
      }
      return normalizeBoard(DEFAULT_BOARD);
    }
    try {
      return normalizeBoard(JSON.parse(raw));
    } catch (error) {
      // 解析失败：把坏文件留一份副本，别直接覆盖掉用户数据。
      const backup = `${this.file}.broken-${Date.now()}`;
      try { fs.copyFileSync(this.file, backup); } catch { /* 忽略 */ }
      console.warn(`[workbench] 看板 JSON 解析失败，已备份到 ${backup}：${error?.message ?? error}`);
      return normalizeBoard(DEFAULT_BOARD);
    }
  }

  write(board) {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return board;
  }

  /** 串行地做一次读-改-写，返回 { board, result }。 */
  mutate(fn) {
    const run = async () => {
      const board = this.read();
      const result = fn(board);
      this.write(board);
      return { board, result };
    };
    const next = this.queue.then(run, run);
    // 队列本身不因为单次失败而断掉
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  addNote(input) { return this.mutate((b) => addNote(b, input)); }
  updateNote(id, patch) { return this.mutate((b) => updateNote(b, id, patch)); }
  setDone(id, done) { return this.mutate((b) => setDone(b, id, done)); }
  addUpdate(id, text) { return this.mutate((b) => addUpdate(b, id, text)); }
  removeUpdate(id, updateId) { return this.mutate((b) => removeUpdate(b, id, updateId)); }
  removeNote(id) { return this.mutate((b) => removeNote(b, id)); }
}
