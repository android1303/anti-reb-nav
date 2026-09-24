#!/usr/bin/env node
/**
 * Відтворення заїзду: подає сирі колонки CSV у справжнє ядро telemetry.js.
 *
 *   node tools/replay/replay.mjs <вхідний.csv> [вихідний.csv] [шлях_до_ядра] [sessionId]
 *
 * За замовчуванням ядро = ./telemetry.js, вихід = replay_out.csv.
 * Щоб перевірити інші константи — скопіюй telemetry.js у тимчасовий файл,
 * зміни константу і передай його третім аргументом.
 * sessionId (4-й аргумент, опційно): відтворити лише рядки з цим sessionId
 * (для кумулятивних дампів з кількома сесіями).
 * Потрібен devDependency esbuild. Далі: python3 (Windows: python) tools/replay/compare.py replay_out.csv
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [, , csvPath, outPath = 'replay_out.csv', corePath = 'telemetry.js', sessionId] = process.argv;
if (!csvPath) {
  console.error('Використання: node tools/replay/replay.mjs <вхідний.csv> [вихідний.csv] [ядро.js] [sessionId]');
  process.exit(1);
}

// Заглушки для залежностей, яких немає поза телефоном
const mocks = {
  'expo-file-system/legacy': `
    export const documentDirectory='/tmp/'; export const cacheDirectory='/tmp/';
    export const EncodingType={UTF8:'utf8'};
    export const getInfoAsync=async()=>({exists:true}); export const makeDirectoryAsync=async()=>{};
    export const readDirectoryAsync=async()=>[]; export const writeAsStringAsync=async()=>{};
    export const readAsStringAsync=async()=>''; export const moveAsync=async()=>{};
    export const deleteAsync=async()=>{};`,
  '@react-native-community/netinfo': `export default { fetch: async () => ({ isConnected: false }) };`,
  'firebase/firestore': `export const collection=()=>{}; export const writeBatch=()=>{}; export const doc=()=>{};`,
};
const mockPlugin = {
  name: 'mocks',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => (mocks[a.path] ? { path: a.path, namespace: 'mock' } : null));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: mocks[a.path], loader: 'js' }));
  },
};

const bundled = await build({
  entryPoints: [path.resolve(root, corePath)],
  bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [mockPlugin], logLevel: 'error',
});
const tmp = path.join(os.tmpdir(), `antireb_core_${Date.now()}.mjs`);
writeFileSync(tmp, bundled.outputFiles[0].text);
const core = await import(pathToFileURL(tmp).href);
unlinkSync(tmp);
const telemetry = core.telemetry || core.default;

// Простий парсер CSV (значення без ком; лапки знімаються)
const lines = readFileSync(csvPath, 'utf8').replace(/\r/g, '').trim().split('\n');
const header = lines[0].split(',');
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const need = ['timestamp', 'speedRaw', 'obdAgeMs', 'gyroXRaw', 'gyroYRaw', 'gyroZRaw', 'gravX', 'gravY', 'gravZ'];
const missing = need.filter((k) => !(k in col));
if (missing.length) {
  console.error('У CSV бракує сирих колонок:', missing.join(', '));
  process.exit(1);
}
if (sessionId && !('sessionId' in col)) {
  console.error('Заданий sessionId, але в CSV немає колонки sessionId.');
  process.exit(1);
}
const num = (cells, k) => {
  if (!(k in col)) return 0;
  const v = cells[col[k]]?.replace(/^"|"$/g, '');
  return v === '' || v === undefined ? NaN : Number(v);
};

telemetry.startSession();
const outCols = ['timestamp', 'currentState', 'speedUsed', 'speedExtrapolated', 'gapS', 'yawRateClean',
  'gyroBias', 'zuptApplied', 'heading', 'posX', 'posY', 'lat', 'lon',
  'forwardAxis', 'forwardSign', 'isReversing'];
const out = [outCols.join(',')];
for (const line of lines.slice(1)) {
  const c = line.split(',');
  if (sessionId && c[col.sessionId] !== sessionId) continue;
  const lat = num(c, 'lat'), lon = num(c, 'lon');
  const e = telemetry.recordPoint({
    speed: num(c, 'speedRaw'), obdAgeMs: num(c, 'obdAgeMs'),
    gyroX: num(c, 'gyroXRaw'), gyroY: num(c, 'gyroYRaw'), gyroZ: num(c, 'gyroZRaw'),
    accelX: num(c, 'accelX') || 0, accelY: num(c, 'accelY') || 0, accelZ: num(c, 'accelZ') || 0,
    gravX: num(c, 'gravX'), gravY: num(c, 'gravY'), gravZ: num(c, 'gravZ'),
    pressure: num(c, 'pressure') || 0,
    lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null,
    timestamp: num(c, 'timestamp'),
  });
  if (e) out.push(outCols.map((k) => (e[k] === null || e[k] === undefined ? '' : e[k])).join(','));
}
writeFileSync(outPath, out.join('\n'));
const s = telemetry.getNavState();
console.log(`Відтворено ${out.length - 1} точок -> ${outPath}`);
console.log(`Кінцевий стан: heading=${s.heading.toFixed(1)}° posX=${s.posX.toFixed(1)} posY=${s.posY.toFixed(1)} bias=${s.gyroBias.toFixed(3)}°/с`);
process.exit(0); // таймер flush у telemetry тримає процес
