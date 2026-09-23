import { NativeModules, NativeEventEmitter } from 'react-native';

const { Elm327Module } = NativeModules;
const elmEmitter = new NativeEventEmitter(Elm327Module);

/* =====================================================================
 * OBD-сканер (v1.2)
 *  - Парсинг без залежності від пробілів (ATS0 справді вимикає пробіли).
 *  - Відповідь обробляється цілком по символу-запрошенню '>'.
 *  - Опитування «запит -> відповідь -> наступний запит» замість фіксованих
 *    400 мс: частота оновлення швидкості зростає до можливостей шини.
 *  - Довший тайм-аут першої відповіді (ATSP0 шукає протокол кілька секунд,
 *    а будь-який символ, надісланий під час пошуку, його перериває).
 *  - MAC-адресу можна змінити через setMacAddress().
 * ===================================================================== */

const POLL_GAP_MS = 50; // пауза між відповіддю та наступним запитом
const FIRST_RESPONSE_TIMEOUT_MS = 6000;
const RESPONSE_TIMEOUT_MS = 1000;
const MAX_BUFFER_LEN = 1024;
const SPEED_REGEX = /410D([0-9A-F]{2})/;
const ERROR_MARKERS = ['NODATA', 'UNABLETOCONNECT', 'CANERROR', 'BUSERROR', 'STOPPED', 'ERROR'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class OBDScanner {
  constructor() {
    this.BUILD_VERSION = 'OBD-NATIVE-BRIDGE-1.2';
    this.macAddress = '81:60:2C:6B:A0:58';

    this.buffer = '';
    this.lastTimestamp = null;
    this.dataListener = null;
    this.disconnectListener = null;

    this.onSpeedReceived = null;
    this.onStatusUpdate = null;

    this.isPolling = false;
    this.awaitingResponse = false;
    this.gotFirstResponse = false;
    this.responseTimer = null;
    this.nextRequestTimer = null;
  }

  getVersion() {
    return this.BUILD_VERSION;
  }

  setMacAddress(mac) {
    if (typeof mac === 'string' && /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(mac)) {
      this.macAddress = mac.toUpperCase();
      return true;
    }
    return false;
  }

  _status(text) {
    if (typeof this.onStatusUpdate === 'function') this.onStatusUpdate(text);
  }

  async connectToELM() {
    try {
      console.log(`[${this.BUILD_VERSION}] Підключення до ${this.macAddress}...`);
      const isConnected = await Elm327Module.connect(this.macAddress);
      if (!isConnected) return false;
      this.setupListeners();
      await this.initELM();
      return true;
    } catch (error) {
      console.log('Помилка в Native Module:', error);
      return false;
    }
  }

  setupListeners() {
    this._removeListeners();

    this.dataListener = elmEmitter.addListener('ON_ELM_DATA', (event) => {
      if (!event) return;
      if (typeof event.timestamp === 'number') this.lastTimestamp = event.timestamp;
      if (typeof event.data === 'string') {
        this.buffer += event.data.toUpperCase();
        if (this.buffer.length > MAX_BUFFER_LEN) {
          this.buffer = this.buffer.slice(-MAX_BUFFER_LEN);
        }
        this.processBuffer();
      }
    });

    this.disconnectListener = elmEmitter.addListener('ON_ELM_DISCONNECTED', () => {
      console.log('Нативний модуль повідомив про розрив сокета.');
      this._status("Розрив зв'язку");
      this.stopReading();
    });
  }

  _removeListeners() {
    if (this.dataListener) this.dataListener.remove();
    if (this.disconnectListener) this.disconnectListener.remove();
    this.dataListener = null;
    this.disconnectListener = null;
  }

  async initELM() {
    // ATZ — повне перезавантаження чипа, потребує ~1 с
    const commands = [
      ['ATZ\r', 1500],
      ['ATE0\r', 200], // без луни
      ['ATL0\r', 200], // без переводів рядка
      ['ATS0\r', 200], // без пробілів
      ['ATH0\r', 200], // без CAN-заголовків (щоб SPEED_REGEX завжди збігався)
      ['ATST64\r', 200], // тайм-аут відповіді ECU
      ['ATSP0\r', 300], // автовибір протоколу
    ];
    for (const [cmd, wait] of commands) {
      try {
        await Elm327Module.write(cmd);
      } catch (e) {}
      await sleep(wait);
    }
    this.buffer = '';
  }

  startReadingSpeed(onSpeedReceived, onStatusUpdate) {
    this.onSpeedReceived = onSpeedReceived;
    this.onStatusUpdate = onStatusUpdate;
    this._clearTimers();
    this.isPolling = true;
    this.gotFirstResponse = false;
    this._status('Пошук протоколу...');
    this._sendSpeedRequest();
  }

  async _sendSpeedRequest() {
    if (!this.isPolling) return;
    this._clearTimers();
    this.awaitingResponse = true;

    try {
      await Elm327Module.write('010D\r');
    } catch (e) {
      this._status('Очікування шини...');
    }

    const timeout = this.gotFirstResponse ? RESPONSE_TIMEOUT_MS : FIRST_RESPONSE_TIMEOUT_MS;
    this.responseTimer = setTimeout(() => {
      if (!this.isPolling) return;
      this._status('Немає відповіді ECU...');
      this.buffer = '';
      this._sendSpeedRequest();
    }, timeout);
  }

  _scheduleNextRequest() {
    if (!this.isPolling || !this.awaitingResponse) return; // захист від подвійного циклу
    this.awaitingResponse = false;
    if (this.responseTimer) clearTimeout(this.responseTimer);
    this.nextRequestTimer = setTimeout(() => this._sendSpeedRequest(), POLL_GAP_MS);
  }

  processBuffer() {
    let idx = this.buffer.indexOf('>');
    while (idx !== -1) {
      const response = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this._handleResponse(response);
      idx = this.buffer.indexOf('>');
    }
  }

  _handleResponse(response) {
    const compact = response.replace(/\s/g, '');
    if (!compact) return;

    const m = SPEED_REGEX.exec(compact);
    if (m) {
      const speedKmH = parseInt(m[1], 16);
      if (!this.gotFirstResponse) {
        this.gotFirstResponse = true;
        this._status('Онлайн (Native)');
      }
      if (typeof this.onSpeedReceived === 'function') {
        this.onSpeedReceived(speedKmH, this.lastTimestamp);
      }
    } else if (ERROR_MARKERS.some((e) => compact.includes(e))) {
      this._status(`ECU: ${compact.slice(0, 24)}`);
    }

    this._scheduleNextRequest();
  }

  _clearTimers() {
    if (this.responseTimer) clearTimeout(this.responseTimer);
    if (this.nextRequestTimer) clearTimeout(this.nextRequestTimer);
    this.responseTimer = null;
    this.nextRequestTimer = null;
  }

  stopReading() {
    this.isPolling = false;
    this.awaitingResponse = false;
    this._clearTimers();
    this._removeListeners();
    this.buffer = '';
    try {
      const p = Elm327Module.disconnect();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {}
  }
}

export default new OBDScanner();
