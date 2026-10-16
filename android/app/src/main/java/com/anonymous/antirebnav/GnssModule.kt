package com.anonymous.antirebnav

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.OnNmeaMessageListener
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Окремі потоки: GPS-приймач (GPS_PROVIDER), мережева позиція (NETWORK_PROVIDER),
 * fused-позиція Google (FusedLocationProviderClient, без діалогів SettingsClient)
 * і стан супутників (GnssStatus). TASK-033: NMEA-потік приймача (OnNmeaMessageListener) —
 * справжні координати з $GxRMC/$GxGGA, навіть коли GPS_PROVIDER підмінено тестовим провайдером.
 * Події: gnssGpsFix, gnssNetFix, gnssFusedFix, gnssStatus, gnssNmeaFix.
 */
class GnssModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val TAG = "GnssModule"
    private val mainHandler = Handler(Looper.getMainLooper())

    private var locationManager: LocationManager? = null
    private var gpsListener: LocationListener? = null
    private var netListener: LocationListener? = null
    private var statusCallback: GnssStatus.Callback? = null
    private var nmeaListener: OnNmeaMessageListener? = null
    private var nmeaQuality: Int? = null // остання якість фіксу з $GxGGA
    private var nmeaSats: Int? = null
    private var nmeaHdop: Double? = null
    private var fusedClient: FusedLocationProviderClient? = null
    private var fusedCallback: LocationCallback? = null
    private var lastStatusEmitMs = 0L
    private var running = false

    override fun getName(): String {
        return "GnssModule"
    }

    // --- ОБОВ'ЯЗКОВІ МЕТОДИ ДЛЯ NativeEventEmitter ---
    @ReactMethod
    fun addListener(eventName: String) {
    }

    @ReactMethod
    fun removeListeners(count: Int) {
    }
    // -------------------------------------------------

    private fun emit(eventName: String, params: WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (e: Exception) {
            Log.e(TAG, "Помилка відправки події $eventName: ", e)
        }
    }

    private fun isMock(loc: Location): Boolean {
        return if (Build.VERSION.SDK_INT >= 31) {
            loc.isMock
        } else {
            @Suppress("DEPRECATION")
            loc.isFromMockProvider
        }
    }

    private fun fixToMap(loc: Location, withAge: Boolean = false): WritableMap {
        val map = Arguments.createMap()
        map.putDouble("lat", loc.latitude)
        map.putDouble("lon", loc.longitude)
        if (loc.hasAccuracy()) map.putDouble("accuracy", loc.accuracy.toDouble()) else map.putNull("accuracy")
        map.putDouble("timeMs", loc.time.toDouble())
        map.putDouble("elapsedMs", loc.elapsedRealtimeNanos / 1_000_000.0)
        map.putBoolean("isMock", isMock(loc))
        // Вік фіксу в момент відправки події — за монотонним часом Android (для gnssGpsFix і gnssNetFix)
        if (withAge) {
            map.putDouble("ageAtEmitMs", (SystemClock.elapsedRealtimeNanos() - loc.elapsedRealtimeNanos) / 1_000_000.0)
        }
        return map
    }

    // LocationListener: усі методи реалізовано явно — на Android < 11 платформа
    // викликає onStatusChanged/onProviderEnabled/onProviderDisabled без default-реалізації.
    private fun makeListener(eventName: String): LocationListener {
        return object : LocationListener {
            override fun onLocationChanged(location: Location) {
                emit(eventName, fixToMap(location, true))
            }

            @Deprecated("Deprecated in Java")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
            }

            override fun onProviderEnabled(provider: String) {
                Log.i(TAG, "Провайдер увімкнено: $provider")
            }

            override fun onProviderDisabled(provider: String) {
                Log.i(TAG, "Провайдер вимкнено: $provider")
            }
        }
    }

    private fun constellationName(type: Int): String {
        return when (type) {
            GnssStatus.CONSTELLATION_GPS -> "GPS"
            GnssStatus.CONSTELLATION_GLONASS -> "GLO"
            GnssStatus.CONSTELLATION_GALILEO -> "GAL"
            GnssStatus.CONSTELLATION_BEIDOU -> "BDS"
            GnssStatus.CONSTELLATION_QZSS -> "QZS"
            GnssStatus.CONSTELLATION_SBAS -> "SBAS"
            GnssStatus.CONSTELLATION_IRNSS -> "IRN"
            else -> "UNK"
        }
    }

    private val constellationOrder = listOf("GPS", "GLO", "GAL", "BDS", "QZS", "SBAS", "IRN", "UNK")

    private fun makeStatusCallback(): GnssStatus.Callback {
        return object : GnssStatus.Callback() {
            override fun onSatelliteStatusChanged(status: GnssStatus) {
                val now = SystemClock.elapsedRealtime()
                if (now - lastStatusEmitMs < 1000) return
                lastStatusEmitMs = now

                val inView = status.satelliteCount
                var used = 0
                var cn0SumUsed = 0.0
                var cn0MaxAll = 0f
                val usedConstellations = HashSet<String>()
                for (i in 0 until inView) {
                    val cn0 = status.getCn0DbHz(i)
                    if (cn0 > cn0MaxAll) cn0MaxAll = cn0
                    if (status.usedInFix(i)) {
                        used++
                        cn0SumUsed += cn0
                        usedConstellations.add(constellationName(status.getConstellationType(i)))
                    }
                }

                val map = Arguments.createMap()
                map.putInt("satInView", inView)
                map.putInt("satUsed", used)
                if (used > 0) map.putDouble("cn0MeanUsed", cn0SumUsed / used) else map.putNull("cn0MeanUsed")
                if (cn0MaxAll > 0f) map.putDouble("cn0MaxAll", cn0MaxAll.toDouble()) else map.putNull("cn0MaxAll")
                if (used > 0) {
                    map.putString("constellationsUsed", constellationOrder.filter { usedConstellations.contains(it) }.joinToString("+"))
                } else {
                    map.putNull("constellationsUsed")
                }
                emit("gnssStatus", map)
            }
        }
    }

    // --- NMEA (TASK-033): лише $GxRMC і $GxGGA; будь-яка помилка розбору ігнорується ---

    /** ddmm.mmmm / dddmm.mmmm + N/S/E/W -> градуси; null, якщо формат хибний. */
    private fun nmeaCoord(value: String, hemi: String, degDigits: Int): Double? {
        if (value.length < degDigits + 2 || hemi.isEmpty()) return null
        val deg = value.substring(0, degDigits).toDoubleOrNull() ?: return null
        val min = value.substring(degDigits).toDoubleOrNull() ?: return null
        val v = deg + min / 60.0
        return when (hemi[0]) {
            'N', 'E' -> v
            'S', 'W' -> -v
            else -> null
        }
    }

    private fun handleNmeaSentence(raw: String) {
        val line = raw.trim()
        if (line.length < 7 || line[0] != '$') return
        val f = line.substring(1).substringBefore('*').split(',')
        val id = f[0]
        if (id.length != 5) return
        when (id.substring(2)) {
            "GGA" -> {
                // 0 id, 1 time, 2 lat, 3 N/S, 4 lon, 5 E/W, 6 quality, 7 sats, 8 hdop
                if (f.size < 9) return
                nmeaQuality = f[6].toIntOrNull()
                nmeaSats = f[7].toIntOrNull()
                nmeaHdop = f[8].toDoubleOrNull()
            }
            "RMC" -> {
                // 0 id, 1 time, 2 status, 3 lat, 4 N/S, 5 lon, 6 E/W, 7 speed (вузли), 8 course
                if (f.size < 9 || f[2] != "A") return
                val lat = nmeaCoord(f[3], f[4], 2) ?: return
                val lon = nmeaCoord(f[5], f[6], 3) ?: return
                val map = Arguments.createMap()
                map.putDouble("lat", lat)
                map.putDouble("lon", lon)
                map.putBoolean("valid", true)
                val q = nmeaQuality
                val sats = nmeaSats
                val hdop = nmeaHdop
                if (q != null) map.putInt("quality", q) else map.putNull("quality")
                if (sats != null) map.putInt("sats", sats) else map.putNull("sats")
                if (hdop != null) map.putDouble("hdop", hdop) else map.putNull("hdop")
                val spd = f[7].toDoubleOrNull()
                if (spd != null) map.putDouble("speedMps", spd * 0.514444) else map.putNull("speedMps")
                val crs = f[8].toDoubleOrNull()
                if (crs != null) map.putDouble("courseDeg", crs) else map.putNull("courseDeg")
                map.putDouble("rxMs", System.currentTimeMillis().toDouble())
                emit("gnssNmeaFix", map)
            }
        }
    }

    private fun makeNmeaListener(): OnNmeaMessageListener {
        return OnNmeaMessageListener { message, _ ->
            try {
                for (s in message.split('\n')) handleNmeaSentence(s)
            } catch (e: Exception) {
                // помилки розбору ігноруємо
            }
        }
    }

    private fun startedMap(): WritableMap {
        return Arguments.createMap().apply {
            putBoolean("nmea", nmeaListener != null)
            putBoolean("gps", gpsListener != null)
            putBoolean("network", netListener != null)
            putBoolean("fused", fusedCallback != null)
            putBoolean("status", statusCallback != null)
        }
    }

    /** Resolve: { gps, network, fused, status } — які з потоків реально запущено. */
    @SuppressLint("MissingPermission")
    @ReactMethod
    fun start(promise: Promise) {
        if (running) {
            promise.resolve(startedMap())
            return
        }

        val ctx = reactApplicationContext
        if (ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            promise.reject("NO_PERMISSION", "Немає дозволу ACCESS_FINE_LOCATION")
            return
        }

        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        if (lm == null) {
            promise.reject("NO_LOCATION_MANAGER", "LocationManager недоступний")
            return
        }
        locationManager = lm
        lastStatusEmitMs = 0L
        nmeaQuality = null
        nmeaSats = null
        nmeaHdop = null

        // GPS_PROVIDER реєструємо й коли він зараз вимкнено: LocationManager приймає
        // підписку і почне видавати фікси після ввімкнення геолокації в системі.
        try {
            if (lm.getProvider(LocationManager.GPS_PROVIDER) != null) {
                val l = makeListener("gnssGpsFix")
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, l, Looper.getMainLooper())
                gpsListener = l
                if (!lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    Log.w(TAG, "GPS_PROVIDER зараз вимкнено — чекаємо ввімкнення")
                }
            } else {
                Log.w(TAG, "GPS_PROVIDER відсутній на пристрої")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Помилка запуску GPS_PROVIDER: ", e)
        }

        try {
            // Як і GPS: реєструємо незалежно від поточного стану — фікси підуть,
            // щойно мережева геолокація стане доступною.
            if (lm.allProviders.contains(LocationManager.NETWORK_PROVIDER)) {
                val l = makeListener("gnssNetFix")
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1000L, 0f, l, Looper.getMainLooper())
                netListener = l
                if (!lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    Log.w(TAG, "NETWORK_PROVIDER зараз вимкнено — чекаємо ввімкнення")
                }
            } else {
                Log.w(TAG, "NETWORK_PROVIDER відсутній на пристрої")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Помилка запуску NETWORK_PROVIDER: ", e)
        }

        // Fused (Google Play Services). Без SettingsClient/checkLocationSettings — діалогу немає.
        try {
            val client = LocationServices.getFusedLocationProviderClient(ctx)
            val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000L).build()
            val cb = object : LocationCallback() {
                override fun onLocationResult(result: LocationResult) {
                    for (loc in result.locations) {
                        emit("gnssFusedFix", fixToMap(loc))
                    }
                }
            }
            client.requestLocationUpdates(request, cb, Looper.getMainLooper())
                .addOnFailureListener { e -> Log.e(TAG, "Fused недоступний: ", e) }
            fusedClient = client
            fusedCallback = cb
        } catch (e: Exception) {
            Log.e(TAG, "Помилка запуску fused: ", e)
        }

        try {
            val cb = makeStatusCallback()
            if (lm.registerGnssStatusCallback(cb, mainHandler)) {
                statusCallback = cb
            }
        } catch (e: Exception) {
            Log.e(TAG, "Помилка запуску GnssStatus: ", e)
        }

        // NMEA-слухач живе разом із GPS-слухачем (TASK-033); приймач віддає справжні дані і при підміні GPS_PROVIDER
        if (gpsListener != null) {
            try {
                val l = makeNmeaListener()
                if (lm.addNmeaListener(l, mainHandler)) nmeaListener = l
            } catch (e: Exception) {
                Log.e(TAG, "Помилка запуску NMEA: ", e)
            }
        }

        running = gpsListener != null || netListener != null || fusedCallback != null || statusCallback != null
        promise.resolve(startedMap())
    }

    @ReactMethod
    fun stop(promise: Promise) {
        stopInternal()
        promise.resolve(true)
    }

    private fun stopInternal() {
        val lm = locationManager
        try {
            gpsListener?.let { lm?.removeUpdates(it) }
            netListener?.let { lm?.removeUpdates(it) }
            statusCallback?.let { lm?.unregisterGnssStatusCallback(it) }
            nmeaListener?.let { lm?.removeNmeaListener(it) }
        } catch (e: Exception) {
            Log.e(TAG, "Помилка зупинки: ", e)
        }
        try {
            fusedCallback?.let { fusedClient?.removeLocationUpdates(it) }
        } catch (e: Exception) {
            Log.e(TAG, "Помилка зупинки fused: ", e)
        }
        gpsListener = null
        netListener = null
        statusCallback = null
        nmeaListener = null
        fusedCallback = null
        fusedClient = null
        running = false
    }

    // Підписки не повинні переживати перезавантаження JS / знищення контексту
    override fun invalidate() {
        stopInternal()
        super.invalidate()
    }
}
