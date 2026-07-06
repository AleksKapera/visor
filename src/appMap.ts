import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveTapMode } from './adapters.js';
import type {
  CommandName,
  MapExecutionOptions,
  MapExecutionSummary,
  MapRouteStep,
  Platform,
  PlatformAdapter
} from './types.js';
import { canonicalJson, ensureDir, signatureFor, utcNowIso } from './utils.js';

export const APP_MAP_SCHEMA_VERSION = 1;

type ControlSafety = 'safe' | 'needs-input' | 'risky' | 'unknown';
type TargetKind = 'stable' | 'text' | 'coordinate' | 'unknown';

interface SourceElement {
  tag: string;
  selector: string;
  targets: string[];
  labels: string[];
  stable: boolean;
  safety: ControlSafety;
}

interface ScreenObservation {
  fingerprint: string;
  normalized_fingerprint: string;
  elements: SourceElement[];
  element_keys: string[];
  auth_required: boolean;
}

interface AppMapScreen {
  id: string;
  variant_ids: string[];
}

interface AppMapVariant {
  id: string;
  screen_id: string;
  fingerprint: string;
  normalized_fingerprint: string;
  elements: SourceElement[];
  element_keys: string[];
  auth_required: boolean;
  observations: number;
  confidence: number;
  last_observed_at: string;
}

interface DestinationContract {
  variant_id: string;
  required_targets: string[];
  normalized_fingerprint: string;
}

interface AppMapEdge {
  id: string;
  from_variant_id: string;
  to_variant_id: string;
  command: CommandName;
  args: Record<string, unknown>;
  target?: string;
  confidence: number;
  successes: number;
  failures: number;
  stale: boolean;
  candidate: boolean;
  destination_contract: DestinationContract;
  last_observed_at: string;
}

interface AppMapFile {
  schema_version: number;
  identity: string;
  app_id: string;
  platform: Platform;
  created_at: string;
  updated_at: string;
  screens: AppMapScreen[];
  variants: AppMapVariant[];
  edges: AppMapEdge[];
}

interface ResolvedMapOptions {
  enabled: boolean;
  rootDir: string;
  appId: string;
  repairDepth: number;
  repairTimeoutMs: number;
}

interface AppMapContext {
  adapter: PlatformAdapter;
  map: AppMapFile;
  filePath: string;
  options: ResolvedMapOptions;
  summary: MapExecutionSummary;
  changed: boolean;
}

interface LoadedAppMap {
  map: AppMapFile;
  scrubbed: boolean;
}

interface ObservedVariant {
  observation: ScreenObservation;
  variant: AppMapVariant;
  created: boolean;
}

interface PlannedRoute {
  edges: AppMapEdge[];
  ambiguous: boolean;
  authRequired: boolean;
}

interface RouteDriveResult {
  current: ObservedVariant;
  failedEdge?: AppMapEdge;
}

interface RepairResult {
  current: ObservedVariant;
  route: MapRouteStep[];
}

interface RepairAttempt {
  found: boolean;
  current: ObservedVariant;
  route: MapRouteStep[];
  remainingDepth: number;
}

interface TargetDescriptor {
  kind: TargetKind;
  target?: string;
  value?: string;
  confidence: number;
}

const RISKY_WORDS = [
  'delete',
  'remove',
  'logout',
  'log out',
  'sign out',
  'submit',
  'send',
  'pay',
  'purchase',
  'buy',
  'confirm',
  'destroy',
  'archive'
];

const INPUT_WORDS = ['password', 'email', 'username', 'search', 'input', 'text field', 'textfield'];
const AUTH_WORDS = ['login', 'log in', 'sign in', 'password', 'username', 'auth', 'authentication'];

function envNoMap(): boolean {
  const raw = process.env.VISOR_NO_MAP ?? process.env.VISOR_DISABLE_MAP;
  return ['1', 'true', 'yes', 'on'].includes(String(raw ?? '').trim().toLowerCase());
}

function resolveOptions(platform: Platform, options?: MapExecutionOptions): ResolvedMapOptions {
  const enabled = options?.enabled !== false && !envNoMap();
  return {
    enabled,
    rootDir: options?.rootDir ?? process.env.VISOR_APP_MAP_DIR ?? path.join(process.cwd(), '.visor', 'maps'),
    appId: options?.appId ?? `default-${platform}`,
    repairDepth: options?.repairDepth ?? 2,
    repairTimeoutMs: options?.repairTimeoutMs ?? 30000
  };
}

function mapIdentity(platform: Platform, appId: string): string {
  return `${platform}:${appId}`;
}

function mapFilePath(rootDir: string, identity: string): string {
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
  return path.join(ensureDir(rootDir), `${digest}.json`);
}

function newMap(platform: Platform, appId: string): AppMapFile {
  const now = utcNowIso();
  return {
    schema_version: APP_MAP_SCHEMA_VERSION,
    identity: mapIdentity(platform, appId),
    app_id: appId,
    platform,
    created_at: now,
    updated_at: now,
    screens: [],
    variants: [],
    edges: []
  };
}

function readMap(filePath: string, platform: Platform, appId: string): LoadedAppMap {
  if (!fs.existsSync(filePath)) {
    return { map: newMap(platform, appId), scrubbed: false };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AppMapFile;
    if (parsed.schema_version !== APP_MAP_SCHEMA_VERSION || parsed.identity !== mapIdentity(platform, appId)) {
      return { map: newMap(platform, appId), scrubbed: false };
    }
    const originalEdgeCount = parsed.edges.length;
    parsed.edges = parsed.edges.filter((edge) => !isValueBearingAction(edge.command, edge.args));
    return { map: parsed, scrubbed: parsed.edges.length !== originalEdgeCount };
  } catch {
    return { map: newMap(platform, appId), scrubbed: false };
  }
}

function writeMap(filePath: string, map: AppMapFile): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function createMapSummary(
  adapter: PlatformAdapter,
  options?: MapExecutionOptions
): MapExecutionSummary {
  const platform = adapter.capability().platform;
  const resolved = resolveOptions(platform, options);
  const identity = mapIdentity(platform, resolved.appId);
  return {
    enabled: resolved.enabled,
    used: false,
    updated: false,
    repaired: false,
    repairs: 0,
    schema_version: APP_MAP_SCHEMA_VERSION,
    path: resolved.enabled ? mapFilePath(resolved.rootDir, identity) : undefined,
    identity
  };
}

export function createAppMapContext(
  adapter: PlatformAdapter,
  options?: MapExecutionOptions
): AppMapContext | null {
  const platform = adapter.capability().platform;
  const resolved = resolveOptions(platform, options);
  if (!resolved.enabled) {
    return null;
  }

  const identity = mapIdentity(platform, resolved.appId);
  const filePath = mapFilePath(resolved.rootDir, identity);
  const summary = createMapSummary(adapter, options);
  const loaded = readMap(filePath, platform, resolved.appId);

  return {
    adapter,
    map: loaded.map,
    filePath,
    options: resolved,
    summary,
    changed: loaded.scrubbed
  };
}

export function persistAppMapContext(context: AppMapContext | null): MapExecutionSummary | undefined {
  if (!context) {
    return undefined;
  }

  context.summary.updated = context.summary.updated || context.changed;
  if (context.changed) {
    context.map.updated_at = utcNowIso();
    writeMap(context.filePath, context.map);
    context.changed = false;
  }

  return context.summary;
}

function attributeMap(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (const match of input.matchAll(pattern)) {
    attrs[match[1]] = match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function normalizeLabel(value: string): string {
  return value
    .replace(/[0-9a-f]{8,}/gi, '<id>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<time>')
    .replace(/\b\d+\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim() !== '')));
}

function isLikelyFormControl(tag: string, attrs: Record<string, string>): boolean {
  const haystack = [
    tag,
    attrs.type ?? '',
    attrs.class ?? '',
    attrs.name ?? '',
    attrs.label ?? '',
    attrs.placeholder ?? ''
  ]
    .join(' ')
    .toLowerCase();

  return [
    'input',
    'textfield',
    'text field',
    'edittext',
    'secure',
    'password',
    'email',
    'username',
    'search',
    'phone',
    'credit',
    'card'
  ].some((word) => haystack.includes(word));
}

function redactLabel(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>')
    .replace(/\b(?:\+?\d[\d .()-]{7,}\d)\b/g, '<redacted-phone>')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '<redacted-card>');
}

function classifyControl(tag: string, labels: string[], attrs: Record<string, string>): ControlSafety {
  const haystack = [...labels, tag, attrs.type ?? '', attrs.class ?? ''].join(' ').toLowerCase();
  if (RISKY_WORDS.some((word) => haystack.includes(word))) {
    return 'risky';
  }
  if (INPUT_WORDS.some((word) => haystack.includes(word))) {
    return 'needs-input';
  }
  if (
    tag.toLowerCase().includes('button') ||
    attrs.clickable === 'true' ||
    attrs.enabled === 'true' ||
    attrs.accessible === 'true'
  ) {
    return 'safe';
  }
  return 'unknown';
}

function extractElements(source: string): SourceElement[] {
  const elements: SourceElement[] = [];
  const tagPattern = /<([A-Za-z][A-Za-z0-9_.:-]*)([^<>]*?)(?:\/>|>([^<>]*)<\/\1>)/g;

  for (const match of source.matchAll(tagPattern)) {
    const tag = match[1];
    const attrs = attributeMap(match[2] ?? '');
    const bodyText = (match[3] ?? '').trim();
    const formControl = isLikelyFormControl(tag, attrs);
    const rawLabels = unique([
      redactLabel(attrs.name ?? ''),
      redactLabel(attrs.label ?? ''),
      formControl ? '' : redactLabel(attrs.text ?? ''),
      formControl ? '' : redactLabel(attrs.value ?? ''),
      redactLabel(attrs['content-desc'] ?? ''),
      redactLabel(attrs['contentDescription'] ?? ''),
      formControl ? '' : redactLabel(bodyText)
    ]);
    const id = attrs['resource-id'] ?? attrs.id ?? attrs.identifier ?? '';
    const targets = unique([
      ...rawLabels,
      ...rawLabels.map((label) => `text=${label}`),
      id ? `id=${id}` : ''
    ]);
    if (targets.length === 0) {
      continue;
    }

    const stable = Boolean(rawLabels.length > 0 || id);
    const selector = id ? `id=${id}` : rawLabels[0] ?? targets[0];
    elements.push({
      tag,
      selector,
      targets,
      labels: rawLabels,
      stable,
      safety: classifyControl(tag, rawLabels, attrs)
    });
  }

  return elements;
}

function observeSource(source: string): ScreenObservation {
  const elements = extractElements(source);
  const normalizedLabels = elements.flatMap((element) => element.labels.map(normalizeLabel));
  const elementKeys = unique([
    ...elements.flatMap((element) => element.targets.map(normalizeLabel)),
    ...normalizedLabels
  ]).sort();
  const normalizedFingerprint = signatureFor(elementKeys);
  const authRequired = AUTH_WORDS.some((word) => normalizedLabels.some((label) => label.includes(word)));

  return {
    fingerprint: signatureFor(source),
    normalized_fingerprint: normalizedFingerprint,
    elements,
    element_keys: elementKeys,
    auth_required: authRequired
  };
}

function similarity(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 1;
  }
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = Array.from(leftSet).filter((value) => rightSet.has(value)).length;
  const union = new Set([...left, ...right]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  const smaller = Math.min(leftSet.size, rightSet.size);
  const containment = smaller === 0 ? 0 : intersection / smaller;
  return containment >= 0.8 ? Math.max(jaccard, containment) : jaccard;
}

function elementIdentityKeys(elements: SourceElement[]): string[] {
  return unique(
    elements.flatMap((element) => {
      const tag = element.tag.toLowerCase();
      const labels = element.labels.map(normalizeLabel);
      const ids = element.targets.filter((target) => target.startsWith('id=')).map(normalizeLabel);
      return [...labels, ...ids].map((value) => `${tag}:${element.safety}:${value}`);
    })
  ).sort();
}

function newVariant(map: AppMapFile, observation: ScreenObservation): AppMapVariant {
  const screen: AppMapScreen = {
    id: `screen_${map.screens.length + 1}`,
    variant_ids: []
  };
  const variant: AppMapVariant = {
    id: `variant_${map.variants.length + 1}`,
    screen_id: screen.id,
    fingerprint: observation.fingerprint,
    normalized_fingerprint: observation.normalized_fingerprint,
    elements: observation.elements,
    element_keys: observation.element_keys,
    auth_required: observation.auth_required,
    observations: 1,
    confidence: 0.6,
    last_observed_at: utcNowIso()
  };
  screen.variant_ids.push(variant.id);
  map.screens.push(screen);
  map.variants.push(variant);
  return variant;
}

function upsertVariant(map: AppMapFile, observation: ScreenObservation): ObservedVariant {
  let best: AppMapVariant | null = null;
  let bestScore = 0;

  for (const variant of map.variants) {
    const score =
      variant.normalized_fingerprint === observation.normalized_fingerprint
        ? 1
        : similarity(elementIdentityKeys(variant.elements), elementIdentityKeys(observation.elements));
    if (score > bestScore) {
      best = variant;
      bestScore = score;
    }
  }

  if (!best || bestScore < 0.45) {
    return {
      observation,
      variant: newVariant(map, observation),
      created: true
    };
  }

  best.fingerprint = observation.fingerprint;
  best.normalized_fingerprint = observation.normalized_fingerprint;
  best.elements = observation.elements;
  best.element_keys = observation.element_keys;
  best.auth_required = observation.auth_required;
  best.observations += 1;
  best.confidence = Math.min(1, best.confidence + 0.05);
  best.last_observed_at = utcNowIso();

  return {
    observation,
    variant: best,
    created: false
  };
}

async function observeCurrentScreen(context: AppMapContext): Promise<ObservedVariant> {
  const sourceDir = ensureDir(path.join(os.tmpdir(), 'visor-app-map-source'));
  const sourcePath = path.join(sourceDir, `${process.pid}-${Date.now()}-${randomUUID()}.xml`);
  const details = await context.adapter.source({ label: 'app-map-source', path: sourcePath });
  const args = details.args;
  const sourceArgs = args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
  const detailPath =
    typeof sourceArgs.path === 'string'
      ? sourceArgs.path
      : sourcePath;
  const source = fs.existsSync(detailPath) ? fs.readFileSync(detailPath, 'utf8') : '';
  try {
    fs.rmSync(detailPath, { force: true });
  } catch {
    // Source observations are transient; stale temp files should not fail a run.
  }
  const observed = upsertVariant(context.map, observeSource(source));
  context.changed = true;
  return observed;
}

function targetDescriptor(command: CommandName, args: Record<string, unknown>): TargetDescriptor {
  if (isValueBearingAction(command, args)) {
    return { kind: 'unknown', confidence: 0 };
  }

  if (command === 'tap') {
    try {
      if (resolveTapMode(args) === 'coordinates') {
        return { kind: 'coordinate', confidence: 0 };
      }
    } catch {
      return { kind: 'unknown', confidence: 0 };
    }
  }

  const target = typeof args.target === 'string' ? args.target : undefined;
  if (!target) {
    return { kind: 'unknown', confidence: 0 };
  }

  if (target.startsWith('text=')) {
    return { kind: 'text', target, value: target.slice(5), confidence: 0.6 };
  }

  if (target.startsWith('xpath=')) {
    return { kind: 'unknown', target, value: target.slice(6), confidence: 0.2 };
  }

  return { kind: 'stable', target, value: target.replace(/^(id=|accessibility=)/, ''), confidence: 0.9 };
}

function isValueBearingAction(command: CommandName, args: Record<string, unknown>): boolean {
  return command === 'act' && args.name === 'type' && args.value !== undefined;
}

function replayableEdge(edge: AppMapEdge): boolean {
  return !isValueBearingAction(edge.command, edge.args);
}

function variantContainsTarget(variant: AppMapVariant, descriptor: TargetDescriptor): boolean {
  if (!descriptor.target && !descriptor.value) {
    return false;
  }

  const target = descriptor.target ?? '';
  const value = descriptor.value ?? target;
  return variant.elements.some((element) => {
    if (element.targets.includes(target) || element.targets.includes(value)) {
      return true;
    }
    if (descriptor.kind === 'text') {
      return element.labels.some((label) => label === value);
    }
    return element.labels.some((label) => label === value);
  });
}

function candidateVariants(map: AppMapFile, descriptor: TargetDescriptor): AppMapVariant[] {
  return map.variants.filter((variant) => variantContainsTarget(variant, descriptor));
}

function summarizeEdge(edge: AppMapEdge): MapRouteStep {
  return {
    command: edge.command,
    target: edge.target,
    confidence: Math.round(edge.confidence * 100) / 100
  };
}

function summarizeControl(command: CommandName, target: string, confidence: number): MapRouteStep {
  return {
    command,
    target,
    confidence: Math.round(confidence * 100) / 100
  };
}

function planRoute(map: AppMapFile, fromVariantId: string, descriptor: TargetDescriptor): PlannedRoute {
  if (descriptor.kind === 'coordinate' || descriptor.kind === 'unknown') {
    return { edges: [], ambiguous: false, authRequired: false };
  }

  const destinations = candidateVariants(map, descriptor);
  if (destinations.length === 0) {
    return { edges: [], ambiguous: false, authRequired: false };
  }

  if (descriptor.kind === 'text' && destinations.length > 1) {
    return { edges: [], ambiguous: true, authRequired: false };
  }

  const destinationIds = new Set(destinations.map((variant) => variant.id));
  const visited = new Set<string>([fromVariantId]);
  const queue: Array<{ variantId: string; edges: AppMapEdge[] }> = [{ variantId: fromVariantId, edges: [] }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    if (destinationIds.has(current.variantId)) {
      const destination = map.variants.find((variant) => variant.id === current.variantId);
      return { edges: current.edges, ambiguous: false, authRequired: Boolean(destination?.auth_required) };
    }

    const outgoing = map.edges
      .filter((edge) => edge.from_variant_id === current.variantId && !edge.stale && edge.confidence >= 0.25 && replayableEdge(edge))
      .sort((left, right) => right.confidence - left.confidence);
    for (const edge of outgoing) {
      if (visited.has(edge.to_variant_id)) {
        continue;
      }
      visited.add(edge.to_variant_id);
      queue.push({ variantId: edge.to_variant_id, edges: [...current.edges, edge] });
    }
  }

  return { edges: [], ambiguous: false, authRequired: destinations.some((variant) => variant.auth_required) };
}

function contractTargets(variant: AppMapVariant): string[] {
  return variant.elements
    .filter((element) => element.stable)
    .flatMap((element) => element.targets)
    .slice(0, 8);
}

function matchingEdge(
  map: AppMapFile,
  fromVariantId: string,
  command: CommandName,
  target: string | undefined
): AppMapEdge | undefined {
  return map.edges.find(
    (edge) =>
      edge.from_variant_id === fromVariantId &&
      edge.command === command &&
      String(edge.target ?? '') === String(target ?? '')
  );
}

function recordEdgeSuccess(
  context: AppMapContext,
  from: AppMapVariant,
  to: AppMapVariant,
  command: CommandName,
  args: Record<string, unknown>,
  candidate: boolean
): void {
  if (from.id === to.id) {
    return;
  }

  const descriptor = targetDescriptor(command, args);
  if (descriptor.kind === 'coordinate' || descriptor.kind === 'unknown') {
    return;
  }

  const edge = matchingEdge(context.map, from.id, command, descriptor.target);
  if (edge) {
    edge.to_variant_id = to.id;
    edge.successes += 1;
    edge.failures = 0;
    edge.stale = false;
    edge.candidate = edge.candidate && edge.successes < 2;
    edge.confidence = Math.min(1, edge.confidence + 0.15);
    edge.destination_contract = {
      variant_id: to.id,
      required_targets: contractTargets(to),
      normalized_fingerprint: to.normalized_fingerprint
    };
    edge.last_observed_at = utcNowIso();
    context.changed = true;
    return;
  }

  context.map.edges.push({
    id: `edge_${context.map.edges.length + 1}`,
    from_variant_id: from.id,
    to_variant_id: to.id,
    command,
    args: structuredClone(args),
    target: descriptor.target,
    confidence: candidate ? 0.45 : descriptor.confidence,
    successes: 1,
    failures: 0,
    stale: false,
    candidate,
    destination_contract: {
      variant_id: to.id,
      required_targets: contractTargets(to),
      normalized_fingerprint: to.normalized_fingerprint
    },
    last_observed_at: utcNowIso()
  });
  context.changed = true;
}

function demoteEdge(context: AppMapContext, edge: AppMapEdge): void {
  edge.failures += 1;
  edge.confidence = Math.max(0, edge.confidence - 0.25);
  if (edge.failures >= 2 || edge.confidence < 0.25) {
    edge.stale = true;
  }
  edge.last_observed_at = utcNowIso();
  context.changed = true;
}

function satisfiesContract(edge: AppMapEdge, observed: ObservedVariant): boolean {
  if (observed.variant.id === edge.destination_contract.variant_id) {
    return true;
  }

  const observedTargets = new Set(observed.variant.elements.flatMap((element) => element.targets));
  const required = edge.destination_contract.required_targets;
  if (required.length === 0) {
    return observed.variant.normalized_fingerprint === edge.destination_contract.normalized_fingerprint;
  }

  const matched = required.filter((target) => observedTargets.has(target)).length;
  return matched / required.length >= 0.6;
}

async function driveRoute(
  context: AppMapContext,
  current: ObservedVariant,
  route: AppMapEdge[]
): Promise<RouteDriveResult> {
  for (const edge of route) {
    const args = structuredClone(edge.args);
    let observed: ObservedVariant;
    try {
      await context.adapter[edge.command](args);
      observed = await observeCurrentScreen(context);
    } catch {
      demoteEdge(context, edge);
      try {
        current = await observeCurrentScreen(context);
      } catch {
        // Keep the last known screen if the app cannot provide source after a failed cached action.
      }
      return { current, failedEdge: edge };
    }
    if (!satisfiesContract(edge, observed)) {
      demoteEdge(context, edge);
      return { current: observed, failedEdge: edge };
    }
    recordEdgeSuccess(context, current.variant, observed.variant, edge.command, args, false);
    current = observed;
  }

  return { current };
}

function safeTapTargets(variant: AppMapVariant): string[] {
  return unique(
    variant.elements
      .filter((element) => element.safety === 'safe' && element.stable)
      .map((element) => {
        const plainLabel = element.targets.find((target) => !target.includes('='));
        return plainLabel ?? element.targets[0] ?? '';
      })
  );
}

async function repairToTarget(
  context: AppMapContext,
  current: ObservedVariant,
  descriptor: TargetDescriptor,
  depth: number,
  deadline: number,
  blockedTargets: Set<string>
): Promise<RepairResult | null> {
  if (Date.now() > deadline || depth <= 0) {
    return null;
  }

  const attemptedTargets = new Map<string, Set<string>>();

  const attemptFrom = async (
    start: ObservedVariant,
    remainingDepth: number,
    route: MapRouteStep[]
  ): Promise<RepairAttempt> => {
    let cursor = start;
    let depthLeft = remainingDepth;
    let routeSoFar = route;

    while (Date.now() <= deadline) {
      if (variantContainsTarget(cursor.variant, descriptor)) {
        return { found: true, current: cursor, route: routeSoFar, remainingDepth: depthLeft };
      }
      if (depthLeft <= 0) {
        return { found: false, current: cursor, route: routeSoFar, remainingDepth: depthLeft };
      }

      const attemptsForVariant = attemptedTargets.get(cursor.variant.id) ?? new Set<string>();
      attemptedTargets.set(cursor.variant.id, attemptsForVariant);
      const target = safeTapTargets(cursor.variant).find(
        (candidate) => !blockedTargets.has(candidate) && !attemptsForVariant.has(candidate)
      );
      if (!target) {
        return { found: false, current: cursor, route: routeSoFar, remainingDepth: depthLeft };
      }

      attemptsForVariant.add(target);
      const args = { target };
      let observed: ObservedVariant;
      try {
        await context.adapter.tap(args);
        observed = await observeCurrentScreen(context);
      } catch {
        try {
          cursor = await observeCurrentScreen(context);
        } catch {
          // If both the exploratory tap and source read fail, keep the last observed screen.
        }
        continue;
      }

      recordEdgeSuccess(context, cursor.variant, observed.variant, 'tap', args, true);
      const nextRoute = [...routeSoFar, summarizeControl('tap', target, 0.45)];
      const nested = await attemptFrom(observed, depthLeft - 1, nextRoute);
      if (nested.found) {
        return nested;
      }

      cursor = nested.current;
      depthLeft = nested.remainingDepth;
      routeSoFar = nested.route;
    }

    return { found: false, current: cursor, route: routeSoFar, remainingDepth: depthLeft };
  };

  const attempt = await attemptFrom(current, depth, []);
  return attempt.found ? { current: attempt.current, route: attempt.route } : null;
}

export async function runMappedCommand(
  context: AppMapContext,
  command: CommandName,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const descriptor = targetDescriptor(command, args);
  const metadata: Record<string, unknown> = {
    enabled: true,
    routed: false,
    route: [] as MapRouteStep[],
    repaired: false,
    repairs: 0,
    path: context.filePath
  };

  if (descriptor.kind === 'unknown' || descriptor.kind === 'coordinate') {
    const details = await context.adapter[command](args);
    return { ...details, map: metadata };
  }

  let before = await observeCurrentScreen(context);
  if (!variantContainsTarget(before.variant, descriptor)) {
    if (before.variant.auth_required) {
      throw new Error(`Target '${descriptor.target ?? descriptor.value}' requires authentication from the current screen`);
    }

    const route = planRoute(context.map, before.variant.id, descriptor);
    if (route.ambiguous) {
      throw new Error(`Target '${descriptor.target ?? descriptor.value}' is ambiguous in the app map`);
    }
    if (route.authRequired) {
      throw new Error(`Target '${descriptor.target ?? descriptor.value}' is behind an auth-required screen`);
    }
    if (route.edges.length > 0) {
      context.summary.used = true;
      metadata.routed = true;
      metadata.route = route.edges.map(summarizeEdge);
      const driven = await driveRoute(context, before, route.edges);
      before = driven.current;
      if (driven.failedEdge) {
        const repair = await repairToTarget(
          context,
          before,
          descriptor,
          context.options.repairDepth,
          Date.now() + context.options.repairTimeoutMs,
          new Set(driven.failedEdge.target ? [driven.failedEdge.target] : [])
        );
        if (!repair) {
          throw new Error(
            `Cached app-map route for '${driven.failedEdge.target ?? driven.failedEdge.command}' could not be repaired within the bounded repair budget`
          );
        }
        context.summary.repaired = true;
        context.summary.repairs += 1;
        metadata.repaired = true;
        metadata.repairs = context.summary.repairs;
        metadata.route = [...(metadata.route as MapRouteStep[]), ...repair.route];
        before = repair.current;
      }
    } else {
      const repair = await repairToTarget(
        context,
        before,
        descriptor,
        context.options.repairDepth,
        Date.now() + context.options.repairTimeoutMs,
        new Set()
      );
      if (repair) {
        context.summary.used = true;
        context.summary.repaired = true;
        context.summary.repairs += 1;
        metadata.routed = repair.route.length > 0;
        metadata.repaired = true;
        metadata.repairs = context.summary.repairs;
        metadata.route = repair.route;
        before = repair.current;
      }
    }
  }

  if (!variantContainsTarget(before.variant, descriptor)) {
    throw new Error(`Target '${descriptor.target ?? descriptor.value}' is not reachable from the current app-map state`);
  }

  const details = await context.adapter[command](args);
  const after = await observeCurrentScreen(context);
  recordEdgeSuccess(context, before.variant, after.variant, command, args, false);
  return { ...details, map: metadata };
}

export async function discoverAppMap(
  adapter: PlatformAdapter,
  options?: MapExecutionOptions
): Promise<Record<string, unknown>> {
  const context = createAppMapContext(adapter, options);
  if (!context) {
    return {
      action: 'discover',
      map: createMapSummary(adapter, options),
      screen: null
    };
  }

  try {
    const observed = await observeCurrentScreen(context);
    const summary = persistAppMapContext(context);
    return {
      action: 'discover',
      map: summary,
      screen: {
        variant_id: observed.variant.id,
        screen_id: observed.variant.screen_id,
        element_count: observed.variant.elements.length,
        auth_required: observed.variant.auth_required,
        created: observed.created
      }
    };
  } finally {
    persistAppMapContext(context);
  }
}

export function mapDebugSnapshot(rootDir: string, platform: Platform, appId: string): unknown {
  const identity = mapIdentity(platform, appId);
  const filePath = mapFilePath(rootDir, identity);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AppMapFile;
  return JSON.parse(canonicalJson(parsed));
}
