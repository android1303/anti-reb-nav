import RNBluetoothClassic from 'react-native-bluetooth-classic';

class OBDScanner {
  constructor() {
    this.device = null;
    this.readInterval = null;
  }

  async connectToELM() {
    try {
      // Шукаємо серед вже спарених по Bluetooth пристроїв наш адаптер
      const paired = await RNBluetoothClassic.getBondedDevices();
      const elmDevice = paired.find(d => d.name.includes('OBD') || d.name.includes('ELM'));

      if (!elmDevice) {
        console.log('ELM327 не знайдено серед спарених пристроїв');
        return false;
      }

      this.device = elmDevice;
      const connected = await this.device.connect();
      
      if (connected) {
        console.log('Підключено до ELM327!');
        await this.initELM();
        return true;
      }
    } catch (error) {
      console.error('Помилка підключення:', error);
      return false;
    }
  }

  async initELM() {
    // Скидаємо налаштування адаптера та вимикаємо "відлуння" для чистіших даних
    await this.device.write('ATZ\r');
    await new Promise(r => setTimeout(r, 1000));
    await this.device.write('ATE0\r');
    await new Promise(r => setTimeout(r, 500));
  }

  startReadingSpeed(onSpeedReceived) {
    this.readInterval = setInterval(async () => {
      if (!this.device || !this.device.isConnected()) return;

      try {
        // Команда 010D - це стандартний запит швидкості по OBD-II
        await this.device.write('010D\r');
        const response = await this.device.read();
        
        // Перевіряємо, чи прийшла правильна відповідь
        if (response && response.includes('41 0D')) {
          const hexSpeed = response.split('41 0D')[1].trim().substring(0, 2);
          const speedKmH = parseInt(hexSpeed, 16);
          onSpeedReceived(speedKmH);
        }
      } catch (error) {
        console.error('Помилка читання швидкості:', error);
      }
    }, 200); 
  }

  stopReading() {
    if (this.readInterval) clearInterval(this.readInterval);
    if (this.device) this.device.disconnect();
  }
}

export default new OBDScanner();