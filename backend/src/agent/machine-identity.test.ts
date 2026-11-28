import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { machineFingerprint, parseWindowsMachineGuid, resolveMachineId } from './machine-identity';

describe('resolveMachineId', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-id-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses MACHINE_ID when set, and persists nothing', () => {
    expect(resolveMachineId(' lab-7 ', dir, 'box')).toEqual({ id: 'lab-7', source: 'env' });
    expect(fs.existsSync(path.join(dir, 'machine-id'))).toBe(false);
  });

  it('persists the hostname on first start and keeps it after a rename', () => {
    expect(resolveMachineId(undefined, dir, 'old-name')).toEqual({ id: 'old-name', source: 'new' });
    expect(resolveMachineId(undefined, dir, 'new-name')).toEqual({ id: 'old-name', source: 'file' });
  });

  it('replaces an empty or malformed file instead of using it', () => {
    fs.writeFileSync(path.join(dir, 'machine-id'), '\n');
    expect(resolveMachineId(undefined, dir, 'box')).toEqual({ id: 'box', source: 'new' });
    fs.writeFileSync(path.join(dir, 'machine-id'), '/etc/passwd\n');
    expect(resolveMachineId(undefined, dir, 'box')).toEqual({ id: 'box', source: 'new' });
    expect(fs.readFileSync(path.join(dir, 'machine-id'), 'utf8')).toBe('box\n');
  });

  it('falls back to the hostname, unsaved, when the folder cannot be written', () => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    expect(resolveMachineId(undefined, path.join(blocker, 'sub'), 'box')).toEqual({ id: 'box', source: 'unsaved' });
  });
});

describe('machineFingerprint', () => {
  it('is a stable 32-hex hash that does not contain the OS id', () => {
    const f = machineFingerprint('1234-abcd');
    expect(f).toMatch(/^[0-9a-f]{32}$/);
    expect(machineFingerprint('1234-abcd')).toBe(f);
    expect(machineFingerprint('1234-abce')).not.toBe(f);
    expect(f).not.toContain('1234');
  });
  it('is null without an OS id', () => {
    expect(machineFingerprint(null)).toBeNull();
  });
});

describe('parseWindowsMachineGuid', () => {
  it('reads the value out of reg query output', () => {
    const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    0f1e2d3c-aaaa-bbbb-cccc-1234567890ab\r\n';
    expect(parseWindowsMachineGuid(out)).toBe('0f1e2d3c-aaaa-bbbb-cccc-1234567890ab');
    expect(parseWindowsMachineGuid('ERROR: not found')).toBeNull();
  });
});
