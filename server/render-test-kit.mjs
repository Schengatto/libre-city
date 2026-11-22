import fs from 'node:fs';
import path from 'node:path';

const JS_DIR = path.join(import.meta.dirname, '..', 'js');

export const readSource = file => fs.readFileSync(path.join(JS_DIR, file), 'utf8').replace(/\r\n/g, '\n');

export function extractTopLevel(source, name) {
  const start = source.search(new RegExp(`^(function ${name}\\(|const ${name}\\b)`, 'm'));
  if (start < 0) throw new Error(`declaration not found: ${name}`);
  const firstLineEnd = source.indexOf('\n', start);
  if (/;\s*(\/\/.*)?$/.test(source.slice(start, firstLineEnd)) && !source.slice(start, firstLineEnd).startsWith('function')) {
    return source.slice(start, firstLineEnd);
  }
  const close = source.slice(start).search(/^};?\s*$/m);
  return source.slice(start, start + close + 2);
}

export function createRecordingContext() {
  const calls = [];
  const state = {};
  const gradient = { addColorStop: (...args) => calls.push(['addColorStop', args]) };
  const context = new Proxy(state, {
    get: (target, property) => property in target ? target[property]
      : (...args) => { calls.push([property, args]); return gradient; },
    set: (target, property, value) => { target[property] = value; calls.push(['set:' + String(property), [value]]); return true; },
  });
  return { context, calls };
}
