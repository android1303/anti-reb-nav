import { NativeModules, NativeEventEmitter } from 'react-native';

const { Elm327Module } = NativeModules;
const elmEmitter = new NativeEventEmitter(Elm327Module);

class OBDScanner {
  constructor() {
    this.buffer = '';
    this.dataListener = null;
    this.disconnectListener = null;
    this.readInterval = null;
    this.onSpeedReceived = null;
    this.onStatusUpdate = null;
    this.BUILD_VERSION = 'OBD-NATIVE-BRIDGE-1.0';
    
    // MAC-адреса твого адаптера ELM327 (зафіксована для максимальної швидкості)
    this.macAddress = '81:60:2C:6B:A0:58'; 
  }

  getVersion() {
    return this.BUILD_VERSION;
  }

  async connectToELM() {
    try {
      console.log(`[${this.BUILD_VERSION}] Підключення до ${this.macAddress} через Native Module...`);
      
      // Звертаємося напряму до нашого Kotlin-коду
      const isConnected = await Elm327Module.connect(this.macAddress);
      
      if (isConnected) {
        this.setupListeners();
        await this.initELM();
        return true;
      }
      return false;
    } catch (error) {
      console.log('Помилка в Native Module:', error);
      return false;
    }
  }

  setupListeners() {
    // Відписуємося від попередніх слухачів, щоб уникнути дублювання
    if (this.dataListener) this.dataListener.remove();
    if (this.disconnectListener) this.disconnectListener.remove();

    // Слухаємо вхідні байти від Kotlin у фоновому режимі
    this.dataListener = elmEmitter.addListener('ON_ELM_DATA', (data) => {
      this.buffer += data;
      this.processBuffer();
    });

    // Слухаємо подію розриву зв'язку від заліза
    this.disconnectListener = elmEmitter.addListener('ON_ELM_DISCONNECTED', () => {
      console.log('Нативний модуль повідомив про розрив сокета.');
      if (this.onStatusUpdate) this.onStatusUpdate('Розрив зв\'язку');
      this.stopReading();
    });
  }

  async initELM() {
    const commands = ['ATZ\r', 'ATE0\r', 'ATL0\r', 'ATS0\r', 'ATST64\r', 'ATSP0\r'];
    for (const cmd of commands) {
      try {
        await Elm327Module.write(cmd);
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 300));
  }

  startReadingSpeed(onSpeedReceived, onStatusUpdate) {
    this.onSpeedReceived = onSpeedReceived;
    this.onStatusUpdate = onStatusUpdate;

    if (this.readInterval) clearInterval(this.readInterval);
    
    if (this.onStatusUpdate) this.onStatusUpdate('Онлайн (Native)');

    // Інтервал лише відправляє команду. Читання відбувається асинхронно в setupListeners.
    this.readInterval = setInterval(async () => {
      try {
        await Elm327Module.write('010D\r');
      } catch (e) {
        if (this.onStatusUpdate) this.onStatusUpdate('Очікування шини...');
      }
    }, 400);
  }

  processBuffer() {
    // Чекаємо на символ кінця рядка або символ запрошення
    if (this.buffer.includes('\r') || this.buffer.includes('\n') || this.buffer.includes('>')) {
      if (this.buffer.includes('41 0D')) {
        const parts = this.buffer.split('41 0D');
        if (parts.length > 1) {
          const hexSpeed = parts[1].trim().substring(0, 2);
          const speedKmH = parseInt(hexSpeed, 16);
          if (!isNaN(speedKmH) && this.onSpeedReceived) {
            this.onSpeedReceived(speedKmH);
          }
        }
      }
      this.buffer = ''; // Очищаємо буфер після обробки
    }
  }

  stopReading() {
    if (this.readInterval) clearInterval(this.readInterval);
    if (this.dataListener) this.dataListener.remove();
    if (this.disconnectListener) this.disconnectListener.remove();
    
    try {
      Elm327Module.disconnect();
    } catch(e) {}
  }
}

export default new OBDScanner();