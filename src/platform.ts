import {
  DynamicPlatformPlugin,
  PlatformAccessory,
  PlatformConfig,
  Characteristic,
  Service,
  Logger,
  API,
  UnknownContext,
} from 'homebridge';
import * as path from 'node:path';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import VeSyncAccessory from './VeSyncAccessory';
import VeSyncFan from './api/VeSyncFan';
import DebugMode from './debugMode';
import VeSync from './api/VeSync';

export interface VeSyncContext {
  name: string;
  device: VeSyncFan;
}

export type VeSyncPlatformAccessory = PlatformAccessory<VeSyncContext>;

export default class Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  public readonly cachedAccessories: VeSyncPlatformAccessory[] = [];
  public readonly registeredDevices: VeSyncAccessory[] = [];

  public readonly debugger: DebugMode;
  private readonly client: VeSync;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    const { email, password } = this.config ?? {};
    // Support backwards compatibility: check top-level first, then options
    const enableDebugMode =
      (this.config as { enableDebugMode?: boolean }).enableDebugMode ??
      this.config.options?.enableDebugMode ??
      false;

    this.debugger = new DebugMode(!!enableDebugMode, this.log);
    this.debugger.debug('[PLATFORM]', 'Debug mode enabled');

    const storagePath = this.api.user.storagePath();
    const defaultSessionPath = path.join(
      storagePath,
      'homebridge-levoit-humidifiers.session.json',
    );
    const sessionPath = this.config.options?.sessionPath || defaultSessionPath;
    this.debugger.debug('[PLATFORM]', `Using sessionPath=${sessionPath}`);

    this.client = new VeSync(
      email,
      password,
      this.config,
      this.debugger,
      log,
      sessionPath,
    );

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory<UnknownContext>) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.cachedAccessories.push(accessory as VeSyncPlatformAccessory);
  }

  async discoverDevices() {
    const { email, password } = this.config ?? {};
    if (!email || !password) {
      if (this.cachedAccessories.length > 0) {
        this.debugger.debug(
          '[PLATFORM]',
          'Removing cached accessories because the email and password are not set (Count:',
          `${this.cachedAccessories.length})`,
        );
        this.api.unregisterPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          this.cachedAccessories,
        );
      }

      this.log.error('The email and password are not correct!');
      return;
    }

    try {
      this.log.info('Connecting to the VeSync servers...');
      const ok = await this.client.startSession();

      if (!ok) {
        this.log.error(
          'VeSync login failed – enable debug mode and check logs for [LOGIN]/[SESSION] messages.',
        );
        return;
      }

      this.log.info('Discovering devices...');

      const devices = await this.client.getDevices();
      await Promise.all(devices.map(this.loadDevice.bind(this)));

      this.checkOldDevices();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('Unexpected error during device discovery:', message);
    }
  }

  private async loadDevice(device: VeSyncFan) {
    try {
      await device.updateInfo();
      const { uuid, name } = device;

      const existingAccessory = this.cachedAccessories.find(
        (accessory) => accessory.UUID === uuid,
      );

      if (existingAccessory) {
        this.log.info(
          'Restoring existing accessory from cache:',
          existingAccessory.displayName,
        );

        existingAccessory.context = {
          name,
          device,
        };

        this.registeredDevices.push(
          new VeSyncAccessory(this, existingAccessory),
        );

        return;
      }

      this.log.info('Adding new accessory:', name);
      const accessory = new this.api.platformAccessory<VeSyncContext>(
        name,
        uuid,
      );
      accessory.context = {
        name,
        device,
      };

      this.registeredDevices.push(new VeSyncAccessory(this, accessory));
      return this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory,
      ]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(
        `Error for device: ${device.name}:${device.uuid} | ${message}`,
      );
      return null;
    }
  }

  private checkOldDevices() {
    this.cachedAccessories.forEach((accessory) => {
      const exists = this.registeredDevices.find(
        (device) => device.UUID === accessory.UUID,
      );

      if (!exists) {
        this.log.info('Remove cached accessory:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    });
  }
}
