import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RemoteControls } from './RemoteControls';
import { canControl, labelOf, lastResultText, pointToScreenFraction } from '../lib/remoteControl';
import type { useDeviceAction } from '../api/devices.api';
import type { Device } from '../types';

const device = {
  udid: 'emulator-5554',
  machineId: 'host-a',
  name: 'Pixel',
  platform: 'android',
  status: 'in-use',
  lock: { heldBy: 'u1', sessionId: 's', acquiredAt: new Date().toISOString() },
} as unknown as Device;

function fakeSend(over: Record<string, unknown> = {}) {
  return { mutate: vi.fn(), isPending: false, error: null, data: undefined, variables: undefined, ...over } as unknown as ReturnType<
    typeof useDeviceAction
  >;
}

describe('RemoteControls', () => {
  beforeAll(() => {
    // jsdom has no modal <dialog>; the kit's Dialog calls these.
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  it('sends a button press', async () => {
    const send = fakeSend();
    render(<RemoteControls device={device} send={send} />);
    await userEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(send.mutate).toHaveBeenCalledWith({ kind: 'key', key: 'home' });
  });

  it('types plain ASCII, and will not send what the phone cannot type', async () => {
    const send = fakeSend();
    render(<RemoteControls device={device} send={send} />);
    const box = screen.getByLabelText('Type on the phone');
    await userEvent.type(box, 'café');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await userEvent.clear(box);
    await userEvent.type(box, 'hello there{Enter}');
    expect(send.mutate).toHaveBeenCalledWith({ kind: 'text', text: 'hello there' });
    expect(box).toHaveValue('');
  });

  it('asks before rebooting', async () => {
    const send = fakeSend();
    render(<RemoteControls device={device} send={send} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reboot' }));
    expect(send.mutate).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button', { name: 'Reboot' });
    await userEvent.click(buttons[buttons.length - 1]);
    expect(send.mutate).toHaveBeenCalledWith({ kind: 'reboot' });
  });

  it("shows what the phone reported, named after the last action (a tap on the stream too)", () => {
    const send = fakeSend({
      variables: { kind: 'rotate', rotation: 1 },
      data: { _id: 'j', status: 'failed', action: { kind: 'rotate' }, output: null, error: 'The display stayed at 0°.', late: false },
    });
    render(<RemoteControls device={device} send={send} />);
    expect(screen.getByRole('status')).toHaveTextContent('Landscape: Failed — The display stayed at 0°.');
  });
});

describe('remoteControl helpers', () => {
  it('maps a click to the picture, not to the letterboxed box around it', () => {
    // A 1080x2220 portrait frame drawn into a 400x400 box: 194.6 px wide, centred.
    const box = { left: 0, top: 0, width: 400, height: 400 };
    expect(pointToScreenFraction(200, 200, box, 1080, 2220)).toEqual({ x: 0.5, y: 0.5 });
    expect(pointToScreenFraction(50, 200, box, 1080, 2220)).toBeNull(); // in the side bar
    const p = pointToScreenFraction(200 + 97, 400, box, 1080, 2220); // just inside the right edge
    expect(p?.x).toBeCloseTo(1, 2);
    expect(p?.y).toBe(1);
  });

  it('offers control only to the holder, on Android, outside a test run', () => {
    expect(canControl(device, 'u1')).toBe(true);
    expect(canControl(device, 'u2')).toBe(false);
    expect(canControl({ ...device, platform: 'ios' } as Device, 'u1')).toBe(false);
    expect(canControl({ ...device, lock: { ...device.lock, reason: 'execution:r1' } } as Device, 'u1')).toBe(false);
  });

  it('never puts typed text in the status line', () => {
    expect(labelOf({ kind: 'text', text: 'secret' })).toBe('Type');
    expect(lastResultText('Type', { _id: 'j', status: 'succeeded', action: { kind: 'text' }, output: null, error: null, late: false })).toBe(
      'Type: done',
    );
  });
});
