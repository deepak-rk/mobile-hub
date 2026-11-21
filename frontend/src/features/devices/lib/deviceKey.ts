/**
 * A UDID alone is not a device: emulator serials (`emulator-5554`) repeat on
 * every host, so anything that selects, keys or links to "a device" must use
 * host + udid. Keying by udid alone made ticking one host's emulator-5554
 * tick every host's.
 *
 * Compared as an opaque string, never parsed back apart, so a `/` inside a
 * udid or machineId can't confuse it.
 */
export function deviceKey(device: { machineId: string; udid: string }): string {
  return `${device.machineId}/${device.udid}`;
}

/** Link to the single-device page, carrying the host so the page fetches the right one. */
export function deviceHref(udid: string, machineId: string | undefined): string {
  const path = `/devices/${encodeURIComponent(udid)}`;
  return machineId ? `${path}?${new URLSearchParams({ machineId }).toString()}` : path;
}
