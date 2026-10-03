#!/usr/bin/env node
/**
 * Відтворення заїзду: подає сирі колонки CSV у справжнє ядро telemetry.js.
 *
 *   node tools/replay/replay.mjs <вхідний.csv> [вихідний.csv] [шлях_до_ядра] [sessionId] [--sensors=expo] [--anchor] [--gps-off-after=<с>]
 *
 * За замовчуванням ядро = ./telemetry.js, вихід = replay_out.csv.
 * Щоб перевірити інші константи — скопіюй telemetry.js у тимчасовий файл,
 * зміни константу і передай його третім аргументом.
 * sessionId (4-й аргумент, опційно): відтворити лише рядки з цим sessionId
 * (для кумулятивних дампів з кількома сесіями).
 * Входи датчиків (v20): якщо в CSV є нативні колонки nGyroX…nGravZ і вони не порожні —
 * ядро бере їх (sensorSource=native), інакше — старі gyroXRaw/accelX/gravX (expo).
 * --sensors=expo примусово ігнорує нативні колонки (порівняння еквівалентності).
 * --anchor (TASK-018, TASK-021): додатково відтворює geoAnchor.js (прив'язка DR до карти за GPS і
 * за мережевою позицією netLat/netLon, якщо вони є в CSV; пріоритет GPS -> мережа -> DR) і пише
 * mockLat/mockLon/anchorState/anchorSource у вихідний CSV; у кінці друкує відстань позиції для Waze
 * від GPS у моменти GPS-фіксів (до переприв'язки) окремо для кожного anchorSource. --gps-off-after=<с від початку>: після цього часу
 * geoAnchor не отримує GPS-фіксів (режим «без GPS»); істинний GPS у даних лишається для оцінки.
 * --gps-off-after=0 відтворює чисто мережевий режим.
 * Якщо в CSV є колонка rebSim і на рядку rebSim = true («Симуляція РЕБ»), GPS-фікси в geoAnchor
 * на цьому рядку не подаються (відтворення збігається з живим станом); істинний GPS лишається для оцінки.
 * Потрібен devDependency esbuild. Далі: python3 (Windows: python) tools/replay/compare.py replay_out.csv
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.filter((a) => !a.startsWith('--'));
const forceExpo = process.argv.includes('--sensors=expo');
const useAnchor = process.argv.includes('--anchor');
const gpsOffArg = process.argv.find((a) => a.startsWith('--gps-off-after='));
const gpsOffAfterS = gpsOffArg ? Number(gpsOffArg.split('=')[1]) : null;
const [, , csvPath, outPath = 'replay_out.csv', corePath = 'telemetry.js', sessionId] = argv;
if (!csvPath) {
  console.error('Використання: node tools/replay/replay.mjs <вхідний.csv> [вихідний.csv] [ядро.js] [sessionId] [--sensors=expo] [--anchor] [--gps-off-after=<с>]');
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

let geoAnchorMod = null;
if (useAnchor) {
  const ga = await build({
    entryPoints: [path.resolve(root, 'geoAnchor.js')],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
  });
  const gaTmp = path.join(os.tmpdir(), `antireb_geoanchor_${Date.now()}.mjs`);
  writeFileSync(gaTmp, ga.outputFiles[0].text);
  geoAnchorMod = await import(pathToFileURL(gaTmp).href);
  unlinkSync(gaTmp);
}

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
// Колонки датчиків: відсутня/порожня комірка = null (датчик не віддавав значення)
const numOrNull = (cells, k) => {
  if (!(k in col)) return null;
  const v = cells[col[k]]?.replace(/^"|"$/g, '');
  return v === '' || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
};

telemetry.startSession();
const outCols = ['timestamp', 'currentState', 'speedUsed', 'speedExtrapolated', 'gapS', 'yawRateClean',
  'gyroBias', 'zuptApplied', 'heading', 'posX', 'posY', 'lat', 'lon',
  'forwardAxis', 'forwardSign', 'isReversing', 'sensorSource'];
if (useAnchor) outCols.push('mockLat', 'mockLon', 'mockBearing', 'anchorState', 'anchorSource', 'netFitN', 'netFitResidM', 'mockErrM');
const out = [outCols.join(',')];
const anchor = useAnchor ? geoAnchorMod.createGeoAnchor() : null;
let t0 = null;
let prevLat = null, prevLon = null;
let prevNetLat = null, prevNetLon = null;
const errBySource = { gps: [], network: [], dr_only: [] };
const errAfterOff = [];
const mDist = (la1, lo1, la2, lo2) => {
  const k = 111320;
  return Math.hypot((lo2 - lo1) * k * Math.cos(la1 * Math.PI / 180), (la2 - la1) * k);
};
const median = (a) => { const x = [...a].sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : NaN; };
for (const line of lines.slice(1)) {
  const c = line.split(',');
  if (sessionId && c[col.sessionId] !== sessionId) continue;
  const lat = num(c, 'lat'), lon = num(c, 'lon');
  const e = telemetry.recordPoint({
    speed: num(c, 'speedRaw'), obdAgeMs: num(c, 'obdAgeMs'),
    gyroX: numOrNull(c, 'gyroXRaw'), gyroY: numOrNull(c, 'gyroYRaw'), gyroZ: numOrNull(c, 'gyroZRaw'),
    accelX: numOrNull(c, 'accelX'), accelY: numOrNull(c, 'accelY'), accelZ: numOrNull(c, 'accelZ'),
    gravX: numOrNull(c, 'gravX'), gravY: numOrNull(c, 'gravY'), gravZ: numOrNull(c, 'gravZ'),
    ...(forceExpo
      ? {}
      : {
          nGyroX: numOrNull(c, 'nGyroX'), nGyroY: numOrNull(c, 'nGyroY'), nGyroZ: numOrNull(c, 'nGyroZ'),
          nAccX: numOrNull(c, 'nAccX'), nAccY: numOrNull(c, 'nAccY'), nAccZ: numOrNull(c, 'nAccZ'),
          nGravX: numOrNull(c, 'nGravX'), nGravY: numOrNull(c, 'nGravY'), nGravZ: numOrNull(c, 'nGravZ'),
        }),
    pressure: num(c, 'pressure') || 0,
    lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null,
    timestamp: num(c, 'timestamp'),
  });
  if (e) {
    if (anchor) {
      if (t0 === null) t0 = e.timestamp;
      const tRel = (e.timestamp - t0) / 1000;
      anchor.onDrSample({ tMs: e.timestamp, posX: e.posX, posY: e.posY, heading: e.heading, speedKmh: e.speedUsed });
      // Новий GPS-фікс = зміна lat/lon (як у compare.py)
      const isFix = Number.isFinite(lat) && Number.isFinite(lon) && (lat !== prevLat || lon !== prevLon);
      let mockErrM = '';
      // Мережевий фікс = зміна netLat/netLon (колонки є в CSV від v18)
      const netLat = numOrNull(c, 'netLat'), netLon = numOrNull(c, 'netLon');
      if (netLat !== null && netLon !== null && (netLat !== prevNetLat || netLon !== prevNetLon)) {
        anchor.onNetFix({ tMs: e.timestamp, lat: netLat, lon: netLon, accuracy: numOrNull(c, 'netAccuracy'), ageMs: 0 });
        prevNetLat = netLat;
        prevNetLon = netLon;
      }
      const pre = anchor.getPosition(e.timestamp);
      if (isFix) {
        if (prevLat !== null && pre.source !== 'waiting') {
          mockErrM = mDist(pre.lat, pre.lon, lat, lon);
          errBySource[pre.source].push(mockErrM);
          if (gpsOffAfterS !== null && tRel >= gpsOffAfterS) errAfterOff.push({ t: tRel, err: mockErrM, state: pre.source });
        }
        const rebRow = 'rebSim' in col && c[col.rebSim] === 'true';
        const gpsOff = rebRow || (gpsOffAfterS !== null && tRel >= gpsOffAfterS);
        if (!gpsOff) {
          anchor.onGpsFix({
            tMs: e.timestamp, lat, lon,
            accuracy: numOrNull(c, 'gpsAccuracy'),
            mock: 'gpsMock' in col ? c[col.gpsMock] === 'true' : false,
          });
        }
        prevLat = lat;
        prevLon = lon;
      }
      const pos = anchor.getPosition(e.timestamp);
      e.mockLat = pos.lat; e.mockLon = pos.lon; e.mockBearing = pos.bearing; e.anchorState = pos.state; e.anchorSource = pos.source; e.netFitN = pos.netFitN; e.netFitResidM = pos.netFitResidM; e.mockErrM = mockErrM;
    }
    out.push(outCols.map((k) => (e[k] === null || e[k] === undefined ? '' : e[k])).join(','));
  }
}
writeFileSync(outPath, out.join('\n'));
const s = telemetry.getNavState();
console.log(`Відтворено ${out.length - 1} точок -> ${outPath}`);
console.log(`Кінцевий стан: heading=${s.heading.toFixed(1)}° posX=${s.posX.toFixed(1)} posY=${s.posY.toFixed(1)} bias=${s.gyroBias.toFixed(3)}°/с`);
if (anchor) {
  const pct90 = (a) => { const x = [...a].sort((p, q) => p - q); return x[Math.min(x.length - 1, Math.floor(x.length * 0.9))]; };
  const fmt = (a) => (a.length ? `n=${a.length} медіана=${median(a).toFixed(1)} м 90%=${pct90(a).toFixed(1)} м макс=${Math.max(...a).toFixed(1)} м` : 'немає даних');
  for (const src of ['gps', 'network', 'dr_only']) {
    console.log(`geoAnchor: відстань позиції для Waze від GPS у моменти фіксів, anchorSource="${src}": ${fmt(errBySource[src])}`);
  }
  if (gpsOffAfterS !== null) {
    const errs = errAfterOff.map((x) => x.err);
    const lastErr = errAfterOff.length ? errAfterOff[errAfterOff.length - 1].err : NaN;
    console.log(`geoAnchor, --gps-off-after=${gpsOffAfterS}: після цього часу (GPS не подається): ${fmt(errs)} остання=${Number.isFinite(lastErr) ? lastErr.toFixed(1) : '-'} м`);
  }
}
process.exit(0); // таймер flush у telemetry тримає процес
