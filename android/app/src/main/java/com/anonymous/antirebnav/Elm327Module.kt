package com.anonymous.antirebnav

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.InputStream
import java.io.OutputStream

class Elm327Module(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val TAG = "Elm327Module"
    private var btSocket: BluetoothSocket? = null
    private var inputStream: InputStream? = null
    private var outputStream: OutputStream? = null
    private var readThread: Thread? = null
    private var isConnected = false

    override fun getName(): String {
        return "Elm327Module"
    }

    // --- ОБОВ'ЯЗКОВІ МЕТОДИ ДЛЯ NativeEventEmitter ---
    @ReactMethod
    fun addListener(eventName: String) {
        // Залишаємо порожнім
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Залишаємо порожнім
    }
    // -------------------------------------------------

    private fun sendEvent(eventName: String, data: String) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, data)
        } catch (e: Exception) {
            Log.e(TAG, "Помилка відправки події $eventName: ", e)
        }
    }

    private fun sendEvent(eventName: String, params: WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (e: Exception) {
            Log.e(TAG, "Помилка відправки події $eventName: ", e)
        }
    }

    @SuppressLint("MissingPermission")
    @ReactMethod
    fun connect(macAddress: String, promise: Promise) {
        if (isConnected) {
            promise.resolve(true)
            return
        }

        try {
            val btAdapter = BluetoothAdapter.getDefaultAdapter()
            if (btAdapter == null) {
                promise.reject("CONNECT_ERROR", "Bluetooth адаптер недоступний")
                return
            }
            val device: BluetoothDevice = btAdapter.getRemoteDevice(macAddress)

            // НАШ БУЛЬДОЗЕР: РЕФЛЕКСІЯ для обходу блокувань Android 13+
            val m = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
            btSocket = m.invoke(device, 1) as BluetoothSocket

            btAdapter.cancelDiscovery()
            
            btSocket?.connect()
            inputStream = btSocket?.inputStream
            outputStream = btSocket?.outputStream
            isConnected = true

            startReadThread()
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Помилка підключення: ", e)
            isConnected = false
            promise.reject("CONNECT_ERROR", e.message)
        }
    }

    private fun startReadThread() {
        readThread = Thread {
            val buffer = ByteArray(1024)
            var bytes: Int

            while (isConnected) {
                try {
                    bytes = inputStream?.read(buffer) ?: 0
                    if (bytes > 0) {
                        val rawData = String(buffer, 0, bytes)
                        val hardwareTimestamp = System.currentTimeMillis().toDouble()

                        // Формування payload з апаратним часом для ядра Dead Reckoning
                        val params: WritableMap = Arguments.createMap().apply {
                            putString("data", rawData)
                            putDouble("timestamp", hardwareTimestamp)
                        }

                        sendEvent("ON_ELM_DATA", params)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Розрив потоку читання", e)
                    isConnected = false
                    sendEvent("ON_ELM_DISCONNECTED", "Розрив зв'язку")
                    break
                }
            }
        }
        readThread?.start()
    }

    @ReactMethod
    fun write(command: String, promise: Promise) {
        if (!isConnected || outputStream == null) {
            promise.reject("WRITE_ERROR", "Немає підключення")
            return
        }
        try {
            outputStream?.write(command.toByteArray())
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("WRITE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun disconnect(promise: Promise) {
        isConnected = false
        try {
            inputStream?.close()
            outputStream?.close()
            btSocket?.close()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("DISCONNECT_ERROR", e.message)
        }
    }
}