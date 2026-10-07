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
  AppState,
  ScrollView,
  ToastAndroid,
  NativeModules,
  NativeEventEmitter,
} from 'react-native';
import * as Location from 'expo-location';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Barometer, Gyroscope, DeviceMotion } from 'expo-sensors';
import obdScanner from './obdScanner';
import { bgTick, setBgInterval, clearBgInterval } from './bgScheduler';
import { createGeoAnchor } from './geoAnchor';
import telemetry, { CORE_VERSION } from './telemetry';
import { db } from './firebaseConfig';
import { exportFirestoreToCSV } from './exportService';

const OBD_STALE_MS = 2000;
const GPS_FIX_STALE_MS = 3000; // довше — на екрані «GPS: немає»
const GNSS_STATUS_STALE_MS = 5000; // старіший стан супутників у лог не пишемо (null)

const EXPO_SENSOR_STALE_MS = 500; // expo-sensors мовчать (фон) — у лог пишемо null
const NATIVE_TICK_STALE_MS = 200; // нативний такт зник — працює запасний setInterval

const { GnssModule, SensorModule, MockLocationModule } = NativeModules;
const gnssEmitter = GnssModule ? new NativeEventEmitter(GnssModule) : null;
const sensorEmitter = SensorModule ? new NativeEventEmitter(SensorModule) : null;

// Прив'язка DR до карти за GPS (TASK-018): окремий шар поверх ядра, heading/posX/posY не змінює
const geoAnchor = createGeoAnchor();

// Номер останнього TASK у рядку білду (видно, яка збірка встановлена на телефоні)
const LAST_TASK = 'TASK-025';
const GNSS_SILENT_MS = 60000; // TASK-025: від GnssModule жодної події стільки часу — смуга «GNSS МОВЧИТЬ»
const OBD_LOST_BANNER_MS = 5000; // OBD несвіжий довше — червона смуга і сповіщення «OBD втрачено»
const WAZE_FIX_WAIT_MS = 30000; // жодного свіжого фіксу GPS чи мережі за цей час — «очікую GPS або мережу»
const SETTINGS_FILE = (FileSystem.documentDirectory || '') + 'settings.json';

const SYNC_ERROR_DISPLAY_MS = 4000;

const formatHHMMSS = (ms) => {
  if (!ms) return null;
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
};

export default function App() {
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [obdStale, setObdStale] = useState(true);
  const [gnssSilent, setGnssSilent] = useState(false); // TASK-025
  const [obdLost, setObdLost] = useState(false); // під час запису OBD несвіжий > 5 с
  const [fixFresh, setFixFresh] = useState(false); // є свіжий фікс GPS або мережі (≤ 30 с)
  const [currentPressure, setCurrentPressure] = useState(0);
  const [gnssView, setGnssView] = useState({ hasFix: false, lat: null, lon: null, satUsed: null, satInView: null });
  const [isGpsEnabled, setIsGpsEnabled] = useState(false);
  // «Симуляція РЕБ»: geoAnchor не отримує GPS-фіксів (лише мережа і DR); GPS лишається еталоном у лозі
  const [rebSim, setRebSim] = useState(false);
  const rebSimRef = useRef(false);

  const [bufferCount, setBufferCount] = useState(0);
  const [syncState, setSyncState] = useState(telemetry.getSyncState());
  const [syncError, setSyncError] = useState(null);
  const syncErrorTimer = useRef(null);
  const isRecordingRef = useRef(false);
  const isGpsEnabledRef = useRef(false);
  const [wazeArmed, setWazeArmed] = useState(false); // WAZE «озброєно»: подача вмикається, щойно є позиція
  const [mockRunning, setMockRunning] = useState(false); // нативна підміна реально активна
  const [wazeError, setWazeError] = useState(null);
  const [anchorView, setAnchorView] = useState({ state: 'waiting' });
  const wazeArmedRef = useRef(false);
  const mockRunningRef = useRef(false);
  const wazeBusyRef = useRef(false);
  const wazeTimerRef = useRef(null);
  const lastSpeedMpsRef = useRef(0);
  const [isExporting, setIsExporting] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isBluetoothConnected, setIsBluetoothConnected] = useState(false);
  const [rawObd, setRawObd] = useState('Система готова до запуску');
  const [nav, setNav] = useState(telemetry.getNavState());

  // Останні значення сенсорів (оновлюються без ре-рендерів)
  const latestData = useRef({
    speed: 0,
    pressure: 0,
    lat: null, // лише GPS-приймач (GPS_PROVIDER); тримається між фіксами
    lon: null,
    gpsAccuracy: null,
    gpsMock: null,
    gpsRxMs: 0, // Date.now() прийому останнього GPS-фіксу; 0 = не було
    netLat: null,
    netLon: null,
    netAccuracy: null,
    netRxMs: 0,
    netFixSeq: 0, // кількість подій gnssNetFix з початку запису (скидається на старті запису)
    fusedLat: null,
    fusedLon: null,
    fusedAccuracy: null,
    fusedRxMs: 0,
    st: null, // останній gnssStatus
    stRxMs: 0,
    gnssEventMs: 0, // остання подія GnssModule (gnssGpsFix/NetFix/FusedFix/Status)
    gnssWatchSinceMs: 0, // відлік «GNSS МОВЧИТЬ»: ввімкнення GPS або старт запису
    // expo-sensors (працюють лише поки застосунок на екрані)
    expoGyroTs: 0,
    expoMotionTs: 0,
    // нативний SensorModule (працює і у фоні) + нативний такт
    lastNativeTickMs: 0,
    nGyroX: null, nGyroY: null, nGyroZ: null,
    nAccX: null, nAccY: null, nAccZ: null,
    nGravX: null, nGravY: null, nGravZ: null,
    nGyroAgeMs: null, nAccAgeMs: null, nGravAgeMs: null,
    uGyroX: null, uGyroY: null, uGyroZ: null,
    uBiasX: null, uBiasY: null, uBiasZ: null, uGyroAgeMs: null,
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

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // Текст сповіщення RecordingService: «OBD втрачено» замість звичайного, поки OBD несвіжий
  useEffect(() => {
    if (!SensorModule || !isRecording) return;
    SensorModule.setObdLost(obdLost).catch(() => {});
  }, [obdLost, isRecording]);

  // Збережений стан перемикача «Симуляція РЕБ» (локальний файл застосунку)
  useEffect(() => {
    (async () => {
      try {
        const info = await FileSystem.getInfoAsync(SETTINGS_FILE);
        if (!info.exists) return;
        const saved = JSON.parse(await FileSystem.readAsStringAsync(SETTINGS_FILE));
        if (saved && typeof saved.rebSim === 'boolean') {
          rebSimRef.current = saved.rebSim;
          setRebSim(saved.rebSim);
        }
      } catch (e) {
        console.warn('Налаштування не прочитано:', e);
      }
    })();
  }, []);

  // Перемикати можна будь-коли; геoAnchor при цьому не скидається (далі працює за мережею/DR)
  const applyRebSim = async (value) => {
    rebSimRef.current = value;
    setRebSim(value);
    try {
      await FileSystem.writeAsStringAsync(SETTINGS_FILE, JSON.stringify({ rebSim: value }));
    } catch (e) {
      console.warn('Налаштування не збережено:', e);
    }
  };

  // Під час запису зміна симуляції (в обидва боки) — лише після підтвердження; поза записом — одразу
  const toggleRebSim = (value) => {
    if (!isRecording) {
      applyRebSim(value);
      return;
    }
    Alert.alert(value ? 'Увімкнути симуляцію РЕБ?' : 'Вимкнути симуляцію РЕБ?', undefined, [
      { text: 'Скасувати', style: 'cancel' },
      { text: 'Так', onPress: () => applyRebSim(value) },
    ]);
  };

  // Одна точка ядра. recordPoint синхронний — тики не накладаються.
  // Швидкість НЕ обнуляється при втраті OBD: ядро саме вирішує за obdAgeMs.
  // Використовує лише ref-и і модулі, тож безпечно викликається із будь-яких ефектів.
  const runCoreTick = (now) => {
    try {
      const d = latestData.current;
      const stFresh = !!d.st && now - d.stRxMs <= GNSS_STATUS_STALE_MS;
      const expoGyroOk = !!d.expoGyroTs && now - d.expoGyroTs <= EXPO_SENSOR_STALE_MS;
      const expoMotionOk = !!d.expoMotionTs && now - d.expoMotionTs <= EXPO_SENSOR_STALE_MS;
      const nativeOk = !!d.lastNativeTickMs && now - d.lastNativeTickMs <= NATIVE_TICK_STALE_MS;
      const age = (rx) => (rx ? Math.max(0, now - rx) : null);
      const anchorPos = geoAnchor.getPosition(now);
      const entry = telemetry.recordPoint({
        speed: d.speed,
        obdAgeMs: d.lastObdUpdateTime ? now - d.lastObdUpdateTime : Infinity,
        // expo-sensors: паралельний запис (null, коли вони мовчать у фоні)
        gyroX: expoGyroOk ? d.gyroX : null,
        gyroY: expoGyroOk ? d.gyroY : null,
        gyroZ: expoGyroOk ? d.gyroZ : null,
        accelX: expoMotionOk ? d.accelX : null,
        accelY: expoMotionOk ? d.accelY : null,
        accelZ: expoMotionOk ? d.accelZ : null,
        gravX: expoMotionOk ? d.gravX : null,
        gravY: expoMotionOk ? d.gravY : null,
        gravZ: expoMotionOk ? d.gravZ : null,
        // нативні датчики: джерело входів ядра, коли є
        nGyroX: nativeOk ? d.nGyroX : null,
        nGyroY: nativeOk ? d.nGyroY : null,
        nGyroZ: nativeOk ? d.nGyroZ : null,
        nAccX: nativeOk ? d.nAccX : null,
        nAccY: nativeOk ? d.nAccY : null,
        nAccZ: nativeOk ? d.nAccZ : null,
        nGravX: nativeOk ? d.nGravX : null,
        nGravY: nativeOk ? d.nGravY : null,
        nGravZ: nativeOk ? d.nGravZ : null,
        nGyroAgeMs: nativeOk ? d.nGyroAgeMs : null,
        nAccAgeMs: nativeOk ? d.nAccAgeMs : null,
        nGravAgeMs: nativeOk ? d.nGravAgeMs : null,
        uGyroX: nativeOk ? d.uGyroX : null,
        uGyroY: nativeOk ? d.uGyroY : null,
        uGyroZ: nativeOk ? d.uGyroZ : null,
        uBiasX: nativeOk ? d.uBiasX : null,
        uBiasY: nativeOk ? d.uBiasY : null,
        uBiasZ: nativeOk ? d.uBiasZ : null,
        uGyroAgeMs: nativeOk ? d.uGyroAgeMs : null,
        appState: AppState.currentState,
        mockActive: mockRunningRef.current,
        rebSim: rebSimRef.current,
        rebSimMode: 'gps_start',
        netFixSeq: d.netFixSeq,
        mockMode: mockRunningRef.current ? 'fused' : null,
        mockLat: anchorPos.lat,
        mockLon: anchorPos.lon,
        mockAccuracy: anchorPos.accuracy,
        mockBearing: anchorPos.bearing,
        anchorAgeS: anchorPos.anchorAgeS,
        headingOffsetDeg: anchorPos.headingOffsetDeg,
        anchorState: anchorPos.state,
        anchorSource: anchorPos.source,
        netFitN: anchorPos.netFitN,
        netFitResidM: anchorPos.netFitResidM,
        pressure: d.pressure,
        lat: d.lat,
        lon: d.lon,
        gpsAccuracy: d.gpsAccuracy,
        gpsFixAgeMs: age(d.gpsRxMs),
        gpsMock: d.gpsMock,
        netLat: d.netLat,
        netLon: d.netLon,
        netAccuracy: d.netAccuracy,
        netFixAgeMs: age(d.netRxMs),
        fusedLat: d.fusedLat,
        fusedLon: d.fusedLon,
        fusedAccuracy: d.fusedAccuracy,
        fusedFixAgeMs: age(d.fusedRxMs),
        gnssSatInView: stFresh ? d.st.satInView : null,
        gnssSatUsed: stFresh ? d.st.satUsed : null,
        gnssCn0MeanUsed: stFresh ? d.st.cn0MeanUsed : null,
        gnssCn0MaxAll: stFresh ? d.st.cn0MaxAll : null,
        gnssConstellations: stFresh ? d.st.constellationsUsed : null,
        timestamp: now,
      });
      if (entry) {
        geoAnchor.onDrSample({ tMs: now, posX: entry.posX, posY: entry.posY, heading: entry.heading, speedKmh: entry.speedUsed });
        lastSpeedMpsRef.current = entry.speedUsed / 3.6;
      }
    } catch (err) {
      console.error('[Telemetry] Помилка запису точки (20 Гц):', err);
    }
  };

  // Нативний такт 20 Гц (SensorModule): працює у фоні й з вимкненим екраном, на відміну від
  // таймерів JS. Від нього йдуть: цикл ядра, таймери OBD і flush логу (bgScheduler).
  useEffect(() => {
    if (!sensorEmitter) return undefined;
    const sub = sensorEmitter.addListener('nativeSensors', (e) => {
      const d = latestData.current;
      const now = typeof e.tMs === 'number' ? e.tMs : Date.now();
      d.lastNativeTickMs = now;
      d.nGyroX = e.gyroX; d.nGyroY = e.gyroY; d.nGyroZ = e.gyroZ;
      d.nAccX = e.accX; d.nAccY = e.accY; d.nAccZ = e.accZ;
      d.nGravX = e.gravX; d.nGravY = e.gravY; d.nGravZ = e.gravZ;
      d.nGyroAgeMs = e.gyroAgeMs; d.nAccAgeMs = e.accAgeMs; d.nGravAgeMs = e.gravAgeMs;
      d.uGyroX = e.uGyroX; d.uGyroY = e.uGyroY; d.uGyroZ = e.uGyroZ;
      d.uBiasX = e.uBiasX; d.uBiasY = e.uBiasY; d.uBiasZ = e.uBiasZ; d.uGyroAgeMs = e.uGyroAgeMs;
      bgTick(now);
      if (isRecordingRef.current) runCoreTick(now);
    });
    SensorModule.start().catch((err) => console.warn('SensorModule.start:', err));
    return () => {
      sub.remove();
      SensorModule.stop().catch(() => {});
    };
  }, []);

  // Запасний цикл, якщо нативних тактів немає (SensorModule не запустився)
  useEffect(() => {
    const interval = setInterval(() => {
      if (!isRecordingRef.current) return;
      const now = Date.now();
      if (now - latestData.current.lastNativeTickMs < NATIVE_TICK_STALE_MS) return;
      runCoreTick(now);
    }, 50);
    return () => clearInterval(interval);
  }, []);

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
      setAnchorView(geoAnchor.getPosition(Date.now()));
      const last = latestData.current.lastObdUpdateTime;
      setObdStale(!last || Date.now() - last > OBD_STALE_MS);
      const g = latestData.current;
      const nowMs = Date.now();
      setObdLost(isRecordingRef.current && (!last || nowMs - last > OBD_LOST_BANNER_MS));
      setGnssSilent(
        isRecordingRef.current &&
          isGpsEnabledRef.current &&
          nowMs - Math.max(g.gnssEventMs, g.gnssWatchSinceMs) > GNSS_SILENT_MS
      );
      setFixFresh(nowMs - Math.max(g.gpsRxMs, g.netRxMs) <= WAZE_FIX_WAIT_MS);
      setGnssView({
        hasFix: !!g.gpsRxMs && nowMs - g.gpsRxMs <= GPS_FIX_STALE_MS,
        lat: g.lat,
        lon: g.lon,
        satUsed: g.st ? g.st.satUsed : null,
        satInView: g.st ? g.st.satInView : null,
      });
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
            latestData.current.expoGyroTs = Date.now();
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
            latestData.current.expoMotionTs = Date.now();
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

  // Еталонний GPS (Ground Truth, у розрахунках не бере участі).
  // Нативний GnssModule: GPS-приймач, мережева позиція і стан супутників окремо.
  // Без Location.watchPositionAsync — він показує діалог «Точна геолокація».
  useEffect(() => {
    isGpsEnabledRef.current = isGpsEnabled;
    if (isGpsEnabled) latestData.current.gnssWatchSinceMs = Date.now();
    if (!isGpsEnabled || !gnssEmitter) return undefined;
    let cancelled = false;
    const subs = [];
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setIsGpsEnabled(false);
          return;
        }
        if (cancelled) return;
        subs.push(
          gnssEmitter.addListener('gnssGpsFix', (e) => {
            latestData.current.gnssEventMs = Date.now();
            const d = latestData.current;
            d.lat = e.lat;
            d.lon = e.lon;
            d.gpsAccuracy = e.accuracy ?? null;
            d.gpsMock = typeof e.isMock === 'boolean' ? e.isMock : null;
            d.gpsRxMs = Date.now();
            // Фікси з isMock = true (наша ж підміна) geoAnchor ігнорує і заморожує прив'язку
            // «Симуляція РЕБ» = GPS лише для старту прив'язки: geoAnchor сам ігнорує фікси, коли прив'язка вже готова
            geoAnchor.onGpsFix({
              tMs: d.gpsRxMs,
              lat: e.lat,
              lon: e.lon,
              accuracy: e.accuracy,
              mock: e.isMock,
              rebSim: rebSimRef.current,
            });
          }),
          gnssEmitter.addListener('gnssNetFix', (e) => {
            latestData.current.gnssEventMs = Date.now();
            const d = latestData.current;
            d.netLat = e.lat;
            d.netLon = e.lon;
            d.netAccuracy = e.accuracy ?? null;
            d.netRxMs = Date.now();
            d.netFixSeq += 1;
            // Мережеві фікси збираємо завжди: мережева прив'язка має бути готова одразу після втрати GPS.
            // Вік фіксу = час прийому − Location.time; застарілі (> 1.5 с) geoAnchor відкидає.
            // Вік за монотонним часом Android (ageAtEmitMs від GnssModule) + час обробки події;
            // якщо поля немає — за Location.time (годинник телефона), як раніше
            const netAgeMs =
              typeof e.ageAtEmitMs === 'number'
                ? Math.max(0, e.ageAtEmitMs) + Math.max(0, Date.now() - d.netRxMs)
                : typeof e.timeMs === 'number'
                ? Math.max(0, d.netRxMs - e.timeMs)
                : 0;
            geoAnchor.onNetFix({
              tMs: d.netRxMs - netAgeMs,
              lat: e.lat,
              lon: e.lon,
              accuracy: e.accuracy,
              ageMs: netAgeMs,
              mock: e.isMock,
            });
          }),
          gnssEmitter.addListener('gnssFusedFix', (e) => {
            latestData.current.gnssEventMs = Date.now();
            const d = latestData.current;
            d.fusedLat = e.lat;
            d.fusedLon = e.lon;
            d.fusedAccuracy = e.accuracy ?? null;
            d.fusedRxMs = Date.now();
          }),
          gnssEmitter.addListener('gnssStatus', (e) => {
            latestData.current.gnssEventMs = Date.now();
            latestData.current.st = e;
            latestData.current.stRxMs = Date.now();
          })
        );
        const started = await GnssModule.start();
        if (!started.gps) console.warn('GPS_PROVIDER не запущено (немає на пристрої?)', started);
      } catch (e) {
        console.warn('Помилка GNSS:', e);
        setIsGpsEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
      subs.forEach((sub) => sub.remove());
      GnssModule.stop().catch(() => {});
      const d = latestData.current;
      d.lat = null;
      d.lon = null;
      d.gpsAccuracy = null;
      d.gpsMock = null;
      d.gpsRxMs = 0;
      d.netLat = null;
      d.netLon = null;
      d.netAccuracy = null;
      d.netRxMs = 0;
      d.fusedLat = null;
      d.fusedLon = null;
      d.fusedAccuracy = null;
      d.fusedRxMs = 0;
      d.st = null;
      d.stRxMs = 0;
    };
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

  // Подача позиції DR у Waze (TASK-022): кнопка лише «озброює» подачу. Підміна (MockLocationModule)
  // вмикається автоматично, коли geoAnchor має позицію, і вимикається, якщо позиції знову немає:
  // поки прив'язки немає, Waze працює на власній геолокації (вишки/Wi-Fi), а не губить її.
  const stopMock = async () => {
    mockRunningRef.current = false;
    setMockRunning(false);
    if (MockLocationModule) {
      try {
        await MockLocationModule.stop();
      } catch (e) {
        console.warn('MockLocationModule.stop:', e);
      }
    }
  };

  const disarmWaze = async () => {
    clearBgInterval(wazeTimerRef.current);
    wazeTimerRef.current = null;
    wazeArmedRef.current = false;
    setWazeArmed(false);
    if (mockRunningRef.current) await stopMock();
  };

  // NOT_MOCK_APP: повторного старту до наступного натискання WAZE не буде
  const failWaze = async (code, message) => {
    setWazeError(code === 'NOT_MOCK_APP' ? 'NOT_MOCK_APP' : `ПОМИЛКА: ${message}`);
    await disarmWaze();
  };

  const feedWaze = async () => {
    if (!wazeArmedRef.current || wazeBusyRef.current) return;
    wazeBusyRef.current = true;
    try {
      const pos = geoAnchor.getPosition(Date.now());
      if (pos.source === 'waiting') {
        if (mockRunningRef.current) await stopMock(); // позиції немає — повертаємо Waze власну геолокацію
        return;
      }
      if (!mockRunningRef.current) {
        try {
          await MockLocationModule.start('fused');
        } catch (e) {
          await failWaze(e && e.code, e && e.message);
          return;
        }
        if (!wazeArmedRef.current) {
          await MockLocationModule.stop().catch(() => {}); // вимкнули під час старту
          return;
        }
        mockRunningRef.current = true;
        setMockRunning(true);
      }
      // altitude не подаємо: GnssModule не віддає висоту
      await MockLocationModule.push(pos.lat, pos.lon, pos.accuracy, lastSpeedMpsRef.current, pos.bearing, 0, false);
    } catch (e) {
      if (e && e.code === 'NOT_MOCK_APP') {
        await failWaze('NOT_MOCK_APP');
      } else {
        console.warn('MockLocationModule.push:', e);
      }
    } finally {
      wazeBusyRef.current = false;
    }
  };

  const toggleWaze = async () => {
    if (wazeArmed) {
      await disarmWaze();
      setWazeError(null);
      return;
    }
    if (!isRecording) {
      ToastAndroid.show('Спершу почни запис', ToastAndroid.LONG);
      return;
    }
    if (!MockLocationModule) return;
    // Дозвіл на підміну перевіряємо одразу, а не під РЕБ через 1–1.5 км після натискання
    try {
      if (!(await MockLocationModule.canMock())) {
        setWazeError('NOT_MOCK_APP');
        return;
      }
    } catch (e) {
      console.warn('canMock:', e); // не вдалося визначити — не блокуємо, помилка проявиться при старті підміни
    }
    // Мережеві фікси дає GnssModule (запускається перемикачем «Еталонний GPS»): без нього прив'язка неможлива
    if (!isGpsEnabled) setIsGpsEnabled(true);
    setWazeError(null);
    wazeArmedRef.current = true;
    setWazeArmed(true);
    wazeTimerRef.current = setBgInterval(() => {
      feedWaze();
    }, 1000);
  };

  // Чого бракує до підміни — в порядку перевірки (TASK-024); спільне для статусу і табло
  const waitReason = () => {
    if (obdStale) return "немає OBD — прив'язка неможлива";
    if (!fixFresh) return 'очікую GPS або мережу';
    if (anchorView.source === 'waiting') {
      // У симуляції РЕБ спершу потрібен GPS для старту прив'язки (~150 м руху)
      if (rebSim && anchorView.state === 'waiting') return 'чекаю GPS для старту (~150 м руху)';
      return `збираю мережу — ${anchorView.netFitN ?? 0} фіксів, ${Math.round(anchorView.netFitPathM ?? 0)} з 1000 м`;
    }
    return "очікую прив'язку";
  };

  const wazeStatusText = () => {
    if (wazeError === 'NOT_MOCK_APP') {
      return 'Waze: оберіть Anti-REB Nav як застосунок для фіктивних місцезнаходжень у Параметрах розробника';
    }
    if (wazeError) return `Waze: ${wazeError}`;
    if (!wazeArmed) return 'Waze: вимкнено';
    if (!mockRunning) return `Waze: ${waitReason()}`;
    if (anchorView.source === 'gps') return `Waze: GPS, прив'язка ${Math.round(anchorView.anchorAgeS)} с тому`;
    if (anchorView.source === 'network') return `Waze: мережа, ~${Math.round(anchorView.accuracy)} м`;
    return `Waze: лише DR (похибка ~${Math.round(anchorView.accuracy)} м)`;
  };

  // Табло (TASK-026): що саме зараз подається в систему; приховане, коли WAZE не озброєно.
  // Тут лише факт підміни нашим розрахунком; чи бере Waze саме її — підтверджує окремий тест.
  const wazeBoard = () => {
    if (!wazeArmed) return null;
    if (!mockRunning) {
      return {
        bg: '#475569',
        text: `Підміни немає — Waze на власній геолокації (чекаю прив'язку: ${waitReason()})`,
      };
    }
    if (anchorView.source === 'gps') return { bg: '#0369a1', text: 'ПІДМІНА: НАШ РОЗРАХУНОК ЗА GPS' };
    const kind = anchorView.source === 'network' ? 'мережа' : 'DR';
    return { bg: '#15803d', text: `ПІДМІНА: НАШ РОЗРАХУНОК (${kind}, ~${Math.round(anchorView.accuracy)} м)` };
  };

  // TASK-025: під час запису «Еталонний GPS» не вимикається (випадкове вимкнення зупиняє й мережеві фікси)
  const toggleGps = (value) => {
    if (!value && isRecordingRef.current) {
      ToastAndroid.show('GPS вимикається лише після зупинки запису', ToastAndroid.LONG);
      return;
    }
    setIsGpsEnabled(value);
  };

  const toggleRecording = async () => {
    if (!isRecording) {
      latestData.current.gnssWatchSinceMs = Date.now();
      geoAnchor.reset(); // DR починається з нуля — стара прив'язка недійсна
      latestData.current.netFixSeq = 0;
      // Android 13+: без дозволу сповіщення foreground service все одно працює, але його не видно
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        try {
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
        } catch (e) {
          console.warn('POST_NOTIFICATIONS:', e);
        }
      }
      if (SensorModule) {
        try {
          await SensorModule.startRecordingService();
        } catch (e) {
          console.warn('RecordingService не запущено (запис піде без фонового сервісу):', e);
        }
      }
      // Без еталонного GPS запис непридатний для аналізу — вмикаємо автоматично (вручну можна вимкнути)
      if (!isGpsEnabled) setIsGpsEnabled(true);
      telemetry.startSession();
      setNav(telemetry.getNavState());
      setIsRecording(true);
      // Запис стартує в будь-якому разі, але водій має знати, що без OBD DR і прив'язка не працюватимуть
      const lastObd = latestData.current.lastObdUpdateTime;
      if (!isBluetoothConnected || !lastObd || Date.now() - lastObd > OBD_STALE_MS) {
        Alert.alert(
          'OBD не підключено',
          "OBD не підключено — швидкості не буде, позиція DR і прив'язка не працюватимуть",
          [
            { text: 'Підключити OBD', onPress: () => connectBluetooth() },
            { text: 'Писати без OBD', style: 'cancel' },
          ]
        );
      }
    } else {
      setIsRecording(false);
      await disarmWaze();
      await telemetry.stopSession();
      if (SensorModule) SensorModule.stopRecordingService().catch(() => {});
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
      {obdLost && (
        <View style={{ backgroundColor: '#dc2626', borderRadius: 6, paddingVertical: 8, marginBottom: 8 }}>
          <Text style={{ color: 'white', fontWeight: 'bold', textAlign: 'center', letterSpacing: 1 }}>OBD ВТРАЧЕНО</Text>
        </View>
      )}
      {gnssSilent && (
        <View style={{ backgroundColor: '#ca8a04', borderRadius: 6, paddingVertical: 8, marginBottom: 8 }}>
          <Text style={{ color: 'white', fontWeight: 'bold', textAlign: 'center', letterSpacing: 1 }}>GNSS МОВЧИТЬ</Text>
        </View>
      )}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
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
            {!isGpsEnabled
              ? 'GPS вимкнено'
              : gnssView.hasFix
              ? `${gnssView.lat.toFixed(5)}\n${gnssView.lon.toFixed(5)}`
              : `GPS: немає (супутн. ${gnssView.satUsed ?? '?'}/${gnssView.satInView ?? '?'})`}
          </Text>
        </View>
      </View>

      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Еталонний GPS</Text>
        <Switch
          value={isGpsEnabled}
          onValueChange={toggleGps}
          trackColor={{ false: '#334155', true: '#0284c7' }}
          thumbColor={'#fff'}
          style={isRecording && isGpsEnabled ? { opacity: 0.45 } : undefined}
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

      <View style={{ marginTop: 24, marginBottom: 12 }}>
        <View style={[styles.toggleRow, { marginBottom: 8 }]}>
          <Text style={styles.toggleLabel}>Симуляція РЕБ</Text>
          <Switch
            value={rebSim}
            onValueChange={toggleRebSim}
            trackColor={{ false: '#334155', true: '#ca8a04' }}
            thumbColor={'#fff'}
          />
        </View>
        {rebSim && (
          <Text style={{ color: '#facc15', fontWeight: 'bold', fontSize: 12, textAlign: 'center', marginBottom: 12 }}>
            СИМУЛЯЦІЯ РЕБ: GPS лише для старту прив'язки
          </Text>
        )}
        {wazeBoard() && (
          <View style={{ backgroundColor: wazeBoard().bg, borderRadius: 8, paddingVertical: 14, paddingHorizontal: 10, marginBottom: 8 }}>
            <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 18, textAlign: 'center' }}>{wazeBoard().text}</Text>
          </View>
        )}
        <TouchableOpacity
          style={[
            styles.syncBtn,
            { flex: 0, width: '100%' },
            wazeArmed && { backgroundColor: '#0284c7' },
            !isRecording && !wazeArmed && { opacity: 0.45 },
          ]}
          onPress={toggleWaze}
        >
          <Text style={styles.syncBtnText}>{wazeArmed ? 'WAZE: ВИМКНУТИ' : 'WAZE'}</Text>
        </TouchableOpacity>
        <Text style={{ color: '#94a3b8', fontSize: 11, textAlign: 'center', marginTop: 6 }}>{wazeStatusText()}</Text>
      </View>

      <Text style={{ textAlign: 'center', color: '#64748b', fontSize: 11, marginTop: 5, marginBottom: 10 }}>
        Білд: {obdScanner.getVersion()} · {LAST_TASK} · ядро {CORE_VERSION}
      </Text>
      </ScrollView>

      {/* Кнопка запису закріплена внизу, поза зоною прокрутки */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={[styles.recordBtn, isRecording ? styles.recordBtnActive : styles.recordBtnInactive]}
          onPress={toggleRecording}
        >
          <Text style={styles.recordBtnText}>{isRecording ? 'ЗУПИНИТИ ЗАПИС' : 'ЗАПИС ЛОГУ'}</Text>
        </TouchableOpacity>
      </View>
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
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 12,
  },
  // Знизу — запас під системну панель навігації (edge-to-edge: застосунок малюється під нею)
  bottomBar: {
    paddingTop: 8,
    paddingBottom: Platform.OS === 'android' ? 48 : 20,
    backgroundColor: '#0a0f1c',
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