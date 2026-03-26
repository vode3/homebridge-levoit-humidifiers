import {
  CharacteristicGetHandler,
  CharacteristicSetHandler,
  CharacteristicValue,
  Nullable,
} from 'homebridge';

import { AccessoryThisType } from '../VeSyncAccessory';
import { queueLightColorUpdate } from './LightColorUpdate';

const characteristic: {
  get: CharacteristicGetHandler;
  set: CharacteristicSetHandler;
} & AccessoryThisType = {
  get: async function (): Promise<Nullable<CharacteristicValue>> {
    await this.device.updateInfo();
    return this.device.lightSaturation;
  },
  set: async function (value: CharacteristicValue) {
    await queueLightColorUpdate(this.device, {
      saturation: Number(value),
    });
  },
};

export default characteristic;
