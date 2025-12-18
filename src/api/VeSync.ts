import axios, { AxiosInstance } from 'axios';
import { Logger, PlatformConfig } from 'homebridge';
import AsyncLock from 'async-lock';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'node:crypto';

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

// Start on US host for a small set of known non-EU regions – everyone else uses EU
const US_HOST = 'https://smartapi.vesync.com';
const EU_HOST = 'https://smartapi.vesync.eu';
const ACCOUNT_HOST = 'https://accountapi.vesync.com';

/**
 * Determine the initial base URL for a given country code.
 * @param cc - The country code.
 * @returns The initial base URL.
 */
function initialHostForCountry(cc: string): string {
  const upper = cc.toUpperCase();
  if (['US', 'CA', 'MX', 'JP'].includes(upper)) return US_HOST;
  return EU_HOST; // everything else starts on EU
}

const lock = new AsyncLock();

export default class VeSync {
  private api?: AxiosInstance;
  private accountId?: string;
  private token?: string;

  // dynamic baseURL; starts from config/country and may flip on cross-region
  private baseURL: string;

  private readonly VERSION = '5.6.60';
  private readonly FULL_VERSION = `VeSync ${this.VERSION}`;
  private readonly AGENT = `VeSync/${this.VERSION} (iPhone; iOS 17.2.1; Humidifier/5.00)`;
  private readonly TIMEZONE = 'America/New_York';
  private readonly OS = 'iOS 17.2.1';
  private readonly BRAND = 'iPhone 15 Pro';
  private readonly LANG = 'en';

  // Terminal/device identifier that VeSync expects to remain stable
  private readonly terminalId = '2' + uuidv4().replaceAll('-', '');
  private readonly appID = Math.random().toString(36).substring(2, 10);

  constructor(
    private readonly email: string,
    private readonly password: string,
    readonly config: PlatformConfig,
    public readonly debugMode: DebugMode,
    public readonly log: Logger,
  ) {
    const cc = (config.options?.countryCode || 'US').toUpperCase();
    this.baseURL = config.options?.apiHost || initialHostForCountry(cc);
    this.debugMode.debug?.(
      '[CONFIG]',
      `countryCode=${cc}, initialBaseURL=${this.baseURL}`,
    );
  }

  private AXIOS_OPTIONS() {
    return {
      baseURL: this.baseURL,
      timeout: this.config.options?.apiTimeout || 15000,
    };
  }

  private ACCOUNT_AXIOS_OPTIONS() {
    return {
      baseURL: ACCOUNT_HOST,
      timeout: this.config.options?.apiTimeout || 15000,
      headers: {
        'content-type': 'application/json',
        'accept-language': this.LANG,
        'user-agent': this.AGENT,
        appversion: this.FULL_VERSION,
        tz: this.TIMEZONE,
      },
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
      if (isSuccess) {
        this.debugMode.debug(
          '[SEND COMMAND]',
          `Successfully sent command ${method} to ${fan.name}`,
          `with (${JSON.stringify(body)})!`,
          `Response: ${JSON.stringify(response.data)}`,
        );
      } else {
        this.debugMode.debug(
          '[SEND COMMAND]',
          `Failed to send command ${method} to ${fan.name}`,
          `with (${JSON.stringify(body)})!`,
          `Response: ${JSON.stringify(response?.data)}`,
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
    const ok = await this.login();
    if (ok) setInterval(this.login.bind(this), 1000 * 60 * 55);
    return ok;
  }

  private async login(): Promise<boolean> {
    return lock.acquire('auth-call', async () => {
      if (!this.email || !this.password) {
        throw new Error('Email and password are required');
      }

      const userCountryCode = (
        this.config.options?.countryCode || 'US'
      ).toUpperCase();

      this.debugMode.debug('[LOGIN]', 'Step 1: authByPWDOrOTM…');
      const { authorizeCode, bizToken: initialBizToken } =
        await this.authByPWDOrOTM(userCountryCode);

      this.debugMode.debug(
        '[LOGIN]',
        `Step 2: loginByAuthorizeCode on ${this.baseURL}…`,
      );
      let step2Resp = await this.loginByAuthorizeCode4Vesync({
        userCountryCode,
        authorizeCode,
        host: this.baseURL,
      });

      // --- Cross-region handling -----------------
      //
      // Look at ErrorTypes.CROSS_REGION and a bizToken in the result.
      // Any non-zero code with a bizToken means "try again in the correct
      // region" using the countryCode returned by the server.
      if (step2Resp && step2Resp.code !== 0 && step2Resp.result?.bizToken) {
        const result = step2Resp.result;

        const newCountryCode = (
          result.countryCode || userCountryCode
        ).toUpperCase();
        const crossBizToken = result.bizToken || initialBizToken || null;

        this.debugMode.debug(
          '[LOGIN]',
          `Cross-region detected. Switching to countryCode=${newCountryCode} and retrying loginByAuthorizeCode4Vesync with regionChange=last_region…`,
        );

        // Use country → host mapping like pyvesync._api_base_url_for_current_region()
        const regionHost = initialHostForCountry(newCountryCode);
        this.baseURL = (this.config.options?.apiHost as string) || regionHost;

        step2Resp = await this.loginByAuthorizeCode4Vesync({
          userCountryCode,
          bizToken: crossBizToken,
          host: this.baseURL,
          regionChange: 'last_region',
          overrideCountryCode: newCountryCode,
          currentRegion: result.currentRegion,
        });
      }

      if (
        step2Resp?.code !== 0 ||
        !step2Resp.result?.token ||
        !step2Resp.result?.accountID
      ) {
        this.debugMode.debug(
          '[LOGIN] Failed final step',
          JSON.stringify(step2Resp),
        );
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

      this.api.interceptors.response.use(
        (resp) => resp,
        async (err) => {
          if (err?.response?.status === 401) {
            this.debugMode.debug('[AUTH]', '401 detected, re-authenticating…');
            const ok = await this.login();
            if (ok && err.config) {
              err.config.headers = err.config.headers || {};
              err.config.headers.tk = this.token!;
              err.config.headers.accountid = this.accountId!;
              return this.api!.request(err.config);
            }
          }
          throw err;
        },
      );
      return true;
    });
  }

  private async authByPWDOrOTM(
    userCountryCode: string,
  ): Promise<{ authorizeCode: string | null; bizToken: string | null }> {
    const pwdHashed = crypto
      .createHash('md5')
      .update(this.password)
      .digest('hex');
    const body = {
      email: this.email,
      method: 'authByPWDOrOTM',
      password: pwdHashed,
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
      userType: 1,
      devToken: '',
      appID: this.appID,
      sourceAppID: this.appID,
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
      this.debugMode.debug(
        '[AUTH] accountapi failed, falling back to smartapi',
        String(e),
      );
      resp = await axios.post(
        '/globalPlatform/api/accountAuth/v1/authByPWDOrOTM',
        body,
        this.AXIOS_OPTIONS(),
      );
    }

    if (resp?.data?.code !== 0 || !resp.data.result) {
      this.debugMode.debug(
        '[AUTH] Failed authByPWDOrOTM',
        JSON.stringify(resp?.data),
      );
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
    regionChange?: 'last_region';
    overrideCountryCode?: string;
    currentRegion?: string;
  }): Promise<any> {
    const {
      userCountryCode,
      host,
      authorizeCode = null,
      bizToken = null,
      regionChange,
      overrideCountryCode,
      currentRegion,
    } = opts;

    const body: any = {
      method: 'loginByAuthorizeCode4Vesync',
      authorizeCode,
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
      userCountryCode: overrideCountryCode || userCountryCode,
      ...(regionChange ? { regionChange } : {}),
      ...(currentRegion ? { region: String(currentRegion).toUpperCase() } : {}),
      appID: this.appID,
      sourceAppID: this.appID,
      ...this.generateDetailBody(),
    };

    if (bizToken) {
      body.bizToken = bizToken;
      body.authorizeCode = null;
    }

    try {
      const resp = await axios.post(
        '/user/api/accountManage/v1/loginByAuthorizeCode4Vesync',
        body,
        { baseURL: host, timeout: this.config.options?.apiTimeout || 15000 },
      );
      return resp?.data;
    } catch (e) {
      this.debugMode.debug('[LOGIN STEP 2] network error', String(e));
      return undefined;
    }
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
            deviceTypes.some(({ isValid }) => isValid(deviceType)) &&
            type === 'wifi-air',
        )
        .map(VeSyncFan.fromResponse(this));

      return devices;
    });
  }
}
