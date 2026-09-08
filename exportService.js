import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';

/**
 * Експорт даних з Firebase у CSV та шеринг
 */
export async function exportFirestoreToCSV(db, collectionName = 'telemetry_logs') {
  try {
    if (!db) throw new Error('Firestore не ініціалізовано');

    // 1. Отримуємо всі записи з бази, відсортовані за часом
    const q = query(collection(db, collectionName), orderBy('timestamp', 'asc'));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      throw new Error('Немає даних для експорту');
    }

    // 2. Формуємо заголовки CSV
    let csvString = 'Timestamp,Date,Speed_OBD,Pressure_hPa,Latitude,Longitude\n';

    // 3. Заповнюємо рядки
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      const dateStr = data.createdAt || new Date(data.timestamp).toISOString();
      const speed = data.speed || 0;
      const pressure = data.pressure || 0;
      const lat = data.lat !== null ? data.lat : '';
      const lon = data.lon !== null ? data.lon : '';

      csvString += `${data.timestamp},${dateStr},${speed},${pressure},${lat},${lon}\n`;
    });

    // 4. Записуємо файл у локальний кеш
    const fileName = `jetta_telemetry_${Date.now()}.csv`;
    const fileUri = FileSystem.cacheDirectory + fileName;
    await FileSystem.writeAsStringAsync(fileUri, csvString, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    // 5. Викликаємо нативне вікно Share
    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(fileUri, {
        mimeType: 'text/csv',
        dialogTitle: 'Експорт телеметрії',
        UTI: 'public.comma-separated-values-text'
      });
      return { success: true };
    } else {
      throw new Error('Функція шерингу недоступна на цьому пристрої');
    }
  } catch (error) {
    console.error('[EXPORT ERROR]', error);
    return { success: false, error: error.message };
  }
}