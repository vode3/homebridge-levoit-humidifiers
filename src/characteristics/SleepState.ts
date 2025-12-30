import {
  CharacteristicGetHandler,
  CharacteristicSetHandler,
  CharacteristicValue,
  Nullable,
} from 'homebridge';
import { Mode } from '../api/VeSyncFan';

import { AccessoryThisType } from '../VeSyncAccessory';
import { DevicePrefix } from '../api/deviceTypes';

const characteristic: {
  get: CharacteristicGetHandler;
  set: CharacteristicSetHandler;
} & AccessoryThisType = {
  get: async function (): Promise<Nullable<CharacteristicValue>> {
    await this.device.updateInfo();

    // If device is off, set the mode to null so the switch displays Off
    if (!this.device.isOn) {
      return false;
    }

    return this.device.mode === Mode.Sleep;
  },
  set: async function (value: CharacteristicValue) {
    switch (value) {
      case true:
        await this.device.changeMode(Mode.Sleep);
        break;
      case false:
        // LEH_S601S models have an auto and humidity mode, we want to revert to humidity for those models since Auto has its own switch
        if (this.device.model.includes(DevicePrefix.LEH_S601S)) {
          await this.device.changeMode(Mode.Humidity);
          break;
        } else {
          await this.device.changeMode(Mode.Auto);
          break;
        }
    }
  },
};

export default characteristic;
