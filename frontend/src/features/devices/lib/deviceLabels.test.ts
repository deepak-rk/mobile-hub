import { describe, it, expect } from 'vitest';
import { displayModel } from './deviceLabels';

/**
 * The rule that keeps a stock emulator's system-image identifier
 * ("sdk_gphone64_x86_64") off a card that already says "Pixel 3a", without a
 * hardcoded list of junk strings — such a list would rot with every new system
 * image, and the reason those strings are noise is that they came from an
 * emulated device, not that they are on a list.
 */
describe('displayModel', () => {
  it('hides the system-image identifier an emulator reports as its model', () => {
    expect(
      displayModel({ name: 'Pixel 3a', model: 'sdk_gphone64_x86_64', connectionType: 'emulator' }),
    ).toBeNull();
  });

  it('hides it for iOS simulators too', () => {
    expect(displayModel({ name: 'iPhone 15', model: 'x86_64', connectionType: 'simulator' })).toBeNull();
  });

  it('keeps a real product model from physical hardware', () => {
    // The whole point of the field on real devices: "Pixel 7" tells you which
    // hardware you're looking at, and USB devices report a genuine product.
    expect(displayModel({ name: 'Lab phone 2', model: 'Pixel 7', connectionType: 'usb' })).toBe('Pixel 7');
  });

  it('hides a model that only repeats the name', () => {
    // The agent falls back to the model when it has no better name, so both
    // fields end up identical and showing them twice is pure noise.
    expect(displayModel({ name: 'Pixel 7', model: 'Pixel 7', connectionType: 'usb' })).toBeNull();
  });

  it('ignores separator and case differences when comparing to the name', () => {
    expect(displayModel({ name: 'Galaxy S21', model: 'galaxy_s21', connectionType: 'usb' })).toBeNull();
  });

  it('hides an unknown or empty model', () => {
    // adb-discovery falls back to the literal string 'unknown' when the device
    // won't report one; rendering that helps nobody.
    expect(displayModel({ name: 'Lab phone', model: 'unknown', connectionType: 'usb' })).toBeNull();
    expect(displayModel({ name: 'Lab phone', model: '   ', connectionType: 'usb' })).toBeNull();
  });
});
