/* =====================================================================
 * geoAnchor — прив'язка DR до карти (TASK-018, TASK-021).
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
 * Джерела прив'язки, за пріоритетом:
 *   1. "gps"     — хороший GPS (TASK-018): θ за вікном 300 м, перепрв'язка раз на 5 с;
 *   2. "network" — мережева позиція (TASK-021): підгонка повороту і зсуву DR-треку до
 *                  мережевих фіксів у вікні 3000 м шляху з відкиданням викидів;
 *   3. "dr_only" — лише DR від останньої прив'язки (будь-якої);
 *   "waiting"    — прив'язки ще немає.
 * Мережеві фікси збираються завжди, навіть коли GPS хороший, щоб мережевий режим
 * був готовий одразу після втрати GPS. Фікси з mock = true не використовуються ніколи.
 *
 * API:
 *   const ga = createGeoAnchor();
 *   ga.onDrSample({ tMs, posX, posY, heading, speedKmh });         // кожен тік ядра
 *   ga.onGpsFix({ tMs, lat, lon, accuracy, mock });                // кожен новий GPS-фікс
 *   ga.onNetFix({ tMs, lat, lon, accuracy, ageMs, mock });         // кожен новий мережевий фікс
 *   ga.getPosition(nowMs) -> { state, source, lat, lon, bearing, accuracy, anchorAgeS,
 *                              headingOffsetDeg, netFitN, netFitResidM, netFitPathM }
 *   ga.reset();                                                    // початок нової сесії
 * state — стан GPS-прив'язки (як у TASK-018): waiting | gps | dr_only;
 * source — джерело, що реально використано: waiting | gps | network | dr_only.
 * ===================================================================== */

// --- GPS (TASK-018) ---
const GOOD_ACCURACY_M = 15; // лише фікси з accuracy ≤ цього
const MIN_SPEED_KMH = 15; // і лише в русі: на стоянці напрямок невизначений
const WINDOW_PATH_M = 300; // ковзне вікно шляху для оцінки θ
const READY_PATH_M = 150; // θ готовий: ≥ 150 м шляху у вікні
const READY_FIXES = 10; // ... і ≥ 10 фіксів
const REANCHOR_MS = 5000; // перепрв'язка до свіжого GPS-фіксу раз на 5 с
const FREEZE_AFTER_MS = 5000; // немає хороших фіксів довше — не «gps»

// --- Мережа (TASK-021) ---
const NET_MAX_AGE_MS = 1500; // приймаємо лише свіжі фікси
const NET_MAX_ACCURACY_M = 500;
const NET_WINDOW_PATH_M = 3000; // вікно підгонки
const NET_OUTLIER_FACTOR = 3; // викид: відстань > max(3 × медіана, 150 м)
const NET_OUTLIER_MIN_M = 150;
const NET_READY_FIXES = 4; // після відкидання
const NET_READY_PATH_M = 1000; // шлях між першим і останнім фіксом вікна
const NET_ACCURACY_MIN_M = 30;
const NET_STALE_MS = 120000; // мережевих фіксів немає довше — підгонка лише екстраполюється (dr_only)

// --- Спільне ---
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
const median = (a) => {
  const x = [...a].sort((p, q) => p - q);
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
};

// Кращий жорсткий перетворення (поворот за годинниковою стрілкою θ + зсув) DR -> ENU без масштабу:
// θ = atan2(Σ(ay·bE − ax·bN), Σ(ax·bE + ay·bN)) за центрованими парами, t = mean(B) − R(θ)·mean(A).
// (Те саме, що θ = −atan2(Σ(ax·bN − ay·bE), Σ(ax·bE + ay·bN)) для повороту проти годинникової.)
const fitRigid = (pairs) => {
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
  const theta = Math.atan2(s2, s1);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { theta, tE: cbE - (cax * c + cay * s), tN: cbN - (-cax * s + cay * c) };
};

const residuals = (pairs, fit) => {
  const c = Math.cos(fit.theta);
  const s = Math.sin(fit.theta);
  return pairs.map((p) => Math.hypot(p.ax * c + p.ay * s + fit.tE - p.bE, -p.ax * s + p.ay * c + fit.tN - p.bN));
};

export function createGeoAnchor() {
  let samples; // {t, x, y, path}
  let last; // останній DR-зразок {t, x, y, path, heading, speedKmh}
  let path;
  let refLat; // початок місцевої проєкції (перший прийнятий фікс, GPS або мережа)
  let refLon;
  let pairs; // GPS: {ax, ay, bE, bN, path}
  let thetaRad; // GPS θ; null, поки не готовий
  let origin; // GPS-прив'язка {lat, lon, x, y, path, t}
  let lastGoodFixT;
  let mockSeen; // останній GPS-фікс був mock -> заморожено
  let netPairs; // мережа: {ax, ay, bE, bN, path}
  let netFit; // {theta, tE, tN, resid, n, ready, t, path} або null
  let netFixSeen;

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
    netPairs = [];
    netFit = null;
    netFixSeen = false;
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

  const toEnu = (lat, lon) => ({
    bE: (lon - refLon) * M_PER_DEG * Math.cos(refLat * DEG),
    bN: (lat - refLat) * M_PER_DEG,
  });

  // ---------------------------- GPS ----------------------------
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
    const { bE, bN } = toEnu(lat, lon);
    pairs.push({ ax: dr.x, ay: dr.y, bE, bN, path: dr.path });
    while (pairs.length > 1 && dr.path - pairs[0].path > WINDOW_PATH_M) pairs.shift();

    if (pairs.length >= READY_FIXES && pairs[pairs.length - 1].path - pairs[0].path >= READY_PATH_M) {
      thetaRad = fitRigid(pairs).theta; // лише поворот: зсув задає origin
    }
    if (thetaRad !== null && (origin === null || tMs - origin.t >= REANCHOR_MS)) {
      origin = { lat, lon, x: dr.x, y: dr.y, path: dr.path, t: tMs };
    }
  };

  // --------------------------- Мережа ---------------------------
  const refitNetwork = () => {
    const prev = netFit;
    netFit = { ready: false, n: netPairs.length, span: 0, resid: null, theta: 0, tE: 0, tN: 0, t: prev ? prev.t : null, path: prev ? prev.path : 0 };
    if (netPairs.length < 2) return;
    let fit = fitRigid(netPairs);
    let kept = netPairs;
    const d = residuals(netPairs, fit);
    const med = median(d);
    const thr = Math.max(NET_OUTLIER_FACTOR * med, NET_OUTLIER_MIN_M);
    const inl = netPairs.filter((_, i) => d[i] <= thr);
    let resid = med;
    if (inl.length < netPairs.length && inl.length >= 2) {
      fit = fitRigid(inl); // один прохід повторної підгонки
      kept = inl;
      resid = median(residuals(inl, fit));
    }
    netFit.theta = fit.theta;
    netFit.tE = fit.tE;
    netFit.tN = fit.tN;
    netFit.n = kept.length;
    netFit.span = kept.length >= 2 ? kept[kept.length - 1].path - kept[0].path : 0; // лише для відображення
    netFit.resid = resid;
    netFit.ready =
      kept.length >= NET_READY_FIXES && kept[kept.length - 1].path - kept[0].path >= NET_READY_PATH_M;
  };

  const onNetFix = ({ tMs, lat, lon, accuracy, ageMs, mock }) => {
    if (mock === true) return; // підміна нікому не потрібна, але на всяк випадок
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (Number.isFinite(ageMs) && ageMs > NET_MAX_AGE_MS) return; // лише свіжі
    if (!(Number.isFinite(accuracy) && accuracy <= NET_MAX_ACCURACY_M)) return;
    const dr = interpDr(tMs);
    if (!dr) return;
    if (refLat === null) {
      refLat = lat;
      refLon = lon;
    }
    const { bE, bN } = toEnu(lat, lon);
    netPairs.push({ ax: dr.x, ay: dr.y, bE, bN, path: dr.path });
    while (netPairs.length > 1 && dr.path - netPairs[0].path > NET_WINDOW_PATH_M) netPairs.shift();
    netFixSeen = true;
    refitNetwork();
    netFit.t = tMs;
    netFit.path = dr.path;
  };

  // ---------------------------- Позиція ----------------------------
  const gpsPosition = (nowMs, fresh) => {
    const dx = last.x - origin.x;
    const dy = last.y - origin.y;
    const c = Math.cos(thetaRad);
    const s = Math.sin(thetaRad);
    const dE = dx * c + dy * s;
    const dN = -dx * s + dy * c;
    return {
      lat: origin.lat + dN / M_PER_DEG,
      lon: origin.lon + dE / (M_PER_DEG * Math.cos(origin.lat * DEG)),
      bearing: normDeg360(last.heading + thetaRad / DEG),
      accuracy: Math.min(ACCURACY_MAX_M, ACCURACY_BASE_M + ACCURACY_PER_PATH * (last.path - origin.path)),
      anchorAgeS: (nowMs - origin.t) / 1000,
      headingOffsetDeg: normDeg180(thetaRad / DEG),
    };
  };

  const networkPosition = (nowMs, extrapolated) => {
    const c = Math.cos(netFit.theta);
    const s = Math.sin(netFit.theta);
    const E = last.x * c + last.y * s + netFit.tE;
    const N = -last.x * s + last.y * c + netFit.tN;
    const base = Math.max(NET_ACCURACY_MIN_M, netFit.resid);
    return {
      lat: refLat + N / M_PER_DEG,
      lon: refLon + E / (M_PER_DEG * Math.cos(refLat * DEG)),
      bearing: normDeg360(last.heading + netFit.theta / DEG),
      accuracy: extrapolated
        ? Math.min(ACCURACY_MAX_M * 2, base + ACCURACY_PER_PATH * (last.path - netFit.path))
        : base,
      anchorAgeS: netFit.t === null ? null : (nowMs - netFit.t) / 1000,
      headingOffsetDeg: normDeg180(netFit.theta / DEG),
    };
  };

  const getPosition = (nowMs) => {
    const gpsReady = origin !== null && thetaRad !== null;
    const gpsFresh = gpsReady && !mockSeen && lastGoodFixT !== null && nowMs - lastGoodFixT <= FREEZE_AFTER_MS;
    const state = !gpsReady ? 'waiting' : gpsFresh ? 'gps' : 'dr_only';
    const netReady = netFixSeen && netFit !== null && netFit.ready;
    const netFitN = netFit ? netFit.n : null;
    const netFitResidM = netFit ? netFit.resid : null;
    const empty = { lat: null, lon: null, bearing: null, accuracy: null, anchorAgeS: null };
    const netFitPathM = netFit ? netFit.span : null;
    const common = { state, netFitN, netFitResidM, netFitPathM };
    if (last === null) {
      return { ...common, source: 'waiting', ...empty, headingOffsetDeg: thetaRad === null ? null : normDeg180(thetaRad / DEG) };
    }
    // Пріоритет: хороший GPS -> мережа -> лише DR від останньої прив'язки (будь-якої)
    if (gpsFresh) return { ...common, source: 'gps', ...gpsPosition(nowMs, true) };
    if (netReady && nowMs - netFit.t <= NET_STALE_MS) return { ...common, source: 'network', ...networkPosition(nowMs, false) };
    if (gpsReady && (!netReady || origin.t >= netFit.t)) return { ...common, source: 'dr_only', ...gpsPosition(nowMs, false) };
    if (netReady) return { ...common, source: 'dr_only', ...networkPosition(nowMs, true) };
    return { ...common, source: 'waiting', ...empty, headingOffsetDeg: thetaRad === null ? null : normDeg180(thetaRad / DEG) };
  };

  return { onDrSample, onGpsFix, onNetFix, getPosition, reset };
}
