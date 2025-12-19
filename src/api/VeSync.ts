import axios, { AxiosInstance } from 'axios';
import { Logger, PlatformConfig } from 'homebridge';
import AsyncLock from 'async-lock';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

// Known API hosts
const US_HOST = 'https://smartapi.vesync.com';
const EU_HOST = 'https://smartapi.vesync.eu';
const ACCOUNT_HOST = 'https://accountapi.vesync.com';

// Start on US host for a small set of known non-EU regions – everyone else uses EU
const EU_COUNTRY_CODES = new Set<string>([
  'AL', 'AD', 'AT', 'BY', 'BE', 'BA', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'LV', 'LI',
  'LT', 'LU', 'MT', 'MD', 'MC', 'ME', 'NL', 'MK', 'NO', 'PL', 'PT', 'RO', 'RU', 'SM', 'RS', 'SK', 'SI', 'ES', 'SE', 'CH', 'TR', 'UA',
  'GB', 'UK',
]);

function initialHostForCountry(cc: string): string {
  const upper = (cc || '').toUpperCase();
  if (EU_COUNTRY_CODES.has(upper)) return EU_HOST;
  return US_HOST;
}

const lock = new AsyncLock();

// Simple JWT timestamp decoder (best-effort, no verification)
function decodeJwtTimestamps(token: string): { iat?: number; exp?: number } {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return {};
    const part = parts[1];
    if (!part) return {};
    const payload = part
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = Buffer.from(payload, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return { iat: obj.iat, exp: obj.exp };
  } catch {
    return {};
  }
}

interface SessionData {
  token: string;
  accountId: string;
  countryCode: string;

  // Back-compat for existing persisted sessions
  baseURL?: string;
  apiBaseUrl?: string;

  region?: string;
  username?: string;

  issuedAt?: number | null;
  expiresAt?: number | null;
  lastValidatedAt: number;
}

interface LoginResponse {
  code?: number;
  msg?: string;
  result?: {
    token?: string;
    accountID?: string;
    countryCode?: string;
    bizToken?: string;
    currentRegion?: string;
  };
}

interface DeviceResult {
  humidity?: number;
  targetHumidity?: number;
  screenSwitch?: boolean;
  workMode?: string;
  powerSwitch?: number;
  autoStopState?: boolean;
  virtualLevel?: number;
  configuration?: {
    auto_target_humidity?: number;
  };
  display?: boolean;
  mode?: string;
  enabled?: boolean;
  automatic_stop_reach_target?: boolean;
  mist_virtual_level?: number;
  warm_level?: number;
  warm_enabled?: boolean;
  night_light_brightness?: number;
  rgbNightLight?: {
    brightness?: number;
    action?: string;
    blue?: number;
    green?: number;
    red?: number;
    colorMode?: string;
    speed?: number;
    colorSliderLocation?: number;
  };
}

interface DeviceInfoResponse {
  result?: {
    result?: DeviceResult;
  };
  msg?: string;
}

export default class VeSync {
  private api?: AxiosInstance;
  private accountId?: string;
  private token?: string;

  // dynamic baseURL; starts from config/country and may flip on cross-region
  private baseURL: string;

  // track account country once known
  private countryCode: string;

  private region?: string;

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

  // Simple login backoff so we don’t hammer the API on repeated failures
  private lastLoginAttempt = 0;
  private loginBackoffMs = 10000; // start at 10s, max 5min

  // Session persistence
  private readonly sessionFilePath?: string;
  // Treat tokens as valid up to ~25 days unless JWT says otherwise
  private readonly TOKEN_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly email: string,
    private readonly password: string,
    readonly config: PlatformConfig,
    public readonly debugMode: DebugMode,
    public readonly log: Logger,
    sessionPath?: string,
  ) {
    const cc = (config.options?.countryCode || 'US').toUpperCase();
    this.countryCode = cc;
    this.baseURL = config.options?.apiHost || initialHostForCountry(cc);

    // Session file path: use provided path, or config option, or default to cwd
    this.sessionFilePath =
      sessionPath ||
      config.options?.sessionPath ||
      path.join(process.cwd(), 'vesync-session.json');

    this.debugMode.debug?.(
      '[CONFIG]',
      `countryCode=${cc}, initialBaseURL=${this.baseURL}, sessionFile=${this.sessionFilePath}`,
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

  // --- Session persistence ---------------------------------------------------

  private async loadSessionFromDisk(): Promise<SessionData | null> {
    if (!this.sessionFilePath) return null;
    try {
      const raw = await fs.promises.readFile(this.sessionFilePath, 'utf8');
      const session = JSON.parse(raw) as SessionData;

      const persistedBaseURL = session.apiBaseUrl || session.baseURL;

      if (!session.token || !session.accountId || !persistedBaseURL) {
        this.debugMode.debug(
          '[SESSION]',
          'Session file missing required fields, ignoring.',
        );
        return null;
      }

      if (session.username && session.username !== this.email) {
        this.debugMode.debug(
          '[SESSION]',
          'Persisted session is for a different account; ignoring.',
        );
        return null;
      }

      const now = Date.now();
      const { iat, exp } = decodeJwtTimestamps(session.token);

      if (exp && exp * 1000 <= now) {
        this.debugMode.debug(
          '[SESSION]',
          'Persisted token is expired, ignoring.',
        );
        return null;
      }

      // Also protect against extremely old tokens if exp is missing
      const issuedMs = session.issuedAt ?? (iat ? iat * 1000 : now);
      if (now - issuedMs > this.TOKEN_MAX_AGE_MS * 1.5) {
        this.debugMode.debug(
          '[SESSION]',
          'Persisted token appears too old, ignoring.',
        );
        return null;
      }

      session.baseURL = persistedBaseURL;

      this.debugMode.debug('[SESSION]', 'Loaded persisted session from disk.');
      return session;
    } catch (e: unknown) {
      const error = e as { code?: string };
      if (error.code !== 'ENOENT') {
        this.debugMode.debug(
          '[SESSION]',
          'Failed to load session from disk:',
          String(e),
        );
      }
      return null;
    }
  }

  private async saveSessionToDisk(): Promise<void> {
    if (!this.sessionFilePath || !this.token || !this.accountId) return;
    try {
      const { iat, exp } = decodeJwtTimestamps(this.token);
      const session: SessionData = {
        token: this.token,
        accountId: this.accountId,
        countryCode: this.countryCode,
        apiBaseUrl: this.baseURL,
        baseURL: this.baseURL,
        region: this.region,
        username: this.email,
        issuedAt: iat ?? null,
        expiresAt: exp ?? null,
        lastValidatedAt: Date.now(),
      };

      await fs.promises.writeFile(
        this.sessionFilePath,
        JSON.stringify(session, null, 2),
        'utf8',
      );
      this.debugMode.debug('[SESSION]', 'Persisted VeSync session to disk.');
    } catch (e) {
      this.debugMode.debug(
        '[SESSION]',
        'Failed to save session to disk:',
        String(e),
      );
    }
  }

  private buildApiClient() {
    if (!this.token || !this.accountId) {
      throw new Error('Cannot build API client without token/accountId');
    }

    this.api = axios.create({
      ...this.AXIOS_OPTIONS(),
      headers: {
        'content-type': 'application/json',
        'accept-language': this.LANG,
        accountid: this.accountId,
        'user-agent': this.AGENT,
        appversion: this.FULL_VERSION,
        tz: this.TIMEZONE,
        tk: this.token,
      },
    });

    this.api.interceptors.response.use(
      (resp) => resp,
      async (err) => {
        if (err?.response?.status === 401) {
          this.debugMode.debug('[AUTH]', '401 detected, re-authenticating…');
          const ok = await this.login();
          if (ok && err.config && this.api) {
            err.config.headers = err.config.headers || {};
            err.config.headers.tk = this.token!;
            err.config.headers.accountid = this.accountId!;
            return this.api.request(err.config);
          }
        }
        throw err;
      },
    );
  }

  // --- Public API ------------------------------------------------------------

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

  public async getDeviceInfo(fan: VeSyncFan): Promise<DeviceInfoResponse | null> {
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
          return null;
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
    this.debugMode.debug('[START SESSION]', 'Starting auth session…');

    // 1) Try to reuse persisted session
    const session = await this.loadSessionFromDisk();
    if (session) {
      this.debugMode.debug('[SESSION]', 'Reusing persisted VeSync session.');
      this.token = session.token;
      this.accountId = session.accountId;
      this.countryCode = (session.countryCode || this.countryCode || 'US').toUpperCase();

      const persistedBaseURL = session.apiBaseUrl || session.baseURL;
      this.baseURL =
        this.config.options?.apiHost || persistedBaseURL || this.baseURL;

      if (session.region) {
        this.region = String(session.region).toUpperCase();
      }

      try {
        this.buildApiClient();
        return true;
      } catch (e) {
        this.debugMode.debug(
          '[SESSION]',
          'Failed to hydrate persisted session, falling back to fresh login:',
          String(e),
        );
      }
    } else {
      this.debugMode.debug(
        '[SESSION]',
        'No valid persisted session found; logging in.',
      );
    }

    // 2) Fresh login if no valid session
    const ok = await this.login();
    if (!ok) {
      this.log.error(
        'VeSync initial login failed – check credentials / region.',
      );
    }
    return ok;
  }

  // --- Login flow (auth + token + cross-region) ------------------------------

  private async login(): Promise<boolean> {
    return lock.acquire('auth-call', async () => {
      if (!this.email || !this.password) {
        throw new Error('Email and password are required');
      }

      // Avoid spamming VeSync on failing accounts
      const now = Date.now();
      const delta = now - this.lastLoginAttempt;
      if (delta < this.loginBackoffMs) {
        const wait = this.loginBackoffMs - delta;
        this.debugMode.debug(
          '[LOGIN]',
          `Backing off for ${wait}ms before next login attempt…`,
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.lastLoginAttempt = Date.now();

      const configuredCC = (
        this.config.options?.countryCode ||
        this.countryCode ||
        'US'
      ).toUpperCase();
      this.countryCode = configuredCC;

      if (!this.config.options?.apiHost) {
        this.baseURL = initialHostForCountry(this.countryCode);
      }

      this.debugMode.debug('[LOGIN]', 'Step 1: authByPWDOrOTM…');
      const { authorizeCode, bizToken: initialBizToken } =
        await this.authByPWDOrOTM(this.countryCode);

      this.debugMode.debug(
        '[LOGIN]',
        `Step 2: loginByAuthorizeCode on ${this.baseURL}…`,
      );
      let step2Resp = await this.loginByAuthorizeCode4Vesync({
        userCountryCode: this.countryCode,
        authorizeCode,
        host: this.baseURL,
      });

      this.debugMode.debug(
        '[LOGIN]',
        'Raw step 2 response:',
        JSON.stringify(step2Resp),
      );

      const codeIsNonZero =
        typeof step2Resp?.code === 'number' ? step2Resp.code !== 0 : true;

      if (codeIsNonZero && step2Resp?.result?.bizToken && step2Resp.result.countryCode) {
        const result = step2Resp.result;
        const newCountryCode = (result.countryCode ?? this.countryCode).toUpperCase();
        const crossBizToken = result.bizToken || initialBizToken || null;

        this.debugMode.debug(
          '[LOGIN]',
          `Cross-region detected. Switching to countryCode=${newCountryCode} and retrying…`,
        );

        const regionHost = initialHostForCountry(newCountryCode);
        this.baseURL = this.config.options?.apiHost || regionHost;
        this.countryCode = newCountryCode;

        step2Resp = await this.loginByAuthorizeCode4Vesync({
          userCountryCode: this.countryCode,
          authorizeCode,
          bizToken: crossBizToken,
          host: this.baseURL,
          regionChange: 'lastRegion',
          overrideCountryCode: newCountryCode,
          currentRegion: result.currentRegion,
        });

        this.debugMode.debug(
          '[LOGIN]',
          'Raw step 2 response after retry:',
          JSON.stringify(step2Resp),
        );
      }

      if (
        !step2Resp?.result?.token ||
        step2Resp.code !== 0 ||
        !step2Resp.result.accountID
      ) {
        this.debugMode.debug(
          '[LOGIN] Failed final step',
          JSON.stringify(step2Resp),
        );
        // increase backoff on failure (cap at 5 minutes)
        this.loginBackoffMs = Math.min(this.loginBackoffMs * 2, 300000);
        return false;
      }

      // Reset backoff on success
      this.loginBackoffMs = 10000;

      const result = step2Resp.result;
      if (!result?.token || !result.accountID) {
        throw new Error('Invalid login response');
      }
      const { token, accountID, countryCode } = result;

      this.debugMode.debug('[LOGIN]', 'Authentication was successful');

      this.accountId = accountID;
      this.token = token;
      if (!this.token) {
        throw new Error('No token found in login response');
      }
      if (countryCode) {
        this.countryCode = countryCode.toUpperCase();
      }

      if (result.currentRegion) {
        this.region = String(result.currentRegion).toUpperCase();
      }

      if (!this.config.options?.apiHost) {
        this.baseURL = initialHostForCountry(this.countryCode);
      }

      this.buildApiClient();
      await this.saveSessionToDisk();
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

    if (!resp?.data?.result || resp.data.code !== 0) {
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
    regionChange?: 'lastRegion';
    overrideCountryCode?: string;
    currentRegion?: string;
  }): Promise<LoginResponse | undefined> {
    const {
      userCountryCode,
      host,
      authorizeCode = null,
      bizToken = null,
      regionChange,
      overrideCountryCode,
      currentRegion,
    } = opts;

    const body: Record<string, unknown> = {
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

  // --- Devices ---------------------------------------------------------------

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
