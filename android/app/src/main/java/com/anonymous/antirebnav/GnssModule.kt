package com.anonymous.antirebnav

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
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

/**
 * Окремі потоки: GPS-приймач (GPS_PROVIDER), мережева позиція (NETWORK_PROVIDER)
 * і стан супутників (GnssStatus). Події: gnssGpsFix, gnssNetFix, gnssStatus.
 */
class GnssModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val TAG = "GnssModule"
    private val mainHandler = Handler(Looper.getMainLooper())

    private var locationManager: LocationManager? = null
    private var gpsListener: LocationListener? = null
    private var netListener: LocationListener? = null
    private var statusCallback: GnssStatus.Callback? = null
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

    private fun fixToMap(loc: Location): WritableMap {
        val map = Arguments.createMap()
        map.putDouble("lat", loc.latitude)
        map.putDouble("lon", loc.longitude)
        if (loc.hasAccuracy()) map.putDouble("accuracy", loc.accuracy.toDouble()) else map.putNull("accuracy")
        map.putDouble("timeMs", loc.time.toDouble())
        map.putDouble("elapsedMs", loc.elapsedRealtimeNanos / 1_000_000.0)
        map.putBoolean("isMock", isMock(loc))
        return map
    }

    // LocationListener: усі методи реалізовано явно — на Android < 11 платформа
    // викликає onStatusChanged/onProviderEnabled/onProviderDisabled без default-реалізації.
    private fun makeListener(eventName: String): LocationListener {
        return object : LocationListener {
            override fun onLocationChanged(location: Location) {
                emit(eventName, fixToMap(location))
            }

            @Deprecated("Deprecated in Java")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
            }

            override fun onProviderEnabled(provider: String) {
            }

            override fun onProviderDisabled(provider: String) {
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

    /** Resolve: { gps, network, status } — які з трьох потоків реально запущено. */
    @SuppressLint("MissingPermission")
    @ReactMethod
    fun start(promise: Promise) {
        if (running) {
            promise.resolve(Arguments.createMap().apply {
                putBoolean("gps", gpsListener != null)
                putBoolean("network", netListener != null)
                putBoolean("status", statusCallback != null)
            })
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

        try {
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                val l = makeListener("gnssGpsFix")
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, l, Looper.getMainLooper())
                gpsListener = l
            } else {
                Log.w(TAG, "GPS_PROVIDER вимкнено")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Помилка запуску GPS_PROVIDER: ", e)
        }

        try {
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                val l = makeListener("gnssNetFix")
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1000L, 0f, l, Looper.getMainLooper())
                netListener = l
            }
        } catch (e: Exception) {
            Log.e(TAG, "Помилка запуску NETWORK_PROVIDER: ", e)
        }

        try {
            val cb = makeStatusCallback()
            if (lm.registerGnssStatusCallback(cb, mainHandler)) {
                statusCallback = cb
            }
        } catch (e: Exception) {
            Log.e(TAG, "Помилка запуску GnssStatus: ", e)
        }

        running = true
        promise.resolve(Arguments.createMap().apply {
            putBoolean("gps", gpsListener != null)
            putBoolean("network", netListener != null)
            putBoolean("status", statusCallback != null)
        })
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
        } catch (e: Exception) {
            Log.e(TAG, "Помилка зупинки: ", e)
        }
        gpsListener = null
        netListener = null
        statusCallback = null
        running = false
    }
}
