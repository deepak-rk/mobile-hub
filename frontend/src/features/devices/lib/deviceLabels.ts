import type { Device } from '../types';

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * The model string to show beside a device's name, or null when it adds
 * nothing.
 *
 * An emulator or simulator reports a *system image* identifier as its model
 * ("sdk_gphone64_x86_64"), not a product name — it describes the image the
 * device was built from, which is noise next to the AVD-derived name the
 * agent already resolved ("Pixel 3a"). Real hardware reports a genuine product
 * model, which is worth showing.
 *
 * Deliberately keyed on `connectionType` rather than matching known-junk
 * strings: a hardcoded list of stock image names would rot with every new
 * system image, and the reason those strings are noise is precisely that they
 * come from an emulated device. Same reasoning as adb-discovery.ts's
 * `resolveDeviceName`, which crops AVD names for the same class of problem.
 */
export function displayModel(device: Pick<Device, 'model' | 'name' | 'connectionType'>): string | null {
  const model = device.model?.trim();
  if (!model || model.toLowerCase() === 'unknown') return null;
  // The name fell back to the model (or reads identically), so showing both
  // just repeats it.
  if (normalize(model) === normalize(device.name)) return null;
  if (device.connectionType === 'emulator' || device.connectionType === 'simulator') return null;
  return model;
}
