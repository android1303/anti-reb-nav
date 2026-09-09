import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Switch, Platform, StatusBar, PermissionsAndroid, Alert } from 'react-native';
import * as Location from 'expo-location';
import { Barometer } from 'expo-sensors';
import obdScanner from './obdScanner'; // Наш новий нативний міст
import telemetry from './telemetry';
import { db } from './firebaseConfig';
import { exportFirestoreToCSV } from './exportService';

export default function App() {
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [currentPressure, setCurrentPressure] = useState(0);
  const [location, setLocation] = useState(null);
  const [isGpsEnabled, setIsGpsEnabled] = useState(false);

  const [bufferCount, setBufferCount] = useState(0);
  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [syncError, setSyncError] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isBluetoothConnected, setIsBluetoothConnected] = useState(false);
  const [rawObd, setRawObd] = useState('Система готова до запуску'); 

  const latestData = useRef({ speed: 0, heading: 0, pressure: 0, lat: null, lon: null });

  useEffect(() => { latestData.current.speed = currentSpeed; }, [currentSpeed]);
  useEffect(() => { latestData.current.pressure = currentPressure; }, [currentPressure]);
  useEffect(() => {
    latestData.current.lat = location?.coords?.latitude || null;
    latestData.current.lon = location?.coords?.longitude || null;
  }, [location]);

  // Безпечна ініціалізація телеметрії
  useEffect(() => {
    let isMounted = true;
    const initApp = async () => {
      try {
        if (db) {
          await telemetry.init(db);
          telemetry.setOnBufferChange((count) => {
            if (isMounted) setBufferCount(count);
          });
          const count = telemetry.getBufferSize();
          if (isMounted) setBufferCount(count);
        }
      } catch (e) {
        console.error('Помилка ініціалізації:', e);
      }
    };
    initApp();
    return () => { isMounted = false; };
  }, []);

  // Таймер запису телеметрії
  useEffect(() => {
    let interval;
    if (isRecording) {
      interval = setInterval(async () => {
        try {
          await telemetry.recordPoint(latestData.current);
          setBufferCount(telemetry.getBufferSize());
        } catch (err) {
          console.error('Помилка запису:', err);
        }
      }, 1000); 
    }
    return () => { if (interval) clearInterval(interval); };
  }, [isRecording]); 

  // Барометр
  useEffect(() => {
    Barometer.setUpdateInterval(1000);
    let baroSubscription;
    const startBarometer = async () => {
      try {
        if (await Barometer.isAvailableAsync()) {
          baroSubscription = Barometer.addListener(data => {
            setCurrentPressure(data.pressure);
          });
        }
      } catch (e) {
        console.warn('Барометр недоступний:', e);
      }
    };
    startBarometer();
    return () => { if (baroSubscription) baroSubscription.remove(); };
  }, []);

  // GPS
  useEffect(() => {
    let locSubscription;
    (async () => {
      try {
        if (isGpsEnabled) {
          let { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            locSubscription = await Location.watchPositionAsync(
              { accuracy: Location.Accuracy.High, timeInterval: 1000 },
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
    return () => { if (locSubscription) locSubscription.remove(); };
  }, [isGpsEnabled]);

  // Bluetooth (НОВА ЛОГІКА ЧЕРЕЗ NATIVE MODULE)
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
      }

      setRawObd('Підключення через Native Module...');
      
      // Викликаємо наш новий міст
      const connected = await obdScanner.connectToELM();
      
      if (connected) {
        setIsBluetoothConnected(true);
        // Запускаємо читання і прокидаємо колбеки для оновлення UI
        obdScanner.startReadingSpeed(
          (speed) => setCurrentSpeed(speed),
          (status) => setRawObd(status)
        );
      } else {
        setIsBluetoothConnected(false);
        setRawObd('Помилка з\'єднання');
      }
    } catch (err) {
      setIsBluetoothConnected(false);
      setRawObd(`Помилка: ${err.message}`);
    }
  };

  const handleSync = async () => {
    try {
      setSyncError(false);
      await telemetry.syncNow();
      setBufferCount(telemetry.getBufferSize());
      const now = new Date();
      setLastSyncTime(`${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`);
    } catch (e) {
      setSyncError(true);
    }
  };

  const handleExport = async () => {
    setIsExporting(true);
    const result = await exportFirestoreToCSV(db);
    setIsExporting(false);
    if (!result.success) {
      Alert.alert("Помилка експорту", result.error);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>ANTI-REB NAV</Text>
        <View style={styles.statusIcons}>
          <TouchableOpacity onPress={connectBluetooth} style={[styles.badge, isBluetoothConnected ? styles.badgeActive : styles.badgeInactive]}>
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
          <Text style={styles.cardValue}>{currentSpeed}</Text>
          <Text style={styles.cardSub}>{isBluetoothConnected ? "Онлайн" : "Офлайн"}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>RAW (ДЕБАГ)</Text>
          <Text style={[styles.cardValueSmall, {color: '#facc15'}]} numberOfLines={3}>{rawObd}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>ТИСК (BARO)</Text>
          <Text style={styles.cardValue}>{currentPressure ? currentPressure.toFixed(1) : 0} <Text style={{fontSize: 16}}>hPa</Text></Text>
          <Text style={styles.cardSub}>Висотомір</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>GROUND TRUTH GPS</Text>
          <Text style={styles.cardValueSmall}>
            {location ? `${location.coords.latitude.toFixed(5)}\n${location.coords.longitude.toFixed(5)}` : 'Очікування GPS'}
          </Text>
        </View>
      </View>

      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Еталонний GPS</Text>
        <Switch value={isGpsEnabled} onValueChange={setIsGpsEnabled} trackColor={{ false: "#334155", true: "#0284c7" }} thumbColor={"#fff"} />
      </View>

      <View style={styles.bufferInfo}>
        <Text style={styles.bufferText}>Буфер: {bufferCount} | Синхр: {lastSyncTime || '--:--:--'}</Text>
      </View>

      <View style={styles.controlsRow}>
        <TouchableOpacity style={styles.syncBtn} onPress={handleSync}>
          <Text style={styles.syncBtnText}>{syncError ? 'ПОМИЛКА' : 'СИНХРОНІЗУВАТИ'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.syncBtn} onPress={handleExport} disabled={isExporting}>
          <Text style={styles.syncBtnText}>{isExporting ? 'ФОРМУВАННЯ...' : 'ЕКСПОРТ (CSV)'}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={[styles.recordBtn, isRecording ? styles.recordBtnActive : styles.recordBtnInactive]} onPress={() => setIsRecording(!isRecording)}>
        <Text style={styles.recordBtnText}>{isRecording ? "ЗУПИНИТИ ЗАПИС" : "ЗАПИС ЛОГУ"}</Text>
      </TouchableOpacity>

      {/* ВЕРСІЯ БІЛДА */}
      <Text style={{ textAlign: 'center', color: '#64748b', fontSize: 11, marginTop: 15, marginBottom: 10 }}>
        Білд: {obdScanner.getVersion()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0f1c', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight + 10 : 40, paddingHorizontal: 15 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  headerTitle: { color: '#38bdf8', fontSize: 20, fontWeight: '900', letterSpacing: 1 },
  statusIcons: { flexDirection: 'row', gap: 10 },
  badge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1 },
  badgeInactive: { borderColor: '#334155', backgroundColor: '#1e293b' },
  badgeActive: { borderColor: '#0ea5e9', backgroundColor: '#0284c7' },
  badgeText: { color: 'white', fontSize: 12, fontWeight: 'bold' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 10 },
  card: { backgroundColor: '#151c2c', width: '48%', padding: 15, borderRadius: 10, marginBottom: 15, borderWidth: 1, borderColor: '#222f47' },
  cardLabel: { color: '#94a3b8', fontSize: 11, fontWeight: 'bold', marginBottom: 5 },
  cardValue: { color: 'white', fontSize: 28, fontWeight: 'bold' },
  cardValueSmall: { color: '#38bdf8', fontSize: 13, fontWeight: 'bold', lineHeight: 18 },
  cardSub: { color: '#64748b', fontSize: 11, marginTop: 5 },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#151c2c', padding: 15, borderRadius: 10, marginBottom: 20, borderWidth: 1, borderColor: '#222f47' },
  toggleLabel: { color: 'white', fontSize: 14, fontWeight: 'bold' },
  bufferInfo: { backgroundColor: '#151c2c', padding: 12, borderRadius: 8, alignItems: 'center', marginBottom: 20 },
  bufferText: { color: '#38bdf8', fontWeight: 'bold' },
  controlsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 },
  syncBtn: { backgroundColor: '#1c2539', paddingVertical: 12, flex: 0.48, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: '#334155' },
  syncBtnText: { color: 'white', fontWeight: 'bold', textAlign: 'center', fontSize: 12 },
  recordBtn: { paddingVertical: 18, borderRadius: 10, alignItems: 'center' },
  recordBtnInactive: { backgroundColor: '#dc2626' },
  recordBtnActive: { backgroundColor: '#16a34a' },
  recordBtnText: { color: 'white', fontSize: 18, fontWeight: 'bold', letterSpacing: 1 },
});