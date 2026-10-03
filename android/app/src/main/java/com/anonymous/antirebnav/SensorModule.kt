package com.anonymous.antirebnav

import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
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
 * Нативні датчики для ядра + нативний такт 20 Гц (TASK-016).
 *
 * Датчики не зупиняються при переході застосунку у фон (на відміну від expo-sensors).
 * Подія "nativeSensors" шлеться кожні 50 мс з окремого потоку: вона ж є тактом
 * для циклу ядра, OBD-опитування і flush логу, бо таймери JS React Native у фоні
 * призупиняє (JavaTimerManager прив'язаний до Choreographer).
 *
 * Також керує RecordingService (foreground service) через startRecordingService/stopRecordingService.
 */
class SensorModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), SensorEventListener {

    private val TAG = "SensorModule"
    private val TICK_MS = 50L
    private val SAMPLING_US = 20000

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var sensorManager: SensorManager? = null
    private var running = false

    // Останні значення й timestamp (elapsedRealtime, нс) кожного датчика.
    // Пишуться і читаються лише на потоці `handler`.
    private var gyro: FloatArray? = null
    private var gyroTs = 0L
    private var acc: FloatArray? = null
    private var accTs = 0L
    private var grav: FloatArray? = null
    private var gravTs = 0L
    // TYPE_GYROSCOPE_UNCALIBRATED: values[0..2] — сирий гіроскоп, values[3..5] — оцінка зсуву Android
    private var ugyro: FloatArray? = null
    private var ugyroTs = 0L

    private var tickCount = 0L
    private var tickStartUptime = 0L

    override fun getName(): String {
        return "SensorModule"
    }

    // --- ОБОВ'ЯЗКОВІ МЕТОДИ ДЛЯ NativeEventEmitter ---
    @ReactMethod
    fun addListener(eventName: String) {
    }

    @ReactMethod
    fun removeListeners(count: Int) {
    }
    // -------------------------------------------------

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_GYROSCOPE -> {
                gyro = event.values.copyOf(3)
                gyroTs = event.timestamp
            }
            Sensor.TYPE_LINEAR_ACCELERATION -> {
                acc = event.values.copyOf(3)
                accTs = event.timestamp
            }
            Sensor.TYPE_GRAVITY -> {
                grav = event.values.copyOf(3)
                gravTs = event.timestamp
            }
            Sensor.TYPE_GYROSCOPE_UNCALIBRATED -> {
                ugyro = event.values.copyOf(6)
                ugyroTs = event.timestamp
            }
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            if (!running) return
            emitSnapshot()
            tickCount += 1
            // Без накопичення дрейфу: наступний такт від початку відліку
            handler?.postAtTime(this, tickStartUptime + tickCount * TICK_MS)
        }
    }

    private fun putVec(map: WritableMap, x: String, y: String, z: String, v: FloatArray?, sign: Double) {
        if (v == null) {
            map.putNull(x)
            map.putNull(y)
            map.putNull(z)
        } else {
            map.putDouble(x, sign * v[0])
            map.putDouble(y, sign * v[1])
            map.putDouble(z, sign * v[2])
        }
    }

    private fun putAge(map: WritableMap, key: String, v: FloatArray?, ts: Long, nowNs: Long) {
        if (v == null) map.putNull(key) else map.putDouble(key, (nowNs - ts) / 1_000_000.0)
    }

    private fun emitSnapshot() {
        val nowNs = SystemClock.elapsedRealtimeNanos()
        val map = Arguments.createMap()
        map.putDouble("tMs", System.currentTimeMillis().toDouble())
        putVec(map, "gyroX", "gyroY", "gyroZ", gyro, 1.0)
        putVec(map, "accX", "accY", "accZ", acc, 1.0)
        // Ядро очікує gravX/Y/Z ≈ −TYPE_GRAVITY (так рахує expo-sensors)
        putVec(map, "gravX", "gravY", "gravZ", grav, -1.0)
        putAge(map, "gyroAgeMs", gyro, gyroTs, nowNs)
        putAge(map, "accAgeMs", acc, accTs, nowNs)
        putAge(map, "gravAgeMs", grav, gravTs, nowNs)
        // Некалібрований гіроскоп і оцінка зсуву від Android — лише для логу (рад/с, як є)
        val u = ugyro
        if (u == null) {
            map.putNull("uGyroX")
            map.putNull("uGyroY")
            map.putNull("uGyroZ")
            map.putNull("uBiasX")
            map.putNull("uBiasY")
            map.putNull("uBiasZ")
        } else {
            map.putDouble("uGyroX", u[0].toDouble())
            map.putDouble("uGyroY", u[1].toDouble())
            map.putDouble("uGyroZ", u[2].toDouble())
            map.putDouble("uBiasX", u[3].toDouble())
            map.putDouble("uBiasY", u[4].toDouble())
            map.putDouble("uBiasZ", u[5].toDouble())
        }
        if (u == null) map.putNull("uGyroAgeMs") else map.putDouble("uGyroAgeMs", (nowNs - ugyroTs) / 1_000_000.0)
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("nativeSensors", map)
        } catch (e: Exception) {
            Log.e(TAG, "Помилка відправки nativeSensors: ", e)
        }
    }

    /** Resolve: { gyro, acc, grav, tick } — які датчики реально знайдено. */
    @ReactMethod
    fun start(promise: Promise) {
        if (running) {
            promise.resolve(Arguments.createMap().apply {
                putBoolean("gyro", gyro != null || sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null)
                putBoolean("acc", sensorManager?.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION) != null)
                putBoolean("grav", sensorManager?.getDefaultSensor(Sensor.TYPE_GRAVITY) != null)
                putBoolean("tick", true)
            })
            return
        }
        try {
            val sm = reactApplicationContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
            sensorManager = sm
            val t = HandlerThread("SensorModuleThread")
            t.start()
            thread = t
            val h = Handler(t.looper)
            handler = h

            gyro = null
            acc = null
            grav = null
            ugyro = null

            val sGyro = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
            val sAcc = sm.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
            val sGrav = sm.getDefaultSensor(Sensor.TYPE_GRAVITY)
            val sUGyro = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE_UNCALIBRATED)
            // Датчика немає — поля null, без падіння
            if (sGyro != null) sm.registerListener(this, sGyro, SAMPLING_US, h)
            if (sAcc != null) sm.registerListener(this, sAcc, SAMPLING_US, h)
            if (sGrav != null) sm.registerListener(this, sGrav, SAMPLING_US, h)
            if (sUGyro != null) sm.registerListener(this, sUGyro, SAMPLING_US, h)

            running = true
            tickCount = 1
            tickStartUptime = SystemClock.uptimeMillis()
            h.postAtTime(ticker, tickStartUptime + TICK_MS)

            promise.resolve(Arguments.createMap().apply {
                putBoolean("gyro", sGyro != null)
                putBoolean("acc", sAcc != null)
                putBoolean("grav", sGrav != null)
                putBoolean("ugyro", sUGyro != null)
                putBoolean("tick", true)
            })
        } catch (e: Exception) {
            Log.e(TAG, "Помилка запуску датчиків: ", e)
            stopInternal()
            promise.reject("SENSOR_START_ERROR", e.message)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        stopInternal()
        promise.resolve(true)
    }

    private fun stopInternal() {
        running = false
        try {
            sensorManager?.unregisterListener(this)
        } catch (e: Exception) {
            Log.e(TAG, "Помилка зупинки датчиків: ", e)
        }
        handler?.removeCallbacksAndMessages(null)
        thread?.quitSafely()
        thread = null
        handler = null
    }

    /** Запускає RecordingService (foreground service, сповіщення, WakeLock). */
    @ReactMethod
    fun startRecordingService(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val intent = Intent(ctx, RecordingService::class.java)
            if (Build.VERSION.SDK_INT >= 26) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Не вдалося запустити RecordingService: ", e)
            promise.reject("SERVICE_START_ERROR", e.message)
        }
    }

    @ReactMethod
    fun stopRecordingService(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            ctx.stopService(Intent(ctx, RecordingService::class.java))
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Не вдалося зупинити RecordingService: ", e)
            promise.reject("SERVICE_STOP_ERROR", e.message)
        }
    }

    override fun invalidate() {
        stopInternal()
        super.invalidate()
    }
}
