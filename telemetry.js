import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system/legacy';
import { collection, writeBatch, doc } from 'firebase/firestore';

/* =====================================================================
 * Anti-Reb Nav — ядро телеметрії та Dead Reckoning (v17)
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
 *
 * Зміни v15 (фікс аудиту):
 *  7. isStopped/ZUPT більше не залежить виключно від свіжості OBD:
 *     при втраті зв'язку нерухомість визначається по акселерометру й
 *     гіроскопу (ACCEL_STILL_MAX / GYRO_STILL_MAX_DEG), тож калібрування
 *     дрейфу гіроскопа не зупиняється через Bluetooth-глюк.
 *  8. Короткі розриви OBD (<OBD_EXTRAPOLATE_MAX_MS) під час руху більше не
 *     "заморожують" позицію — DR тримає останню відому швидкість
 *     (speedExtrapolated=true в лозі, щоб Архітектор бачив ці ділянки).
 *
 * Зміни v16 (за результатами польового тесту, Вишгород, 1.38 км):
 *  9. Скасовано п.7: детекція нерухомості по миттєвих порогах accel/gyro
 *     не відрізняє стоянку від руху з постійною швидкістю по прямій —
 *     у тесті при розриві OBD на 22 км/год ядро оголосило STOPPED,
 *     заморозило курс і обнулило швидкість. ZUPT тепер знову лише при
 *     свіжому OBD зі швидкістю 0; розрив OBD = стан OBD_LOST.
 * 10. Виправлено п.8: екстраполяція вмикалась при obdAgeMs <= 1000, але
 *     obdFresh=false лише після 2000 мс — умова ніколи не виконувалась.
 *     Тепер: 2000..5000 мс -> тримаємо останню швидкість, >5000 мс -> 0.
 * 11. ZUPT: у тесті розкид гіроскопа на зупинках 0.56–2.2 °/с (вібрація
 *     двигуна), поріг 0.5 не пропустив жодної зупинки. Але відтворення
 *     заїзду показало: короткі зупинки (2–5 с) дають оцінки bias від
 *     −0.4 до +0.9 °/с, а для точності потрібно ±0.02 °/с (помилка 0.1 °/с
 *     = 100–200 м на цьому маршруті). Тому bias оцінюється лише на
 *     стоянках ≥10 с (після 1 с «заспокоєння»), усереднюється між
 *     стоянками з вагою за кількістю зразків. Поріг розкиду 2.5 °/с.
 * 12. Паузи потоку JS 1–5 с: позиція доінтегровується з останньою
 *     швидкістю (у тесті пауза 2.6 с «з'їла» 16 м). Колонка gapS.
 * 13. Синхронізація з Firestore блокувала потік JS (паузи кожні 30 с,
 *     до 2.6 с) — під час запису вимкнена, запускається після stopSession.
 *
 * Зміни v17 (за польовим тестом №2, 24.09.2026):
 * 14. Вісь руху: обирається лише серед двох осей, що НЕ найближчі до
 *     вертикалі (вісь, найближча до вектора гравітації, віссю руху бути
 *     не може). Раніше калібрування могло вибрати вертикальну вісь —
 *     на прямій тесту №2 це разом із п.15 давало хибний реверс.
 * 15. Детекція реверсу: рішення приймається за середнім прискоренням
 *     вздовж осі руху за перші 20 тиків (1 с) після рушання, а не за
 *     одним тіком одразу після скидання LPF на стоянці. Працює лише
 *     після калібрування осі (isAxesCalibrated) і знімається понад
 *     REVERSE_MAX_KMH — на такій швидкості реверс неможливий.
 * 16. Bias ZUPT оцінюється і пишеться в лог (gyroBias, zuptStd,
 *     zuptApplied), але більше НЕ віднімається від курсу
 *     (ZUPT_APPLY_TO_HEADING = false): у тестах №1 і №2 bias на стоянці
 *     мав протилежний знак до оптимального bias у русі — застосування
 *     погіршувало похибку (тест №2, пряма: 144.6 → 586.4 м).
 * ===================================================================== */

export const CORE_VERSION = 'v17';
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
const MAX_BIAS_BUFFER = 1200; // до 60 с стоянки при 20 Гц
const ZUPT_SETTLE_SAMPLES = 20; // перша 1 с зупинки не йде в bias (авто ще докочується,
                                // OBD показує 0 вже нижче ~2 км/год)
const ZUPT_MIN_SAMPLES = 200; // оцінка bias лише після 10 с стоянки
const ZUPT_MAX_STD_DEG = 2.5; // град/с; у тесті на зупинках 0.56–2.2 (вібрація двигуна)
const BIAS_WEIGHT_CAP = 2400; // макс. «пам'ять» bias у зразках (~2 хв стоянок)
// Bias зі стоянок оцінюється і пишеться в лог, але НЕ віднімається від курсу:
// у тестах №1 і №2 bias на стоянці мав протилежний знак до bias у русі.
const ZUPT_APPLY_TO_HEADING = false;

// --- Реверс ---
const REVERSE_WINDOW_SAMPLES = 20; // 1 с після рушання
const REVERSE_ACCEL_MIN = 0.2; // м/с², середнє вздовж осі руху
const REVERSE_MAX_KMH = 20; // вище — реверс неможливий, знімаємо прапорець

// --- OBD / час ---
const OBD_STALE_MS = 2000; // дані швидкості старші за це вважаються втраченими
const OBD_EXTRAPOLATE_MAX_MS = 5000; // OBD_STALE_MS..це значення: тримаємо останню швидкість
const MAX_DT_S = 1.0; // нормальний крок інтеграції
const GAP_FILL_MAX_S = 5.0; // паузи JS до 5 с: позицію доінтегровуємо з останньою швидкістю

// Колонки CSV (порядок = порядок у файлі)
export const CSV_COLUMNS = [
  'timestamp', 'createdAt', 'sessionId', 'currentState', 'dt', 'gapS',
  'speedRaw', 'speedUsed', 'speedExtrapolated', 'obdAgeMs', 'obdFresh',
  'gyroXRaw', 'gyroYRaw', 'gyroZRaw',
  'accelX', 'accelY', 'accelZ', 'gravX', 'gravY', 'gravZ', 'gravityValid',
  'yawRateRaw', 'yawRateValid', 'gyroBias', 'yawRateClean', 'zuptStd', 'zuptApplied',
  'filteredAccelX', 'filteredAccelY', 'filteredAccelZ',
  'forwardAxis', 'forwardSign', 'isAxesCalibrated', 'isReversing',
  'heading', 'posX', 'posY', 'pressure', 'altitude', 'lat', 'lon', 'gpsAccuracy',
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

/** Екранування значення для CSV-комірки (кома/лапки/переніс рядка) */
export const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
    this.isRecording = false;
    this.sessionId = null;
    this.lastSyncAt = null; // мс (Date.now()), null = ще не синхронізували
    this.lastSyncResult = null; // останній результат syncNow() (успіх або помилка)

    this.resetNavigation();
  }

  /** Повне скидання навігаційного стану (на початку кожної сесії запису) */
  resetNavigation() {
    this.currentState = 'STOPPED';

    // ZUPT
    this.gyroBias = 0; // град/с — поточна оцінка (з урахуванням поточної зупинки)
    this.committedBias = 0; // bias, накопичений за попередні зупинки
    this.committedWeight = 0; // його вага в зразках
    this.stopEstimateN = 0; // скільки зразків дала поточна зупинка (0 = оцінки ще немає)
    this.stopSamples = 0; // скільки тиків триває поточна зупинка
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
    this.revSum = 0;
    this.revN = 0;
    this.revPending = false;
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

  getSyncState() {
    return {
      isSyncing: this.isSyncing,
      isRecording: this.isRecording,
      lastSyncAt: this.lastSyncAt,
      lastSyncResult: this.lastSyncResult,
    };
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
    this.isRecording = true;
    this.resetNavigation();
    this.pendingPoints = [];
    this.sessionId = `s_${Date.now()}`;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    return this.sessionId;
  }

  async stopSession() {
    this.isRecording = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    // Синхронізація лише після запису: під час запису вона блокує потік JS
    if (this.firestoreDb) this.syncNow().catch(() => {});
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
    gpsAccuracy = null,
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

    // --- 1. dt ---
    // dt — крок для курсу та позиції; gapS — пауза потоку JS (1..5 с), яку
    // доінтегровуємо лише для позиції (даних гіроскопа за паузу немає).
    let dt = 0;
    let gapS = 0;
    if (this.lastTimestamp !== null) {
      const calc = (timestamp - this.lastTimestamp) / 1000;
      if (calc > 0 && calc < MAX_DT_S) dt = calc;
      else if (calc >= MAX_DT_S && calc <= GAP_FILL_MAX_S) gapS = calc;
    }
    this.lastTimestamp = timestamp;

    // --- 2. LPF акселерометра ---
    this.filteredAccelX = LPF_ALPHA * aX + (1 - LPF_ALPHA) * this.filteredAccelX;
    this.filteredAccelY = LPF_ALPHA * aY + (1 - LPF_ALPHA) * this.filteredAccelY;
    this.filteredAccelZ = LPF_ALPHA * aZ + (1 - LPF_ALPHA) * this.filteredAccelZ;

    // --- 3. Калібрування осі руху (лише для детекції реверсу) ---
    if (!this.isAxesCalibrated && obdFresh && speedRaw > 15 && speedRaw > this.previousSpeed) {
      // вісь, найближча до вертикалі, не може бути віссю руху
      const gA = [Math.abs(grX), Math.abs(grY), Math.abs(grZ)];
      const vert = gA.indexOf(Math.max(...gA));
      const cand = [['x', this.filteredAccelX], ['y', this.filteredAccelY], ['z', this.filteredAccelZ]]
        .filter((_, i) => i !== vert);
      const best = Math.abs(cand[0][1]) >= Math.abs(cand[1][1]) ? cand[0] : cand[1];
      this.forwardAxis = best[0];
      this.forwardSign = Math.sign(best[1]) || 1;
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

    // --- 5b. isStopped — ЛИШЕ за свіжим OBD.
    // Миттєві пороги accel/gyro не відрізняють стоянку від руху з постійною
    // швидкістю по прямій (лінійне прискорення ≈ 0, поворотів немає).
    // Хибний STOPPED у русі заморожує курс і, що гірше, записує в bias
    // дані з руху. Тому при розриві OBD — стан OBD_LOST, ZUPT не працює.
    const isStopped = obdFresh && speedRaw === 0;

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

      this.stopSamples += 1;
      if (this.stopSamples > ZUPT_SETTLE_SAMPLES) {
        this.biasBuffer.push(yawRateValid);
        if (this.biasBuffer.length > MAX_BIAS_BUFFER) this.biasBuffer.shift();
      }

      if (this.biasBuffer.length >= ZUPT_MIN_SAMPLES) {
        zuptStd = stdDev(this.biasBuffer);
        if (zuptStd <= ZUPT_MAX_STD_DEG) {
          // Зважене усереднення з попередніми зупинками: коротка стоянка з
          // шумом ±2 °/с дає грубу оцінку, тож не перезаписуємо bias повністю.
          const n = this.biasBuffer.length;
          const est = median(this.biasBuffer);
          this.gyroBias =
            (this.committedBias * this.committedWeight + est * n) / (this.committedWeight + n);
          this.stopEstimateN = n;
          zuptApplied = true;
        }
      }

      yawRateClean = 0; // авто на місці не повертає
    } else {
      this.currentState = obdFresh ? 'MOVING' : 'OBD_LOST';
      // Кінець зупинки: фіксуємо оцінку bias у «пам'ять»
      this.stopSamples = 0;
      if (this.biasBuffer.length) {
        if (this.stopEstimateN > 0) {
          this.committedBias = this.gyroBias;
          this.committedWeight = Math.min(this.committedWeight + this.stopEstimateN, BIAS_WEIGHT_CAP);
        }
        this.gyroBias = this.committedBias;
        this.stopEstimateN = 0;
        this.biasBuffer = [];
      }
      // Курс інтегруємо навіть при втраті OBD — поворот не можна пропускати
      yawRateClean = yawRateValid - (ZUPT_APPLY_TO_HEADING ? this.gyroBias : 0);
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

    // --- 8b. Швидкість для DR:
    //   obdAgeMs <= 2000        -> свіжий OBD, довіряємо
    //   2000 < obdAgeMs <= 5000 -> розрив, тримаємо останню відому швидкість
    //   obdAgeMs > 5000         -> швидкість невідома, 0
    let speedUsed = 0;
    let speedExtrapolated = false;
    if (obdFresh) {
      speedUsed = speedRaw * SPEED_SCALE_FACTOR;
    } else if (Number.isFinite(obdAgeMs) && obdAgeMs <= OBD_EXTRAPOLATE_MAX_MS) {
      speedUsed = this.previousSpeed * SPEED_SCALE_FACTOR;
      speedExtrapolated = true;
    }

    // --- 9. Детекція реверсу: середнє прискорення вздовж осі руху за перші
    // REVERSE_WINDOW_SAMPLES тиків після рушання (одиночний тік вирішувався шумом).
    // Лише після калібрування осі; знімається на швидкості > REVERSE_MAX_KMH.
    if (isStopped) {
      this.isReversing = false;
      this.revSum = 0;
      this.revN = 0;
      this.revPending = false;
    } else if (obdFresh) {
      if (this.previousSpeed === 0 && speedRaw > 0) {
        this.revSum = 0;
        this.revN = 0;
        this.revPending = this.isAxesCalibrated;
      }
      if (this.revPending) {
        const a = this.forwardAxis === 'x' ? aX : this.forwardAxis === 'y' ? aY : aZ;
        this.revSum += a * this.forwardSign;
        this.revN += 1;
        if (this.revN >= REVERSE_WINDOW_SAMPLES) {
          this.isReversing = this.revSum / this.revN < -REVERSE_ACCEL_MIN;
          this.revPending = false;
        }
      }
      if (this.isReversing && speedRaw > REVERSE_MAX_KMH) this.isReversing = false;
    }
    if (obdFresh) this.previousSpeed = speedRaw;

    // --- 10. Dead Reckoning 2D ---
    let v = speedUsed / 3.6;
    if (this.isReversing) v = -v;
    const distance = v * (dt + gapS);
    const hRad = this.currentHeading * (Math.PI / 180);
    this.posX += distance * Math.sin(hRad);
    this.posY += distance * Math.cos(hRad);

    const entry = {
      timestamp,
      createdAt: new Date(timestamp).toISOString(),
      sessionId: this.sessionId,
      currentState: this.currentState,
      dt,
      gapS,
      speedRaw,
      speedUsed,
      speedExtrapolated,
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
      gpsAccuracy:
        gpsAccuracy !== null && gpsAccuracy !== undefined && Number.isFinite(Number(gpsAccuracy))
          ? Number(gpsAccuracy)
          : null,
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
    const result = await this._syncNowImpl();
    this.lastSyncResult = result;
    if (result.success) this.lastSyncAt = Date.now();
    return result;
  }

  async _syncNowImpl() {
    // Під час запису синхронізація блокувала потік JS (у тесті — до 2.6 с)
    if (this.isRecording) return { success: false, reason: 'recording' };
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

  /** sessionId останньої сесії: поточна/щойно зупинена, інакше — з порції з найбільшим startTs */
  async getLastSessionId() {
    if (this.sessionId) return this.sessionId;
    const names = [...(await this._listChunks(PENDING_DIR)), ...(await this._listChunks(SYNCED_DIR))];
    let best = null;
    let bestTs = -Infinity;
    for (const name of names) {
      const meta = this._parseChunkName(name);
      if (meta && meta.startTs > bestTs) {
        bestTs = meta.startTs;
        best = meta.sessionId;
      }
    }
    return best;
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
            lines.push(CSV_COLUMNS.map((c) => csvCell(p[c])).join(','));
          }
        } catch (e) {
          console.warn('[Telemetry] Пропущено файл при експорті:', path);
        }
      }

      if (lines.length === 1) return { success: false, error: 'Немає записаних даних' };

      const uri = `${FileSystem.cacheDirectory}anti_reb_${sessionId || 'all'}_${Date.now()}_${CORE_VERSION}.csv`;
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
