import AsyncLock from 'async-lock';
import deviceTypes, {
  DevicePrefix,
  DeviceType,
  isNewFormatDevice,
} from './deviceTypes';

import VeSync, { BypassMethod } from './VeSync';

export enum Mode {
  Manual = 'manual',
  Sleep = 'sleep',
  Auto = 'auto',
  AutoPro = 'autoPro',
  Humidity = 'humidity',
}

const RGB_STALE_DATA_TIMEOUT_MS = 180000;
const RGB_FULL_BRIGHTNESS = 100;
const RGB_MIN_BRIGHTNESS = 40;

export default class VeSyncFan {
  private static readonly RGB_NIGHTLIGHT_GRADIENT: readonly [
    number,
    number,
    number,
  ][] = [
    [252, 50, 0],
    [255, 171, 2],
    [181, 255, 0],
    [2, 255, 120],
    [3, 200, 254],
    [0, 40, 255],
    [220, 0, 255],
    [254, 0, 60],
  ];

  private readonly lock: AsyncLock = new AsyncLock();
  public readonly deviceType: DeviceType;
  private lastCheck = 0;
  private lastLightSetAt = 0;

  private _displayOn = true;

  public readonly manufacturer = 'Levoit';

  public get humidityLevel() {
    return this._humidityLevel;
  }

  public get targetHumidity() {
    return this._targetHumidity;
  }

  public get displayOn() {
    return this._displayOn;
  }

  public get brightnessLevel() {
    return this._brightnessLevel;
  }

  public get mistLevel() {
    return this._mistLevel;
  }

  public get warmLevel() {
    return this._warmLevel;
  }

  public get warmEnabled() {
    return this._warmEnabled;
  }

  public get lightOn() {
    return this._lightOn;
  }

  public get mode() {
    return this._mode;
  }

  public get targetReached() {
    return this._targetReached;
  }

  public get isOn() {
    return this._isOn;
  }

  public get getBlue() {
    return this._blue;
  }

  public get getGreen() {
    return this._green;
  }

  public get getColorMode() {
    return this._colorMode;
  }

  public get getColorSliderLocation() {
    return this._colorSliderLocation;
  }

  public get getLightSpeed() {
    return this._lightSpeed;
  }

  public get getRed() {
    return this._red;
  }

  public get lightHue() {
    return VeSyncFan.rgbToHsv(this._red, this._green, this._blue).hue;
  }

  public get lightSaturation() {
    return VeSyncFan.rgbToHsv(this._red, this._green, this._blue).saturation * 100;
  }

  constructor(
    private readonly client: VeSync,
    public readonly name: string,
    private _mode: Mode,
    private _isOn: boolean,
    private _mistLevel: number,
    private _warmLevel: number,
    private _warmEnabled: boolean,
    private _brightnessLevel: number,
    private _humidityLevel: number,
    private _targetHumidity: number,
    private _targetReached: boolean,
    private _lightOn: string,
    private _lightSpeed: number,
    private _red: number,
    private _blue: number,
    private _green: number,
    private _colorMode: string,
    private _colorSliderLocation: number,
    public readonly configModule: string,
    public readonly cid: string,
    public readonly region: string,
    public readonly model: string,
    public readonly mac: string,
    public readonly uuid: string,
  ) {
    this.deviceType = deviceTypes.find(({ isValid }) => isValid(this.model))!;
  }

  public async setPower(power: boolean): Promise<boolean> {
    this.client.log.info('Setting Power to ' + power);
    let switchJson;
    if (isNewFormatDevice(this.model)) {
      switchJson = {
        powerSwitch: power ? 1 : 0,
        id: 0,
      };
    } else {
      switchJson = {
        enabled: power,
        id: 0,
      };
    }
    const success = await this.client.sendCommand(
      this,
      BypassMethod.SWITCH,
      switchJson,
    );

    if (success) {
      this._isOn = power;
      if (!this._isOn) {
        this._humidityLevel = 0;
        this._targetHumidity = 0;
        this._mistLevel = 0;
        this._warmLevel = 0;
      }
    } else {
      this.client.log.error('Failed to setPower due to unreachable device.');
      if (this.client.config.options.showOffWhenDisconnected) {
        this._isOn = false;
        this._humidityLevel = 0;
        this._targetHumidity = 0;
        this._displayOn = false;
        this._mistLevel = 0;
        this._warmLevel = 0;
        this._brightnessLevel = 0;
        this._lightOn = 'off';
      } else {
        return false;
      }
    }

    return success;
  }

  public async setTargetHumidity(level: number): Promise<boolean> {
    this.client.log.info('Setting Target Humidity to ' + level);

    // Oasis 1000 uses camelcase instead of snakecase
    let humidityJson;
    if (isNewFormatDevice(this.model)) {
      humidityJson = {
        targetHumidity: level,
        id: 0,
      };
    } else {
      humidityJson = {
        target_humidity: level,
        id: 0,
      };
    }

    const success = await this.client.sendCommand(
      this,
      BypassMethod.HUMIDITY,
      humidityJson,
    );

    if (success) {
      this._targetHumidity = level;
    }

    return success;
  }

  public async changeMode(mode: Mode): Promise<boolean> {
    // LV600s models use "Humidity" mode instead of "Auto"
    if (this.model.includes(DevicePrefix.LV600S) && mode == Mode.Auto) {
      mode = Mode.Humidity;
    }
    // Some models use "AutoPro" mode instead of "Auto"
    if (this.deviceType.hasAutoProMode && mode == Mode.Auto) {
      mode = Mode.AutoPro;
    }

    let success: boolean;

    // Oasis 1000 uses camelcase instead of snakecase
    let modeJson;
    if (isNewFormatDevice(this.model)) {
      modeJson = {
        workMode: mode.toString(),
      };
    } else {
      modeJson = {
        mode: mode.toString(),
      };
    }
    // Don't change the mode if we are already in that mode
    if (this._mode == mode) {
      success = true;
    } else {
      this.client.log.info('Changing Mode to ' + mode);
      success = await this.client.sendCommand(
        this,
        BypassMethod.MODE,
        modeJson,
      );
    }
    if (success) {
      this._mode = mode;
    }

    return success;
  }

  public async setBrightness(brightness: number): Promise<boolean> {
    this.client.log.info('Setting Night Light to ' + brightness);

    const success = await this.client.sendCommand(
      this,
      BypassMethod.NIGHT_LIGHT_BRIGHTNESS,
      {
        night_light_brightness: brightness,
      },
    );

    if (success) {
      this._brightnessLevel = brightness;
    }

    return success;
  }

  public async setDisplay(power: boolean): Promise<boolean> {
    this.client.log.info('Setting Display to ' + power);

    // Oasis 1000 uses camelcase instead of snakecase
    let displayJson;
    if (isNewFormatDevice(this.model)) {
      displayJson = {
        screenSwitch: power ? 1 : 0,
        id: 0,
      };
    } else {
      displayJson = {
        state: power,
        id: 0,
      };
    }

    const success = await this.client.sendCommand(
      this,
      BypassMethod.DISPLAY,
      displayJson,
    );

    if (success) {
      this._displayOn = power;
    }

    return success;
  }

  public async changeMistLevel(mistLevel: number): Promise<boolean> {
    if (mistLevel > this.deviceType.mistLevels || mistLevel < 1) {
      return false;
    }

    this.client.log.info('Setting Mist Level to ' + mistLevel);

    // New models use different JSON keys
    let mistJson;
    const method = BypassMethod.MIST_LEVEL;
    if (isNewFormatDevice(this.model)) {
      mistJson = {
        virtualLevel: mistLevel,
        levelType: 'mist',
        id: 0,
      };
    } else {
      mistJson = {
        level: mistLevel,
        type: 'mist',
        id: 0,
      };
    }

    const success = await this.client.sendCommand(this, method, mistJson);

    if (success) {
      this._mistLevel = mistLevel;
    }

    return success;
  }

  public async changeWarmMistLevel(warmMistLevel: number): Promise<boolean> {
    if (!this.deviceType.warmMistLevels) {
      this.client.log.error(
        'Error: Attempted to set warm level on device without warmMistLevels field.',
      );
      return false;
    }

    if (warmMistLevel > this.deviceType.warmMistLevels || warmMistLevel < 0) {
      return false;
    }

    this.client.log.info('Setting Warm Level to ' + warmMistLevel);

    const success = await this.client.sendCommand(this, BypassMethod.LEVEL, {
      level: warmMistLevel,
      type: 'warm',
      id: 0,
    });

    if (success) {
      this._warmLevel = warmMistLevel;
      if (this._warmLevel == 0) {
        this._warmEnabled = false;
      } else {
        this._warmEnabled = true;
      }
    }

    return success;
  }

  public async setLightStatus(
    action: string,
    brightness: number,
    red?: number,
    green?: number,
    blue?: number,
  ): Promise<boolean> {
    const normalizedAction = action === 'off' ? 'off' : 'on';
    const boundedBrightness =
      normalizedAction === 'off'
        ? VeSyncFan.clamp(brightness, 0, RGB_FULL_BRIGHTNESS)
        : VeSyncFan.clamp(brightness, RGB_MIN_BRIGHTNESS, RGB_FULL_BRIGHTNESS);
    const hasExplicitColor =
      red !== undefined || green !== undefined || blue !== undefined;
    const hasStoredColor = this.getRed !== 0 || this.getGreen !== 0 || this.getBlue !== 0;
    const currentRed = hasStoredColor ? this.getRed : 255;
    const currentGreen = hasStoredColor ? this.getGreen : 255;
    const currentBlue = hasStoredColor ? this.getBlue : 255;
    const baseRed = VeSyncFan.clamp(red ?? currentRed, 0, 255);
    const baseGreen = VeSyncFan.clamp(
      green ?? currentGreen,
      0,
      255,
    );
    const baseBlue = VeSyncFan.clamp(blue ?? currentBlue, 0, 255);
    const [payloadRed, payloadGreen, payloadBlue] =
      boundedBrightness === RGB_FULL_BRIGHTNESS
        ? [baseRed, baseGreen, baseBlue]
        : VeSyncFan.applyBrightnessToRgb(
            baseRed,
            baseGreen,
            baseBlue,
            boundedBrightness,
          );
    const colorMode = hasExplicitColor ? 'color' : this.getColorMode || 'color';
    const colorSliderLocation = VeSyncFan.rgbToColorSliderLocation(
      baseRed,
      baseGreen,
      baseBlue,
    );

    const lightJson = {
      action: normalizedAction,
      speed: this.getLightSpeed,
      red: payloadRed,
      green: payloadGreen,
      blue: payloadBlue,
      brightness: boundedBrightness,
      colorMode,
      colorSliderLocation,
    };
    this.client.log.debug(
      'Setting Night Light Status to ' + JSON.stringify(lightJson),
    );

    const success = await this.client.sendCommand(
      this,
      BypassMethod.LIGHT_STATUS,
      lightJson,
    );

    if (success) {
      this._brightnessLevel = boundedBrightness;
      this._blue = baseBlue;
      this._green = baseGreen;
      this._red = baseRed;
      this._lightOn = normalizedAction;
      this._colorMode = colorMode;
      this._colorSliderLocation = colorSliderLocation;
      this.lastLightSetAt = Date.now();
    }

    return success;
  }

  public async updateInfo(): Promise<void> {
    return this.lock.acquire('update-info', async () => {
      try {
        if (Date.now() - this.lastCheck < 5 * 1000) {
          return;
        }

        const data = await this.client.getDeviceInfo(this);

        this.lastCheck = Date.now();
        const deviceResult = data?.result?.result;
        if (
          !deviceResult &&
          this.client.config.options?.showOffWhenDisconnected
        ) {
          this._isOn = false;
          this._humidityLevel = 0;
          this._targetHumidity = 0;
          this._displayOn = false;
          this._mistLevel = 0;
          this._warmLevel = 0;
          this._brightnessLevel = 0;
          return;
        } else if (!deviceResult) {
          return;
        }

        const result = deviceResult;

        this._humidityLevel = (result.humidity as number) ?? 0;
        // Fields are different on newer models
        if (isNewFormatDevice(this.model)) {
          this._targetHumidity = (result.targetHumidity as number) ?? 0;
          this._displayOn = (result.screenSwitch as boolean) ?? false;
          this._mode = (result.workMode as Mode) ?? Mode.Auto;
          this._isOn = (result.powerSwitch as number) === 1;
          this._targetReached = (result.autoStopState as boolean) ?? false;
          this._mistLevel = (result.virtualLevel as number) ?? 0;
        } else {
          this._targetHumidity =
            (result.configuration?.auto_target_humidity as number) ?? 0;
          this._displayOn = (result.display as boolean) ?? false;
          this._mode = (result.mode as Mode) ?? Mode.Auto;
          this._isOn = (result.enabled as boolean) ?? false;
          this._targetReached =
            (result.automatic_stop_reach_target as boolean) ?? false;
          this._mistLevel = (result.mist_virtual_level as number) ?? 0;
        }

        this._warmLevel = (result.warm_level as number) ?? 0;
        this._warmEnabled = (result.warm_enabled as boolean) ?? false;

        if (this.deviceType.hasColorMode && result.rgbNightLight) {
          const skipRgbUpdate =
            this.lastLightSetAt > 0 &&
            Date.now() - this.lastLightSetAt < RGB_STALE_DATA_TIMEOUT_MS;

          if (!skipRgbUpdate) {
            const rgbBrightness = (result.rgbNightLight.brightness as number) ?? 0;
            this._brightnessLevel = rgbBrightness;
            this._lightOn = (result.rgbNightLight.action as string) ?? 'off';
            this._colorMode = (result.rgbNightLight.colorMode as string) ?? '';
            this._lightSpeed = (result.rgbNightLight.speed as number) ?? 0;
            this._colorSliderLocation =
              (result.rgbNightLight.colorSliderLocation as number) ?? 0;

            const rawRed = (result.rgbNightLight.red as number) ?? 0;
            const rawGreen = (result.rgbNightLight.green as number) ?? 0;
            const rawBlue = (result.rgbNightLight.blue as number) ?? 0;
            const [baseRed, baseGreen, baseBlue] =
              rgbBrightness > 0 && rgbBrightness < RGB_FULL_BRIGHTNESS
                ? VeSyncFan.normalizeRgbToFullBrightness(
                    rawRed,
                    rawGreen,
                    rawBlue,
                  )
                : [rawRed, rawGreen, rawBlue];

            this._red = baseRed;
            this._green = baseGreen;
            this._blue = baseBlue;
            this.lastLightSetAt = 0;
          }

          const lightJson = {
            action: this._lightOn,
            speed: this._lightSpeed,
            green: this._green,
            blue: this._blue,
            red: this._red,
            brightness: this._brightnessLevel,
            colorMode: this._colorMode,
            colorSliderLocation: this._colorSliderLocation,
          };

          this.client.debugMode.debug(
            '[GET LIGHT JSON]',
            JSON.stringify(lightJson),
          );
        } else {
          this._brightnessLevel = (result.night_light_brightness as number) ?? 0;
          this._lightOn = '';
          this._blue = 0;
          this._green = 0;
          this._red = 0;
          this._colorMode = '';
          this._lightSpeed = 0;
          this._colorSliderLocation = 0;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.client.log.error(
          'Failed to updateInfo due to unreachable device: ' + message,
        );
        if (this.client.config.options.showOffWhenDisconnected) {
          this._isOn = false;
          this._humidityLevel = 0;
          this._targetHumidity = 0;
          this._displayOn = false;
          this._mistLevel = 0;
          this._warmLevel = 0;
          this._brightnessLevel = 0;
        } else {
          throw new Error(
            'Device was unreachable. Ensure it is plugged in and connected to WiFi.',
          );
        }
      }
    });
  }

  public static readonly fromResponse =
    (client: VeSync) =>
    ({
      deviceName,
      mode,
      deviceStatus,
      mistLevel,
      warmLevel,
      warmEnabled,
      brightnessLevel,
      humidity,
      targetHumidity,
      targetReached,
      lightOn,
      lightSpeed,
      red,
      blue,
      green,
      colorMode,
      colorSliderLocation,
      configModule,
      cid,
      deviceRegion,
      deviceType,
      macID,
      uuid,
    }) =>
      new VeSyncFan(
        client,
        deviceName,
        mode,
        deviceStatus,
        mistLevel,
        warmLevel,
        warmEnabled,
        brightnessLevel,
        humidity,
        targetHumidity,
        targetReached,
        lightOn,
        lightSpeed,
        red,
        blue,
        green,
        colorMode,
        colorSliderLocation,
        configModule,
        cid,
        deviceRegion,
        deviceType,
        macID,
        uuid,
      );

  private static clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
  }

  private static colorDistance(
    red1: number,
    green1: number,
    blue1: number,
    red2: number,
    green2: number,
    blue2: number,
  ) {
    return (
      (red1 - red2) ** 2 + (green1 - green2) ** 2 + (blue1 - blue2) ** 2
    ) ** 0.5;
  }

  private static interpolateColor(
    color1: readonly [number, number, number],
    color2: readonly [number, number, number],
    fraction: number,
  ): [number, number, number] {
    return [
      Math.round(color1[0] + (color2[0] - color1[0]) * fraction),
      Math.round(color1[1] + (color2[1] - color1[1]) * fraction),
      Math.round(color1[2] + (color2[2] - color1[2]) * fraction),
    ];
  }

  private static rgbToHsv(red: number, green: number, blue: number) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;

    if (delta !== 0) {
      if (max === r) {
        hue = ((g - b) / delta) % 6;
      } else if (max === g) {
        hue = (b - r) / delta + 2;
      } else {
        hue = (r - g) / delta + 4;
      }
    }

    hue = Math.round(hue * 60);
    if (hue < 0) {
      hue += 360;
    }

    const saturation = max === 0 ? 0 : delta / max;
    return { hue, saturation, value: max };
  }

  private static hsvToRgb(
    hue: number,
    saturation: number,
    value: number,
  ): [number, number, number] {
    const boundedHue = ((hue % 360) + 360) % 360;
    const boundedSaturation = VeSyncFan.clamp(saturation, 0, 1);
    const boundedValue = VeSyncFan.clamp(value, 0, 1);
    const chroma = boundedValue * boundedSaturation;
    const huePrime = boundedHue / 60;
    const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
    let rgb: [number, number, number];

    if (huePrime < 1) {
      rgb = [chroma, x, 0];
    } else if (huePrime < 2) {
      rgb = [x, chroma, 0];
    } else if (huePrime < 3) {
      rgb = [0, chroma, x];
    } else if (huePrime < 4) {
      rgb = [0, x, chroma];
    } else if (huePrime < 5) {
      rgb = [x, 0, chroma];
    } else {
      rgb = [chroma, 0, x];
    }

    const match = boundedValue - chroma;
    return rgb.map((channel) =>
      Math.round((channel + match) * 255),
    ) as [number, number, number];
  }

  private static applyBrightnessToRgb(
    red: number,
    green: number,
    blue: number,
    brightness: number,
  ): [number, number, number] {
    const { hue, saturation } = VeSyncFan.rgbToHsv(red, green, blue);
    return VeSyncFan.hsvToRgb(hue, saturation, brightness / 100);
  }

  private static normalizeRgbToFullBrightness(
    red: number,
    green: number,
    blue: number,
  ): [number, number, number] {
    const { hue, saturation } = VeSyncFan.rgbToHsv(red, green, blue);
    return VeSyncFan.hsvToRgb(hue, saturation, 1);
  }

  private static rgbToColorSliderLocation(
    red: number,
    green: number,
    blue: number,
  ) {
    const gradient = VeSyncFan.RGB_NIGHTLIGHT_GRADIENT;
    const segmentSize = 100 / (gradient.length - 1);
    let bestPosition = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < gradient.length - 1; index++) {
      const startColor = gradient[index];
      const endColor = gradient[index + 1];
      if (!startColor || !endColor) {
        continue;
      }
      const startPosition = index * segmentSize;

      for (let step = 0; step <= 100; step++) {
        const fraction = step / 100;
        const [interpRed, interpGreen, interpBlue] =
          VeSyncFan.interpolateColor(startColor, endColor, fraction);
        const distance = VeSyncFan.colorDistance(
          red,
          green,
          blue,
          interpRed,
          interpGreen,
          interpBlue,
        );

        if (distance < bestDistance) {
          bestDistance = distance;
          bestPosition = startPosition + fraction * segmentSize;
        }
      }
    }

    return Math.round(bestPosition);
  }

  public async setLightColor(hue: number, saturation: number): Promise<boolean> {
    const [red, green, blue] = VeSyncFan.hsvToRgb(
      hue,
      VeSyncFan.clamp(saturation / 100, 0, 1),
      1,
    );
    const brightness =
      this.brightnessLevel > 0 ? this.brightnessLevel : RGB_MIN_BRIGHTNESS;
    const action = this.lightOn === 'on' ? 'on' : 'off';

    return this.setLightStatus(action, brightness, red, green, blue);
  }
}
