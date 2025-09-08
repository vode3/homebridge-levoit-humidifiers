import axios, { AxiosInstance } from 'axios';
import { Logger, PlatformConfig } from 'homebridge';
import AsyncLock from 'async-lock';
import { v4 as uuidv4 } from 'uuid';

import deviceTypes from './deviceTypes';
import DebugMode from '../debugMode';
import VeSyncFan from './VeSyncFan';

export enum BypassMethod {
  STATUS = 'getHumidifierStatus',
  MODE = 'setHumidityMode',
  NIGHT_LIGHT_BRIGHTNESS = 'setNightLightBrightness',
  DISPLAY = 'setDisplay',
  SWITCH = 'setSwitch',
  HUMIDITY = 'setTargetHumidity',
  MIST_LEVEL = 'setVirtualLevel',
  LEVEL = 'setLevel',
  LIGHT_STATUS = 'setLightStatus',
  DRYING_MODE = 'setDryingMode',
}

function initialHostForCountry(cc: string): string {
  const upper = cc.toUpperCase();
  if (['US', 'CA', 'MX', 'JP'].includes(upper)) return US_HOST;
  return EU_HOST; // everything else starts on EU
}

const lock = new AsyncLock();

// Known API hosts
const US_HOST = 'https://smartapi.vesync.com';
const EU_HOST = 'https://smartapi.vesync.eu';
const ACCOUNT_HOST = 'https://accountapi.vesync.com';

// Server error code indicating cross-region login is required
const CROSS_REGION_CODE = -11260022;

// Convert server region → host (default to US if unknown)
function regionToHost(region?: string): string {
  if (typeof region === 'string' && region.toUpperCase() === 'EU') return EU_HOST;
  return US_HOST;
}

export default class VeSync {
  private api?: AxiosInstance;
  private accountId?: string;
  private token?: string;

  // dynamic baseURL; starts with US then may flip to EU on cross-region
  private baseURL: string;

  private readonly VERSION = '5.6.60';
  private readonly FULL_VERSION = `VeSync ${this.VERSION}`;
  private readonly AGENT = `VeSync/${this.VERSION} (iPhone; iOS 17.2.1; Humidifier/5.00)`;
  private readonly TIMEZONE = 'America/New_York';
  private readonly OS = 'iOS 17.2.1';
  private readonly BRAND = 'iPhone 15 Pro';
  private readonly LANG = 'en';

  // Terminal/device identifier that VeSync expects to remain stable
  private readonly terminalId = uuidv4().replace(/-/g, '');

  constructor(
    private readonly email: string,
    private readonly password: string,
    readonly config: PlatformConfig,
    public readonly debugMode: DebugMode,
    public readonly log: Logger,
  ) {
    // Allow explicit override via config.options.apiHost; otherwise start with US
    const cc = (config.options?.countryCode || 'US').toUpperCase();
    this.baseURL = config.options?.apiHost || initialHostForCountry(cc);
  }

  private AXIOS_OPTIONS() {
    return {
      baseURL: this.baseURL,
      timeout: this.config.options?.apiTimeout || 15000,
    };
  }

  private ACCOUNT_AXIOS_OPTIONS() {
    // Step 1 hits the account API (global). If this ever stops working,
    // we can fall back to the smartapi host by switching baseURL here.
    return {
      baseURL: ACCOUNT_HOST,
      timeout: this.config.options?.apiTimeout || 15000,
    };
  }

  private generateDetailBody() {
    return {
      appVersion: this.FULL_VERSION,
      phoneBrand: this.BRAND,
      traceId: `APP${Date.now()}-00001`,
      phoneOS: this.OS,
    };
  }

  private generateBody(includeAuth = false) {
    return {
      acceptLanguage: this.LANG,
      timeZone: this.TIMEZONE,
      ...(includeAuth
        ? {
            accountID: this.accountId,
            token: this.token,
          }
        : {}),
    };
  }

  private generateV2Body(fan: VeSyncFan, method: BypassMethod, data = {}) {
    return {
      method: 'bypassV2',
      debugMode: false,
      deviceRegion: fan.region,
      cid: fan.cid,
      configModule: fan.configModule,
      payload: {
        data: {
          ...data,
        },
        method,
        source: 'APP',
      },
    };
  }

  public async sendCommand(
    fan: VeSyncFan,
    method: BypassMethod,
    body = {},
  ): Promise<boolean> {
    return lock.acquire('api-call', async () => {
      if (!this.api) {
        throw new Error('The user is not logged in!');
      }

      this.debugMode.debug(
        '[SEND COMMAND]',
        `Sending command ${method} to ${fan.name}`,
        `with (${JSON.stringify(body)})...`,
      );

      const response = await this.api.put('cloud/v2/deviceManaged/bypassV2', {
        ...this.generateV2Body(fan, method, body),
        ...this.generateDetailBody(),
        ...this.generateBody(true),
      });

      if (response.data?.msg === 'device offline') {
        this.log.error(
          'VeSync cannot communicate with humidifier! Check the VeSync App.',
        );
        if (this.config.options?.showOffWhenDisconnected) {
          return false;
        } else {
          throw new Error(
            'Device was unreachable. Ensure it is plugged in and connected to WiFi.',
          );
        }
      }

      if (!response?.data) {
        this.debugMode.debug(
          '[SEND COMMAND]',
          'No response data!! JSON:',
          JSON.stringify(response?.data),
        );
      }

      const isSuccess = response?.data?.code === 0;
      if (!isSuccess) {
        this.debugMode.debug(
          '[SEND COMMAND]',
          `Failed to send command ${method} to ${fan.name}`,
          `with (${JSON.stringify(body)})!`,
          `Response: ${JSON.stringify(response?.data)}`,
        );
      } else {
        this.debugMode.debug(
          '[SEND COMMAND]',
          `Successfully sent command ${method} to ${fan.name}`,
          `with (${JSON.stringify(body)})!`,
          `Response: ${JSON.stringify(response.data)}`,
        );
      }

      return isSuccess;
    });
  }

  public async getDeviceInfo(fan: VeSyncFan): Promise<any> {
    return lock.acquire('api-call', async () => {
      if (!this.api) {
        throw new Error('The user is not logged in!');
      }

      this.debugMode.debug('[GET DEVICE INFO]', 'Getting device info...');

      const response = await this.api.post('cloud/v2/deviceManaged/bypassV2', {
        ...this.generateV2Body(fan, BypassMethod.STATUS),
        ...this.generateDetailBody(),
        ...this.generateBody(true),
      });

      this.debugMode.debug('[DEVICE INFO]', JSON.stringify(response.data));

      if (response.data?.msg === 'device offline') {
        this.log.error(
          'VeSync cannot communicate with humidifier! Check the VeSync App.',
        );
        if (this.config.options?.showOffWhenDisconnected) {
          return false;
        } else {
          throw new Error(
            'Device was unreachable. Ensure it is plugged in and connected to WiFi.',
          );
        }
      }

      if (!response?.data) {
        this.debugMode.debug(
          '[GET DEVICE INFO]',
          'No response data!! JSON:',
          JSON.stringify(response?.data),
        );
      }

      return response.data;
    });
  }

  public async startSession(): Promise<boolean> {
    this.debugMode.debug('[START SESSION]', 'Starting auth session...');
    const firstLoginSuccess = await this.login();
    // Refresh token every ~55 minutes
    setInterval(this.login.bind(this), 1000 * 60 * 55);
    return firstLoginSuccess;
  }

  private async login(): Promise<boolean> {
    return lock.acquire('api-call', async () => {
      if (!this.email || !this.password) {
        throw new Error('Email and password are required');
      }

      const userCountryCode = (this.config.options?.countryCode || 'US').toUpperCase();

      this.debugMode.debug('[LOGIN]', 'Step 1: authByPWDOrOTM…');
      const { authorizeCode, bizToken: initialBizToken } =
        await this.authByPWDOrOTM(userCountryCode);

      this.debugMode.debug('[LOGIN]', `Step 2: loginByAuthorizeCode on ${this.baseURL}…`);
      let step2Resp = await this.loginByAuthorizeCode4Vesync({
        userCountryCode,
        authorizeCode,
        host: this.baseURL,
      });

      // Cross-region handling
      if (step2Resp?.code === CROSS_REGION_CODE) {
        const currentRegion =
          step2Resp?.result?.currentRegion ||
          step2Resp?.data?.currentRegion ||
          step2Resp?.currentRegion;

        const crossBizToken =
          step2Resp?.result?.bizToken ||
          step2Resp?.data?.bizToken ||
          initialBizToken ||
          null;

        const regionHost = regionToHost(currentRegion);

        this.debugMode.debug(
          '[LOGIN]',
          `Cross-region detected (${currentRegion}). Retrying on ${regionHost} with bizToken…`,
        );

        // Switch baseURL and retry with bizToken
        this.baseURL = (this.config.options?.apiHost as string) || regionHost;

        step2Resp = await this.loginByAuthorizeCode4Vesync({
          userCountryCode,
          bizToken: crossBizToken,
          host: this.baseURL,
        });
      }

      if (!step2Resp || step2Resp.code !== 0 || !step2Resp.result?.token || !step2Resp.result?.accountID) {
        this.debugMode.debug('[LOGIN] Failed final step', JSON.stringify(step2Resp));
        return false;
      }

      const { token, accountID } = step2Resp.result;

      this.debugMode.debug('[LOGIN]', 'Authentication was successful');

      this.accountId = accountID;
      this.token = token;

      this.api = axios.create({
        ...this.AXIOS_OPTIONS(),
        headers: {
          'content-type': 'application/json',
          'accept-language': this.LANG,
          accountid: this.accountId!,
          'user-agent': this.AGENT,
          appversion: this.FULL_VERSION,
          tz: this.TIMEZONE,
          tk: this.token!,
        },
      });

      return true;
    });
  }

  private async authByPWDOrOTM(
    userCountryCode: string,
  ): Promise<{ authorizeCode: string | null; bizToken: string | null }> {
    const body = {
      email: this.email,
      method: 'authByPWDOrOTM',
      password: this.password,
      acceptLanguage: this.LANG,
      accountID: '',
      authProtocolType: 'generic',
      clientInfo: this.BRAND,
      clientType: 'vesyncApp',
      clientVersion: this.FULL_VERSION,
      debugMode: false,
      osInfo: this.OS.includes('iOS') ? 'iOS' : 'Android',
      terminalId: this.terminalId,
      timeZone: this.TIMEZONE,
      token: '',
      userCountryCode,
      appID: 'homebridge-levoit',
      sourceAppID: 'homebridge-levoit',
      ...this.generateDetailBody(),
    };

    // Prefer the account API for step 1 (matches app behavior)
    let resp;
    try {
      resp = await axios.post(
        '/globalPlatform/api/accountAuth/v1/authByPWDOrOTM',
        body,
        this.ACCOUNT_AXIOS_OPTIONS(),
      );
    } catch (e) {
      // Fallback to smartapi host if accountapi ever blocks this
      this.debugMode.debug('[AUTH] accountapi failed, falling back to smartapi', String(e));
      resp = await axios.post(
        '/globalPlatform/api/accountAuth/v1/authByPWDOrOTM',
        body,
        this.AXIOS_OPTIONS(),
      );
    }

    if (!resp?.data || resp.data.code !== 0 || !resp.data.result) {
      this.debugMode.debug('[AUTH] Failed authByPWDOrOTM', JSON.stringify(resp?.data));
      throw new Error('VeSync authentication failed at step 1');
    }

    const { authorizeCode = null, bizToken = null } = resp.data.result;
    return { authorizeCode, bizToken };
  }

  private async loginByAuthorizeCode4Vesync(opts: {
    userCountryCode: string;
    host: string;
    authorizeCode?: string | null;
    bizToken?: string | null;
  }): Promise<any> {
    const { userCountryCode, host, authorizeCode = null, bizToken = null } = opts;

    const body: any = {
      method: 'loginByAuthorizeCode4Vesync',
      authorizeCode, // null when using bizToken
      acceptLanguage: this.LANG,
      accountID: '',
      clientInfo: this.BRAND,
      clientType: 'vesyncApp',
      clientVersion: this.FULL_VERSION,
      debugMode: false,
      emailSubscriptions: false,
      osInfo: this.OS.includes('iOS') ? 'iOS' : 'Android',
      terminalId: this.terminalId,
      timeZone: this.TIMEZONE,
      token: '',
      regionChange: '',
      userCountryCode,
      ...this.generateDetailBody(),
    };

    if (bizToken) {
      body.bizToken = bizToken;
      body.authorizeCode = null;
    }

    const resp = await axios.post(
      '/user/api/accountManage/v1/loginByAuthorizeCode4Vesync',
      body,
      {
        baseURL: host,
        timeout: this.config.options?.apiTimeout || 15000,
      },
    );

    return resp?.data;
  }

  public async getDevices(): Promise<VeSyncFan[]> {
    return lock.acquire('api-call', async () => {
      if (!this.api) {
        this.log.error('The user is not logged in!');
        return [];
      }

      const response = await this.api.post('cloud/v2/deviceManaged/devices', {
        method: 'devices',
        pageNo: 1,
        pageSize: 1000,
        ...this.generateDetailBody(),
        ...this.generateBody(true),
      });

      if (!response?.data) {
        this.debugMode.debug(
          '[GET DEVICES]',
          'No response data!! JSON:',
          JSON.stringify(response?.data),
        );
        return [];
      }

      if (!Array.isArray(response.data?.result?.list)) {
        this.debugMode.debug(
          '[GET DEVICES]',
          'No list found!! JSON:',
          JSON.stringify(response.data),
        );
        return [];
      }

      const { list } = response.data.result ?? { list: [] };

      this.debugMode.debug(
        '[GET DEVICES]',
        'Device List -> JSON:',
        JSON.stringify(list),
      );

      const devices = list
        .filter(
          ({ deviceType, type }) =>
            !!deviceTypes.find(({ isValid }) => isValid(deviceType)) &&
            type === 'wifi-air',
        )
        .map(VeSyncFan.fromResponse(this));

      return devices;
    });
  }
}
