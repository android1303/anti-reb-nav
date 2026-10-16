# Anti-Reb Nav — Формат CSV (розд. 8 Master Plan)

## 8. Формат CSV (колонки `CSV_COLUMNS`)

| Група | Колонки |
|---|---|
| Час і стан | `timestamp`, `createdAt`, `sessionId`, `currentState`, `dt`, `gapS` |
| Швидкість | `speedRaw`, `speedUsed`, `speedExtrapolated`, `obdAgeMs`, `obdFresh` |
| Сирий гіроскоп (рад/с) | `gyroXRaw`, `gyroYRaw`, `gyroZRaw` |
| Прискорення і гравітація (м/с²) | `accelX`, `accelY`, `accelZ`, `gravX`, `gravY`, `gravZ`, `gravityValid` |
| Рискання (°/с) | `yawRateRaw`, `yawRateValid`, `gyroBias`, `yawRateClean`, `zuptStd`, `zuptApplied` |
| Фільтр і вісь руху | `filteredAccelX/Y/Z`, `forwardAxis`, `forwardSign`, `isAxesCalibrated`, `isReversing` |
| Навігація | `heading`, `posX`, `posY` (метри від старту) |
| Висота | `pressure`, `altitude` |
| Еталон: GPS-приймач (TASK-012) | `lat`, `lon`, `gpsAccuracy` (м) — лише `GPS_PROVIDER`, тримаються між фіксами; `gpsFixAgeMs` (мс від прийому останнього фіксу до тіку, `null` — фіксу ще не було); `gpsMock` (`true` — фікс від mock-провайдера) |
| Мережева позиція (TASK-012) | `netLat`, `netLon`, `netAccuracy` (м), `netFixAgeMs` (мс); порожні, якщо `NETWORK_PROVIDER` недоступний або фіксів не було |
| Стан GNSS (TASK-012) | `gnssSatInView` (видимі супутники), `gnssSatUsed` (у рішенні), `gnssCn0MeanUsed` (середнє C/N0 по використаних, дБ-Гц; порожньо, якщо 0 використано), `gnssCn0MaxAll` (максимум C/N0 по всіх видимих), `gnssConstellations` (використані сузір'я, напр. `GPS+GAL+GLO`). Порожні, якщо `gnssStatus` не надходив понад 5 с або GPS вимкнено |
| Fused-позиція Google (TASK-013) | `fusedLat`, `fusedLon`, `fusedAccuracy` (м), `fusedFixAgeMs` (мс від прийому події до тіку). Окремо від GPS-приймача й мережі; порожні, якщо fused недоступний або фіксів не було. Лише для діагностики джерела позиції |
| Нативні датчики (TASK-016) | `nGyroX/Y/Z` (рад/с), `nAccX/Y/Z` (м/с², лінійне), `nGravX/Y/Z` (= −`TYPE_GRAVITY`), `nGyroAgeMs`, `nAccAgeMs`, `nGravAgeMs` (мс від події датчика до такту), `sensorSource` (`native`/`expo` — звідки ядро взяло входи), `appState` (`AppState.currentState` на момент тіку: `active`/`background`/`inactive`). Порожні, якщо нативні датчики недоступні |
| Некалібрований гіроскоп (TASK-017) | `uGyroX/Y/Z` (рад/с, `TYPE_GYROSCOPE_UNCALIBRATED`, як є), `uBiasX/Y/Z` (рад/с, оцінка зсуву від Android), `uGyroAgeMs`. Лише для відтворення обробки зсуву без системної калібровки; ядро не використовує |
| Прив'язка / mock (TASK-018) | `mockActive` (чи подається позиція у Waze), `mockLat`, `mockLon`, `mockAccuracy` (м), `mockBearing` (°) — позиція `geoAnchor` (порожні в стані `waiting`; пишуться й коли подача вимкнена), `anchorAgeS` (с від прив'язки), `headingOffsetDeg` (θ, °, готовий після ≥ 150 м шляху і ≥ 10 хороших фіксів), `anchorState` (`waiting`/`gps`/`dr_only`). Лише лог |
| Джерело прив'язки (TASK-021) | `anchorSource` (`gps`/`network`/`dr_only`/`waiting` — джерело, що реально використано для `mock*`), `netFitN` (фіксів у мережевій підгонці після відкидання викидів), `netFitResidM` (медіана залишків підгонки, м). `anchorState` лишається станом GPS-прив'язки. Лише лог |
| Симуляція РЕБ (TASK-023) | `rebSim` (`true`/`false`): увімкнено «Симуляцію РЕБ» — `geoAnchor` не отримує GPS-фіксів, а `lat`/`lon`/`gpsAccuracy` лишаються справжнім еталоном. Лише лог |
| Лічильник мережевих фіксів (TASK-028) | `netFixSeq`: кількість подій `gnssNetFix` з початку запису (+1 на кожну, скидається на старті запису) — щоб відтворення відрізняло новий фікс від повтору тієї самої позиції. Лише лог |
| Тест Waze (TASK-029) | `mockTestOffsetM`: 300 під час тесту зі зсувом поданої позиції на північ (`mockLat`/`mockLon` — вже зі зсувом), 0 поза ним. Лише лог |
| Режим симуляції РЕБ (TASK-026) | `rebSimMode`: `gps_start` на кожному рядку v26 — у симуляції РЕБ GPS потрібен лише для старту прив'язки (у v25 колонки не було, GPS у симуляції не подавався взагалі). Лише лог |
| Точність у Waze (TASK-033) | `mockPushedAccuracy` (м): точність, фактично подана в останньому push (чесна оцінка = `mockAccuracy`, або 10, або 5 у тесті зсуву); порожньо, коли підміни немає. Лише лог |
| NMEA-еталон (TASK-033) | `nmeaLat`, `nmeaLon` (останній валідний `$GxRMC`, статус A; тримаються між фіксами), `nmeaFixAgeMs` (мс від прийому до тіку), `nmeaQuality` (якість фіксу з `$GxGGA`: 0 немає, 1 GPS, 2 DGPS…), `nmeaSats` (супутників у рішенні за GGA), `nmeaHdop`. Гіпотеза: не підміняється тестовим провайдером; у `geoAnchor` і ядро не потрапляє. Порожні, якщо NMEA не надходить. Лише лог |
| Режим підміни (TASK-019) | `mockMode`: `fused` (підміняється лише fused) / `fusedGps` (fused + GPS_PROVIDER) / порожньо, коли подача вимкнена. Лише лог |

Примітка: `accelX/Y/Z` у стані `STOPPED` примусово обнуляються. Колонки TASK-012, TASK-013, TASK-016, TASK-017, TASK-018, TASK-019, TASK-021, TASK-023, TASK-026, TASK-028, TASK-029 і TASK-033 додано в кінець; колонки `gyroXRaw`…, `accelX`…, `gravX`… з v20 — це expo-sensors (порожні у фоні), а не вхід ядра, якщо `sensorSource=native`; CSV версій до v18 (до v19 для `fused*`) їх не мають (`replay.mjs` відтворює такі файли без змін). Жодне з полів GNSS не впливає на `heading`, `posX`, `posY`, стан чи bias.

