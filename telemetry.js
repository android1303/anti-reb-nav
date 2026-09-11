import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { collection, writeBatch, doc } from 'firebase/firestore';

const STORAGE_KEY = '@anti_reb_telemetry_buffer_v1';
const SYNC_INTERVAL_MS = 10000; // 10 секунд
const MAX_BATCH_SIZE = 450; // Безпечний ліміт для batch у Firestore (макс. 500)
const LPF_ALPHA = 0.2; // Коефіцієнт згладжування Low-Pass Filter
const GYRO_MAX_LIMIT = 200; // Поріг фільтрації апаратних артефактів

class TelemetryService {
  constructor() {
    this.memoryBuffer = [];
    this.syncTimer = null;
    this.isSyncing = false;
    this.firestoreDb = null;
    this.collectionName = 'telemetry_logs';
    this.onBufferChangeCallback = null;

    // Машина станів та ZUPT
    this.currentState = 'STOPPED';
    this.gyroZBias = 0;
    this.biasSamplesCount = 0;
    this.lastValidGyroZ = 0;

    // Стан фільтрації акселерометра
    this.filteredAccelX = 0;
    this.filteredAccelY = 0;
    this.filteredAccelZ = 0;

    // Курс та часові позначки
    this.currentHeading = 0; // Курс у градусах [0, 360)
    this.lastTimestamp = null;
    this.previousSpeed = 0;

    // Стан реверсу та барометричної висоти
    this.isReversing = false;
    this.basePressure = null;
    this.relativeAltitude = 0;

    // Навігаційне ядро (Dead Reckoning)
    this.posX = 0;
    this.posY = 0;

    // Ground-Truth Filter (GPS)
    this.lastLat = null;
    this.lastLon = null;
    this.lastGpsTimestamp = null;
  }

  /**
   * Ініціалізація сервісу телеметрії
   * @param {object} db - Інстанс Firebase Firestore (getFirestore())
   * @param {string} [collectionName='telemetry_logs']
   */
  async init(db, collectionName = 'telemetry_logs') {
    if (!db) {
      console.error('[SYNC_ERROR] Передано невалідний або пустий інстанс Firestore DB у telemetry.init()');
      return;
    }
    this.firestoreDb = db;
    this.collectionName = collectionName;
    await this._loadFromStorage();
    this.startAutoSync();
  }

  setOnBufferChange(callback) {
    this.onBufferChangeCallback = callback;
  }

  _notifyBufferChange() {
    if (typeof this.onBufferChangeCallback === 'function') {
      this.onBufferChangeCallback(this.memoryBuffer.length);
    }
  }

  async _loadFromStorage() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.memoryBuffer = parsed;
        }
      }
    } catch (err) {
      console.warn('[Telemetry] Помилка завантаження локального буфера:', err);
      this.memoryBuffer = [];
    }
    this._notifyBufferChange();
  }

  async _saveToStorage() {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.memoryBuffer));
    } catch (err) {
      console.error('[Telemetry] Помилка запису в AsyncStorage:', err);
    }
    this._notifyBufferChange();
  }

  /**
   * Запис точки телеметрії (з Машиною станів, валідацією артефактів, ZUPT, Dead Reckoning та GPS-фільтром)
   */
  async recordPoint({
    speed = 0,
    gyroX = 0,
    gyroY = 0,
    gyroZ = 0,
    accelX = 0,
    accelY = 0,
    accelZ = 0,
    pressure = 0,
    lat = null,
    lon = null,
    timestamp = Date.now(),
  }) {
    const rawSpeed = typeof speed === 'number' ? speed : Number(speed) || 0;
    const rawGyroX = typeof gyroX === 'number' ? gyroX : Number(gyroX) || 0;
    const rawGyroY = typeof gyroY === 'number' ? gyroY : Number(gyroY) || 0;
    let inputGyroZ = typeof gyroZ === 'number' ? gyroZ : Number(gyroZ) || 0;
    let rawAccelX = typeof accelX === 'number' ? accelX : Number(accelX) || 0;
    let rawAccelY = typeof accelY === 'number' ? accelY : Number(accelY) || 0;
    const rawAccelZ = typeof accelZ === 'number' ? accelZ : Number(accelZ) || 0;
    const rawPressure = typeof pressure === 'number' ? pressure : Number(pressure) || 0;
    const currentTimestamp = Number(timestamp) || Date.now();

    // Фільтрація апаратних артефактів гіроскопа
    let validGyroZ = inputGyroZ;
    if (Math.abs(inputGyroZ) > GYRO_MAX_LIMIT) {
      validGyroZ = this.lastValidGyroZ;
    } else {
      this.lastValidGyroZ = inputGyroZ;
    }
    let cleanGyroZ = validGyroZ;

    // Машина станів та логіка ZUPT
    if (rawSpeed === 0) {
      this.currentState = 'STOPPED';
      // Примусове скидання лінійних прискорень
      rawAccelX = 0;
      rawAccelY = 0;
      this.filteredAccelX = 0;
      this.filteredAccelY = 0;
      // Ковзне середнє зміщення гіроскопа
      this.gyroZBias = ((this.gyroZBias * this.biasSamplesCount) + validGyroZ) / (this.biasSamplesCount + 1);
      this.biasSamplesCount++;
      // Очищене значення для нерухомого стану
      cleanGyroZ = 0;
    } else {
      this.currentState = 'MOVING';
      this.biasSamplesCount = 0;
      // Компенсація дрейфу
      cleanGyroZ = validGyroZ - this.gyroZBias;
    }

    // Low-Pass Filter для акселерометра
    this.filteredAccelX = LPF_ALPHA * rawAccelX + (1 - LPF_ALPHA) * this.filteredAccelX;
    this.filteredAccelY = LPF_ALPHA * rawAccelY + (1 - LPF_ALPHA) * this.filteredAccelY;
    this.filteredAccelZ = LPF_ALPHA * rawAccelZ + (1 - LPF_ALPHA) * this.filteredAccelZ;

    // Розрахунок інтервалу часу dt
    let dt = 0;
    if (this.lastTimestamp !== null) {
      const calculatedDt = (currentTimestamp - this.lastTimestamp) / 1000;
      if (calculatedDt > 0 && calculatedDt < 3.0) { // Збільшено вікно валідності dt до 3.0 секунд
        dt = calculatedDt;
      }
    }

    // КРОК Г: Розрахунок курсу (Heading Integration)
    if (dt > 0) {
      const deltaHeading = (cleanGyroZ * (180 / Math.PI)) * dt;
      this.currentHeading = (this.currentHeading + deltaHeading) % 360;
      if (this.currentHeading < 0) {
        this.currentHeading += 360;
      }
    }
    this.lastTimestamp = currentTimestamp;

    // Розрахунок відносної висоти
    if (this.basePressure === null && rawPressure > 0) {
      this.basePressure = rawPressure;
    }
    if (rawPressure > 0 && this.basePressure !== null) {
      this.relativeAltitude = (this.basePressure - rawPressure) * 8.3;
    }

    // КРОК Д: Детекція реверсу
    const isTransitionToMoving = this.previousSpeed === 0 && rawSpeed > 0;
    if (isTransitionToMoving) {
      if (this.filteredAccelY < -0.1) {
        this.isReversing = true;
      } else {
        this.isReversing = false;
      }
    } else if (rawSpeed === 0) {
      this.isReversing = false;
    }
    this.previousSpeed = rawSpeed;

    // Навігаційне ядро (Dead Reckoning 2D)
    let velocity_ms = rawSpeed / 3.6;
    if (this.isReversing) {
      velocity_ms *= -1;
    }
    const distance = velocity_ms * dt;
    const headingRad = this.currentHeading * (Math.PI / 180);
    this.posX += distance * Math.sin(headingRad);
    this.posY += distance * Math.cos(headingRad);

    // Фільтрація аномальних GPS-координат (Ground-Truth Filter)
    let validLat = lat !== null && lat !== undefined ? Number(lat) : null;
    let validLon = lon !== null && lon !== undefined ? Number(lon) : null;

    if (validLat !== null && validLon !== null) {
      if (this.lastLat !== null && this.lastLon !== null && this.lastGpsTimestamp !== null) {
        const gpsDt = (currentTimestamp - this.lastGpsTimestamp) / 1000;
        
        if (gpsDt > 0) {
          // Haversine formula
          const R = 6371e3; // радіус Землі в метрах
          const phi1 = this.lastLat * Math.PI / 180;
          const phi2 = validLat * Math.PI / 180;
          const deltaPhi = (validLat - this.lastLat) * Math.PI / 180;
          const deltaLambda = (validLon - this.lastLon) * Math.PI / 180;

          const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
                    Math.cos(phi1) * Math.cos(phi2) *
                    Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          const gpsDistance = R * c;

          const gpsSpeed = gpsDistance / gpsDt;

          if (gpsSpeed > 50) { // Якщо швидкість > 50 м/с (180 км/год)
            validLat = null;
            validLon = null;
          } else {
            this.lastLat = validLat;
            this.lastLon = validLon;
            this.lastGpsTimestamp = currentTimestamp;
          }
        }
      } else {
        this.lastLat = validLat;
        this.lastLon = validLon;
        this.lastGpsTimestamp = currentTimestamp;
      }
    }

    const entry = {
      id: `${currentTimestamp}_${Math.random().toString(36).substring(2, 8)}`,
      currentState: this.currentState,
      speed: rawSpeed,
      gyroX: rawGyroX,
      gyroY: rawGyroY,
      gyroZ: cleanGyroZ,
      cleanGyroZ: cleanGyroZ,
      accelX: rawAccelX,
      accelY: rawAccelY,
      accelZ: rawAccelZ,
      filteredAccelX: this.filteredAccelX,
      filteredAccelY: this.filteredAccelY,
      filteredAccelZ: this.filteredAccelZ,
      heading: this.currentHeading,
      isReversing: this.isReversing,
      altitude: this.relativeAltitude,
      pressure: rawPressure,
      posX: this.posX,
      posY: this.posY,
      lat: validLat,
      lon: validLon,
      timestamp: currentTimestamp,
      createdAt: new Date(currentTimestamp).toISOString(),
    };

    this.memoryBuffer.push(entry);
    await this._saveToStorage();
    return entry;
  }

  startAutoSync() {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => {
      this.syncNow();
    }, SYNC_INTERVAL_MS);
  }

  stopAutoSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Пакетна синхронізація з Firebase Firestore
   */
  async syncNow() {
    if (this.isSyncing) {
      return { success: false, reason: 'already_syncing' };
    }

    if (!this.firestoreDb) {
      console.error('[SYNC_ERROR] Firestore DB не ініціалізовано. Перевірте виклик telemetry.init(db)');
      return { success: false, reason: 'firestore_not_initialized' };
    }

    if (this.memoryBuffer.length === 0) {
      return { success: true, count: 0 };
    }

    let isConnected = false;
    try {
      const netState = await NetInfo.fetch();
      isConnected = Boolean(netState.isConnected && netState.isInternetReachable !== false);
    } catch (netErr) {
      console.warn('[SYNC_ERROR] Помилка перевірки NetInfo:', netErr);
      isConnected = false;
    }

    if (!isConnected) {
      console.warn('[Telemetry] Офлайн режим або мережа недоступна. Записів у буфері:', this.memoryBuffer.length);
      return { success: false, reason: 'offline', buffered: this.memoryBuffer.length };
    }

    this.isSyncing = true;
    try {
      const chunk = this.memoryBuffer.slice(0, MAX_BATCH_SIZE);
      const batch = writeBatch(this.firestoreDb);
      const colRef = collection(this.firestoreDb, this.collectionName);

      chunk.forEach((item) => {
        const docRef = doc(colRef, item.id);
        batch.set(docRef, item);
      });

      console.log(`[Telemetry] Спроба відправки batch (${chunk.length} записів) у Firestore...`);
      await batch.commit();

      const sentIds = new Set(chunk.map((i) => i.id));
      this.memoryBuffer = this.memoryBuffer.filter((i) => !sentIds.has(i.id));
      await this._saveToStorage();

      console.log(`[Telemetry] Успішно відправлено: ${chunk.length}. Залишилось у буфері: ${this.memoryBuffer.length}`);
      return { success: true, count: chunk.length, remaining: this.memoryBuffer.length };
    } catch (error) {
      console.error('[SYNC_ERROR] Помилка під час вивантаження batch у Firestore:', error);
      if (error && error.code) {
        console.error('[SYNC_ERROR_CODE]:', error.code);
      }
      if (error && error.message) {
        console.error('[SYNC_ERROR_MESSAGE]:', error.message);
      }
      return { success: false, error: error.message || error };
    } finally {
      this.isSyncing = false;
    }
  }

  getBufferSize() {
    return this.memoryBuffer.length;
  }
}

export const telemetry = new TelemetryService();
export default telemetry;