import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system/legacy';
import { collection, writeBatch, doc } from 'firebase/firestore';

/* =====================================================================
 * Anti-Reb Nav — ядро телеметрії та Dead Reckoning (v14)
 *
 * Зміни відносно v13:
 *  1. Гіроскоп expo-sensors віддає рад/с -> конвертація в град/с.
 *  2. Кутова швидкість рискання = проєкція гіроскопа на вектор гравітації
 *     (працює при будь-якому нахилі тримача).
 *  3. ZUPT оновлює bias лише при свіжих даних OBD, достатній кількості
 *     зразків і спокійному гіроскопі (мала дисперсія).
 *  4. recordPoint синхронний (без гонок між тиками 20 Гц).
 *  5. Зберігання: порції по 5 с у файли (без ліміту AsyncStorage),
 *     у Firestore одна порція = один документ.
 *  6. У лог пишуться сирі дані сенсорів — заїзд можна «програти» повторно.
 * ===================================================================== */

const RAD2DEG = 180 / Math.PI;

// --- Зберігання та синхронізація ---
const SYNC_INTERVAL_MS = 30000;
const FLUSH_INTERVAL_MS = 5000; // порція = ~100 точок при 20 Гц
const MAX_CHUNKS_PER_SYNC = 20;
const LOG_DIR = FileSystem.documentDirectory + 'telemetry/';
const PENDING_DIR = LOG_DIR + 'pending/';
const SYNCED_DIR = LOG_DIR + 'synced/';

// --- Константи для калібрування (Архітектор) ---
const LPF_ALPHA = 0.2; // Low-Pass Filter акселерометра
const YAW_SIGN = 1; // ±1: при повороті ПРАВОРУЧ heading має ЗРОСТАТИ
const GYRO_SCALE_FACTOR = 1.0; // масштаб гіроскопа (калібрування по GPS)
const SPEED_SCALE_FACTOR = 1.0; // спідометр OBD зазвичай завищує на 2–5%
const GYRO_MAX_LIMIT_DEG = 150; // град/с; авто так швидко не повертає -> артефакт
const MIN_GRAVITY_NORM = 5; // м/с²; менше — вектор гравітації ще не отримано

// --- ZUPT ---
const MAX_BIAS_BUFFER = 50; // 2.5 с при 20 Гц
const ZUPT_MIN_SAMPLES = 20; // мінімум 1 с нерухомості до оновлення bias
const ZUPT_MAX_STD_DEG = 0.5; // град/с; більше — телефон не в спокої

// --- OBD / час ---
const OBD_STALE_MS = 2000; // дані швидкості старші за це вважаються втраченими
const MAX_DT_S = 1.0;

// Колонки CSV (порядок = порядок у файлі)
export const CSV_COLUMNS = [
  'timestamp', 'createdAt', 'sessionId', 'currentState', 'dt',
  'speedRaw', 'speedUsed', 'obdAgeMs', 'obdFresh',
  'gyroXRaw', 'gyroYRaw', 'gyroZRaw',
  'accelX', 'accelY', 'accelZ', 'gravX', 'gravY', 'gravZ', 'gravityValid',
  'yawRateRaw', 'yawRateValid', 'gyroBias', 'yawRateClean', 'zuptStd', 'zuptApplied',
  'filteredAccelX', 'filteredAccelY', 'filteredAccelZ',
  'forwardAxis', 'forwardSign', 'isAxesCalibrated', 'isReversing',
  'heading', 'posX', 'posY', 'pressure', 'altitude', 'lat', 'lon',
];

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const stdDev = (arr) => {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length;
  return Math.sqrt(variance);
};

class TelemetryService {
  constructor() {
    this.firestoreDb = null;
    this.collectionName = 'telemetry_chunks';
    this.onBufferChangeCallback = null;

    this.pendingPoints = []; // точки в пам'яті до наступного flush
    this.unsyncedPoints = 0; // точки, ще не відправлені у Firestore
    this.flushTimer = null;
    this.syncTimer = null;
    this.isFlushing = false;
    this.isSyncing = false;
    this.sessionId = null;

    this.resetNavigation();
  }

  /** Повне скидання навігаційного стану (на початку кожної сесії запису) */
  resetNavigation() {
    this.currentState = 'STOPPED';

    // ZUPT
    this.gyroBias = 0; // град/с
    this.biasBuffer = [];
    this.lastValidYaw = 0;

    // Акселерометр
    this.filteredAccelX = 0;
    this.filteredAccelY = 0;
    this.filteredAccelZ = 0;

    // Вісь руху (для детекції реверсу)
    this.forwardAxis = 'y';
    this.forwardSign = 1;
    this.isAxesCalibrated = false;

    // Курс / час
    this.currentHeading = 0; // [0, 360), відносно початкового напрямку
    this.lastTimestamp = null;
    this.previousSpeed = 0;

    // Реверс / висота
    this.isReversing = false;
    this.basePressure = null;
    this.relativeAltitude = 0;

    // Dead Reckoning
    this.posX = 0;
    this.posY = 0;
  }

  /** db може бути null — тоді працює лише локальне зберігання (режим РЕБ) */
  async init(db = null, collectionName = 'telemetry_chunks') {
    this.firestoreDb = db;
    this.collectionName = collectionName;
    await this._ensureDirs();
    this.unsyncedPoints = await this._countPendingPoints();
    this._notifyBufferChange();
    if (db) this.startAutoSync();
  }

  setOnBufferChange(callback) {
    this.onBufferChangeCallback = callback;
  }

  _notifyBufferChange() {
    if (typeof this.onBufferChangeCallback === 'function') {
      this.onBufferChangeCallback(this.unsyncedPoints);
    }
  }

  getBufferSize() {
    return this.unsyncedPoints;
  }

  getNavState() {
    return {
      state: this.currentState,
      heading: this.currentHeading,
      posX: this.posX,
      posY: this.posY,
      gyroBias: this.gyroBias,
      isAxesCalibrated: this.isAxesCalibrated,
      isReversing: this.isReversing,
      altitude: this.relativeAltitude,
    };
  }

  // ------------------------------------------------------------------
  // Сесія запису
  // ------------------------------------------------------------------

  startSession() {
    this.resetNavigation();
    this.pendingPoints = [];
    this.sessionId = `s_${Date.now()}`;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    return this.sessionId;
  }

  async stopSession() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  // ------------------------------------------------------------------
  // Ядро: одна точка 20 Гц (СИНХРОННО)
  // ------------------------------------------------------------------

  recordPoint({
    speed = 0,
    obdAgeMs = Infinity,
    gyroX = 0, gyroY = 0, gyroZ = 0, // рад/с (expo-sensors)
    accelX = 0, accelY = 0, accelZ = 0,
    gravX = 0, gravY = 0, gravZ = 0,
    pressure = 0,
    lat = null,
    lon = null,
    timestamp,
  }) {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      console.warn('[Telemetry] Відхилено точку: невалідний timestamp.');
      return null;
    }

    // --- 0. Вхідні дані ---
    const speedRaw = num(speed);
    const gX = num(gyroX), gY = num(gyroY), gZ = num(gyroZ);
    let aX = num(accelX), aY = num(accelY), aZ = num(accelZ);
    const grX = num(gravX), grY = num(gravY), grZ = num(gravZ);
    const pressureRaw = num(pressure);

    const obdFresh = Number.isFinite(obdAgeMs) && obdAgeMs <= OBD_STALE_MS;
    // Без свіжого OBD швидкість невідома -> позицію не рухаємо (прапорець у лозі)
    const speedUsed = obdFresh ? speedRaw * SPEED_SCALE_FACTOR : 0;
    const isStopped = obdFresh && speedRaw === 0;

    // --- 1. dt ---
    let dt = 0;
    if (this.lastTimestamp !== null) {
      const calc = (timestamp - this.lastTimestamp) / 1000;
      if (calc > 0 && calc < MAX_DT_S) dt = calc;
    }
    this.lastTimestamp = timestamp;

    // --- 2. LPF акселерометра ---
    this.filteredAccelX = LPF_ALPHA * aX + (1 - LPF_ALPHA) * this.filteredAccelX;
    this.filteredAccelY = LPF_ALPHA * aY + (1 - LPF_ALPHA) * this.filteredAccelY;
    this.filteredAccelZ = LPF_ALPHA * aZ + (1 - LPF_ALPHA) * this.filteredAccelZ;

    // --- 3. Калібрування осі руху (лише для детекції реверсу) ---
    if (!this.isAxesCalibrated && obdFresh && speedRaw > 15 && speedRaw > this.previousSpeed) {
      const ax = Math.abs(this.filteredAccelX);
      const ay = Math.abs(this.filteredAccelY);
      const az = Math.abs(this.filteredAccelZ);
      if (ax >= ay && ax >= az) {
        this.forwardAxis = 'x';
        this.forwardSign = Math.sign(this.filteredAccelX) || 1;
      } else if (ay >= az) {
        this.forwardAxis = 'y';
        this.forwardSign = Math.sign(this.filteredAccelY) || 1;
      } else {
        this.forwardAxis = 'z';
        this.forwardSign = Math.sign(this.filteredAccelZ) || 1;
      }
      this.isAxesCalibrated = true;
    }

    // --- 4. Кутова швидкість рискання: проєкція на вертикаль, рад/с -> град/с ---
    const gNorm = Math.hypot(grX, grY, grZ);
    const gravityValid = gNorm > MIN_GRAVITY_NORM;
    let yawRateRaw = 0;
    if (gravityValid) {
      yawRateRaw =
        ((gX * grX + gY * grY + gZ * grZ) / gNorm) * RAD2DEG * YAW_SIGN * GYRO_SCALE_FACTOR;
    }

    // --- 5. Фільтр апаратних артефактів ---
    let yawRateValid = yawRateRaw;
    if (Math.abs(yawRateRaw) > GYRO_MAX_LIMIT_DEG) {
      yawRateValid = this.lastValidYaw;
    } else {
      this.lastValidYaw = yawRateRaw;
    }

    // --- 6. Машина станів + ZUPT ---
    let yawRateClean;
    let zuptStd = null;
    let zuptApplied = false;

    if (isStopped) {
      this.currentState = 'STOPPED';

      aX = 0; aY = 0; aZ = 0;
      this.filteredAccelX = 0;
      this.filteredAccelY = 0;
      this.filteredAccelZ = 0;

      this.biasBuffer.push(yawRateValid);
      if (this.biasBuffer.length > MAX_BIAS_BUFFER) this.biasBuffer.shift();

      if (this.biasBuffer.length >= ZUPT_MIN_SAMPLES) {
        zuptStd = stdDev(this.biasBuffer);
        if (zuptStd <= ZUPT_MAX_STD_DEG) {
          this.gyroBias = median(this.biasBuffer);
          zuptApplied = true;
        }
      }

      yawRateClean = 0; // авто на місці не повертає
    } else {
      this.currentState = obdFresh ? 'MOVING' : 'OBD_LOST';
      if (this.biasBuffer.length) this.biasBuffer = [];
      // Курс інтегруємо навіть при втраті OBD — поворот не можна пропускати
      yawRateClean = yawRateValid - this.gyroBias;
    }

    // --- 7. Інтеграція курсу ---
    if (dt > 0) {
      this.currentHeading = (this.currentHeading + yawRateClean * dt) % 360;
      if (this.currentHeading < 0) this.currentHeading += 360;
    }

    // --- 8. Відносна висота ---
    if (this.basePressure === null && pressureRaw > 0) this.basePressure = pressureRaw;
    if (pressureRaw > 0 && this.basePressure !== null) {
      this.relativeAltitude = (this.basePressure - pressureRaw) * 8.3;
    }

    // --- 9. Детекція реверсу (на момент рушання) ---
    if (isStopped) {
      this.isReversing = false;
    } else if (obdFresh && this.previousSpeed === 0 && speedRaw > 0) {
      const f =
        this.forwardAxis === 'x' ? this.filteredAccelX
          : this.forwardAxis === 'y' ? this.filteredAccelY
            : this.filteredAccelZ;
      this.isReversing = f * this.forwardSign < -0.1;
    }
    if (obdFresh) this.previousSpeed = speedRaw;

    // --- 10. Dead Reckoning 2D ---
    let v = speedUsed / 3.6;
    if (this.isReversing) v = -v;
    const distance = v * dt;
    const hRad = this.currentHeading * (Math.PI / 180);
    this.posX += distance * Math.sin(hRad);
    this.posY += distance * Math.cos(hRad);

    const entry = {
      timestamp,
      createdAt: new Date(timestamp).toISOString(),
      sessionId: this.sessionId,
      currentState: this.currentState,
      dt,
      speedRaw,
      speedUsed,
      obdAgeMs: Number.isFinite(obdAgeMs) ? obdAgeMs : -1,
      obdFresh,
      gyroXRaw: gX,
      gyroYRaw: gY,
      gyroZRaw: gZ,
      accelX: aX,
      accelY: aY,
      accelZ: aZ,
      gravX: grX,
      gravY: grY,
      gravZ: grZ,
      gravityValid,
      yawRateRaw,
      yawRateValid,
      gyroBias: this.gyroBias,
      yawRateClean,
      zuptStd,
      zuptApplied,
      filteredAccelX: this.filteredAccelX,
      filteredAccelY: this.filteredAccelY,
      filteredAccelZ: this.filteredAccelZ,
      forwardAxis: this.forwardAxis,
      forwardSign: this.forwardSign,
      isAxesCalibrated: this.isAxesCalibrated,
      isReversing: this.isReversing,
      heading: this.currentHeading,
      posX: this.posX,
      posY: this.posY,
      pressure: pressureRaw,
      altitude: this.relativeAltitude,
      lat: lat !== null && lat !== undefined && Number.isFinite(Number(lat)) ? Number(lat) : null,
      lon: lon !== null && lon !== undefined && Number.isFinite(Number(lon)) ? Number(lon) : null,
    };

    this.pendingPoints.push(entry);
    this.unsyncedPoints += 1;
    return entry;
  }

  // ------------------------------------------------------------------
  // Локальне зберігання (файли-порції)
  // ------------------------------------------------------------------

  async _ensureDirs() {
    for (const dir of [LOG_DIR, PENDING_DIR, SYNCED_DIR]) {
      try {
        const info = await FileSystem.getInfoAsync(dir);
        if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      } catch (e) {
        console.error('[Telemetry] Не вдалося створити теку', dir, e);
      }
    }
  }

  // Ім'я файлу: <timestamp першої точки>_<sessionId>_<кількість>.json
  _parseChunkName(name) {
    const m = /^(\d+)_(.+)_(\d+)\.json$/.exec(name);
    return m ? { startTs: Number(m[1]), sessionId: m[2], count: Number(m[3]) } : null;
  }

  async _listChunks(dir) {
    try {
      const names = await FileSystem.readDirectoryAsync(dir);
      return names.filter((n) => n.endsWith('.json')).sort();
    } catch (e) {
      return [];
    }
  }

  async _countPendingPoints() {
    const names = await this._listChunks(PENDING_DIR);
    return names.reduce((sum, n) => sum + (this._parseChunkName(n)?.count || 0), 0);
  }

  /** Скидає точки з пам'яті у файл-порцію */
  async flush() {
    if (this.isFlushing || this.pendingPoints.length === 0) return;
    this.isFlushing = true;
    const points = this.pendingPoints;
    this.pendingPoints = [];
    try {
      const name = `${points[0].timestamp}_${this.sessionId || 'nosession'}_${points.length}.json`;
      await FileSystem.writeAsStringAsync(
        PENDING_DIR + name,
        JSON.stringify({ sessionId: this.sessionId, points })
      );
    } catch (e) {
      console.error('[Telemetry] Помилка запису порції:', e);
      this.pendingPoints = points.concat(this.pendingPoints); // повертаємо назад
    } finally {
      this.isFlushing = false;
      this._notifyBufferChange();
    }
  }

  // ------------------------------------------------------------------
  // Синхронізація з Firestore: одна порція = один документ
  // ------------------------------------------------------------------

  startAutoSync() {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => this.syncNow(), SYNC_INTERVAL_MS);
  }

  stopAutoSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async syncNow() {
    if (this.isSyncing) return { success: false, reason: 'already_syncing' };
    if (!this.firestoreDb) return { success: false, reason: 'firestore_not_initialized' };

    const names = (await this._listChunks(PENDING_DIR)).slice(0, MAX_CHUNKS_PER_SYNC);
    if (names.length === 0) return { success: true, count: 0 };

    try {
      const net = await NetInfo.fetch();
      if (!(net.isConnected && net.isInternetReachable !== false)) {
        return { success: false, reason: 'offline', buffered: this.unsyncedPoints };
      }
    } catch (e) {
      return { success: false, reason: 'offline' };
    }

    this.isSyncing = true;
    try {
      const batch = writeBatch(this.firestoreDb);
      const colRef = collection(this.firestoreDb, this.collectionName);
      const included = [];

      for (const name of names) {
        try {
          const raw = await FileSystem.readAsStringAsync(PENDING_DIR + name);
          const data = JSON.parse(raw);
          const pts = Array.isArray(data.points) ? data.points : [];
          if (pts.length === 0) continue;
          batch.set(doc(colRef, name.replace('.json', '')), {
            sessionId: data.sessionId || null,
            startTs: pts[0].timestamp,
            endTs: pts[pts.length - 1].timestamp,
            count: pts.length,
            points: pts,
          });
          included.push({ name, count: pts.length });
        } catch (e) {
          console.warn('[Telemetry] Пошкоджена порція, пропускаю:', name, e);
        }
      }

      if (included.length === 0) return { success: true, count: 0 };

      await batch.commit();

      let sent = 0;
      for (const { name, count } of included) {
        await FileSystem.moveAsync({ from: PENDING_DIR + name, to: SYNCED_DIR + name });
        sent += count;
      }
      this.unsyncedPoints = Math.max(0, this.unsyncedPoints - sent);
      return { success: true, count: sent, remaining: this.unsyncedPoints };
    } catch (error) {
      console.error('[SYNC_ERROR]', error);
      return { success: false, reason: 'error', error: error?.message || String(error) };
    } finally {
      this.isSyncing = false;
      this._notifyBufferChange();
    }
  }

  // ------------------------------------------------------------------
  // Офлайн-експорт у CSV (з локальних файлів, без інтернету)
  // ------------------------------------------------------------------

  /**
   * @param {string|null} sessionId — лише одна сесія; null = усі
   * @returns {Promise<{success:boolean, uri?:string, rows?:number, error?:string}>}
   */
  async exportLocalCSV(sessionId = null) {
    try {
      await this.flush();
      const files = [
        ...(await this._listChunks(SYNCED_DIR)).map((n) => SYNCED_DIR + n),
        ...(await this._listChunks(PENDING_DIR)).map((n) => PENDING_DIR + n),
      ].sort((a, b) => a.split('/').pop().localeCompare(b.split('/').pop()));

      const lines = [CSV_COLUMNS.join(',')];
      for (const path of files) {
        const meta = this._parseChunkName(path.split('/').pop());
        if (sessionId && meta?.sessionId !== sessionId) continue;
        try {
          const data = JSON.parse(await FileSystem.readAsStringAsync(path));
          for (const p of data.points || []) {
            lines.push(
              CSV_COLUMNS.map((c) => (p[c] === null || p[c] === undefined ? '' : p[c])).join(',')
            );
          }
        } catch (e) {
          console.warn('[Telemetry] Пропущено файл при експорті:', path);
        }
      }

      if (lines.length === 1) return { success: false, error: 'Немає записаних даних' };

      const uri = `${FileSystem.cacheDirectory}anti_reb_${sessionId || 'all'}_${Date.now()}.csv`;
      await FileSystem.writeAsStringAsync(uri, lines.join('\n'));
      return { success: true, uri, rows: lines.length - 1 };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  /** Видаляє вже синхронізовані порції (звільнення пам'яті телефону) */
  async clearSynced() {
    const names = await this._listChunks(SYNCED_DIR);
    for (const n of names) {
      await FileSystem.deleteAsync(SYNCED_DIR + n, { idempotent: true });
    }
    return names.length;
  }
}

export const telemetry = new TelemetryService();
export default telemetry;
