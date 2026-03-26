import VeSyncFan from '../api/VeSyncFan';

const LIGHT_COLOR_DEBOUNCE_MS = 150;

type PendingLightColorUpdate = {
  hue: number;
  saturation: number;
  timeout?: ReturnType<typeof setTimeout>;
  resolvers: Array<() => void>;
  rejecters: Array<(error: unknown) => void>;
};

const pendingUpdates = new WeakMap<VeSyncFan, PendingLightColorUpdate>();

export async function queueLightColorUpdate(
  device: VeSyncFan,
  color: { hue?: number; saturation?: number },
): Promise<void> {
  let pendingUpdate = pendingUpdates.get(device);

  if (!pendingUpdate) {
    await device.updateInfo();
    pendingUpdate = {
      hue: device.lightHue,
      saturation: device.lightSaturation,
      resolvers: [],
      rejecters: [],
    };
    pendingUpdates.set(device, pendingUpdate);
  }

  if (color.hue !== undefined) {
    pendingUpdate.hue = Number(color.hue);
  }
  if (color.saturation !== undefined) {
    pendingUpdate.saturation = Number(color.saturation);
  }

  if (pendingUpdate.timeout) {
    clearTimeout(pendingUpdate.timeout);
  }

  return new Promise<void>((resolve, reject) => {
    pendingUpdate!.resolvers.push(resolve);
    pendingUpdate!.rejecters.push(reject);
    pendingUpdate!.timeout = setTimeout(async () => {
      const activeUpdate = pendingUpdates.get(device);
      if (!activeUpdate) {
        resolve();
        return;
      }

      pendingUpdates.delete(device);

      try {
        await device.setLightColor(activeUpdate.hue, activeUpdate.saturation);
        activeUpdate.resolvers.forEach((resolver) => resolver());
      } catch (error: unknown) {
        activeUpdate.rejecters.forEach((rejecter) => rejecter(error));
      }
    }, LIGHT_COLOR_DEBOUNCE_MS);
  });
}
