import { describe, it, expect } from 'vitest';
import { solidPng, syntheticFrame } from './synthetic-frame';

/**
 * The synthetic source only earns its keep if a browser can actually decode
 * what it emits — otherwise device-less dev and E2E show a broken image and
 * quietly prove nothing. These assert the bytes really are a valid PNG.
 */
describe('solidPng', () => {
  it('starts with the PNG signature', () => {
    const png = solidPng(4, 4, [255, 0, 0]);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('declares the requested dimensions in IHDR', () => {
    const png = solidPng(270, 480, [0, 0, 0]);
    // IHDR data begins at byte 16 (8 signature + 4 length + 4 type).
    expect(png.readUInt32BE(16)).toBe(270);
    expect(png.readUInt32BE(20)).toBe(480);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(2); // truecolour RGB
  });

  it('contains IHDR, IDAT and IEND chunks in order', () => {
    const png = solidPng(8, 8, [1, 2, 3]);
    const s = png.toString('latin1');
    expect(s.indexOf('IHDR')).toBeGreaterThan(0);
    expect(s.indexOf('IDAT')).toBeGreaterThan(s.indexOf('IHDR'));
    expect(s.indexOf('IEND')).toBeGreaterThan(s.indexOf('IDAT'));
  });

  it('ends with the IEND chunk', () => {
    const png = solidPng(2, 2, [9, 9, 9]);
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });
});

describe('syntheticFrame', () => {
  it('produces a different image as the frame number advances', () => {
    const a = syntheticFrame(1);
    const b = syntheticFrame(2);
    expect(a.equals(b)).toBe(false);
  });

  it('always produces a valid PNG', () => {
    for (const n of [0, 1, 15, 30, 100]) {
      const png = syntheticFrame(n);
      expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(png.length).toBeGreaterThan(50);
    }
  });
});
