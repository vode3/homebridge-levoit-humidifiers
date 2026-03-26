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
    return this.device.brightnessLevel;
  },
  set: async function (value: CharacteristicValue) {
    // Convert value to number
    value = Number(value);

    if (this.device.brightnessLevel > 0 && value > 0) {
      // If light is on, and we are applying a non-zero value, change brightness to that level.
      // Otherwise, LightState will handle on / off switching.

      // Handle Color Mode (RGB) devices
      if (this.device.deviceType.hasColorMode) {
        // VeSync RGB nightlights only support brightness 40-100 while on.
        // Apple Home may send lower non-zero values during color adjustments,
        // so clamp them instead of accidentally turning the light off.
        if (value < 40) {
          value = 40;
        }
        await this.device.setLightStatus('on', Number(value));
      } else {
        // Other devices
        await this.device.setBrightness(Number(value));
      }
    }
  },
};

export default characteristic;
