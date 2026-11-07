#!/usr/bin/env node
/**
 * 桌面版打包预处理：
 * 1. 生成全套图标（PNG 不入库）
 * 2. 把网页资源复制到 desktop/app/（electron-builder 的 files 无法引用上级目录）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'desktop', 'app');

/* 1. 图标（gen-icons.mjs 会同时输出 PWA 与 Android 图标） */
await import('./gen-icons.mjs');

/* 2. 复制网页资源 */
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const f of ['index.html', 'manifest.webmanifest', 'sw.js']) {
  fs.copyFileSync(path.join(root, f), path.join(dest, f));
}
for (const d of ['css', 'js', 'icons']) {
  fs.cpSync(path.join(root, d), path.join(dest, d), { recursive: true });
}
console.log('✓ 网页资源已复制到 desktop/app/（供 electron-builder 打包）');
