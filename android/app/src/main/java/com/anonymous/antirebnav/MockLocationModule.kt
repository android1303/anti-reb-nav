package com.anonymous.antirebnav

import android.app.AppOpsManager
import android.content.Context
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices

/**
 * Подача DR-позиції як системної геолокації (mock location provider) — для Waze/Google Maps (TASK-018).
 *
 * Потрібно обрати застосунок у «Параметри розробника → Застосунок для фіктивних місцезнаходжень».
 * Два режими (TASK-019): "fused" — підміняється лише fused (GPS_PROVIDER лишається справжнім і видимим
 * для застосунку); "fusedGps" — fused і GPS_PROVIDER (TASK-018). Навігатори часто читають fused.
 * NETWORK_PROVIDER не чіпаємо — мережеві колонки лишаються справжніми.
 */
class MockLocationModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val TAG = "MockLocationModule"
    private val MOCK_NETWORK = false // константа з TASK-018: мережу НЕ підміняти
    private val GPS = LocationManager.GPS_PROVIDER
    private val FUSED = "fused"

    private var locationManager: LocationManager? = null
    private var fusedClient: FusedLocationProviderClient? = null
    private var active = false
    private var fusedMockOn = false
    private var gpsMockOn = false

    override fun getName(): String {
        return "MockLocationModule"
    }

    private fun addGpsTestProvider(lm: LocationManager) {
        try {
            lm.removeTestProvider(GPS)
        } catch (e: Exception) {
            // провайдера не було — нормально
        }
        lm.addTestProvider(
            GPS,
            false, // requiresNetwork
            true, // requiresSatellite
            false, // requiresCell
            false, // hasMonetaryCost
            true, // supportsAltitude
            true, // supportsSpeed
            true, // supportsBearing
            Criteria.POWER_LOW,
            Criteria.ACCURACY_FINE
        )
        lm.setTestProviderEnabled(GPS, true)
    }

    /**
     * Чи обрано застосунок у «Параметри розробника → Застосунок для фіктивних місцезнаходжень»
     * (AppOps MOCK_LOCATION), без вмикання підміни. Resolve: true/false.
     */
    @ReactMethod
    fun canMock(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            @Suppress("DEPRECATION")
            val mode = appOps.checkOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, Process.myUid(), ctx.packageName)
            promise.resolve(mode == AppOpsManager.MODE_ALLOWED)
        } catch (e: Exception) {
            Log.w(TAG, "canMock не вдалося визначити: ", e)
            promise.reject("CAN_MOCK_ERROR", e.message)
        }
    }

    private fun notMockAppMessage(): String {
        return "Оберіть Anti-REB Nav як застосунок для фіктивних місцезнаходжень у Параметрах розробника"
    }

    /**
     * mode: "fused" (лише fused; GPS_PROVIDER не чіпаємо) або "fusedGps" (fused + GPS_PROVIDER).
     * Resolve: { gps, fused, mode }. Reject з кодом NOT_MOCK_APP, якщо застосунок не обрано
     * для фіктивних місцезнаходжень.
     */
    @ReactMethod
    fun start(mode: String, promise: Promise) {
        val withGps = mode == "fusedGps"
        try {
            val ctx = reactApplicationContext
            val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            locationManager = lm
            if (withGps) {
                addGpsTestProvider(lm)
                gpsMockOn = true
            }

            val client = LocationServices.getFusedLocationProviderClient(ctx)
            fusedClient = client
            client.setMockMode(true)
                .addOnSuccessListener {
                    fusedMockOn = true
                    active = true
                    promise.resolve(Arguments.createMap().apply {
                        putBoolean("gps", gpsMockOn)
                        putBoolean("fused", true)
                        putString("mode", if (withGps) "fusedGps" else "fused")
                    })
                }
                .addOnFailureListener { e ->
                    Log.e(TAG, "fused setMockMode(true) не вдалося: ", e)
                    val notMockApp = e is SecurityException ||
                        (e.message ?: "").contains("mock", ignoreCase = true)
                    stopInternal()
                    if (notMockApp) {
                        promise.reject("NOT_MOCK_APP", notMockAppMessage())
                    } else {
                        promise.reject("MOCK_START_ERROR", e.message)
                    }
                }
        } catch (e: SecurityException) {
            Log.e(TAG, "Застосунок не обрано для фіктивних місцезнаходжень: ", e)
            stopInternal()
            promise.reject("NOT_MOCK_APP", notMockAppMessage())
        } catch (e: Exception) {
            Log.e(TAG, "Помилка запуску mock: ", e)
            stopInternal()
            promise.reject("MOCK_START_ERROR", e.message)
        }
    }

    private fun buildLocation(
        provider: String,
        lat: Double,
        lon: Double,
        accuracy: Double,
        speedMps: Double,
        bearingDeg: Double,
        altitude: Double,
        hasAltitude: Boolean
    ): Location {
        val loc = Location(provider)
        loc.latitude = lat
        loc.longitude = lon
        loc.accuracy = accuracy.toFloat()
        loc.speed = speedMps.toFloat()
        loc.bearing = bearingDeg.toFloat()
        if (hasAltitude) loc.altitude = altitude
        // Без elapsedRealtimeNanos Android відкидає фіктивну позицію
        loc.time = System.currentTimeMillis()
        loc.elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
        if (Build.VERSION.SDK_INT >= 26) {
            loc.speedAccuracyMetersPerSecond = 1f
            loc.bearingAccuracyDegrees = 10f
            if (hasAltitude) loc.verticalAccuracyMeters = accuracy.toFloat()
        }
        return loc
    }

    @ReactMethod
    fun push(
        lat: Double,
        lon: Double,
        accuracy: Double,
        speedMps: Double,
        bearingDeg: Double,
        altitude: Double,
        hasAltitude: Boolean,
        promise: Promise
    ) {
        val lm = locationManager
        if (!active || lm == null) {
            promise.reject("NOT_STARTED", "MockLocationModule не запущено")
            return
        }
        try {
            if (gpsMockOn) {
                try {
                    lm.setTestProviderLocation(GPS, buildLocation(GPS, lat, lon, accuracy, speedMps, bearingDeg, altitude, hasAltitude))
                } catch (e: IllegalArgumentException) {
                    // Android іноді скидає тестовий провайдер — реєструємо заново і повторюємо
                    Log.w(TAG, "Тестовий провайдер скинуто, реєструємо заново")
                    addGpsTestProvider(lm)
                    lm.setTestProviderLocation(GPS, buildLocation(GPS, lat, lon, accuracy, speedMps, bearingDeg, altitude, hasAltitude))
                }
            }
            if (fusedMockOn) {
                fusedClient
                    ?.setMockLocation(buildLocation(FUSED, lat, lon, accuracy, speedMps, bearingDeg, altitude, hasAltitude))
                    ?.addOnFailureListener { e -> Log.e(TAG, "fused setMockLocation не вдалося: ", e) }
            }
            promise.resolve(true)
        } catch (e: SecurityException) {
            active = false
            promise.reject("NOT_MOCK_APP", notMockAppMessage())
        } catch (e: Exception) {
            Log.e(TAG, "Помилка push: ", e)
            promise.reject("MOCK_PUSH_ERROR", e.message)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        stopInternal()
        promise.resolve(true)
    }

    // Знімаємо лише те, що було ввімкнено (режим "fused" не чіпає GPS_PROVIDER)
    private fun stopInternal() {
        val lm = locationManager
        if (gpsMockOn) {
            try {
                lm?.setTestProviderEnabled(GPS, false)
            } catch (e: Exception) {
                Log.w(TAG, "setTestProviderEnabled(false): ", e)
            }
            try {
                lm?.removeTestProvider(GPS)
            } catch (e: Exception) {
                Log.w(TAG, "removeTestProvider: ", e)
            }
        }
        try {
            if (fusedMockOn) fusedClient?.setMockMode(false)
        } catch (e: Exception) {
            Log.w(TAG, "fused setMockMode(false): ", e)
        }
        gpsMockOn = false
        fusedMockOn = false
        fusedClient = null
        active = false
    }

    override fun invalidate() {
        if (active) stopInternal()
        super.invalidate()
    }
}
