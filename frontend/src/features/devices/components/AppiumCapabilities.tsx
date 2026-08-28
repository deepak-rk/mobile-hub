import { useState } from 'react';
import { Button, Card, CardBody } from 'react-design-kit';
import { icons, iconSize } from '@/lib/icons';
import type { Device } from '../types';
import styles from './AppiumCapabilities.module.css';

/**
 * The W3C-style capability set (Appium 2.x requires the `appium:` vendor
 * prefix on everything but `platformName`) a real Appium client would need
 * to start a session against this device. Purely informational — mobile-hub
 * doesn't run Appium sessions itself; see docs/TODO.md's "Appium server
 * orchestration" row. This exists so a device's identifiers don't have to be
 * hand-copied field by field into someone's own test config.
 */
function buildCapabilities(device: Device): Record<string, string> {
  const isIos = device.platform === 'ios';
  return {
    platformName: isIos ? 'iOS' : 'Android',
    'appium:deviceName': device.name,
    'appium:udid': device.udid,
    'appium:platformVersion': device.osVersion,
    'appium:automationName': isIos ? 'XCUITest' : 'UiAutomator2',
  };
}

export function AppiumCapabilities({ device }: { device: Device }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(buildCapabilities(device), null, 2);

  function onCopy() {
    void navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Card>
      <CardBody>
        <div className={styles.head}>
          <span className={styles.title}>Appium capabilities</span>
          <Button size="sm" variant="secondary" onClick={onCopy}>
            <icons.copy size={iconSize.control} aria-hidden="true" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <pre className={styles.block}>{json}</pre>
        <p className={styles.hint}>
          For your own Appium client — mobile-hub doesn&rsquo;t start Appium sessions itself yet.
        </p>
      </CardBody>
    </Card>
  );
}
