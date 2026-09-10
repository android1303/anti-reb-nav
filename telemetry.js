import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { collection, writeBatch, doc } from 'firebase/firestore';

const STORAGE_KEY = '@anti_reb_telemetry_buffer_v1';
const SYNC_INTERVAL_MS = 30000; // 30 секунд
const MAX_BATCH_SIZE = 450; // Безпечний ліміт для batch у Firestore (макс. 500)

class TelemetryService {
  constructor() {
    this.memoryBuffer = [];
    this.syncTimer = null;
    this.isSyncing = false;
    this.firestoreDb = null;
    this.collectionName = 'telemetry_logs';
    this.onBufferChangeCallback = null;
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
   * Запис точки телеметрії (з підтримкою осей гіроскопа та акселерометра)
   */
  async recordPoint({ speed, gyroX = 0, gyroY = 0, gyroZ = 0, accelX = 0, accelY = 0, accelZ = 0, pressure, lat = null, lon = null, timestamp = Date.now() }) {
    const entry = {
      id: `${timestamp}_${Math.random().toString(36).substring(2, 8)}`,
      speed: typeof speed === 'number' ? speed : Number(speed) || 0,
      gyroX: typeof gyroX === 'number' ? gyroX : Number(gyroX) || 0,
      gyroY: typeof gyroY === 'number' ? gyroY : Number(gyroY) || 0,
      gyroZ: typeof gyroZ === 'number' ? gyroZ : Number(gyroZ) || 0,
      accelX: typeof accelX === 'number' ? accelX : Number(accelX) || 0,
      accelY: typeof accelY === 'number' ? accelY : Number(accelY) || 0,
      accelZ: typeof accelZ === 'number' ? accelZ : Number(accelZ) || 0,
      pressure: typeof pressure === 'number' ? pressure : Number(pressure) || 0,
      lat: lat !== null && lat !== undefined ? Number(lat) : null,
      lon: lon !== null && lon !== undefined ? Number(lon) : null,
      timestamp: Number(timestamp) || Date.now(),
      createdAt: new Date(timestamp).toISOString(),
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

    // Перевірка наявності зв'язку через NetInfo
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

      // Успішне вивантаження: видаляємо відправлені записи з локального буфера
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
