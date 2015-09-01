/*
 *This program is free software: you can redistribute it and/or modify
 *it under the terms of the GNU General Public License as published by
 *the Free Software Foundation, either version 3 of the License, or
 *(at your option) any later version.
 *
 *This program is distributed in the hope that it will be useful,
 *but WITHOUT ANY WARRANTY; without even the implied warranty of
 *MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *GNU General Public License for more details.
 *
 *You should have received a copy of the GNU General Public License
 *along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

(function(ext) {

  var PIN_MODE = 0xF4,
    REPORT_DIGITAL = 0xD0,
    REPORT_ANALOG = 0xC0,
    DIGITAL_MESSAGE = 0x90,
    START_SYSEX = 0xF0,
    END_SYSEX = 0xF7,
    QUERY_FIRMWARE = 0x79,
    REPORT_VERSION = 0xF9,
    ANALOG_MESSAGE = 0xE0,
    ANALOG_MAPPING_QUERY = 0x69,
    ANALOG_MAPPING_RESPONSE = 0x6A,
    CAPABILITY_QUERY = 0x6B,
    CAPABILITY_RESPONSE = 0x6C;

  var INPUT = 0x00,
    OUTPUT = 0x01,
    ANALOG = 0x02,
    PWM = 0x03,
    SERVO = 0x04,
    SHIFT = 0x05,
    I2C = 0x06,
    ONEWIRE = 0x07,
    STEPPER = 0x08,
    ENCODER = 0x09,
    IGNORE = 0x7F;

  var LOW = 0,
    HIGH = 1;
  
  var MAX_DATA_BYTES = 4096;
  var MAX_PINS = 128;

  var parsingSysex = false,
    waitForData = 0,
    executeMultiByteCommand = 0,
    multiByteChannel = 0,
    sysexBytesRead = 0,
    storedInputData = new Uint8Array(MAX_DATA_BYTES);

  var digitalOutputData = new Uint8Array(16),
    digitalInputData = new Uint8Array(16),
    analogInputData = new Uint16Array(16);

  var analogChannel = new Uint8Array(MAX_PINS);
  var pinModes = [];
  for (var i = 0; i < 11; i++) pinModes[i] = [];

  var majorVersion = 0,
    minorVersion = 0;
  
  var connected = false;
  var notifyConnection = false;
  var device = null;
  var inputData = null;

  // TEMPORARY WORKAROUND
  // Since _deviceRemoved is not used with Serial devices
  // ping device regularly to check connection
  var pinging = false;
  var pingCount = 0;
  var pinger = null;

  var hwList = new HWList();

  function HWList() {
    this.devices = [];

    this.add = function(dev, pin) {
      var device = this.search(dev);
      if (!device) {
        device = {name: dev, pin: pin, val: 0};
        this.devices.push(device);
      } else {
        device.pin = pin;
        device.val = 0;
      }
    };

    this.search = function(dev) {
      for (var i=0; i<this.devices.length; i++) {
        if (this.devices[i].name === dev)
          return this.devices[i];
      }
      return null;
    };
  }

  function init() {

    for (var i = 0; i < 16; i++) {
      var output = new Uint8Array([REPORT_DIGITAL | i, 0x01]);
      device.send(output.buffer);
    }

    queryCapabilities();

    // TEMPORARY WORKAROUND
    // Since _deviceRemoved is not used with Serial devices
    // ping device regularly to check connection
    pinger = setInterval(function() {
      if (pinging) {
        if (++pingCount > 6) {
          clearInterval(pinger);
          pinger = null;
          connected = false;
          if (device) device.close();
          device = null;
          return;
        }
      } else {
        if (!device) {
          clearInterval(pinger);
          pinger = null;
          return;
        }
        queryFirmware();
        pinging = true;
      }
    }, 100);
  }

  function hasCapability(pin, mode) {
    if (pinModes[mode].indexOf(pin) > -1)
      return true;
    else
      return false;
  }

  function queryFirmware() {
    var output = new Uint8Array([START_SYSEX, QUERY_FIRMWARE, END_SYSEX]);
    device.send(output.buffer);
  }
 
  function queryCapabilities() {
    console.log('Querying ' + device.id + ' capabilities');
    var msg = new Uint8Array([
        START_SYSEX, CAPABILITY_QUERY, END_SYSEX]);
    device.send(msg.buffer);
  }

  function queryAnalogMapping() {
    console.log('Querying ' + device.id + ' analog mapping');
    var msg = new Uint8Array([
        START_SYSEX, ANALOG_MAPPING_QUERY, END_SYSEX]);
    device.send(msg.buffer);
  }

  function setDigitalInputs(portNum, portData) {
    digitalInputData[portNum] = portData;
  }

  function setAnalogInput(pin, val) {
    analogInputData[pin] = val;
  }

  function setVersion(major, minor) {
    majorVersion = major;
    minorVersion = minor;
  }

  function processSysexMessage() {
    switch(storedInputData[0]) {
      case CAPABILITY_RESPONSE:
        for (var i = 1, pin = 0; pin < MAX_PINS; pin++) {
          while (storedInputData[i++] != 0x7F) {
            pinModes[storedInputData[i-1]].push(pin);
            i++; //Skip mode resolution
          }
          if (i == sysexBytesRead) break;
        }
        queryAnalogMapping();
        break;
      case ANALOG_MAPPING_RESPONSE:
        for (var pin = 0; pin < analogChannel.length; pin++)
          analogChannel[pin] = 127;
        for (var i = 1; i < sysexBytesRead; i++)
          analogChannel[i-1] = storedInputData[i];
        for (var pin = 0; pin < analogChannel.length; pin++) {
          if (analogChannel[pin] != 127) {
            var out = new Uint8Array([
                REPORT_ANALOG | analogChannel[pin], 0x01]);
            device.send(out.buffer);
          }
        }
        notifyConnection = true;
        setTimeout(function() {
          notifyConnection = false;
        }, 100);
        break;
      case QUERY_FIRMWARE:
        if (!connected) {
          clearInterval(poller);
          poller = null;
          clearTimeout(watchdog);
          watchdog = null;
          connected = true;
          setTimeout(init, 200);
        }
        pinging = false;
        pingCount = 0;
        break;
    }
  }

  function processInput(inputData) { 
    for (var i=0; i < inputData.length; i++) {
      
      if (parsingSysex) {
        if (inputData[i] == END_SYSEX) {
          parsingSysex = false;
          processSysexMessage();
        } else {
          storedInputData[sysexBytesRead++] = inputData[i];
        }
      } else if (waitForData > 0 && inputData[i] < 0x80) {
        storedInputData[--waitForData] = inputData[i];
        if (executeMultiByteCommand !== 0 && waitForData === 0) {
          switch(executeMultiByteCommand) {
            case DIGITAL_MESSAGE:
              setDigitalInputs(multiByteChannel, (storedInputData[0] << 7) + storedInputData[1]);
              break;
            case ANALOG_MESSAGE:
              setAnalogInput(multiByteChannel, (storedInputData[0] << 7) + storedInputData[1]);
              break;
            case REPORT_VERSION:
              setVersion(storedInputData[1], storedInputData[0]);
              break;
          }
        }
      } else {
        if (inputData[i] < 0xF0) {
          command = inputData[i] & 0xF0;
          multiByteChannel = inputData[i] & 0x0F;
        } else {
          command = inputData[i];
        }
        switch(command) {
          case DIGITAL_MESSAGE:
          case ANALOG_MESSAGE:
          case REPORT_VERSION:
            waitForData = 2;
            executeMultiByteCommand = command;
            break;
          case START_SYSEX:
            parsingSysex = true;
            sysexBytesRead = 0;
            break;
        }
      }
    }
  }

  function pinMode(pin, mode) {
    var msg = new Uint8Array([PIN_MODE, pin, mode]);
    device.send(msg.buffer);
  }

  function analogRead(pin) {
    if (pin >= 0 && pin < pinModes[ANALOG].length) {
      return Math.round((analogInputData[pin] * 100) / 1023);
    } else {
      var valid = [];
      for (var i = 0; i < pinModes[ANALOG].length; i++)
        valid.push(i);
      console.log('ERROR: valid analog pins are ' + valid.join(', '));
      return;
    }
  }

  function digitalRead(pin) {
    if (!hasCapability(pin, INPUT)) {
      console.log('ERROR: valid input pins are ' + pinModes[INPUT].join(', '));
      return;
    }
    pinMode(pin, INPUT);
    return (digitalInputData[pin >> 3] >> (pin & 0x07)) & 0x01;
  }

  function analogWrite(pin, val) {
    if (!hasCapability(pin, PWM)) {
      console.log('ERROR: valid PWM pins are ' + pinModes[PWM].join(', '));
      return;
    }
    if (val < 0) val = 0;
    else if (val > 100) val = 100;
    val = Math.round((val / 100) * 255);
    pinMode(pin, PWM);
    var msg = new Uint8Array([
        ANALOG_MESSAGE | (pin & 0x0F),
        val & 0x7F,
        val >> 7]);
    device.send(msg.buffer);
  }

  function digitalWrite(pin, val) {
    if (!hasCapability(pin, OUTPUT)) {
      console.log('ERROR: valid output pins are ' + pinModes[OUTPUT].join(', '));
      return;
    }
    var portNum = (pin >> 3) & 0x0F;
    if (val == LOW)
      digitalOutputData[portNum] &= ~(1 << (pin & 0x07));
    else
      digitalOutputData[portNum] |= (1 << (pin & 0x07));
    pinMode(pin, OUTPUT);
    var msg = new Uint8Array([
        DIGITAL_MESSAGE | portNum,
        digitalOutputData[portNum] & 0x7F,
        digitalOutputData[portNum] >> 0x07]);
    device.send(msg.buffer);
  }

  function rotateServo(pin, deg) {
    if (!hasCapability(pin, SERVO)) {
      console.log('ERROR: valid servo pins are ' + pinModes[SERVO].join(', '));
      return;
    }
    pinMode(pin, SERVO);
    var msg = new Uint8Array([
        ANALOG_MESSAGE | (pin & 0x0F),
        deg & 0x7F,
        deg >> 0x07]);
    device.send(msg.buffer);
  }

  ext.whenConnected = function() {
    if (notifyConnection) return true;
    return false;
  };

  ext.analogWrite = function(pin, val) {
    analogWrite(pin, val);
  };

  ext.digitalWrite = function(pin, val) {
    if (val == 'on')
      digitalWrite(pin, HIGH);
    else if (val == 'off')
      digitalWrite(pin, LOW);
  };

  ext.analogRead = function(pin) {
    return analogRead(pin);
  };

  ext.digitalRead = function(pin) {
    return digitalRead(pin);
  };

  ext.whenAnalogRead = function(pin, op, val) {
    if (pin >= 0 && pin < pinModes[ANALOG].length) {
      if (op == '>')
        return analogRead(pin) > val;
      else if (op == '<')
        return analogRead(pin) < val;
      else if (op == '=')
        return analogRead(pin) == val;
      else
        return false;
    }
  };

  ext.whenDigitalRead = function(pin, val) {
    if (hasCapability(pin, INPUT)) {
      if (val == 'on')
        return digitalRead(pin);
      else if (val == 'off')
        return digitalRead(pin) === false;
    }
  };

  ext.connectHW = function(hw, pin) {
    hwList.add(hw, pin);
  };

  ext.rotateServo = function(servo, deg) {
    var hw = hwList.search(servo);
    if (!hw) return;
    if (deg < 0) deg = 0;
    else if (deg > 180) deg = 180;
    rotateServo(hw.pin, deg);
    hw.val = deg;
  };

  ext.changeServo = function(servo, change) {
    var hw = hwList.search(servo);
    if (!hw) return;
    var deg = hw.val + change;
    if (deg < 0) deg = 0;
    else if (deg > 180) deg = 180;
    rotateServo(hw.pin, deg);
    hw.val = deg;
  };

  ext.setLED = function(led, val) {
    var hw = hwList.search(led);
    if (!hw) return;
    analogWrite(hw.pin, val);
    hw.val = val;
  };

  ext.changeLED = function(led, val) {
    var hw = hwList.search(led);
    if (!hw) return;
    var b = hw.val + val;
    if (b < 0) b = 0;
    else if (b > 100) b = 100;
    analogWrite(hw.pin, b);
    hw.val = b;
  };

  ext.digitalLED = function(led, val) {
    var hw = hwList.search(led);
    if (!hw) return;
    if (val == 'on') {
      digitalWrite(hw.pin, HIGH);
      hw.val = 255;
    } else if (val == 'off') {
      digitalWrite(hw.pin, LOW);
      hw.val = 0;
    }
  };
  
  ext.readInput = function(name) {
    var hw = hwList.search(name);
    if (!hw) return;
    return analogRead(hw.pin);
  };

  ext.whenButton = function(btn, state) {
    var hw = hwList.search(btn);
    if (!hw) return;
    if (state === 'pressed')
      return digitalRead(hw.pin);
    else if (state === 'released')
      return !digitalRead(hw.pin);
  };

  ext.isButtonPressed = function(btn) {
    var hw = hwList.search(btn);
    if (!hw) return;
    return digitalRead(hw.pin);
  };

  ext.whenInput = function(name, op, val) {
    var hw = hwList.search(name);
    if (!hw) return;
    if (op == '>')
      return analogRead(hw.pin) > val;
    else if (op == '<')
      return analogRead(hw.pin) < val;
    else if (op == '=')
      return analogRead(hw.pin) == val;
    else
      return false;
  };

  ext.mapValues = function(val, aMin, aMax, bMin, bMax) {
    var output = (((bMax - bMin) * (val - aMin)) / (aMax - aMin)) + bMin;
    return Math.round(output);
  };
 
  ext._getStatus = function() {
    if (!connected)
      return { status:1, msg:'Disconnected' };
    else
      return { status:2, msg:'Connected' };
  };

  ext._deviceRemoved = function(dev) {
    console.log('Device removed');
    // Not currently implemented with serial devices
  };

  var potentialDevices = [];
  ext._deviceConnected = function(dev) {
    potentialDevices.push(dev);
    if (!device)
      tryNextDevice();
  };

  var poller = null;
  var watchdog = null;
  function tryNextDevice() {
    device = potentialDevices.shift();
    if (!device) return;

    device.open({ stopBits: 0, bitRate: 57600, ctsFlowControl: 0 });
    console.log('Attempting connection with ' + device.id);
    device.set_receive_handler(function(data) {
      var inputData = new Uint8Array(data);
      processInput(inputData);
    });

    poller = setInterval(function() {
      queryFirmware();
    }, 1000);

    watchdog = setTimeout(function() {
      clearInterval(poller);
      poller = null;
      device.set_receive_handler(null);
      device.close();
      device = null;
      tryNextDevice();
    }, 5000);
  }

  ext._shutdown = function() {
    // TODO: Bring all pins down 
    if (device) device.close();
    if (poller) clearInterval(poller);
    device = null;
  };

  // Check for GET param 'lang'
  var paramString = window.location.search.replace(/^\?|\/$/g, '');
  var vars = paramString.split("&");
  var lang = 'en';
  for (var i=0; i<vars.length; i++) {
    var pair = vars[i].split('=');
    if (pair.length > 1 && pair[0]=='lang')
      lang = pair[1];
  }

  var blocks = {
    en: [
      ['h', 'when device is connected', 'whenConnected'],
      [' ', 'connect %m.hwOut to pin %n', 'connectHW', 'led A', 3],
      [' ', 'connect %m.hwIn to analog %n', 'connectHW', 'rotation knob', 0],
      ['-'],
      [' ', 'set %m.leds %m.outputs', 'digitalLED', 'led A', 'on'],
      [' ', 'set %m.leds brightness to %n%', 'setLED', 'led A', 100],
      [' ', 'change %m.leds brightness by %n%', 'changeLED', 'led A', 20],
      ['-'],
      [' ', 'rotate %m.servos to %n degrees', 'rotateServo', 'servo A', 180],
      [' ', 'rotate %m.servos by %n degrees', 'changeServo', 'servo A', 20],
      ['-'],
      ['h', 'when %m.buttons is %m.btnStates', 'whenButton', 'button A', 'pressed'],
      ['b', '%m.buttons pressed?', 'isButtonPressed', 'button A'],
      ['-'],
      ['h', 'when %m.hwIn %m.ops %n%', 'whenInput', 'rotation knob', '>', 50],
      ['r', 'read %m.hwIn', 'readInput', 'rotation knob'],
      ['-'],
      [' ', 'set pin %n %m.outputs', 'digitalWrite', 1, 'on'],
      [' ', 'set pin %n to %n%', 'analogWrite', 3, 100],
      ['-'],
      ['h', 'when pin %n is %m.outputs', 'whenDigitalRead', 1, 'on'],
      ['b', 'pin %n on?', 'digitalRead', 1],
      ['-'],
      ['h', 'when analog %n %m.ops %n%', 'whenAnalogRead', 1, '>', 50],
      ['r', 'read analog %n', 'analogRead', 0],
      ['-'],
      ['r', 'map %n from %n %n to %n %n', 'mapValues', 50, 0, 100, -240, 240]
    ],
    de: [
      ['h', 'Wenn Arduino verbunden ist', 'whenConnected'],
      [' ', 'Verbinde %m.hwOut mit Pin %n', 'connectHW', 'LED A', 3],
      [' ', 'Verbinde %m.hwIn mit Analog %n', 'connectHW', 'Drehknopf', 0],
      ['-'],
      [' ', 'Schalte %m.leds %m.outputs', 'digitalLED', 'LED A', 'Ein'],
      [' ', 'Setze %m.leds Helligkeit auf %n%', 'setLED', 'LED A', 100],
      [' ', 'Ändere %m.leds Helligkeit um %n%', 'changeLED', 'LED A', 20],
      ['-'],
      [' ', 'Drehe %m.servos auf %n Grad', 'rotateServo', 'Servo A', 180],
      [' ', 'Drehe %m.servos um %n Grad', 'changeServo', 'Servo A', 20],
      ['-'],
      ['h', 'Wenn %m.buttons ist %m.btnStates', 'whenButton', 'Taste A', 'gedrückt'],
      ['b', '%m.buttons gedrückt?', 'isButtonPressed', 'Taste A'],
      ['-'],
      ['h', 'Wenn %m.hwIn %m.ops %n%', 'whenInput', 'Drehknopf', '>', 50],
      ['r', 'Wert von %m.hwIn', 'readInput', 'Drehknopf'],
      ['-'],
      [' ', 'Schalte Pin %n %m.outputs', 'digitalWrite', 1, 'Ein'],
      [' ', 'Setze Pin %n auf %n%', 'analogWrite', 3, 100],
      ['-'],
      ['h', 'Wenn Pin %n ist %m.outputs', 'whenDigitalRead', 1, 'Ein'],
      ['b', 'Pin %n ein?', 'digitalRead', 1],
      ['-'],
      ['h', 'Wenn Analog %n %m.ops %n%', 'whenAnalogRead', 1, '>', 50],
      ['r', 'Wert von Analog %n', 'analogRead', 0],
      ['-'],
      ['r', 'Setze %n von %n %n auf %n %n', 'mapValues', 50, 0, 100, -240, 240]
    ],
    it: [
      ['h', 'quando Arduino è connesso', 'whenConnected'],
      [' ', 'connetti il %m.hwOut al pin %n', 'connectHW', 'led A', 3],
      [' ', 'connetti il %m.hwIn ad analog %n', 'connectHW', 'potenziometro', 0],
      ['-'],
      [' ', '%m.outputs il %m.leds', 'digitalLED', 'led A', 'on'],
      [' ', 'porta luminosità di %m.leds a %n%', 'setLED', 'led A', 100],
      [' ', 'cambia luminosità di %m.leds a %n%', 'changeLED', 'led A', 20],
      ['-'],
      [' ', 'ruota %m.servos fino a %n gradi', 'rotateServo', 'servo A', 180],
      [' ', 'ruota %m.servos di %n gradi', 'changeServo', 'servo A', 20],
      ['-'],
      ['h', 'quando tasto %m.buttons è %m.btnStates', 'whenButton', 'pulsante A', 'premuto'],
      ['b', '%m.buttons premuto?', 'isButtonPressed', 'pulsante A'],
      ['-'],
      ['h', 'quando %m.hwIn %m.ops %n%', 'whenInput', 'potenziometro', '>', 50],
      ['r', 'leggi %m.hwIn', 'readInput', 'potenziometro'],
      ['-'],
      [' ', 'porta pin %n a %m.outputs', 'digitalWrite', 1, 'acceso'],
      [' ', 'porta pin %n al %n%', 'analogWrite', 3, 100],
      ['-'],
      ['h', 'quando pin %n è %m.outputs', 'whenDigitalRead', 1, 'acceso'],
      ['b', 'pin %n acceso?', 'digitalRead', 1],
      ['-'],
      ['h', 'quando analog %n %m.ops %n%', 'whenAnalogRead', 1, '>', 50],
      ['r', 'leggi analog %n', 'analogRead', 0],
      ['-'],
      ['r', 'porta %n da %n %n a %n %n', 'mapValues', 50, 0, 100, -240, 240]
    ],
    ja: [
      ['h', '????????????', 'whenConnected'],
      [' ', '%m.hwOut ? %n ??????', 'connectHW', 'led A', 3],
      [' ', '%m.hwIn ??????? %n ??????', 'connectHW', 'rotation knob', 0],
      ['-'],
      [' ', '%m.leds ? %m.outputs ???', 'digitalLED', 'led A', 'on'],
      [' ', '%m.leds ????? %n% ???', 'setLED', 'led A', 100],
      [' ', '%m.leds ????? %n% ?????', 'changeLED', 'led A', 20],
      ['-'],
      [' ', '%m.servos ? %n ?????', 'rotateServo', 'servo A', 180],
      [' ', '%m.servos ? %n ?????', 'changeServo', 'servo A', 20],
      ['-'],
      ['h', '%m.buttons ? %m.btnStates ??', 'whenButton', '??? A', '????'],
      ['b', '%m.buttons ????', 'isButtonPressed', '??? A'],
      ['-'],
      ['h', '%m.hwIn ? %m.ops %n% ??????', 'whenInput', '?????', '>', 50],
      ['r', '%m.hwIn ??', 'readInput', '?????'],
      ['-'],
      [' ', '?????? %n ? %m.outputs ???', 'digitalWrite', 1, 'on'],
      [' ', '?????? %n ? %n% ???', 'analogWrite', 3, 100],
      ['-'],
      ['h', '?????? %n ? %m.outputs ??????', 'whenDigitalRead', 1, 'on'],
      ['b', '?????? %n ???', 'digitalRead', 1],
      ['-'],
      ['h', '?????? %n ? %m.ops %n% ??????', 'whenAnalogRead', 1, '>', 50],
      ['r', '?????? %n ??', 'analogRead', 0],
      ['-'],
      ['r', '%n ? %n ... %n ?? %n ... %n ???', 'mapValues', 50, 0, 100, -240, 240]
    ],
    nb: [
      ['h', 'når enheten tilkobles', 'whenConnected'],
      [' ', 'koble %m.hwOut til digital %n', 'connectHW', 'LED A', 3],
      [' ', 'koble %m.hwIn til analog %n', 'connectHW', 'dreieknapp', 0],
      ['-'],
      [' ', 'sett %m.leds %m.outputs', 'digitalLED', 'LED A', 'på'],
      [' ', 'sett %m.leds styrke til %n%', 'setLED', 'LED A', 100],
      [' ', 'endre %m.leds styrke med %n%', 'changeLED', 'LED A', 20],
      ['-'],
      [' ', 'rotér %m.servos til %n grader', 'rotateServo', 'servo A', 180],
      [' ', 'rotér %m.servos med %n grader', 'changeServo', 'servo A', 20],
      ['-'],
      ['h', 'når %m.buttons %m.btnStates', 'whenButton', 'knapp A', 'trykkes'],
      ['b', '%m.buttons trykket?', 'isButtonPressed', 'knapp A'],
      ['-'],
      ['h', 'når %m.hwIn %m.ops %n%', 'whenInput', 'dreieknapp', '>', 50],
      ['r', '%m.hwIn verdi', 'readInput', 'dreieknapp'],
      ['-'],
      [' ', 'sett digital %n %m.outputs', 'digitalWrite', 1, 'på'],
      [' ', 'set utgang %n til %n%', 'analogWrite', 3, 100],
      ['-'],
      ['h', 'når digital %n er %m.outputs', 'whenDigitalRead', 1, 'på'],
      ['b', 'digital %n på?', 'digitalRead', 1],
      ['-'],
      ['h', 'når analog %n %m.ops %n%', 'whenAnalogRead', 1, '>', 50],
      ['r', 'analog %n verdi', 'analogRead', 0],
      ['-'],
      ['r', 'skalér %n fra %n %n til %n %n', 'mapValues', 50, 0, 100, -240, 240]
    ],
    nl: [
      ['h', 'als het apparaat verbonden is', 'whenConnected'],
      [' ', 'verbindt %m.hwOut met pin %n', 'connectHW', 'led A', 3],
      [' ', 'verbindt %m.hwIn met analoog %n', 'connectHW', 'draaiknop', 0],
      ['-'],
      [' ', 'schakel %m.leds %m.outputs', 'digitalLED', 'led A', 'on'],
      [' ', 'schakel %m.leds helderheid tot %n%', 'setLED', 'led A', 100],
      [' ', 'verander %m.leds helderheid met %n%', 'changeLED', 'led A', 20],
      ['-'],
      [' ', 'draai %m.servos tot %n graden', 'rotateServo', 'servo A', 180],
      [' ', 'draai %m.servos met %n graden', 'changeServo', 'servo A', 20],
      ['-'],
      ['h', 'wanneer %m.buttons is %m.btnStates', 'whenButton', 'knop A', 'in gedrukt'],
      ['b', '%m.knoppen in gedrukt?', 'isButtonPressed', 'knoppen A'],
      ['-'],
      ['h', 'wanneer%m.hwIn %m.ops %n%', 'whenInput', 'draaiknop', '>', 50],
      ['r', 'read %m.hwIn', 'readInput', 'draaiknop'],
      ['-'],
      [' ', 'schakel pin %n %m.outputs', 'digitalWrite', 1, 'on'],
      [' ', 'schakel pin %n tot %n%', 'analogWrite', 3, 100],
      ['-'],
      ['h', 'wanneer pin %n is %m.outputs', 'whenDigitalRead', 1, 'on'],
      ['b', 'pin %n aan?', 'digitalRead', 1],
      ['-'],
      ['h', 'wanneer analoge %n %m.ops %n%', 'whenAnalogRead', 1, '>', 50],
      ['r', 'lees analoge %n', 'analogRead', 0],
      ['-'],
      ['r', 'zet %n van %n %n tot %n %n', 'mapValues', 50, 0, 100, -240, 240]
    ],
    pt: [
      ['h', 'Quando dispositivo estiver conectado', 'whenConnected'],
      [' ', 'conectar%m.hwOut para pino %n', 'connectHW', 'led A', 3],
      [' ', 'conectar %m.hwIn para analogico %n', 'connectHW', 'potenciometro', 0],
      ['-'],
      [' ', 'estado %m.leds %m.outputs', 'digitalLED', 'led A', 'ligado'],
      [' ', 'estado %m.leds brilho to %n%', 'setLED', 'led A', 100],
      [' ', 'mudar %m.leds brilho em %n%', 'changeLED', 'led A', 20],
      ['-'],
      [' ', 'girar %m.servos para %n graus', 'rotateServo', 'servo A', 180],
      [' ', 'girar %m.servos em %n graus', 'changeServo', 'servo A', 20],
      ['-'],
      ['h', 'quando %m.buttons is %m.btnStates', 'whenButton', 'botao A', 'pressionado'],
      ['b', '%m.buttons pressionado?', 'isButtonPressed', 'botao A'],
      ['-'],
      ['h', 'quando %m.hwIn %m.ops %n%', 'whenInput', 'potenciometro', '>', 50],
      ['r', 'read %m.hwIn', 'readInput', 'potenciometro'],
      ['-'],
      [' ', 'estado digital pino %n %m.outputs', 'digitalWrite', 1, 'ligado'],
      [' ', 'estado analogico pino %n to %n%', 'analogWrite', 3, 100],
      ['-'],
      ['h', 'quando pino %n is %m.outputs', 'whenDigitalRead', 1, 'ligado'],
      ['b', 'pino %n ligado?', 'digitalRead', 1],
      ['-'],
      ['h', 'quando valor analogico %n %m.ops %n%', 'whenAnalogRead', 1, '>', 50],
      ['r', 'ler valor analogico %n', 'analogRead', 0],
      ['-'],
      ['r', 'mapear %n from %n %n to %n %n', 'mapValues', 50, 0, 100, -240, 240]
    ],
    el: [
      ['h', '?ta? ? s?s?e?? e??a? s??dedeµ???', 'whenConnected'],
      [' ', 's??dese t? %m.hwOut st? pin %n', 'connectHW', 'led A', 3],
      [' ', 's??dese t? %m.hwIn st? a?a?????? %n', 'connectHW', 'p??tes??µet??', 0],
      ['-'],
      [' ', '???a?e t? %m.leds se %m.outputs', 'digitalLED', 'led A', 'e?e???p???µ???'],
      [' ', '???se st? %m.leds t? f?te???t?ta ?s? µe %n%', 'setLED', 'led A', 100],
      [' ', '???a?e st? %m.leds t? f?te???t?ta ?at? %n%', 'changeLED', 'led A', 20],
      ['-'],
      [' ', 'st???e t? %m.servos st?? %n µ???e?', 'rotateServo', 'servo A', 180],
      [' ', 'st???e t? %m.servos ?at? %n µ???e?', 'changeServo', 'servo A', 20],
      ['-'],
      ['h', '?ta? t? %m.buttons e??a? %m.btnStates', 'whenButton', '???µp? A', 'pat?µ???'],
      ['b', 't? %m.buttons pat????e;', 'isButtonPressed', '???µp? A'],
      ['-'],
      ['h', '?ta? t? %m.hwIn %m.ops %n%', 'whenInput', 'p??tes??µet??', '>', 50],
      ['r', 'd??ßase %m.hwIn', 'readInput', 'p??tes??µet??'],
      ['-'],
      [' ', '???a?e t? pin %n se %m.outputs', 'digitalWrite', 1, 'e?e???p???µ???'],
      [' ', '???se t? pin %n se %n%', 'analogWrite', 3, 100],
      ['-'],
      ['h', '?ta? t? pin %n e??a? %m.outputs', 'whenDigitalRead', 1, 'e?e???p???µ???'],
      ['b', 't? pin %n e??a? e?e???p???µ???;', 'digitalRead', 1],
      ['-'],
      ['h', '?ta? t? a?a?????? %n %m.ops %n%', 'whenAnalogRead', 1, '>', 50],
      ['r', 'd??ßase t? a?a?????? %n', 'analogRead', 0],
      ['-'],
      ['r', 's?s??t?se %n ap? %n %n ??? %n %n', 'mapValues', 50, 0, 100, -240, 240]
    ]
  };

  var menus = {
    en: {
      buttons: ['button A', 'button B', 'button C', 'button D'],
      btnStates: ['pressed', 'released'],
      hwIn: ['rotation knob', 'light sensor', 'temperature sensor'],
      hwOut: ['led A', 'led B', 'led C', 'led D', 'button A', 'button B', 'button C', 'button D', 'servo A', 'servo B', 'servo C', 'servo D'],
      leds: ['led A', 'led B', 'led C', 'led D'],
      outputs: ['on', 'off'],
      ops: ['>', '=', '<'],
      servos: ['servo A', 'servo B', 'servo C', 'servo D']
    },  
    de: {
      buttons: ['Taste A', 'Taste B', 'Taste C', 'Taste D'],
      btnStates: ['gedrückt', 'losgelassen'],
      hwIn: ['Drehknopf', 'Lichtsensor', 'Temperatursensor'],
      hwOut: ['LED A', 'LED B', 'LED C', 'LED D', 'Taste A', 'Taste B', 'Taste C', 'Taste D', 'Servo A', 'Servo B', 'Servo C', 'Servo D'],
      leds: ['LED A', 'LED B', 'LED C', 'LED D'],
      outputs: ['Ein', 'Aus'],
      ops: ['>', '=', '<'],
      servos: ['Servo A', 'Servo B', 'Servo C', 'Servo D']
    },
    it: {
      buttons: ['pulsante A', 'pulsante B', 'pulsante C', 'pulsante D'],
      btnStates: ['premuto', 'rilasciato'],
      hwIn: ['potenziometro', 'sensore di luce', 'sensore di temperatura'],
      hwOut: ['led A', 'led B', 'led C', 'led D', 'pulsante A', 'pulsante B', 'pulsante C', 'pulsante D', 'servo A', 'servo B', 'servo C', 'servo D'],
      leds: ['led A', 'led B', 'led C', 'led D'],
      outputs: ['acceso', 'spento'],
      ops: ['>', '=', '<'],
      servos: ['servo A', 'servo B', 'servo C', 'servo D']
    },
    ja: {
      buttons: ['??? A', '??? B', '??? C', '??? D'],
      btnStates: ['????', '????'],
      hwIn: ['?????', '?????', '??????'],
      hwOut: ['led A', 'led B', 'led C', 'led D', '??? A', '??? B', '??? C', '??? D', '??? A', '??? B', '??? C', '??? D'],
      leds: ['led A', 'led B', 'led C', 'led D'],
      outputs: ['??', '??'],
      ops: ['>', '=', '<'],
      servos: ['??? A', '??? B', '??? C', '??? D']
    },
    nb: {
      buttons: ['knapp A', 'knapp B', 'knapp C', 'knapp D'],
      btnStates: ['trykkes', 'slippes'],
      hwIn: ['dreieknapp', 'lyssensor', 'temperatursensor'],
      hwOut: ['LED A', 'LED B', 'LED C', 'LED D', 'knapp A', 'knapp B', 'knapp C', 'knapp D', 'servo A', 'servo B', 'servo C', 'servo D'],
      leds: ['LED A', 'LED B', 'LED C', 'LED D'],
      outputs: ['på', 'av'],
      ops: ['>', '=', '<'],
      servos: ['servo A', 'servo B', 'servo C', 'servo D']
    },
    nl: {
      buttons: ['knop A', 'knop B', 'knop C', 'knop D'],
      btnStates: ['ingedrukt', 'losgelaten'],
      hwIn: ['draaiknop', 'licht sensor', 'temperatuur sensor'],
      hwOut: ['led A', 'led B', 'led C', 'led D', 'knop A', 'knop B', 'knop C', 'knop D', 'servo A', 'servo B', 'servo C', 'servo D'],
      leds: ['led A', 'led B', 'led C', 'led D'],
      outputs: ['aan', 'uit'],
      ops: ['>', '=', '<'],
      servos: ['servo A', 'servo B', 'servo C', 'servo D']
    },
    pt: {
      buttons: ['botao A', 'botao B', 'botao C', 'botao D'],
      btnStates: ['pressionado', 'solto'],
      hwIn: ['potenciometro', 'sensor de luz', 'sensor de temperatura'],
      hwOut: ['led A', 'led B', 'led C', 'led D', 'botao A', 'botao B', 'botao C', 'botao D', 'servo A', 'servo B', 'servo C', 'servo D'],
      leds: ['led A', 'led B', 'led C', 'led D'],
      outputs: ['ligado', 'desligado'],
      ops: ['>', '=', '<'],
      servos: ['servo A', 'servo B', 'servo C', 'servo D']
    },
    el: {
      buttons: ['???µp? A', '???µp? B', '???µp? C', '???µp? D'],
      btnStates: ['pat?µ???', 'e?e??e??'],
      hwIn: ['p??tes??µet??', 'f?t?a?s??t??a', '?e?µ?a?s??t??a'],
      hwOut: ['led A', 'led B', 'led C', 'led D', '???µp? A', '???µp? B', '???µp? C', '???µp? D', 'servo A', 'servo B', 'servo C', 'servo D'],
      leds: ['led A', 'led B', 'led C', 'led D'],
      outputs: ['e?e???p???µ???', 'ape?e???p???µ???'],
      ops: ['>', '=', '<'],
      servos: ['servo A', 'servo B', 'servo C', 'servo D']
    }
  };

  var descriptor = {
    blocks: blocks[lang],
    menus: menus[lang],
    url: 'http://khanning.github.io/scratch-arduino-extension'
  };

  ScratchExtensions.register('Arduino', descriptor, ext, {type:'serial'});

	if (typeof Tone !== 'undefined') {
		console.log('Tone library is already loaded');
		startSynth();
	} else {
		$.getScript('http://ericrosenbaum.github.io/tone-synth-extension/Tone.min.js', startSynth);
	}

	function startSynth() {
		var tone = new Tone();
		
		// synth is a single oscillator

		var synthOptions = {
			oscillator: {
				type: "triangle"
			},
			envelope: {
				attack: 0.03,
				decay: 0,
				sustain: 1,
				release: 0.03
			},
		};			
		
		var synth = new Tone.SimpleSynth(synthOptions);

		synth.portamento = 0;

		// effects chain

		var autoWah = new Tone.AutoWah();
		autoWah.wet.value = 0;
		autoWah.sensitivity.value = -40;

		var delay = new Tone.FeedbackDelay(0.25, 0.5);
		delay.wet.value = 0;
		
		var panner = new Tone.Panner(0.5);
		
		synth.connect(autoWah);
		autoWah.connect(delay);
		delay.connect(panner);
		panner.toMaster();

		// target frequency is used for the reporter, since
		// the actual frequency may ramp, portamento etc.

		var targetFreq = synth.frequency.value;

		var scaleRoot = 48; // root is note C2
		var minNote = 24;
		var maxNote = 127;
		
		// polysynth
		// var polySynth = new Tone.PolySynth(6, Tone.MonoSynth).toMaster();

		/*
		// timers for time interval hats 
		var intervalNames = ['bar', 'two bars', 'four bars', 'eight bars'];
		var intervalNotation = ['1m', '2m', '4m', '8m'];
		var intervalFlags = [];
		for (var i = 0; i < intervalNames.length; i++) {
			intervalFlags[i] = false;
			Tone.Transport.setInterval(function(i, time){
				intervalFlags[i] = true;
			}.bind(undefined, i), intervalNotation[i]);
		}
		Tone.Transport.start();
		Tone.Transport.loop = true;
		*/

		// Cleanup function when the extension is unloaded
		ext._shutdown = function() {
			stopAllSounds();
		};

		// Status reporting code
		// Use this to report missing hardware, plugin or unsupported browser
		ext._getStatus = function() {
			if (typeof AudioContext !== "undefined") {
				return {status: 2, msg: 'Ready'};
			} else {
				return {status: 1, msg: 'Browser not supported'};
			}
		};

		function stopAllSounds() {
			synth.triggerRelease();	
		}

		/// turn synth on and off

		ext.synthOnFor = function(secs) {
			synth.triggerAttackRelease(targetFreq, secs);
		};
		
		ext.synthOnForAndWait = function(secs, callback) {
			synth.triggerAttackRelease(targetFreq, secs);
			window.setTimeout(function() {
	            callback();
	        }, secs*1000);
		};

		ext.synthOn = function() {
			synth.triggerAttack(targetFreq);
		};

		ext.synthOff = function() {
			synth.triggerRelease();
		};

		// synth note control

		ext.synthSetFreq = function(control, val) {
			switch (control) {
				case 'note':
					var note = clamp(val, minNote, maxNote);
					targetFreq = midiToFrequency(note);
					synth.setNote(targetFreq);
					break;
				case 'major scale note':
					var note = majorScaleToMidi(val);
					note = clamp(note, minNote, maxNote);
					targetFreq = midiToFrequency(note);
					synth.setNote(targetFreq);					
					break;
				case 'frequency':
					targetFreq = val;
					synth.setNote(targetFreq);
					break;
			}
		};

		ext.synthChangeFreq = function(control, val) {
			switch (control) {									
				case 'note':
					var ratio = tone.intervalToFrequencyRatio(val);
					targetFreq *= ratio;
					synth.setNote(targetFreq);
					break;
				case 'major scale note':
					var currentNoteName = tone.frequencyToNote(targetFreq);
					var currentMidiNote = tone.noteToMidi(noteName);
					// this requires more work!
					// need to find current nearest major scale degree and octave
					// then modify and convert back to midi then to freq

					break;
				case 'frequency':
					targetFreq += val;
					synth.setNote(targetFreq);
					break;
			}
		};

		ext.synthGetFreq = function(control) {
			switch (control) {
				case 'note':
					var noteName = tone.frequencyToNote(targetFreq);
					var midiNote = tone.noteToMidi(noteName);
					return (midiNote);
					break;
				case 'major scale note':
					// needs work!
					break;
				case 'frequency':
					return targetFreq;
					break;
			}
		};

		function midiToFrequency(noteNum) {
			return tone.toFrequency(tone.midiToNote(noteNum));
		};

		function majorScaleToMidi(note) {
			var majorScale = [0,2,4,5,7,9,11,12];
			note = round(note);
			var scaleDegree = note % majorScale.length;
			var octave = floor(note / majorScale.length);
			var midiNote = scaleRoot + octave * 12 + majorScale[scaleDegree];
			return (midiNote);
		};

		// effects

		ext.setEffect = function(effectName, amt) {
			amt = clamp(amt, 0, 100);
			amt /= 100;

			switch (effectName) {
				case 'echo': 
					delay.wet.value = amt/2;
					break;
				case 'wah': 
					if (amt == 0) {
						autoWah.wet.value = 0;
					} else {
						autoWah.wet.value = 1;
					}
					autoWah.Q.value = amt * 6;
					break;
				case 'pan left/right': 
					panner.pan.value = amt;
					break;
				case 'glide':
					synth.portamento = amt * 0.25; 
					break;
				case 'volume':
					var db = tone.gainToDb(amt);
					Tone.Master.volume.rampTo(db, 0.01);
					break;
			}
		};

		ext.changeEffect = function(effectName, amt) {
			amt /= 100;

			switch (effectName) {
				case 'echo': 
					delay.wet.value += amt/2;
					delay.wet.value = clamp(delay.wet.value, 0, 0.5);
					break;
				case 'wah': 
					autoWah.Q.value += amt * 6;
					autoWah.Q.value = clamp(autoWah.Q.value, 0, 6);
					if (autoWah.Q.value == 0) {
						autoWah.wet.value = 0;
					} else {
						autoWah.wet.value = 1;
					}
					break;
				case 'pan left/right': 
					panner.pan.value += amt;
					panner.pan.value = clamp(panner.pan.value, 0, 1);
					break;
				case 'glide':
					synth.portamento += amt * 0.25; 
					break;
				case 'volume':
					var currentDb = Tone.Master.volume.value;
					var currentVol = tone.dbToGain(currentDb);
					var newVol = currentVol + amt; 
					newVol = clamp(newVol, 0, 1);
					var db = tone.gainToDb(newVol);
					Tone.Master.volume.rampTo(db, 0.01);
					break;
			}
		};

		ext.clearEffects = function() {
			delay.wet.value = 0;
			autoWah.Q.value = 0;
			autoWah.wet.value = 0;
			panner.pan.value = 0.5;
			synth.portamento = 0;
			Tone.Master.volume.rampTo(0, 0.01);
		};

		ext.setDelayTime = function(delayTime) {
			delay.delayTime.value = delayTime;
		};

		ext.setOscType = function(type) {
			synth.oscillator.type = type;
		};

		function clamp(input, min, max) {
			return Math.min(Math.max(input, min), max);
		};

		/*
		ext.intervalHat = function(interval) {
			for (var i = 0; i < intervalNames.length; i++) {
				if (interval == intervalNames[i]) {
					if (intervalFlags[i]) {
						intervalFlags[i] = false;
						return true;
					} else {
						return false;
					}
				}
			}
		};

		ext.scheduleNote = function(note, duration, delay) {
			var freq = getFreqForNote(note);
			// polySynth.triggerAttackRelease(freq, duration, '+' + delay);
			Tone.Transport.setTimeout(function(time){
			 	polySynth.triggerAttackRelease(freq, duration, time);
			}, delay);
		};
		*/

		// Block and block menu descriptions

		var descriptor = {
			blocks: [

				[' ', 'synth on for %n secs', 'synthOnFor', 0.5],
				['w', 'synth on for %n secs and wait', 'synthOnForAndWait', 0.5],
				[' ', 'synth on', 'synthOn'],
				[' ', 'synth off', 'synthOff'],

				[' ', 'synth set %m.freqControls %n', 'synthSetFreq', 'note', 60],
				[' ', 'synth change %m.freqControls by %n', 'synthChangeFreq', 'note', 1],
				['r', 'synth %m.freqControls', 'synthGetFreq', 'note'],

				[' ', 'set synth effect %m.effects to %n%', 'setEffect', 'echo', 100],
				[' ', 'change synth effect %m.effects by %n%', 'changeEffect', 'echo', 10],
				[' ', 'clear synth effects', 'clearEffects'],

				[' ', 'set echo delay time %n secs', 'setDelayTime', 0.5],

				[' ', 'synth oscillator type %m.oscTypes', 'setOscType', 'square']

			],
				menus: {
					effects: ['echo', 'wah', 'pan left/right', 'glide', 'volume'],
					oscTypes: ['sine', 'triangle', 'square', 'sawtooth', 'pwm'],
					freqControls: ['note', 'frequency']
				}
		};

		// Register the extension
		ScratchExtensions.register('Synth Extension', descriptor, ext);
	
	};


})({});
