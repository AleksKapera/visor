import fs from 'node:fs';
import path from 'node:path';

import type { AdapterCapability, PlatformAdapter } from './types.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axDRf0AAAAASUVORK5CYII=',
  'base64'
);

function resolveArtifactPath(args: Record<string, unknown>, extension: string, fallbackLabel: string): string {
  const label = String(args.label ?? fallbackLabel);
  return path.resolve(typeof args.path === 'string' ? args.path : `${label}.${extension}`);
}

function targetValue(target: string): string {
  const separatorIndex = target.indexOf('=');
  return separatorIndex === -1 ? target : target.slice(separatorIndex + 1);
}

export class LocalRuntimeAdapter implements PlatformAdapter {
  private counter = 0;
  private route = 'app://home';

  capability(): AdapterCapability {
    return {
      platform: 'android',
      commands: ['navigate', 'tap', 'act', 'scroll', 'screenshot', 'wait', 'source']
    };
  }

  async navigate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.route = String(args.to ?? this.route);
    return {
      action: 'navigate',
      platform: 'android',
      args: { to: this.route }
    };
  }

  async tap(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = String(args.target ?? '');
    if (targetValue(target) === 'Increment') {
      this.counter += 1;
    }

    return {
      action: 'tap',
      platform: 'android',
      args: { target }
    };
  }

  async act(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {
      action: 'act',
      platform: 'android',
      args
    };
  }

  async scroll(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {
      action: 'scroll',
      platform: 'android',
      args: {
        direction: args.direction ?? 'down',
        percent: args.percent ?? 70
      }
    };
  }

  async screenshot(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const label = String(args.label ?? 'capture');
    const filePath = resolveArtifactPath(args, 'png', label);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, TINY_PNG);

    return {
      action: 'screenshot',
      platform: 'android',
      args: {
        label,
        file: path.basename(filePath),
        path: filePath,
        width: 1,
        height: 1
      }
    };
  }

  async wait(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {
      action: 'wait',
      platform: 'android',
      args: { ms: Number(args.ms ?? 0) }
    };
  }

  async source(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const label = String(args.label ?? 'source');
    const filePath = resolveArtifactPath(args, 'xml', label);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = this.sourceXml();
    fs.writeFileSync(filePath, content, 'utf8');

    return {
      action: 'source',
      platform: 'android',
      args: {
        label,
        file: path.basename(filePath),
        path: filePath,
        format: 'xml',
        bytes: Buffer.byteLength(content, 'utf8')
      }
    };
  }

  async exists(target: string): Promise<boolean> {
    const value = targetValue(target);
    return value === 'Increment' || value === String(this.counter) || this.sourceXml().includes(value);
  }

  async close(): Promise<void> {
    return undefined;
  }

  private sourceXml(): string {
    return [
      '<hierarchy>',
      `  <node text="Route: ${this.route}" />`,
      `  <node text="${this.counter}" label="${this.counter}" name="${this.counter}" value="${this.counter}" />`,
      '  <node text="Increment" content-desc="Increment" label="Increment" name="Increment" />',
      '</hierarchy>',
      ''
    ].join('\n');
  }
}
