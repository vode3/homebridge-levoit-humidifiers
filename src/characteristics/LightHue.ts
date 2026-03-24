import {
  CharacteristicGetHandler,
  CharacteristicSetHandler,
  CharacteristicValue,
  Nullable,
} from 'homebridge';

import { AccessoryThisType } from '../VeSyncAccessory';

const characteristic: {
  get: CharacteristicGetHandler;
  set: CharacteristicSetHandler;
} & AccessoryThisType = {
  get: async function (): Promise<Nullable<CharacteristicValue>> {
    await this.device.updateInfo();
    return this.device.lightHue;
  },
  set: async function (value: CharacteristicValue) {
    await this.device.updateInfo();
    await this.device.setLightColor(
      Number(value),
      this.device.lightSaturation,
    );
  },
};

export default characteristic;
