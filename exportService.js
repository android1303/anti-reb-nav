import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { collection, getDocs, query, orderBy, where } from 'firebase/firestore';
import { CSV_COLUMNS } from './telemetry';

/* =====================================================================
 * Експорт з Firebase у CSV (v14)
 *
 * Нова структура: колекція `telemetry_chunks`, один документ = порція
 * ~100 точок { sessionId, startTs, endTs, count, points: [...] }.
 * Колонки CSV ті самі, що й у локальному експорті (telemetry.CSV_COLUMNS),
 * тому файли з хмари та з телефону можна аналізувати одним скриптом.
 *
 * Стара колекція `telemetry_logs` (1 документ = 1 точка) експортується
 * окремою функцією exportLegacyLogsToCSV у старому форматі — її поля
 * мають інший зміст (gyroZ там уже очищений, у рад/с), тож змішувати
 * їх з новими даними не можна.
 * ===================================================================== */

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function writeAndShare(csvString, fileName) {
  const fileUri = FileSystem.cacheDirectory + fileName;
  await FileSystem.writeAsStringAsync(fileUri, csvString, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Функція шерингу недоступна на цьому пристрої');
  }
  await Sharing.shareAsync(fileUri, {
    mimeType: 'text/csv',
    dialogTitle: 'Експорт телеметрії',
    UTI: 'public.comma-separated-values-text',
  });
  return fileUri;
}

/**
 * Експорт порцій з Firestore у CSV.
 * @param db Firestore
 * @param {{ sessionId?: string|null, collectionName?: string }} options
 */
export async function exportFirestoreToCSV(db, options = {}) {
  const { sessionId = null, collectionName = 'telemetry_chunks' } = options;
  try {
    if (!db) throw new Error('Firestore не ініціалізовано');

    const colRef = collection(db, collectionName);
    // Фільтр по сесії без orderBy — не потребує складеного індексу;
    // сортування все одно робимо локально.
    const q = sessionId
      ? query(colRef, where('sessionId', '==', sessionId))
      : query(colRef, orderBy('startTs', 'asc'));

    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error('Немає даних для експорту');

    const chunks = [];
    snapshot.forEach((d) => {
      const data = d.data();
      if (Array.isArray(data.points) && data.points.length) chunks.push(data);
    });
    chunks.sort((a, b) => (a.startTs || 0) - (b.startTs || 0));

    const lines = [CSV_COLUMNS.join(',')];
    let lastTs = -Infinity;
    for (const chunk of chunks) {
      for (const p of chunk.points) {
        // Захист від дублікатів, якщо порцію колись відправили двічі
        if (typeof p.timestamp === 'number' && p.timestamp <= lastTs) continue;
        lastTs = p.timestamp;
        lines.push(CSV_COLUMNS.map((c) => csvCell(p[c])).join(','));
      }
    }

    if (lines.length === 1) throw new Error('Порції не містять точок');

    const fileName = `anti_reb_cloud_${sessionId || 'all'}_${Date.now()}.csv`;
    const uri = await writeAndShare(lines.join('\n'), fileName);
    return { success: true, uri, rows: lines.length - 1 };
  } catch (error) {
    console.error('[EXPORT ERROR]', error);
    return { success: false, error: error.message };
  }
}

/** Старі дані з `telemetry_logs` у старому форматі (для архіву заїздів до v14) */
export async function exportLegacyLogsToCSV(db, collectionName = 'telemetry_logs') {
  try {
    if (!db) throw new Error('Firestore не ініціалізовано');

    const q = query(collection(db, collectionName), orderBy('timestamp', 'asc'));
    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error('Немає даних для експорту');

    const lines = [
      'Timestamp,Date,Speed_OBD,Pressure_hPa,Latitude,Longitude,Gyro_X,Gyro_Y,Gyro_Z_clean,Accel_X,Accel_Y,Accel_Z,Heading,PosX,PosY',
    ];
    snapshot.forEach((d) => {
      const x = d.data();
      lines.push(
        [
          x.timestamp,
          x.createdAt || (x.timestamp ? new Date(x.timestamp).toISOString() : ''),
          x.speed ?? 0,
          x.pressure ?? 0,
          x.lat,
          x.lon,
          x.gyroX ?? 0,
          x.gyroY ?? 0,
          x.gyroZ ?? 0,
          x.accelX ?? 0,
          x.accelY ?? 0,
          x.accelZ ?? 0,
          x.heading,
          x.posX,
          x.posY,
        ].map(csvCell).join(',')
      );
    });

    const uri = await writeAndShare(lines.join('\n'), `jetta_telemetry_legacy_${Date.now()}.csv`);
    return { success: true, uri, rows: lines.length - 1 };
  } catch (error) {
    console.error('[EXPORT ERROR]', error);
    return { success: false, error: error.message };
  }
}
