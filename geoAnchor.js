/* =====================================================================
 * geoAnchor — прив'язка DR до карти за хорошим GPS (TASK-018).
 *
 * Чиста логіка без залежностей від React Native: її використовують і застосунок
 * (подача позиції у Waze через mock location), і tools/replay/replay.mjs.
 * НЕ змінює heading/posX/posY ядра — це окремий шар поверх нього.
 *
 * Система DR: posX = схід, posY = північ (метри від старту), heading — градуси за
 * годинниковою стрілкою від початкового напрямку авто (не від півночі).
 * θ (headingOffsetDeg) — поворот за годинниковою стрілкою, що суміщає DR зі
 * справжніми сторонами світу: справжній курс = heading + θ.
 *
 * API:
 *   const ga = createGeoAnchor();
 *   ga.onDrSample({ tMs, posX, posY, heading, speedKmh });   // кожен тік ядра
 *   ga.onGpsFix({ tMs, lat, lon, accuracy, mock });          // кожен новий GPS-фікс
 *   ga.getPosition(nowMs) -> { state, lat, lon, bearing, accuracy, anchorAgeS, headingOffsetDeg }
 *   ga.reset();                                              // початок нової сесії (DR від нуля)
 * state: 'waiting' (θ ще не готовий / прив'язки нема) | 'gps' | 'dr_only'.
 * ===================================================================== */

const GOOD_ACCURACY_M = 15; // лише фікси з accuracy ≤ цього
const MIN_SPEED_KMH = 15; // і лише в русі: на стоянці напрямок невизначений
const WINDOW_PATH_M = 300; // ковзне вікно шляху для оцінки θ
const READY_PATH_M = 150; // θ готовий: ≥ 150 м шляху у вікні
const READY_FIXES = 10; // ... і ≥ 10 фіксів
const REANCHOR_MS = 5000; // перепрв'язка до свіжого GPS-фіксу раз на 5 с
const FREEZE_AFTER_MS = 5000; // немає хороших фіксів довше — лише DR
const ACCURACY_BASE_M = 10; // accuracy для Waze: 10 м + 3% шляху від прив'язки
const ACCURACY_PER_PATH = 0.03;
const ACCURACY_MAX_M = 300;
const SAMPLE_KEEP_MS = 30000; // історія DR для інтерполяції на момент фіксу
const M_PER_DEG = 111320;
const DEG = Math.PI / 180;

const normDeg360 = (d) => ((d % 360) + 360) % 360;
const normDeg180 = (d) => {
  const x = normDeg360(d);
  return x > 180 ? x - 360 : x;
};

export function createGeoAnchor() {
  let samples; // {t, x, y, path}
  let last; // останній DR-зразок {t, x, y, path, heading, speedKmh}
  let path;
  let refLat; // початок місцевої проєкції GPS (перший хороший фікс)
  let refLon;
  let pairs; // {ax, ay, bE, bN, path}: DR і GPS в одну мить
  let thetaRad; // null, поки не готовий
  let origin; // {lat, lon, x, y, path, t}
  let lastGoodFixT;
  let mockSeen; // останній фікс був mock -> заморожено

  const reset = () => {
    samples = [];
    last = null;
    path = 0;
    refLat = null;
    refLon = null;
    pairs = [];
    thetaRad = null;
    origin = null;
    lastGoodFixT = null;
    mockSeen = false;
  };
  reset();

  const onDrSample = ({ tMs, posX, posY, heading, speedKmh }) => {
    if (last) path += Math.hypot(posX - last.x, posY - last.y);
    last = { t: tMs, x: posX, y: posY, path, heading, speedKmh: Number.isFinite(speedKmh) ? speedKmh : 0 };
    samples.push(last);
    while (samples.length > 1 && tMs - samples[0].t > SAMPLE_KEEP_MS) samples.shift();
  };

  // DR на момент t (лінійна інтерполяція між сусідніми зразками)
  const interpDr = (t) => {
    if (samples.length === 0) return null;
    if (t >= samples[samples.length - 1].t) return samples[samples.length - 1];
    if (t < samples[0].t) return null;
    for (let i = samples.length - 1; i > 0; i--) {
      const a = samples[i - 1];
      const b = samples[i];
      if (t >= a.t) {
        const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
        return {
          t,
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          path: a.path + (b.path - a.path) * k,
          heading: b.heading,
          speedKmh: b.speedKmh,
        };
      }
    }
    return null;
  };

  // Кращий поворот (за годинниковою стрілкою), що суміщає центровані точки DR з GPS:
  // θ = atan2(Σ(ay·bE − ax·bN), Σ(ax·bE + ay·bN)) — той самий принцип, що вирівнювання в compare.py
  const estimateTheta = () => {
    const n = pairs.length;
    let cax = 0, cay = 0, cbE = 0, cbN = 0;
    for (const p of pairs) {
      cax += p.ax;
      cay += p.ay;
      cbE += p.bE;
      cbN += p.bN;
    }
    cax /= n; cay /= n; cbE /= n; cbN /= n;
    let s1 = 0;
    let s2 = 0;
    for (const p of pairs) {
      const ax = p.ax - cax;
      const ay = p.ay - cay;
      const bE = p.bE - cbE;
      const bN = p.bN - cbN;
      s1 += ax * bE + ay * bN;
      s2 += ay * bE - ax * bN;
    }
    return Math.atan2(s2, s1);
  };

  const onGpsFix = ({ tMs, lat, lon, accuracy, mock }) => {
    // Фікс від mock-провайдера (наша ж позиція) НІКОЛИ не використовується: заморожуємо
    if (mock === true) {
      mockSeen = true;
      return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!(Number.isFinite(accuracy) && accuracy <= GOOD_ACCURACY_M)) return;
    const dr = interpDr(tMs);
    if (!dr || dr.speedKmh < MIN_SPEED_KMH) return;

    mockSeen = false; // хороший справжній фікс знімає заморозку
    lastGoodFixT = tMs;
    if (refLat === null) {
      refLat = lat;
      refLon = lon;
    }
    const bE = (lon - refLon) * M_PER_DEG * Math.cos(refLat * DEG);
    const bN = (lat - refLat) * M_PER_DEG;
    pairs.push({ ax: dr.x, ay: dr.y, bE, bN, path: dr.path });
    while (pairs.length > 1 && dr.path - pairs[0].path > WINDOW_PATH_M) pairs.shift();

    if (pairs.length >= READY_FIXES && pairs[pairs.length - 1].path - pairs[0].path >= READY_PATH_M) {
      thetaRad = estimateTheta();
    }
    if (thetaRad !== null && (origin === null || tMs - origin.t >= REANCHOR_MS)) {
      origin = { lat, lon, x: dr.x, y: dr.y, path: dr.path, t: tMs };
    }
  };

  const getPosition = (nowMs) => {
    if (origin === null || thetaRad === null || last === null) {
      return { state: 'waiting', lat: null, lon: null, bearing: null, accuracy: null, anchorAgeS: null, headingOffsetDeg: thetaRad === null ? null : normDeg180(thetaRad / DEG) };
    }
    const fresh = !mockSeen && lastGoodFixT !== null && nowMs - lastGoodFixT <= FREEZE_AFTER_MS;
    const dx = last.x - origin.x;
    const dy = last.y - origin.y;
    // поворот за годинниковою стрілкою на θ (схід, північ)
    const c = Math.cos(thetaRad);
    const s = Math.sin(thetaRad);
    const dE = dx * c + dy * s;
    const dN = -dx * s + dy * c;
    return {
      state: fresh ? 'gps' : 'dr_only',
      lat: origin.lat + dN / M_PER_DEG,
      lon: origin.lon + dE / (M_PER_DEG * Math.cos(origin.lat * DEG)),
      bearing: normDeg360(last.heading + thetaRad / DEG),
      accuracy: Math.min(ACCURACY_MAX_M, ACCURACY_BASE_M + ACCURACY_PER_PATH * (last.path - origin.path)),
      anchorAgeS: (nowMs - origin.t) / 1000,
      headingOffsetDeg: normDeg180(thetaRad / DEG),
    };
  };

  return { onDrSample, onGpsFix, getPosition, reset };
}
