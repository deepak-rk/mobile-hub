import { describe, it, expect } from 'vitest';
import { identifyInstalledPackage, parsePackageList } from './installer';

/**
 * Post-install verification's two pure parts. These are the pieces that
 * actually break: `pm list packages` output varies by Android version, and a
 * misparse would make either every package or no package look changed — which
 * would turn verification into either a false alarm on every install or a
 * silent no-op, and a check that silently no-ops reads as a guarantee it
 * isn't giving.
 */
describe('parsePackageList', () => {
  it('parses names and version codes from a modern device', () => {
    const packages = parsePackageList(
      ['package:com.android.settings versionCode:33', 'package:com.wdiodemoapp versionCode:2'].join('\n'),
    );
    expect(packages.get('com.android.settings')).toBe('33');
    expect(packages.get('com.wdiodemoapp')).toBe('2');
  });

  it('records a null version when the device is too old for --show-versioncode', () => {
    // Distinct from "version 0": null means unknown, and callers must not read
    // unknown-to-unknown as evidence a package is unchanged.
    const packages = parsePackageList('package:com.example.legacy');
    expect(packages.has('com.example.legacy')).toBe(true);
    expect(packages.get('com.example.legacy')).toBeNull();
  });

  it('tolerates CRLF and blank lines', () => {
    // adb over Windows emits CRLF; an unhandled \r would become part of the
    // version string and make every package look changed.
    const packages = parsePackageList('package:com.a versionCode:1\r\n\r\npackage:com.b versionCode:2\r\n');
    expect([...packages.keys()]).toEqual(['com.a', 'com.b']);
    expect(packages.get('com.a')).toBe('1');
  });

  it('ignores lines that are not package entries', () => {
    const packages = parsePackageList(['WARNING: linker: something', 'package:com.real versionCode:5'].join('\n'));
    expect([...packages.keys()]).toEqual(['com.real']);
  });

  it('returns an empty map for empty output', () => {
    expect(parsePackageList('').size).toBe(0);
  });
});

describe('identifyInstalledPackage', () => {
  it('identifies a package that was not previously installed', () => {
    const before = new Map([['com.other', '1']]);
    const after = new Map([
      ['com.other', '1'],
      ['com.wdiodemoapp', '2'],
    ]);
    expect(identifyInstalledPackage(before, after)).toBe('com.wdiodemoapp');
  });

  it('identifies an upgrade by its changed version code', () => {
    const before = new Map([['com.wdiodemoapp', '1']]);
    const after = new Map([['com.wdiodemoapp', '2']]);
    expect(identifyInstalledPackage(before, after)).toBe('com.wdiodemoapp');
  });

  it('returns null for a same-version reinstall', () => {
    // The common case here: `pm install -r` of an already-present build leaves
    // the table identical, so no package can be attributed to this run. Null
    // means "unknown", and the caller must not treat it as verified.
    const before = new Map([['com.wdiodemoapp', '2']]);
    const after = new Map([['com.wdiodemoapp', '2']]);
    expect(identifyInstalledPackage(before, after)).toBeNull();
  });

  it('does not treat unknown-to-unknown versions as a change', () => {
    // An older device reports no version codes at all; every package would
    // otherwise look changed on every install.
    const before = new Map([['com.wdiodemoapp', null]]);
    const after = new Map([['com.wdiodemoapp', null]]);
    expect(identifyInstalledPackage(before, after)).toBeNull();
  });

  it('returns null when several packages changed at once', () => {
    // Something else installed concurrently, so no single candidate can be
    // attributed to this run — guessing one would verify the wrong app.
    const before = new Map<string, string | null>();
    const after = new Map([
      ['com.a', '1'],
      ['com.b', '1'],
    ]);
    expect(identifyInstalledPackage(before, after)).toBeNull();
  });

  it('returns null when the device could not be queried at all', () => {
    // listInstalledPackages yields an empty map when adb fails; that must read
    // as unverified rather than as a change.
    expect(identifyInstalledPackage(new Map(), new Map())).toBeNull();
  });
});
