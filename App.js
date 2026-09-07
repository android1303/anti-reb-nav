import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Switch, Platform, StatusBar } from 'react-native';
import * as Location from 'expo-location';
import { Magnetometer, Barometer } from 'expo-sensors';
import RNBluetoothClassic from 'react-native-bluetooth-classic';
import * as telemetry from './telemetry';
import { db } from './firebaseConfig';

export default function App() {
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [currentHeading, setCurrentHeading] = useState(0);
  const [currentPressure, setCurrentPressure] = useState(0);
  const [location, setLocation] = useState(null);
  const [isGpsEnabled, setIsGpsEnabled] = useState(false);
  
  const [bufferCount, setBufferCount] = useState(0);
  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [syncError, setSyncError] = useState(false);
  
  const [isRecording, setIsRecording] = useState(false);
  
  const [isBluetoothConnected, setIsBluetoothConnected] = useState(false);
  const [device, setDevice] = useState(null);

  useEffect(() => {
    telemetry.init(db);
    updateBufferCount();
  }, []);

  const updateBufferCount = async () => {
    const count = await telemetry.getBufferCount();
    setBufferCount(count);
  };

  useEffect(() => {
    let interval;
    if (isRecording) {
      interval = setInterval(async () => {
        await telemetry.recordPoint({
          speed: currentSpeed,
          heading: currentHeading,
          pressure: currentPressure,
          lat: location?.coords?.latitude || null,
          lon: location?.coords?.longitude || null,
        });
        updateBufferCount();
      }, 1000); 
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecording, currentSpeed, currentHeading, currentPressure, location]);

  useEffect(() => {
    Magnetometer.setUpdateInterval(1000);
    const magSubscription = Magnetometer.addListener(data => {
      let heading = Math.atan2(data.y, data.x) * (180 / Math.PI);
      if (heading < 0) heading += 360;
      setCurrentHeading(Math.round(heading));
    });

    Barometer.setUpdateInterval(1000);
    const baroSubscription = Barometer.addListener(data => {
      setCurrentPressure(data.pressure);
    });

    return () => {
      magSubscription.remove();
      baroSubscription.remove();
    };
  }, []);

  useEffect(() => {
    let locSubscription;
    (async () => {
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
    })();
    return () => {
      if (locSubscription) locSubscription.remove();
    };
  }, [isGpsEnabled]);

  // --- ОНОВЛЕНА ЛОГІКА ELM327 ---
  const connectBluetooth = async () => {
    try {
      const bonded = await RNBluetoothClassic.getBondedDevices();
      const obdDevice = bonded.find(d => d.name.includes('OBD') || d.name.includes('ELM'));
      if (obdDevice) {
        const connected = await obdDevice.connect();
        if (connected) {
          setDevice(obdDevice);
          setIsBluetoothConnected(true);
          
          // Ініціалізація ELM327
          await obdDevice.write('ATZ\r'); // Скидання
          await new Promise(r => setTimeout(r, 1000));
          await obdDevice.read(); // Очищення буфера
          
          await obdDevice.write('ATE0\r'); // Вимкнути луну (Echo off)
          await new Promise(r => setTimeout(r, 500));
          await obdDevice.read();
          
          await obdDevice.write('ATSP0\r'); // Авто-пошук протоколу
          await new Promise(r => setTimeout(r, 500));
          await obdDevice.read();

          startObdPolling(obdDevice);
        }
      }
    } catch (err) {
      console.log('BT Connection Error', err);
      setIsBluetoothConnected(false);
    }
  };

  const startObdPolling = (obdDevice) => {
    setInterval(async () => {
      try {
        await obdDevice.write('010D\r');
        const response = await obdDevice.read();
        
        if (response) {
          // Видаляємо всі пробіли, переноси рядків та символ '>'
          const cleanRes = response.replace(/[\r\n\s>]/g, '');
          
          // Шукаємо маркер відповіді швидкості (410D) і наступні 2 символи (HEX швидкості)
          const match = cleanRes.match(/410D([0-9A-F]{2})/i);
          
          if (match && match[1]) {
             const speed = parseInt(match[1], 16);
             if (!isNaN(speed)) {
               setCurrentSpeed(speed);
             }
          }
        }
      } catch (e) {
        console.log('OBD Read Error');
      }
    }, 1000); // Опитування раз на секунду
  };
  // ---------------------------------

  const handleSync = async () => {
    try {
      setSyncError(false);
      await telemetry.syncNow();
      updateBufferCount();
      const now = new Date();
      setLastSyncTime(`${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`);
    } catch (e) {
      setSyncError(true);
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
          <Text style={styles.cardLabel}>ШВИДКІСТЬ (OBD-II)</Text>
          <Text style={styles.cardValue}>{currentSpeed}</Text>
          <Text style={styles.cardSub}>{isBluetoothConnected ? "Онлайн" : "OBD офлайн"}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>КУРС (HEADING / Z)</Text>
          <Text style={styles.cardValue}>{currentHeading}°</Text>
          <Text style={styles.cardSub}>Магнітометр / Гіро</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>ТИСК (BARO)</Text>
          <Text style={styles.cardValue}>{currentPressure ? currentPressure.toFixed(1) : 0} <Text style={{fontSize: 16}}>hPa</Text></Text>
          <Text style={styles.cardSub}>Висотомір</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>GROUND TRUTH GPS</Text>
          <Text style={styles.cardValueSmall}>
            {location ? `${location.coords.latitude.toFixed(5)}\n${location.coords.longitude.toFixed(5)}` : 'Еталонна траєкторія'}
          </Text>
        </View>
      </View>

      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Еталонний GPS (Ground Truth)</Text>
        <Switch 
          value={isGpsEnabled} 
          onValueChange={setIsGpsEnabled}
          trackColor={{ false: "#334155", true: "#0284c7" }}
          thumbColor={"#fff"}
        />
      </View>

      <View style={styles.bufferInfo}>
        <Text style={styles.bufferText}>Буфер: {bufferCount} | Останній: {lastSyncTime || '--:--:--'}</Text>
      </View>

      <View style={styles.controlsRow}>
        <TouchableOpacity style={styles.syncBtn} onPress={handleSync}>
          <Text style={styles.syncBtnText}>{syncError ? 'ПОМИЛКА\n(ПОВТОРИТИ)' : 'ПОМИЛКА\n(ПОВТОРИТИ)'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.syncBtn} onPress={handleSync}>
          <Text style={styles.syncBtnText}>СИНХРОНІЗУВАТИ</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity 
        style={[styles.recordBtn, isRecording ? styles.recordBtnActive : styles.recordBtnInactive]} 
        onPress={() => setIsRecording(!isRecording)}
      >
        <Text style={styles.recordBtnText}>
          {isRecording ? "ЗУПИНИТИ ЗАПИС" : "ЗАПИС ЛОГУ"}
        </Text>
      </TouchableOpacity>
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
  cardValueSmall: { color: '#38bdf8', fontSize: 16, fontWeight: 'bold', lineHeight: 22 },
  cardSub: { color: '#64748b', fontSize: 11, marginTop: 5 },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#151c2c', padding: 15, borderRadius: 10, marginBottom: 20, borderWidth: 1, borderColor: '#222f47' },
  toggleLabel: { color: 'white', fontSize: 14, fontWeight: 'bold' },
  bufferInfo: { backgroundColor: '#151c2c', padding: 12, borderRadius: 8, alignItems: 'center', marginBottom: 20 },
  bufferText: { color: '#38bdf8', fontWeight: 'bold' },
  controlsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 },
  syncBtn: { backgroundColor: '#1c2539', paddingVertical: 12, flex: 0.48, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: '#334155' },
  syncBtnText: { color: 'white', fontWeight: 'bold', textAlign: 'center', fontSize: 13 },
  recordBtn: { paddingVertical: 18, borderRadius: 10, alignItems: 'center' },
  recordBtnInactive: { backgroundColor: '#dc2626' },
  recordBtnActive: { backgroundColor: '#16a34a' },
  recordBtnText: { color: 'white', fontSize: 18, fontWeight: 'bold', letterSpacing: 1 },
});