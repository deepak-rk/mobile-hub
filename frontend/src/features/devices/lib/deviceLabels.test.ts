import { describe, it, expect } from 'vitest';
import { displayModel, modelDetail } from './deviceLabels';

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

/**
 * The detail page keeps the value and fixes the label instead. Hiding the
 * system image there would be the wrong trade: that page exists to answer
 * exactly this kind of diagnostic question.
 */
describe('modelDetail', () => {
  it("labels an emulator's system image as a system image, not a model", () => {
    expect(modelDetail({ name: 'Pixel 3a', model: 'sdk_gphone64_x86_64', connectionType: 'emulator' })).toEqual({
      term: 'System image',
      value: 'sdk_gphone64_x86_64',
    });
  });

  it('calls a simulator arch a system image too', () => {
    expect(modelDetail({ name: 'iPhone 15', model: 'x86_64', connectionType: 'simulator' })).toEqual({
      term: 'System image',
      value: 'x86_64',
    });
  });

  it('keeps the Model label for real hardware, where the string is a real product name', () => {
    expect(modelDetail({ name: 'Lab phone 2', model: 'Pixel 7', connectionType: 'usb' })).toEqual({
      term: 'Model',
      value: 'Pixel 7',
    });
  });

  it('drops the row when the model only repeats the name', () => {
    expect(modelDetail({ name: 'Pixel 7', model: 'Pixel 7', connectionType: 'usb' })).toBeNull();
    expect(modelDetail({ name: 'Galaxy S21', model: 'galaxy_s21', connectionType: 'usb' })).toBeNull();
  });

  it('drops the row when the model says nothing', () => {
    expect(modelDetail({ name: 'Lab phone', model: 'unknown', connectionType: 'usb' })).toBeNull();
    expect(modelDetail({ name: 'Lab phone', model: '   ', connectionType: 'usb' })).toBeNull();
  });
});
