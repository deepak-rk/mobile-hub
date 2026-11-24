import { useState, type FormEvent } from 'react';
import { Button, Dialog } from 'react-design-kit';
import type { ApiError } from '@/services/api';
import { useDeviceAction, type DeviceAction } from '../api/devices.api';
import { KEYS, labelOf, lastResultText } from '../lib/remoteControl';
import type { Device } from '../types';
import styles from './RemoteControls.module.css';

/**
 * Buttons, typing, rotation and reboot for a phone the viewer holds. Taps and
 * swipes go on the live view itself (see DeviceStream's `onGesture`). The
 * caller decides whether to render this (`canControl`).
 */
export function RemoteControls({ device, send }: { device: Device; send: ReturnType<typeof useDeviceAction> }) {
  const [text, setText] = useState('');
  const [confirmReboot, setConfirmReboot] = useState(false);
  // From the mutation itself, so a tap on the live view is named too.
  const lastLabel = labelOf(send.variables);

  function run(action: DeviceAction) {
    send.mutate(action);
  }

  function onType(e: FormEvent) {
    e.preventDefault();
    if (!text) return;
    run({ kind: 'text', text });
    setText('');
  }

  const error = send.error as ApiError | null;
  const printable = /^[\x20-\x7e]*$/.test(text);

  return (
    <div className={styles.wrap}>
      <div className={styles.row} role="group" aria-label="Phone buttons">
        {KEYS.map((k) => (
          <Button key={k.key} size="sm" variant="secondary" onClick={() => run({ kind: 'key', key: k.key })}>
            {k.label}
          </Button>
        ))}
      </div>
      <div className={styles.row} role="group" aria-label="Rotation">
        <Button size="sm" variant="secondary" onClick={() => run({ kind: 'rotate', rotation: 0 })}>
          Portrait
        </Button>
        <Button size="sm" variant="secondary" onClick={() => run({ kind: 'rotate', rotation: 1 })}>
          Landscape
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmReboot(true)}>
          Reboot
        </Button>
      </div>
      <form className={styles.row} onSubmit={onType}>
        <label className={styles.label} htmlFor={`type-${device.udid}`}>
          Type on the phone
        </label>
        <input
          id={`type-${device.udid}`}
          className={styles.input}
          value={text}
          maxLength={500}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          aria-invalid={!printable}
          aria-describedby={`type-hint-${device.udid}`}
        />
        <Button size="sm" type="submit" disabled={!text || !printable}>
          Send
        </Button>
      </form>
      <p id={`type-hint-${device.udid}`} className={styles.hint}>
        {printable
          ? 'Plain ASCII only. Tap or swipe on the live view to touch the screen.'
          : 'Only plain ASCII characters can be typed on the phone.'}
      </p>

      <p className={styles.status} role="status" aria-live="polite">
        {send.isPending
          ? `${lastLabel}…`
          : error
            ? `${lastLabel}: ${error.message ?? 'the request failed'}`
            : send.data
              ? lastResultText(lastLabel, send.data)
              : ''}
      </p>

      <Dialog
        open={confirmReboot}
        onClose={() => setConfirmReboot(false)}
        title={`Reboot ${device.name}?`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmReboot(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setConfirmReboot(false);
                run({ kind: 'reboot' });
              }}
            >
              Reboot
            </Button>
          </>
        }
      >
        The phone restarts and drops off the lab for a minute or two. Anything unsaved on it is lost.
      </Dialog>
    </div>
  );
}
