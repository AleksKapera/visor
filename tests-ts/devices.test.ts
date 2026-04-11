import { PassThrough } from 'node:stream';

import {
  DeviceSelectionError,
  parseAndroidDevices,
  parseIosBootedDevices,
  resetDeviceCommandRunner,
  resolveRunningDevice,
  setDeviceCommandRunner
} from '../src/devices.js';

function setDetectedDevices(androidOutput: string, iosOutput: string): void {
  setDeviceCommandRunner(async (command) => {
    if (command === 'adb') {
      return androidOutput;
    }
    if (command === 'xcrun') {
      return iosOutput;
    }
    throw new Error(`Unexpected command ${command}`);
  });
}

describe('device discovery', () => {
  afterEach(() => {
    resetDeviceCommandRunner();
  });

  it('parses running android devices only', () => {
    const devices = parseAndroidDevices(
      [
        'List of devices attached',
        'emulator-5554\tdevice',
        'offline-1\toffline',
        'unauthorized-1\tunauthorized',
        ''
      ].join('\n')
    );

    expect(devices).toEqual([
      { platform: 'android', id: 'emulator-5554', name: 'emulator-5554' }
    ]);
  });

  it('parses booted iOS simulators', () => {
    const devices = parseIosBootedDevices(
      [
        '== Devices ==',
        '-- iOS 18.4 --',
        '    iPhone 17 Pro (4F2B8A0B-AAAA-BBBB-CCCC-111122223333) (Booted)',
        '    iPad Air (shutdown)',
        ''
      ].join('\n')
    );

    expect(devices).toEqual([
      {
        platform: 'ios',
        id: '4F2B8A0B-AAAA-BBBB-CCCC-111122223333',
        name: 'iPhone 17 Pro'
      }
    ]);
  });

  it('resolves a provided device by id', async () => {
    setDetectedDevices(
      'List of devices attached\nemulator-5554\tdevice\n',
      '    iPhone 17 Pro (4F2B8A0B-AAAA-BBBB-CCCC-111122223333) (Booted)\n'
    );

    await expect(resolveRunningDevice('emulator-5554')).resolves.toEqual({
      platform: 'android',
      id: 'emulator-5554',
      name: 'emulator-5554'
    });
  });

  it('auto-selects a single detected device', async () => {
    setDetectedDevices('', '    iPhone 17 Pro (4F2B8A0B-AAAA-BBBB-CCCC-111122223333) (Booted)\n');

    await expect(resolveRunningDevice()).resolves.toEqual({
      platform: 'ios',
      id: '4F2B8A0B-AAAA-BBBB-CCCC-111122223333',
      name: 'iPhone 17 Pro'
    });
  });

  it('fails in non-interactive mode when multiple devices are detected', async () => {
    setDetectedDevices(
      'List of devices attached\nemulator-5554\tdevice\n',
      '    iPhone 17 Pro (4F2B8A0B-AAAA-BBBB-CCCC-111122223333) (Booted)\n'
    );

    await expect(
      resolveRunningDevice(undefined, {
        input: process.stdin,
        output: process.stderr
      })
    ).rejects.toThrow(DeviceSelectionError);
  });

  it('prompts for a device when multiple devices are detected in a tty', async () => {
    setDetectedDevices(
      'List of devices attached\nemulator-5554\tdevice\n',
      '    iPhone 17 Pro (4F2B8A0B-AAAA-BBBB-CCCC-111122223333) (Booted)\n'
    );
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    output.isTTY = true;

    const selected = resolveRunningDevice(undefined, { input, output });
    input.write('2\n');

    await expect(selected).resolves.toEqual({
      platform: 'ios',
      id: '4F2B8A0B-AAAA-BBBB-CCCC-111122223333',
      name: 'iPhone 17 Pro'
    });
  });
});
