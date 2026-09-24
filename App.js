import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Switch,
  Platform,
  StatusBar,
  PermissionsAndroid,
  Alert,
} from 'react-native';
import * as Location from 'expo-location';
import * as Sharing from 'expo-sharing';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Barometer, Gyroscope, DeviceMotion } from 'expo-sensors';
import obdScanner from './obdScanner';
import telemetry, { CORE_VERSION } from './telemetry';
import { db } from './firebaseConfig';
import { exportFirestoreToCSV } from './exportService';

const OBD_STALE_MS = 2000;
const SYNC_ERROR_DISPLAY_MS = 4000;

const formatHHMMSS = (ms) => {
  if (!ms) return null;
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
};

export default function App() {
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [obdStale, setObdStale] = useState(true);
  const [currentPressure, setCurrentPressure] = useState(0);
  const [location, setLocation] = useState(null);
  const [isGpsEnabled, setIsGpsEnabled] = useState(false);

  const [bufferCount, setBufferCount] = useState(0);
  const [syncState, setSyncState] = useState(telemetry.getSyncState());
  const [syncError, setSyncError] = useState(null);
  const syncErrorTimer = useRef(null);
  const [isExporting, setIsExporting] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isBluetoothConnected, setIsBluetoothConnected] = useState(false);
  const [rawObd, setRawObd] = useState('Система готова до запуску');
  const [nav, setNav] = useState(telemetry.getNavState());

  // Останні значення сенсорів (оновлюються без ре-рендерів)
  const latestData = useRef({
    speed: 0,
    pressure: 0,
    lat: null,
    lon: null,
    gpsAccuracy: null,
    gyroX: 0,
    gyroY: 0,
    gyroZ: 0,
    accelX: 0,
    accelY: 0,
    accelZ: 0,
    gravX: 0,
    gravY: 0,
    gravZ: 0,
    lastObdUpdateTime: 0, // 0 = OBD ще не відповідав -> дані вважаються несвіжими
  });

  useEffect(() => {
    latestData.current.pressure = currentPressure;
  }, [currentPressure]);

  useEffect(() => {
    latestData.current.lat = location?.coords?.latitude ?? null;
    latestData.current.lon = location?.coords?.longitude ?? null;
    latestData.current.gpsAccuracy = location?.coords?.accuracy ?? null;
  }, [location]);

  // Ініціалізація телеметрії (працює і без Firestore — лише локально)
  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        await telemetry.init(db || null);
        telemetry.setOnBufferChange((count) => {
          if (isMounted) setBufferCount(count);
        });
        if (isMounted) setBufferCount(telemetry.getBufferSize());
      } catch (e) {
        console.error('Помилка ініціалізації:', e);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  // Цикл ядра 20 Гц. recordPoint синхронний — тики не накладаються.
  // Швидкість НЕ обнуляється при втраті OBD: ядро саме вирішує за obdAgeMs.
  useEffect(() => {
    if (!isRecording) return undefined;
    const interval = setInterval(() => {
      try {
        const now = Date.now();
        const d = latestData.current;
        telemetry.recordPoint({
          speed: d.speed,
          obdAgeMs: d.lastObdUpdateTime ? now - d.lastObdUpdateTime : Infinity,
          gyroX: d.gyroX,
          gyroY: d.gyroY,
          gyroZ: d.gyroZ,
          accelX: d.accelX,
          accelY: d.accelY,
          accelZ: d.accelZ,
          gravX: d.gravX,
          gravY: d.gravY,
          gravZ: d.gravZ,
          pressure: d.pressure,
          lat: d.lat,
          lon: d.lon,
          gpsAccuracy: d.gpsAccuracy,
          timestamp: now,
        });
      } catch (err) {
        console.error('[Telemetry] Помилка запису точки (20 Гц):', err);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [isRecording]);

  // Екран не гасне під час запису: інакше Android душить JS-таймери 20 Гц
  useEffect(() => {
    if (isRecording) activateKeepAwakeAsync('recording').catch(() => {});
    else deactivateKeepAwake('recording').catch(() => {});
  }, [isRecording]);

  // Оновлення UI 2 Гц (курс, позиція, буфер, стан OBD, стан синхронізації)
  useEffect(() => {
    const ui = setInterval(() => {
      setNav(telemetry.getNavState());
      setBufferCount(telemetry.getBufferSize());
      setSyncState(telemetry.getSyncState());
      const last = latestData.current.lastObdUpdateTime;
      setObdStale(!last || Date.now() - last > OBD_STALE_MS);
    }, 500);
    return () => clearInterval(ui);
  }, []);

  // Очищення таймера банера помилки синхронізації при розмонтуванні
  useEffect(() => {
    return () => {
      if (syncErrorTimer.current) clearTimeout(syncErrorTimer.current);
    };
  }, []);

  // Барометр (1 Гц)
  useEffect(() => {
    let sub;
    (async () => {
      try {
        if (await Barometer.isAvailableAsync()) {
          Barometer.setUpdateInterval(1000);
          sub = Barometer.addListener((data) => setCurrentPressure(data.pressure));
        }
      } catch (e) {
        console.warn('Барометр недоступний:', e);
      }
    })();
    return () => sub && sub.remove();
  }, []);

  // Гіроскоп (20 Гц). Одиниці: рад/с — конвертація в ядрі.
  useEffect(() => {
    let sub;
    (async () => {
      try {
        if (await Gyroscope.isAvailableAsync()) {
          Gyroscope.setUpdateInterval(50);
          sub = Gyroscope.addListener((data) => {
            latestData.current.gyroX = data.x;
            latestData.current.gyroY = data.y;
            latestData.current.gyroZ = data.z;
          });
        }
      } catch (e) {
        console.warn('Гіроскоп недоступний:', e);
      }
    })();
    return () => sub && sub.remove();
  }, []);

  // DeviceMotion: лінійне прискорення + вектор гравітації (20 Гц)
  useEffect(() => {
    let sub;
    (async () => {
      try {
        if (await DeviceMotion.isAvailableAsync()) {
          DeviceMotion.setUpdateInterval(50);
          sub = DeviceMotion.addListener((data) => {
            const a = data?.acceleration;
            const ag = data?.accelerationIncludingGravity;
            if (a) {
              latestData.current.accelX = a.x || 0;
              latestData.current.accelY = a.y || 0;
              latestData.current.accelZ = a.z || 0;
            }
            if (a && ag) {
              latestData.current.gravX = ag.x - a.x;
              latestData.current.gravY = ag.y - a.y;
              latestData.current.gravZ = ag.z - a.z;
            }
          });
        }
      } catch (e) {
        console.warn('DeviceMotion недоступний:', e);
      }
    })();
    return () => sub && sub.remove();
  }, []);

  // Еталонний GPS (Ground Truth, у розрахунках не бере участі)
  useEffect(() => {
    let sub;
    (async () => {
      try {
        if (isGpsEnabled) {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            sub = await Location.watchPositionAsync(
              { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
              (loc) => setLocation(loc)
            );
          } else {
            setIsGpsEnabled(false);
          }
        } else {
          setLocation(null);
        }
      } catch (e) {
        console.warn('Помилка GPS:', e);
        setIsGpsEnabled(false);
      }
    })();
    return () => sub && sub.remove();
  }, [isGpsEnabled]);

  const connectBluetooth = async () => {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        if (granted['android.permission.BLUETOOTH_CONNECT'] !== PermissionsAndroid.RESULTS.GRANTED) {
          setRawObd('Немає дозволу BLUETOOTH_CONNECT');
          return;
        }
        if (granted['android.permission.BLUETOOTH_SCAN'] !== PermissionsAndroid.RESULTS.GRANTED) {
          setRawObd('Немає дозволу BLUETOOTH_SCAN');
          return;
        }
      }

      setRawObd('Підключення через Native Module...');
      const connected = await obdScanner.connectToELM();

      if (connected) {
        setIsBluetoothConnected(true);
        obdScanner.startReadingSpeed(
          (speed, hwTimestamp) => {
            const parsed = typeof speed === 'number' && !isNaN(speed) ? speed : 0;
            latestData.current.speed = parsed;
            // Kotlin System.currentTimeMillis() і JS Date.now() — один годинник
            latestData.current.lastObdUpdateTime =
              typeof hwTimestamp === 'number' ? hwTimestamp : Date.now();
            setCurrentSpeed(parsed);
          },
          (status) => {
            setRawObd(status);
            if (status === "Розрив зв'язку") setIsBluetoothConnected(false);
          }
        );
      } else {
        setIsBluetoothConnected(false);
        setRawObd("Помилка з'єднання");
      }
    } catch (err) {
      setIsBluetoothConnected(false);
      setRawObd(`Помилка: ${err.message}`);
    }
  };

  const toggleRecording = async () => {
    if (!isRecording) {
      telemetry.startSession();
      setNav(telemetry.getNavState());
      setIsRecording(true);
    } else {
      setIsRecording(false);
      await telemetry.stopSession();
    }
  };

  const handleSync = async () => {
    const result = await telemetry.syncNow();
    setSyncState(telemetry.getSyncState());
    setBufferCount(telemetry.getBufferSize());
    if (result.success) return;
    // already_syncing / recording — кнопка вже відображає цей стан, банер помилки не потрібен
    if (result.reason === 'already_syncing' || result.reason === 'recording') return;

    const reasons = {
      offline: 'НЕМАЄ МЕРЕЖІ',
      firestore_not_initialized: 'FIREBASE ВИМК.',
    };
    setSyncError(reasons[result.reason] || 'ПОМИЛКА');
    if (syncErrorTimer.current) clearTimeout(syncErrorTimer.current);
    syncErrorTimer.current = setTimeout(() => setSyncError(null), SYNC_ERROR_DISPLAY_MS);
  };

  // Офлайн-експорт з локальних файлів (інтернет не потрібен)
  const doExport = async (sessionId) => {
    setIsExporting(true);
    try {
      const result = await telemetry.exportLocalCSV(sessionId);
      if (!result.success) {
        Alert.alert('Помилка експорту', result.error);
        return;
      }
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(result.uri, { mimeType: 'text/csv', dialogTitle: 'Лог Anti-Reb' });
      } else {
        Alert.alert('Експорт', `Файл збережено:\n${result.uri}`);
      }
    } catch (e) {
      Alert.alert('Помилка експорту', e.message);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExport = async () => {
    const lastSessionId = await telemetry.getLastSessionId();
    Alert.alert('Експорт CSV', 'Яку сесію експортувати?', [
      { text: 'Остання сесія', onPress: () => doExport(lastSessionId) },
      { text: 'Усі сесії', onPress: () => doExport(null) },
      { text: 'Скасувати', style: 'cancel' },
    ]);
  };

  // Довге натискання на ЕКСПОРТ — вивантаження з Firebase (потрібен інтернет)
  const handleCloudExport = async () => {
    setIsExporting(true);
    try {
      const result = await exportFirestoreToCSV(db);
      if (!result.success) {
        Alert.alert('Помилка експорту з хмари', result.error);
      } else {
        Alert.alert('Експорт з хмари завершено', `Рядків: ${result.rows}`);
      }
    } finally {
      setIsExporting(false);
    }
  };

  const stateColor = { STOPPED: '#facc15', MOVING: '#4ade80', OBD_LOST: '#f87171' };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>ANTI-REB NAV</Text>
        <View style={styles.statusIcons}>
          <TouchableOpacity
            onPress={connectBluetooth}
            style={[styles.badge, isBluetoothConnected ? styles.badgeActive : styles.badgeInactive]}
          >
            <Text style={styles.badgeText}>OBD</Text>
          </TouchableOpacity>
          <View style={[styles.badge, isGpsEnabled ? styles.badgeActive : styles.badgeInactive]}>
            <Text style={styles.badgeText}>GPS</Text>
          </View>
        </View>
      </View>

      <View style={styles.grid}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>ШВИДКІСТЬ (OBD)</Text>
          <Text style={[styles.cardValue, obdStale && { color: '#64748b' }]}>{currentSpeed}</Text>
          <Text style={styles.cardSub}>
            {!isBluetoothConnected ? 'Офлайн' : obdStale ? 'Дані застаріли' : 'Онлайн'}
          </Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>RAW (ДЕБАГ)</Text>
          <Text style={[styles.cardValueSmall, { color: '#facc15' }]} numberOfLines={3}>
            {rawObd}
          </Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>КУРС / СТАН</Text>
          <Text style={styles.cardValue}>
            {nav.heading.toFixed(0)}
            <Text style={{ fontSize: 16 }}>°</Text>
          </Text>
          <Text style={[styles.cardSub, { color: stateColor[nav.state] || '#64748b' }]}>
            {nav.state} · bias {nav.gyroBias.toFixed(2)}°/с
          </Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>ПОЗИЦІЯ DR (м)</Text>
          <Text style={styles.cardValueSmall}>
            X: {nav.posX.toFixed(1)}
            {'\n'}Y: {nav.posY.toFixed(1)}
          </Text>
          <Text style={styles.cardSub}>{nav.isReversing ? 'РЕВЕРС' : 'Вперед'}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>ТИСК (BARO)</Text>
          <Text style={styles.cardValue}>
            {currentPressure ? currentPressure.toFixed(1) : 0} <Text style={{ fontSize: 16 }}>hPa</Text>
          </Text>
          <Text style={styles.cardSub}>Відн. висота {nav.altitude.toFixed(1)} м</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>GROUND TRUTH GPS</Text>
          <Text style={styles.cardValueSmall}>
            {location
              ? `${location.coords.latitude.toFixed(5)}\n${location.coords.longitude.toFixed(5)}`
              : 'Очікування GPS'}
          </Text>
        </View>
      </View>

      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Еталонний GPS</Text>
        <Switch
          value={isGpsEnabled}
          onValueChange={setIsGpsEnabled}
          trackColor={{ false: '#334155', true: '#0284c7' }}
          thumbColor={'#fff'}
        />
      </View>

      <View style={styles.bufferInfo}>
        <Text style={styles.bufferText}>
          Не синхр.: {bufferCount} | Синхр: {formatHHMMSS(syncState.lastSyncAt) || '--:--:--'}
        </Text>
      </View>

      <View style={styles.controlsRow}>
        <TouchableOpacity
          style={styles.syncBtn}
          onPress={handleSync}
          disabled={syncState.isRecording || syncState.isSyncing}
        >
          <Text style={styles.syncBtnText}>
            {syncState.isRecording
              ? 'ПІСЛЯ ЗАПИСУ'
              : syncState.isSyncing
              ? 'СИНХРОНІЗАЦІЯ...'
              : syncError || 'СИНХРОНІЗУВАТИ'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.syncBtn} onPress={handleExport}
          onLongPress={handleCloudExport}
          disabled={isExporting}
        >
          <Text style={styles.syncBtnText}>{isExporting ? 'ФОРМУВАННЯ...' : 'ЕКСПОРТ (CSV)'}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.recordBtn, isRecording ? styles.recordBtnActive : styles.recordBtnInactive]}
        onPress={toggleRecording}
      >
        <Text style={styles.recordBtnText}>{isRecording ? 'ЗУПИНИТИ ЗАПИС' : 'ЗАПИС ЛОГУ'}</Text>
      </TouchableOpacity>

      <Text style={{ textAlign: 'center', color: '#64748b', fontSize: 11, marginTop: 15, marginBottom: 10 }}>
        Білд: {obdScanner.getVersion()} · ядро {CORE_VERSION}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0f1c',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight + 10 : 40,
    paddingHorizontal: 15,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  headerTitle: {
    color: '#38bdf8',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1,
  },
  statusIcons: {
    flexDirection: 'row',
    gap: 10,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeInactive: {
    borderColor: '#334155',
    backgroundColor: '#1e293b',
  },
  badgeActive: {
    borderColor: '#0ea5e9',
    backgroundColor: '#0284c7',
  },
  badgeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: 'bold',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  card: {
    backgroundColor: '#151c2c',
    width: '48%',
    padding: 12,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#222f47',
  },
  cardLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 5,
  },
  cardValue: {
    color: 'white',
    fontSize: 28,
    fontWeight: 'bold',
  },
  cardValueSmall: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: 'bold',
    lineHeight: 18,
  },
  cardSub: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 5,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#151c2c',
    padding: 15,
    borderRadius: 10,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#222f47',
  },
  toggleLabel: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
  },
  bufferInfo: {
    backgroundColor: '#151c2c',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 20,
  },
  bufferText: {
    color: '#38bdf8',
    fontWeight: 'bold',
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 15,
  },
  syncBtn: {
    backgroundColor: '#1c2539',
    paddingVertical: 12,
    flex: 0.48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  syncBtnText: {
    color: 'white',
    fontWeight: 'bold',
    textAlign: 'center',
    fontSize: 12,
  },
  recordBtn: {
    paddingVertical: 18,
    borderRadius: 10,
    alignItems: 'center',
  },
  recordBtnInactive: {
    backgroundColor: '#dc2626',
  },
  recordBtnActive: {
    backgroundColor: '#16a34a',
  },
  recordBtnText: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
});