
import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  StatusBar,
  Switch,
  Platform,
  PermissionsAndroid,
  Alert,
} from 'react-native';
import * as Location from 'expo-location';
import { Magnetometer, Barometer } from 'expo-sensors';
import RNBluetoothClassic from 'react-native-bluetooth-classic';

import { telemetry } from './telemetry';
import { db } from './firebaseConfig';

export default function App() {
  // Сенсорні показники
  const [speed, setSpeed] = useState(0); // км/год
  const [heading, setHeading] = useState(0); // градуси (0-360°)
  const [pressure, setPressure] = useState(1013.2); // hPa
  const [location, setLocation] = useState(null); // об'єкт координат

  // Стани керування та підключень
  const [elmStatus, setElmStatus] = useState('disconnected'); // 'disconnected' | 'connecting' | 'connected' | 'failed'
  const isElmConnected = elmStatus === 'connected';

  const [isGpsEnabled, setIsGpsEnabled] = useState(false);
  const [bufferCount, setBufferCount] = useState(0);
  const [lastLoggedTime, setLastLoggedTime] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Посилання для Bluetooth та опитування OBD
  const connectedDeviceRef = useRef(null);
  const pollTimerRef = useRef(null);
  const dataSubRef = useRef(null);

  useEffect(() => {
    // 1. Ініціалізація сервісу телеметрії з Firebase Firestore
    telemetry.init(db);

    // 2. Підписка на лічильник буфера
    telemetry.setOnBufferChange((count) => setBufferCount(count));

    // 3. Сенсор курсу (Magnetometer)
    Magnetometer.setUpdateInterval(100);
    const magSub = Magnetometer.addListener((data) => {
      let { x, y } = data;
      let angle = Math.atan2(y, x) * (180 / Math.PI);
      if (angle < 0) angle += 360;
      setHeading(Math.round(angle));
    });

    // 4. Барометр (за наявності датчика на пристрої)
    let baroSub = null;
    Barometer.isAvailableAsync().then((available) => {
      if (available) {
        Barometer.setUpdateInterval(500);
        baroSub = Barometer.addListener((data) => {
          if (data && data.pressure) {
            setPressure(Math.round(data.pressure * 10) / 10);
          }
        });
      }
    });

    return () => {
      magSub && magSub.remove();
      baroSub && baroSub.remove();
      disconnectELM();
      telemetry.stopAutoSync();
    };
  }, []);

  // Управління Ground Truth GPS через expo-location
  useEffect(() => {
    let locationWatcher = null;

    const manageGps = async () => {
      if (isGpsEnabled) {
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status !== 'granted') {
            console.warn('[GPS] Дозвіл на визначення геопозиції відхилено');
            setIsGpsEnabled(false);
            setLocation(null);
            return;
          }

          locationWatcher = await Location.watchPositionAsync(
            {
              accuracy: Location.Accuracy.High,
              timeInterval: 1000,
              distanceInterval: 1,
            },
            (newLoc) => {
              setLocation(newLoc);
            }
          );
        } catch (error) {
          console.warn('[GPS] Помилка запуску відстеження геолокації:', error);
          setIsGpsEnabled(false);
          setLocation(null);
        }
      } else {
        if (locationWatcher) {
          locationWatcher.remove();
          locationWatcher = null;
        }
        setLocation(null);
      }
    };

    manageGps();

    return () => {
      if (locationWatcher) {
        locationWatcher.remove();
        locationWatcher = null;
      }
    };
  }, [isGpsEnabled]);

  // Запит нативних дозволів Android для Bluetooth
  const requestBluetoothPermissions = async () => {
    if (Platform.OS !== 'android') return true;

    if (Platform.Version >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      return (
        granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED &&
        granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
        granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED
      );
    } else {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }
  };

  // Парсинг швидкості з OBD-II відповіді (PID 010D -> 41 0D XX)
  const parseObdSpeed = (rawData) => {
    if (!rawData) return;
    const clean = rawData.replace(/\s+/g, '').toUpperCase();
    const match = clean.match(/410D([0-9A-F]{2})/);
    if (match && match[1]) {
      const speedKmH = parseInt(match[1], 16);
      if (!isNaN(speedKmH)) {
        setSpeed(speedKmH);
      }
    }
  };

  // Підключення до ELM327
  const connectELM = async () => {
    setElmStatus('connecting');
    try {
      const hasPermission = await requestBluetoothPermissions();
      if (!hasPermission) {
        Alert.alert('Помилка', 'Не надано дозволів на використання Bluetooth.');
        setElmStatus('failed');
        return;
      }

      const enabled = await RNBluetoothClassic.isBluetoothEnabled();
      if (!enabled) {
        const requested = await RNBluetoothClassic.requestBluetoothEnabled();
        if (!requested) {
          setElmStatus('failed');
          return;
        }
      }

      const bondedDevices = await RNBluetoothClassic.getBondedDevices();
      if (!bondedDevices || bondedDevices.length === 0) {
        Alert.alert('Пристрій не знайдено', 'Немає спарених Bluetooth-пристроїв. Спаріть ELM327 у налаштуваннях Android.');
        setElmStatus('failed');
        return;
      }

      // Пошук пристрою за ключовими назвами або вибір першого доступного
      const targetDevice =
        bondedDevices.find((d) => {
          const name = (d.name || '').toUpperCase();
          return (
            name.includes('OBD') ||
            name.includes('ELM') ||
            name.includes('V-LINK') ||
            name.includes('SCAN')
          );
        }) || bondedDevices[0];

      const connected = await targetDevice.connect({
        connectorType: 'rfcomm',
        delimiter: '\r',
      });

      if (connected) {
        connectedDeviceRef.current = targetDevice;
        setElmStatus('connected');

        // Базова ініціалізація ELM327: скидання та відключення луни
        await targetDevice.write('ATZ\r');
        await new Promise((r) => setTimeout(r, 500));
        await targetDevice.write('ATE0\r');
        await new Promise((r) => setTimeout(r, 200));

        // Слухач вхідного сокета
        dataSubRef.current = targetDevice.onDataReceived((data) => {
          if (data && data.data) {
            parseObdSpeed(data.data);
          }
        });

        // Періодичне опитування швидкості за PID 010D кожні 500 мс
        pollTimerRef.current = setInterval(async () => {
          try {
            if (connectedDeviceRef.current) {
              await connectedDeviceRef.current.write('010D\r');
            }
          } catch (writeErr) {
            console.warn('[OBD_POLL_ERROR]', writeErr);
          }
        }, 500);
      } else {
        setElmStatus('failed');
      }
    } catch (err) {
      console.error('[BLUETOOTH_CONNECT_ERROR]', err);
      setElmStatus('failed');
      Alert.alert('Помилка підключення', err.message || 'Не вдалося підключитися до ELM327');
    }
  };

  // Відключення ELM327
  const disconnectELM = async () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (dataSubRef.current) {
      dataSubRef.current.remove();
      dataSubRef.current = null;
    }
    if (connectedDeviceRef.current) {
      try {
        await connectedDeviceRef.current.disconnect();
      } catch (e) {
        console.warn('[BLUETOOTH_DISCONNECT]', e);
      }
      connectedDeviceRef.current = null;
    }
    setElmStatus('disconnected');
    setSpeed(0);
  };

  const handleToggleELM = () => {
    if (isElmConnected || elmStatus === 'connecting') {
      disconnectELM();
    } else {
      connectELM();
    }
  };

  // Запис одного пакету телеметрії
  const handleRecordLog = async () => {
    const timestamp = Date.now();
    const lat = isGpsEnabled && location?.coords ? location.coords.latitude : null;
    const lon = isGpsEnabled && location?.coords ? location.coords.longitude : null;

    await telemetry.recordPoint({
      speed,
      gyroZ: heading,
      pressure,
      lat,
      lon,
      timestamp,
    });
    setLastLoggedTime(new Date(timestamp).toLocaleTimeString());
  };

  // Примусова відправка буфера у Firestore
  const handleForceSync = async () => {
    setIsSyncing(true);
    await telemetry.syncNow();
    setIsSyncing(false);
  };

  // Текст кнопки ELM залежно від стану
  const getElmButtonText = () => {
    switch (elmStatus) {
      case 'connecting':
        return 'ПІДКЛЮЧЕННЯ...';
      case 'connected':
        return 'ВІДКЛЮЧИТИ ELM327';
      case 'failed':
        return 'ПОМИЛКА (ПОВТОРИТИ)';
      default:
        return 'ПІДКЛЮЧИТИ ELM327';
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0B0F19" />

      {/* Компактний заголовок */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>ANTI-REB NAV</Text>
        <View style={styles.headerBadges}>
          <View style={[styles.badge, isElmConnected ? styles.badgeGreen : styles.badgeGray]}>
            <Text style={styles.badgeText}>OBD</Text>
          </View>
          <View style={[styles.badge, isGpsEnabled ? styles.badgeBlue : styles.badgeGray]}>
            <Text style={styles.badgeText}>GPS</Text>
          </View>
        </View>
      </View>

      {/* Сенсорна панель (2x2) */}
      <View style={styles.grid}>
        <View style={[styles.card, styles.cardSpeed]}>
          <Text style={styles.cardLabel}>ШВИДКІСТЬ (OBD-II)</Text>
          <View style={styles.cardRow}>
            <Text style={styles.valSpeed}>{speed}</Text>
            <Text style={styles.valUnit}>км/год</Text>
          </View>
          <Text style={styles.subText}>
            {isElmConnected
              ? 'ELM327 підключено'
              : elmStatus === 'connecting'
              ? 'Встановлення зв’язку...'
              : 'OBD офлайн'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>КУРС (HEADING / Z)</Text>
          <View style={styles.cardRow}>
            <Text style={styles.valSensor}>{heading}°</Text>
          </View>
          <Text style={styles.subText}>Магнітометр / Гіро</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>ТИСК (BARO)</Text>
          <View style={styles.cardRow}>
            <Text style={styles.valSensor}>{pressure}</Text>
            <Text style={styles.valUnit}>hPa</Text>
          </View>
          <Text style={styles.subText}>Висотомір</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>GROUND TRUTH GPS</Text>
          {isGpsEnabled && location?.coords ? (
            <View>
              <Text style={styles.gpsCoordsText}>{location.coords.latitude.toFixed(5)}</Text>
              <Text style={styles.gpsCoordsText}>{location.coords.longitude.toFixed(5)}</Text>
            </View>
          ) : (
            <Text style={styles.gpsNullText}>РЕБ / NULL</Text>
          )}
          <Text style={styles.subText}>Еталонна траєкторія</Text>
        </View>
      </View>

      {/* Перемикач еталонного GPS */}
      <View style={styles.gpsRow}>
        <Text style={styles.gpsLabel}>Еталонний GPS (Ground Truth)</Text>
        <Switch
          value={isGpsEnabled}
          onValueChange={setIsGpsEnabled}
          trackColor={{ false: '#334155', true: '#0284C7' }}
          thumbColor={isGpsEnabled ? '#38BDF8' : '#94A3B8'}
        />
      </View>

      {/* Індикатор буфера */}
      <View style={styles.bufferBar}>
        <Text style={styles.bufferText}>
          Буфер: <Text style={styles.bufferHighlight}>{bufferCount}</Text> | Останній:{' '}
          <Text style={styles.bufferHighlight}>{lastLoggedTime || '—'}</Text>
        </Text>
      </View>

      {/* Кнопки дій */}
      <View style={styles.actionBlock}>
        <View style={styles.topButtonsRow}>
          <TouchableOpacity
            style={[styles.btnSecondary, isElmConnected && styles.btnSecondaryActive]}
            onPress={handleToggleELM}
          >
            <Text style={styles.btnSecondaryText}>{getElmButtonText()}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.btnSecondary}
            onPress={handleForceSync}
            disabled={isSyncing || bufferCount === 0}
          >
            <Text style={styles.btnSecondaryText}>
              {isSyncing ? 'СИНХРОНІЗАЦІЯ...' : 'СИНХРОНІЗУВАТИ'}
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          activeOpacity={0.8}
          style={styles.btnRecord}
          onPress={handleRecordLog}
        >
          <Text style={styles.btnRecordText}>ЗАПИС ЛОГУ</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0F19',
    paddingHorizontal: 12,
    paddingVertical: 8,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
    justifyContent: 'space-between',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#38BDF8',
    letterSpacing: 1.5,
  },
  headerBadges: {
    flexDirection: 'row',
    gap: 6,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeGreen: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
  },
  badgeBlue: {
    backgroundColor: '#0C4A6E',
    borderColor: '#0284C7',
  },
  badgeGray: {
    backgroundColor: '#1E293B',
    borderColor: '#475569',
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#F1F5F9',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
  },
  card: {
    width: '48.5%',
    backgroundColor: '#161F30',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#24324D',
  },
  cardSpeed: {
    backgroundColor: '#101B33',
    borderColor: '#2563EB',
  },
  cardLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 0.5,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 2,
  },
  valSpeed: {
    fontSize: 32,
    fontWeight: '900',
    color: '#F8FAFC',
    lineHeight: 36,
  },
  valSensor: {
    fontSize: 22,
    fontWeight: '800',
    color: '#F1F5F9',
    lineHeight: 26,
  },
  valUnit: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
    marginLeft: 4,
  },
  subText: {
    fontSize: 9,
    color: '#64748B',
    marginTop: 2,
  },
  gpsCoordsText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#38BDF8',
    lineHeight: 14,
  },
  gpsNullText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#F43F5E',
    marginTop: 2,
  },
  gpsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#111827',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  gpsLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#E2E8F0',
  },
  bufferBar: {
    backgroundColor: '#161F30',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  bufferText: {
    fontSize: 11,
    color: '#94A3B8',
  },
  bufferHighlight: {
    color: '#38BDF8',
    fontWeight: '700',
  },
  actionBlock: {
    gap: 6,
  },
  topButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  btnSecondary: {
    flex: 1,
    height: 40,
    backgroundColor: '#1E293B',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  btnSecondaryActive: {
    borderColor: '#10B981',
    backgroundColor: '#064E3B',
  },
  btnSecondaryText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '700',
  },
  btnRecord: {
    height: 50,
    backgroundColor: '#DC2626',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnRecordText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 1,
  },
});