'use strict';
/**
 * 计算 Edge/Chrome 为「已解压扩展(unpacked)」分配的扩展 ID。
 *
 * 算法(实测校准):sha256(路径以 UTF-16LE 编码) 取前 16 字节,
 * 每半字节映射为 a-p 中的一个字母。
 * 路径必须用 Windows 原生反斜杠形式,且大小写保持原样 —— 这几个细节错一个,
 * 算出来的 ID 就与浏览器实际分配的不同,注册表策略会指向一个不存在的扩展。
 *
 * 用法:node get_ext_id.js [扩展目录]
 * 输出:仅一行扩展 ID
 */
const crypto = require('crypto');
const path = require('path');

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'extension'));
const hash = crypto.createHash('sha256').update(Buffer.from(dir, 'utf16le')).digest('hex').slice(0, 32);

let id = '';
for (const ch of hash) id += String.fromCharCode(97 + parseInt(ch, 16));

console.log(id);
