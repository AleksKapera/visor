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
type TargetKind = 'stable' | 'text' | 'text-contains' | 'section-first' | 'coordinate' | 'unknown';

interface SourceElement {
  tag: string;
  selector: string;
  targets: string[];
  labels: string[];
  stable: boolean;
  safety: ControlSafety;
  enabled: boolean;
  visible: boolean;
  clickable: boolean;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
}

interface ScreenObservation {
  fingerprint: string;
  normalized_fingerprint: string;
  elements: SourceElement[];
  element_keys: string[];
  auth_required: boolean;
}

interface SourceCapture {
  source: string;
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
  repair: boolean;
  crawl: boolean;
  crawlDepth: number;
  crawlLimit: number;
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
  diagnostics?: RoutePlanDiagnostics;
}

interface RoutePlanCandidateDiagnostic {
  variant_id: string;
  screen_id?: string;
  score: number;
  route: MapRouteStep[];
  selected: boolean;
  rejected_reason?: string;
}

interface RoutePlanDiagnostics {
  target: string;
  route_candidates: RoutePlanCandidateDiagnostic[];
  selected_variant_id?: string;
  ambiguous: boolean;
}

interface RouteDriveResult {
  current: ObservedVariant;
  failedEdge?: AppMapEdge;
}

type RestoreAcceptedBy = 'exact' | 'contract' | 'similarity' | 'root' | 'root-route';

interface RestoreMatch {
  acceptedBy: RestoreAcceptedBy;
  score?: number;
}

interface RestoreAttemptDiagnostic {
  strategy: string;
  command?: CommandName | 'act';
  target?: string;
  result: 'matched' | 'mismatched' | 'error';
  observed_variant_id?: string;
  observed_screen_id?: string;
  accepted_by?: RestoreAcceptedBy;
  error?: string;
}

interface RestoreDiagnostic {
  from_variant_id: string;
  target_variant_id: string;
  result: 'restored' | 'failed';
  accepted_by?: RestoreAcceptedBy;
  attempts: RestoreAttemptDiagnostic[];
}

interface RestoreResult {
  current: ObservedVariant;
  restored: boolean;
  acceptedBy?: RestoreAcceptedBy;
  diagnostic: RestoreDiagnostic;
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

interface TapCandidate {
  target: string;
  args: Record<string, unknown>;
  key: string;
}

interface TapCandidateOptions {
  preferContent?: boolean;
  excludeNavigation?: boolean;
  skipCurrentNavigation?: boolean;
}

interface NavigationControl {
  element: SourceElement;
  target: string;
  priority: number;
}

interface CrawlSummary {
  enabled: boolean;
  actions: number;
  variants: number;
  stopped_reason: string;
  restore_failures?: number;
  restore_diagnostics?: RestoreDiagnostic[];
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
    repairTimeoutMs: options?.repairTimeoutMs ?? 30000,
    repair: options?.repair === true,
    crawl: options?.crawl === true,
    crawlDepth: options?.crawlDepth ?? 2,
    crawlLimit: options?.crawlLimit ?? 24
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
    attrs[match[1]] = decodeXmlEntities(match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
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

function attrBool(attrs: Record<string, string>, key: string, defaultValue: boolean): boolean {
  const raw = attrs[key];
  if (raw === undefined) {
    return defaultValue;
  }
  return raw.trim().toLowerCase() === 'true';
}

function attrNumber(attrs: Record<string, string>, key: string): number | null {
  const parsed = Number(attrs[key]);
  return Number.isFinite(parsed) ? parsed : null;
}

function expandSemanticLabels(labels: string[]): string[] {
  return labels.flatMap((label) => {
    const lines = unique(label.split(/\n+/).map((line) => line.trim()));
    if (lines.length === 1 && lines[0] !== label) {
      return [label, lines[0]];
    }
    if (lines.length > 1 && label.split(/\n+/).filter((line) => line.trim() !== '').every((line) => line.trim() === lines[0])) {
      return [label, lines[0]];
    }
    const rawLines = label.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (rawLines.length >= 3 && rawLines[0] === rawLines[rawLines.length - 1]) {
      return [label, rawLines[0]];
    }
    return [label];
  });
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
    const rawLabels = unique(expandSemanticLabels([
      redactLabel(attrs.name ?? ''),
      redactLabel(attrs.label ?? ''),
      formControl ? '' : redactLabel(attrs.text ?? ''),
      formControl ? '' : redactLabel(attrs.value ?? ''),
      redactLabel(attrs['content-desc'] ?? ''),
      redactLabel(attrs['contentDescription'] ?? ''),
      formControl ? '' : redactLabel(bodyText)
    ]));
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
      safety: classifyControl(tag, rawLabels, attrs),
      enabled: attrBool(attrs, 'enabled', true),
      visible: attrBool(attrs, 'visible', true),
      clickable: attrBool(attrs, 'clickable', false),
      x: attrNumber(attrs, 'x'),
      y: attrNumber(attrs, 'y'),
      width: attrNumber(attrs, 'width'),
      height: attrNumber(attrs, 'height')
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

function identityKeys(elements: SourceElement[], includeStatic: boolean): string[] {
  const navigationElements = new Set(navigationControlsForElements(elements).map((control) => control.element));
  return unique(
    elements.flatMap((element) => {
      if (navigationElements.has(element)) {
        return [];
      }
      const tag = element.tag.toLowerCase();
      if (!includeStatic && isStaticIdentityElement(element)) {
        return [];
      }
      const labels = element.labels
        .filter((label) => !isGlobalIdentityLabel(label, element))
        .map(normalizeLabel);
      const ids = element.targets.filter((target) => target.startsWith('id=')).map(normalizeLabel);
      return [...labels, ...ids].map((value) => `${tag}:${element.safety}:${value}`);
    })
  ).sort();
}

function isStaticIdentityElement(element: SourceElement): boolean {
  const tag = element.tag.toLowerCase();
  return element.safety === 'unknown' || tag.includes('statictext') || tag.includes('image') || tag.includes('scrollview');
}

function screenSimilarity(left: SourceElement[], right: SourceElement[]): number {
  const leftControlKeys = identityKeys(left, false);
  const rightControlKeys = identityKeys(right, false);
  const fullScore = similarity(identityKeys(left, true), identityKeys(right, true));
  if (leftControlKeys.length === 0 && rightControlKeys.length === 0) {
    return fullScore;
  }
  return Math.max(fullScore, similarity(leftControlKeys, rightControlKeys));
}

function isGlobalIdentityLabel(label: string, element?: SourceElement): boolean {
  const normalized = normalizeControlTarget(label);
  if (isBundleLikeLabel(normalized)) {
    return true;
  }
  if (['settings settings', 'notifications notifications'].includes(normalized)) {
    return true;
  }

  return false;
}

function isBundleLikeLabel(normalized: string): boolean {
  return /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/.test(normalized);
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
  const observedNavigationTarget = preferredNavigationTargetForElements(observation.elements);
  const observedHasBottomNavigation = navigationControlsForElements(observation.elements).length >= 2;

  for (const variant of map.variants) {
    const variantNavigationTarget = preferredNavigationTarget(variant);
    if (
      observedNavigationTarget &&
      variantNavigationTarget &&
      observedNavigationTarget !== variantNavigationTarget
    ) {
      continue;
    }
    const score =
      variant.normalized_fingerprint === observation.normalized_fingerprint
        ? 1
        : screenSimilarity(variant.elements, observation.elements);
    if (score > bestScore) {
      best = variant;
      bestScore = score;
    }
  }

  const requiredScore = observedHasBottomNavigation || (best ? hasBottomNavigation(best) : false) ? 0.62 : 0.45;
  if (!best || bestScore < requiredScore) {
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

async function captureCurrentSource(context: AppMapContext): Promise<SourceCapture> {
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
  return { source };
}

function isTransientObservation(observation: ScreenObservation): boolean {
  return observation.elements.length === 0 || observation.element_keys.length === 0;
}

async function observeCurrentScreen(context: AppMapContext): Promise<ObservedVariant> {
  let observation: ScreenObservation | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const captured = await captureCurrentSource(context);
    observation = observeSource(captured.source);
    if (!isTransientObservation(observation) || attempt === 4) {
      break;
    }
    await delay(500);
  }

  const observed = upsertVariant(context.map, observation ?? observeSource(''));
  context.changed = true;
  return observed;
}

async function observeAfterAction(
  context: AppMapContext,
  target?: ObservedVariant
): Promise<ObservedVariant> {
  const observed = await observeCurrentScreen(context);
  if (target && restoreMatch(observed, target)) {
    return observed;
  }
  if (!shouldSettleObservation(observed.observation)) {
    return observed;
  }

  try {
    await delay(400);
    const settled = await observeCurrentScreen(context);
    if (target && restoreMatch(settled, target)) {
      return settled;
    }
    if (settled.observation.fingerprint !== observed.observation.fingerprint) {
      return settled;
    }
  } catch {
    // Keep the immediate observation if a settle read fails.
  }

  return observed;
}

function shouldSettleObservation(observation: ScreenObservation): boolean {
  if (isTransientObservation(observation)) {
    return true;
  }

  const labels = observation.elements.flatMap((element) => element.labels.map(normalizeControlTarget));
  const hasTransitionLabel = labels.some((label) =>
    /\b(loading|syncing|refreshing|please wait|progress)\b/.test(label)
  );
  return hasTransitionLabel && observation.elements.length <= 3;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function targetDescriptor(command: CommandName, args: Record<string, unknown>): TargetDescriptor {
  if (isValueBearingAction(command, args)) {
    return { kind: 'unknown', confidence: 0 };
  }

  if (command === 'tap') {
    try {
      if (resolveTapMode(args) === 'coordinates') {
        return { kind: 'coordinate', target: coordinateTarget(args), confidence: 0.5 };
      }
    } catch {
      return { kind: 'unknown', confidence: 0 };
    }
  }

  if (command === 'scroll') {
    return { kind: 'stable', target: scrollTarget(args), confidence: 0.4 };
  }

  const target = typeof args.target === 'string' ? args.target : undefined;
  if (!target) {
    return { kind: 'unknown', confidence: 0 };
  }

  if (target.startsWith('first-in-section=')) {
    return { kind: 'section-first', target, value: target.slice(17), confidence: 0.55 };
  }

  if (target.startsWith('text~=')) {
    return { kind: 'text-contains', target, value: target.slice(6), confidence: 0.45 };
  }

  if (target.startsWith('text=')) {
    return { kind: 'text', target, value: target.slice(5), confidence: 0.6 };
  }

  if (target.startsWith('xpath=')) {
    return { kind: 'unknown', target, value: target.slice(6), confidence: 0.2 };
  }

  return { kind: 'stable', target, value: target.replace(/^(id=|accessibility=)/, ''), confidence: 0.9 };
}

function coordinateTarget(args: Record<string, unknown>): string {
  const x = Number(args.x);
  const y = Number(args.y);
  const base = `x=${Number.isFinite(x) ? x : String(args.x)},y=${Number.isFinite(y) ? y : String(args.y)}`;
  return args.normalized === true ? `${base},normalized=true` : base;
}

function scrollTarget(args: Record<string, unknown>): string {
  const direction = String(args.direction ?? 'down').trim().toLowerCase() || 'down';
  const percent = args.percent === undefined ? '' : `,percent=${String(args.percent)}`;
  return `scroll=${direction}${percent}`;
}

function isValueBearingAction(command: CommandName, args: Record<string, unknown>): boolean {
  return command === 'act' && args.name === 'type' && args.value !== undefined;
}

function replayableEdge(edge: AppMapEdge): boolean {
  return !isValueBearingAction(edge.command, edge.args);
}

function elementContainsTarget(element: SourceElement, descriptor: TargetDescriptor): boolean {
  if (descriptor.kind === 'section-first') {
    return false;
  }

  if (!descriptor.target && !descriptor.value) {
    return false;
  }

  const target = descriptor.target ?? '';
  const value = descriptor.value ?? target;
  if (element.targets.includes(target) || element.targets.includes(value)) {
    return true;
  }
  if (descriptor.kind === 'text-contains') {
    const normalizedValue = normalizeControlTarget(value);
    return element.labels.some((label) => normalizeControlTarget(label).includes(normalizedValue));
  }
  return element.labels.some((label) => label === value);
}

function variantContainsTarget(variant: AppMapVariant, descriptor: TargetDescriptor): boolean {
  if (descriptor.kind === 'section-first') {
    return sectionFirstTapArgs(variant, descriptor) !== null;
  }

  return variant.elements.some((element) => elementContainsTarget(element, descriptor));
}

async function liveContainsTarget(context: AppMapContext, descriptor: TargetDescriptor): Promise<boolean> {
  if (descriptor.kind === 'section-first') {
    return false;
  }

  const target = descriptor.target ?? descriptor.value;
  if (!target) {
    return false;
  }

  try {
    return await context.adapter.exists(target);
  } catch {
    return false;
  }
}

function candidateVariants(map: AppMapFile, descriptor: TargetDescriptor): AppMapVariant[] {
  return map.variants.filter(
    (variant) => variantContainsTarget(variant, descriptor) && variantMatchesDescriptorContext(map, variant, descriptor)
  );
}

function variantMatchesDescriptorContext(map: AppMapFile, variant: AppMapVariant, descriptor: TargetDescriptor): boolean {
  if (descriptor.kind !== 'section-first') {
    return true;
  }

  const navigationHint = sectionNavigationHint(descriptor.value ?? descriptor.target ?? '', map);
  if (!navigationHint) {
    return true;
  }

  const navigationTarget = preferredNavigationTarget(variant);
  return !navigationTarget || navigationTarget === navigationHint;
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
  if (descriptor.kind === 'coordinate' || descriptor.kind === 'unknown' || !routeableDescriptor(descriptor)) {
    return { edges: [], ambiguous: false, authRequired: false };
  }

  const destinations = candidateVariants(map, descriptor);
  if (destinations.length === 0) {
    return { edges: [], ambiguous: false, authRequired: false };
  }

  const destinationIds = new Set(destinations.map((variant) => variant.id));
  const visited = new Set<string>([fromVariantId]);
  const queue: Array<{ variantId: string; edges: AppMapEdge[] }> = [{ variantId: fromVariantId, edges: [] }];
  const reachableRoutes: Array<{ variantId: string; edges: AppMapEdge[] }> = [];
  let shortestDestinationLength: number | null = null;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    if (destinationIds.has(current.variantId)) {
      if (shortestDestinationLength === null) {
        shortestDestinationLength = current.edges.length;
      }
      if (current.edges.length === shortestDestinationLength) {
        reachableRoutes.push(current);
      }
      continue;
    }
    if (shortestDestinationLength !== null && current.edges.length >= shortestDestinationLength) {
      continue;
    }

    const outgoing = [
      ...map.edges,
      ...navigationVirtualEdges(map, map.variants.find((variant) => variant.id === current.variantId))
    ]
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

  if (reachableRoutes.length > 0) {
    const rankedRoutes = reachableRoutes
      .map((route) => ({
        ...route,
        score:
          destinationTargetScore(
            map,
            map.variants.find((variant) => variant.id === route.variantId),
            descriptor
          ) + routeTargetScore(map, route.edges, descriptor)
      }))
      .sort((left, right) => right.score - left.score);
    const best = rankedRoutes[0];
    if (!best) {
      return { edges: [], ambiguous: false, authRequired: false };
    }
    const tiedBest = rankedRoutes.filter((route) => route.score === best.score);
    const ambiguous =
      (descriptor.kind === 'text' || descriptor.kind === 'text-contains' || descriptor.kind === 'section-first') &&
      tiedBest.length > 1;
    const diagnostics = routePlanDiagnostics(map, descriptor, rankedRoutes, ambiguous ? undefined : best, ambiguous);
    if (
      ambiguous
    ) {
      return { edges: [], ambiguous: true, authRequired: false, diagnostics };
    }
    const route = best;
    const destination = map.variants.find((variant) => variant.id === route?.variantId);
    return {
      edges: route?.edges ?? [],
      ambiguous: false,
      authRequired: Boolean(destination?.auth_required),
      diagnostics
    };
  }

  return { edges: [], ambiguous: false, authRequired: destinations.some((variant) => variant.auth_required) };
}

function routePlanDiagnostics(
  map: AppMapFile,
  descriptor: TargetDescriptor,
  rankedRoutes: Array<{ variantId: string; edges: AppMapEdge[]; score: number }>,
  selected: { variantId: string; edges: AppMapEdge[]; score: number } | undefined,
  ambiguous: boolean
): RoutePlanDiagnostics {
  const bestScore = rankedRoutes[0]?.score;
  return {
    target: descriptor.target ?? descriptor.value ?? descriptor.kind,
    selected_variant_id: selected?.variantId,
    ambiguous,
    route_candidates: rankedRoutes.map((route) => {
      const variant = map.variants.find((candidate) => candidate.id === route.variantId);
      const isSelected = selected?.variantId === route.variantId;
      return {
        variant_id: route.variantId,
        screen_id: variant?.screen_id,
        score: Math.round(route.score * 100) / 100,
        route: route.edges.map(summarizeEdge),
        selected: isSelected,
        ...(isSelected
          ? {}
          : { rejected_reason: ambiguous && route.score === bestScore ? 'ambiguous_tie' : 'lower_score' })
      };
    })
  };
}

function routeableDescriptor(descriptor: TargetDescriptor): boolean {
  if (descriptor.kind === 'section-first') {
    const value = descriptor.value ?? descriptor.target ?? '';
    return /[a-z]/i.test(value);
  }

  if (descriptor.kind !== 'text-contains') {
    return true;
  }

  const value = descriptor.value ?? descriptor.target ?? '';
  return /[a-z]/i.test(value);
}

function navigationVirtualEdges(map: AppMapFile, variant: AppMapVariant | undefined): AppMapEdge[] {
  if (!variant) {
    return [];
  }

  const currentNavigationTarget = preferredNavigationTarget(variant);
  const edges: AppMapEdge[] = [];
  const destinationsByTarget = new Map<string, AppMapVariant>();

  for (const destination of map.variants) {
    if (destination.id === variant.id) {
      continue;
    }
    const target = preferredNavigationTarget(destination);
    if (!target || target === currentNavigationTarget || destinationsByTarget.has(target)) {
      continue;
    }
    destinationsByTarget.set(target, destination);
  }

  for (const candidate of safeTapCandidates(variant, { skipCurrentNavigation: true })) {
    const target = normalizeControlTarget(candidate.target);
    const destination = destinationsByTarget.get(target);
    if (!destination) {
      continue;
    }
    if (hasRealEdgeForTap(map, variant.id, candidate)) {
      continue;
    }

    edges.push({
      id: `virtual_nav_${variant.id}_${target}`,
      from_variant_id: variant.id,
      to_variant_id: destination.id,
      command: 'tap',
      args: structuredClone(candidate.args),
      target: targetDescriptor('tap', candidate.args).target,
      confidence: 0.4,
      successes: 0,
      failures: 0,
      stale: false,
      candidate: true,
      destination_contract: {
        variant_id: destination.id,
        required_targets: contractTargets(destination),
        normalized_fingerprint: destination.normalized_fingerprint
      },
      last_observed_at: utcNowIso()
    });
  }

  return edges;
}

function hasRealEdgeForTap(map: AppMapFile, fromVariantId: string, candidate: TapCandidate): boolean {
  const descriptor = targetDescriptor('tap', candidate.args);
  const candidateTargets = new Set([candidate.key, candidate.target, descriptor.target, descriptor.value].filter(Boolean));

  return map.edges.some(
    (edge) =>
      edge.from_variant_id === fromVariantId &&
      !edge.stale &&
      edge.confidence >= 0.25 &&
      replayableEdge(edge) &&
      candidateTargets.has(edge.target)
  );
}

function destinationTargetScore(map: AppMapFile, variant: AppMapVariant | undefined, descriptor: TargetDescriptor): number {
  if (!variant) {
    return 0;
  }

  if (descriptor.kind === 'section-first') {
    const element = firstItemInSection(variant, descriptor);
    if (!element) {
      return 0;
    }

    let score = isHighValueContentCard(element) ? 10 : 7;
    const navigationHint = sectionNavigationHint(descriptor.value ?? descriptor.target ?? '', map);
    const navigationTarget = preferredNavigationTarget(variant);
    if (navigationHint && navigationTarget === navigationHint) {
      score += 5;
    } else if (navigationHint && navigationTarget && navigationTarget !== navigationHint) {
      score -= 5;
    }
    return score;
  }

  let score = 0;
  for (const element of variant.elements) {
    if (!elementContainsTarget(element, descriptor)) {
      continue;
    }

    let elementScore = 1;
    if (isLikelyTapElement(element)) {
      elementScore += 4;
    } else if (element.visible === false) {
      elementScore -= 2;
    }
    if (isHighValueContentCard(element)) {
      elementScore += 3;
    }
    const value = normalizeControlTarget(descriptor.value ?? descriptor.target ?? '');
    if (
      value &&
      element.labels.some((label) =>
        normalizeControlTarget(label) === value ||
        label.split(/\n+/).some((line) => normalizeControlTarget(line) === value)
      )
    ) {
      elementScore += 2;
    }
    score = Math.max(score, elementScore);
  }

  if (preferredNavigationTarget(variant) && score > 0) {
    score += 1;
  }
  if (score > 0 && isFeedLikeVariant(variant) && !descriptorTargetsFeed(descriptor)) {
    score -= 3;
  }

  return score;
}

function isFeedLikeVariant(variant: AppMapVariant): boolean {
  return contentLabels(variant).some((label) =>
    /^(for you|activity|feed|latest|timeline|updates?)$/.test(label)
  );
}

function descriptorTargetsFeed(descriptor: TargetDescriptor): boolean {
  const value = normalizeControlTarget(descriptor.value ?? descriptor.target ?? '');
  return /\b(activity|feed|post|comment|update|timeline)\b/.test(value);
}

function routeTargetScore(map: AppMapFile, route: AppMapEdge[], descriptor: TargetDescriptor): number {
  if (descriptor.kind !== 'section-first') {
    return 0;
  }

  const navigationHint = sectionNavigationHint(descriptor.value ?? descriptor.target ?? '', map);
  if (!navigationHint) {
    return 0;
  }

  return route.reduce((score, edge) => {
    const target = edgeNavigationTarget(map, edge);
    if (!target) {
      return score;
    }
    return score + (target === navigationHint ? 3 : -3);
  }, 0);
}

function edgeNavigationTarget(map: AppMapFile, edge: AppMapEdge): string | null {
  const normalizedTarget = normalizeControlTarget(edge.target ?? '');
  const from = map.variants.find((variant) => variant.id === edge.from_variant_id);
  if (from && isNavigationTarget(from, normalizedTarget)) {
    return normalizedTarget;
  }

  if (!from || edge.command !== 'tap') {
    return null;
  }

  const edgeCoordinateTarget = coordinateTarget(edge.args);
  for (const control of navigationControls(from)) {
    const elementCoordinateTarget = coordinateArgsForElement(control.element);
    if (elementCoordinateTarget && coordinateTarget(elementCoordinateTarget) === edgeCoordinateTarget) {
      return control.target;
    }
  }

  return null;
}

function contractTargets(variant: AppMapVariant): string[] {
  const navigationElements = new Set(navigationControls(variant).map((control) => control.element));
  const contentTargets = variant.elements
    .filter((element) => element.stable)
    .filter((element) => !navigationElements.has(element))
    .flatMap((element) =>
      element.targets.filter((target) => !isGlobalIdentityLabel(normalizeControlTarget(target), element))
    );
  const fallbackTargets = variant.elements
    .filter((element) => element.stable)
    .flatMap((element) => element.targets);
  return unique([...contentTargets, ...fallbackTargets]).slice(0, 8);
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
  if (descriptor.kind === 'unknown') {
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

function shouldRequireObservedEffect(command: CommandName, args: Record<string, unknown>): boolean {
  return command === 'tap' || command === 'navigate' || command === 'scroll' || (command === 'act' && args.name === 'back');
}

function assertObservedEffect(
  command: CommandName,
  args: Record<string, unknown>,
  before: ObservedVariant,
  after: ObservedVariant,
  descriptor: TargetDescriptor
): void {
  if (!shouldRequireObservedEffect(command, args)) {
    return;
  }

  if (before.observation.fingerprint !== after.observation.fingerprint) {
    return;
  }

  const target = descriptor.target ?? descriptor.value ?? command;
  throw new Error(`Action '${command}' on '${target}' had no effect: screen source did not change after the command`);
}

function variantSatisfiesContract(variant: AppMapVariant, contract: DestinationContract): boolean {
  if (variant.id === contract.variant_id) {
    return true;
  }

  const observedTargets = new Set(variant.elements.flatMap((element) => element.targets));
  const required = contract.required_targets;
  if (required.length === 0) {
    return variant.normalized_fingerprint === contract.normalized_fingerprint;
  }

  const matched = required.filter((target) => observedTargets.has(target)).length;
  return matched / required.length >= 0.6;
}

function restoreContractHasSharedAnchors(observed: AppMapVariant, target: AppMapVariant): boolean {
  const observedTargets = new Set(observed.elements.flatMap((element) => element.targets));
  const required = contractTargets(target);
  if (required.length === 0) {
    return false;
  }

  const matched = unique(required.filter((targetValue) => observedTargets.has(targetValue)));
  return matched.length >= 2 && matched.length / required.length >= 0.25;
}

function restoreMatch(observed: ObservedVariant, target: ObservedVariant): RestoreMatch | null {
  if (observed.variant.id === target.variant.id) {
    return { acceptedBy: 'exact' };
  }

  const observedNavigationTarget = preferredNavigationTarget(observed.variant);
  const targetNavigationTarget = preferredNavigationTarget(target.variant);
  if (observedNavigationTarget && targetNavigationTarget && observedNavigationTarget !== targetNavigationTarget) {
    return null;
  }

  const contract = {
    variant_id: target.variant.id,
    required_targets: contractTargets(target.variant),
    normalized_fingerprint: target.variant.normalized_fingerprint
  };
  if (variantSatisfiesContract(observed.variant, contract)) {
    return { acceptedBy: 'contract' };
  }
  if (
    observedNavigationTarget &&
    targetNavigationTarget &&
    observedNavigationTarget === targetNavigationTarget &&
    restoreContractHasSharedAnchors(observed.variant, target.variant)
  ) {
    return { acceptedBy: 'contract' };
  }

  const score = screenSimilarity(target.variant.elements, observed.variant.elements);
  if (score >= 0.72) {
    return { acceptedBy: 'similarity', score };
  }

  return null;
}

function satisfiesContract(edge: AppMapEdge, observed: ObservedVariant): boolean {
  return variantSatisfiesContract(observed.variant, edge.destination_contract);
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
      observed = await observeAfterAction(context);
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

function safeTapCandidates(variant: AppMapVariant, options: TapCandidateOptions = {}): TapCandidate[] {
  const candidates: TapCandidate[] = [];
  const seen = new Set<string>();
  const currentNavigationTarget = options.skipCurrentNavigation ? preferredNavigationTarget(variant) : null;
  const elements = [...variant.elements].sort((left, right) => {
    const priority = tapElementPriority(left, variant, options) - tapElementPriority(right, variant, options);
    if (priority !== 0) {
      return priority;
    }
    return (left.y ?? 0) - (right.y ?? 0) || (left.x ?? 0) - (right.x ?? 0);
  });

  for (const element of elements) {
    if (!(element.safety === 'safe' && element.stable && isLikelyTapElement(element))) {
      continue;
    }

    const target = plainTapTargets(element)[0] ?? element.selector;
    if (!target) {
      continue;
    }
    const normalizedTarget = normalizeControlTarget(target);
    if (options.excludeNavigation && isNavigationTarget(variant, normalizedTarget)) {
      continue;
    }
    if (currentNavigationTarget && normalizedTarget === currentNavigationTarget) {
      continue;
    }

    const coordinateArgs = coordinateArgsForElement(element);
    const args = coordinateArgs ?? { target };
    const key = coordinateArgs ? coordinateTarget(coordinateArgs) : target;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({ target, args, key });
  }

  return candidates;
}

function tapElementPriority(element: SourceElement, variant: AppMapVariant, options: TapCandidateOptions = {}): number {
  const target = plainTapTargets(element)[0] ?? element.selector;
  const normalized = normalizeControlTarget(target);
  if (options.preferContent && isHighValueContentCard(element)) {
    return 5;
  }

  const navPriority = navigationControlPriority(variant, normalized);
  if (navPriority !== undefined) {
    if (options.preferContent) {
      return 80 + navPriority;
    }
    return navPriority;
  }

  if (normalized === 'see all') {
    return 10;
  }
  if (isBackControl(element)) {
    return 90;
  }
  if (element.tag.toLowerCase().includes('button')) {
    return 40;
  }
  if (element.tag.toLowerCase().includes('other')) {
    return 60;
  }
  return 50;
}

function isHighValueContentCard(element: SourceElement): boolean {
  if (!isLikelyTapElement(element)) {
    return false;
  }
  const target = plainTapTargets(element)[0] ?? element.selector;
  const normalizedTarget = normalizeControlTarget(target);
  if (normalizedTarget === 'see all' || /^(back|close|dismiss|done)$/i.test(target)) {
    return false;
  }

  const lines = unique(element.labels.flatMap((label) => label.split(/\n+/).map((line) => line.trim())));
  const area = (element.width ?? 0) * (element.height ?? 0);
  return (
    lines.length >= 2 ||
    (element.tag.toLowerCase().includes('other') && area >= 3000) ||
    ((element.width ?? 0) >= 120 && (element.height ?? 0) >= 64 && element.labels.length > 0)
  );
}

function normalizeControlTarget(target: string): string {
  return target.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sectionNavigationHint(value: string, map: AppMapFile): string | null {
  const normalized = normalizeControlTarget(value);
  const targets = unique(map.variants.flatMap((variant) => navigationControls(variant).map((control) => control.target)))
    .sort((left, right) => right.length - left.length);
  for (const target of targets) {
    if (normalized.includes(target)) {
      return target;
    }
  }
  return null;
}

function crawlCandidateOptions(variant: AppMapVariant): TapCandidateOptions {
  const preferredTarget = preferredNavigationTarget(variant);
  const preferContent = preferredTarget !== null && !isPrimaryNavigationTarget(variant, preferredTarget);
  return {
    preferContent,
    excludeNavigation: preferContent,
    skipCurrentNavigation: true
  };
}

function preferredNavigationTarget(variant: AppMapVariant): string | null {
  return preferredNavigationTargetForElements(variant.elements);
}

function preferredNavigationTargetForElements(elements: SourceElement[]): string | null {
  const controls = navigationControlsForElements(elements);
  if (controls.length === 0) {
    return null;
  }

  const labels = contentLabelsForElements(elements);
  const matched = controls.find((control) =>
    labels.some((label) => labelMatchesNavigationTarget(label, control.target))
  );
  if (matched) {
    return matched.target;
  }

  return controls[0]?.target ?? null;
}

function hasBottomNavigation(variant: AppMapVariant): boolean {
  return navigationControls(variant).length >= 2;
}

function contentLabels(variant: AppMapVariant): string[] {
  return contentLabelsForElements(variant.elements);
}

function contentLabelsForElements(elements: SourceElement[]): string[] {
  const navigationElements = new Set(navigationControlsForElements(elements).map((control) => control.element));
  return elements.flatMap((element) =>
    element.labels
      .filter(() => !navigationElements.has(element))
      .filter((label) => !isGlobalIdentityLabel(label, element))
      .map(normalizeControlTarget)
  );
}

function navigationControls(variant: AppMapVariant): NavigationControl[] {
  return navigationControlsForElements(variant.elements);
}

function navigationControlsForElements(elements: SourceElement[]): NavigationControl[] {
  const candidates = elements
    .filter((element) => element.safety === 'safe' && element.stable && isLikelyTapElement(element))
    .filter((element) => !isBackControl(element))
    .filter((element) => coordinateArgsForElement(element) !== null)
    .map((element) => ({ element, target: normalizeControlTarget(plainTapTargets(element)[0] ?? element.selector) }))
    .filter((candidate) => isCompactNavigationLabel(candidate.element, candidate.target));

  if (candidates.length < 2) {
    return [];
  }

  const maxY = Math.max(...candidates.map((candidate) => candidate.element.y ?? 0));
  const bottomRow = candidates
    .filter((candidate) => (candidate.element.y ?? 0) >= maxY - 12)
    .sort((left, right) => (left.element.x ?? 0) - (right.element.x ?? 0));

  if (bottomRow.length < 2) {
    return [];
  }

  return bottomRow.map((candidate, priority) => ({
    ...candidate,
    priority
  }));
}

function isCompactNavigationLabel(element: SourceElement, target: string): boolean {
  if (!target || target.includes('\n') || target.length > 32 || target === 'see all') {
    return false;
  }
  if ((element.height ?? 0) > 72) {
    return false;
  }

  const lines = unique(element.labels.flatMap((label) => label.split(/\n+/).map((line) => normalizeControlTarget(line))));
  return lines.length <= 2 && lines.some((line) => line === target);
}

function isNavigationElement(variant: AppMapVariant, element: SourceElement): boolean {
  return navigationControls(variant).some((control) => control.element === element);
}

function isNavigationTarget(variant: AppMapVariant, normalizedTarget: string): boolean {
  return navigationControls(variant).some((control) => control.target === normalizedTarget);
}

function navigationControlPriority(variant: AppMapVariant, normalizedTarget: string): number | undefined {
  return navigationControls(variant).find((control) => control.target === normalizedTarget)?.priority;
}

function isPrimaryNavigationTarget(variant: AppMapVariant, normalizedTarget: string): boolean {
  return navigationControls(variant)[0]?.target === normalizedTarget;
}

function labelMatchesNavigationTarget(label: string, target: string): boolean {
  if (label === target) {
    return true;
  }

  const labelWords = new Set(label.split(/[^a-z0-9]+/).filter(Boolean));
  const targetWords = target.split(/[^a-z0-9]+/).filter(Boolean);
  if (targetWords.length === 1) {
    const words = Array.from(labelWords);
    return words.length <= 2 && words[0] === targetWords[0];
  }
  return targetWords.length > 0 && targetWords.every((word) => labelWords.has(word));
}

function currentScreenTapArgs(variant: AppMapVariant, descriptor: TargetDescriptor): Record<string, unknown> | null {
  if (descriptor.kind === 'section-first') {
    return sectionFirstTapArgs(variant, descriptor);
  }

  for (const element of variant.elements) {
    if (!elementContainsTarget(element, descriptor)) {
      continue;
    }
    if (!(element.safety === 'safe' && element.stable && isLikelyTapElement(element))) {
      continue;
    }

    const coordinateArgs = coordinateArgsForElement(element);
    if (coordinateArgs) {
      return coordinateArgs;
    }
    const stableTarget = plainTapTargets(element)[0] ?? element.selector;
    if (stableTarget && shouldUseStableTargetFallback(element, descriptor)) {
      return { target: stableTarget };
    }
  }

  return null;
}

function shouldUseStableTargetFallback(element: SourceElement, descriptor: TargetDescriptor): boolean {
  if (descriptor.kind !== 'text-contains') {
    return false;
  }

  const value = descriptor.value ?? '';
  return value !== '' && !element.labels.some((label) => label.includes(value));
}

function sectionFirstTapArgs(variant: AppMapVariant, descriptor: TargetDescriptor): Record<string, unknown> | null {
  const element = firstItemInSection(variant, descriptor);
  return element ? coordinateArgsForElement(element) : null;
}

function firstItemInSection(variant: AppMapVariant, descriptor: TargetDescriptor): SourceElement | null {
  const value = descriptor.value ?? descriptor.target ?? '';
  if (!/[a-z]/i.test(value)) {
    return null;
  }

  const section = sectionHeadingElement(variant, value);
  if (!section || section.y === null || section.height === null) {
    return null;
  }

  const sectionY = section.y;
  const sectionBottom = sectionY + Math.max(0, section.height);
  const nextSectionY = variant.elements
    .filter(
      (element) =>
        element !== section &&
        element.y !== null &&
        element.y > sectionY &&
        isLikelySectionHeading(variant, element)
    )
    .map((element) => element.y as number)
    .sort((left, right) => left - right)[0] ?? null;

  const candidates = variant.elements
    .filter(
      (element) =>
        isSectionItemCandidate(variant, element, value) &&
        element.y !== null &&
        element.y > sectionBottom &&
        (nextSectionY === null || element.y < nextSectionY)
    )
    .sort((left, right) => (left.y ?? 0) - (right.y ?? 0) || (left.x ?? 0) - (right.x ?? 0));

  return candidates[0] ?? null;
}

function sectionHeadingElement(variant: AppMapVariant, value: string): SourceElement | null {
  const matches = variant.elements
    .filter(
      (element) =>
        element.visible !== false &&
        element.y !== null &&
        element.height !== null &&
        elementLabelMatchesValue(element, value)
    )
    .sort((left, right) => (left.y ?? 0) - (right.y ?? 0) || (left.x ?? 0) - (right.x ?? 0));

  return matches[0] ?? null;
}

function isSectionItemCandidate(variant: AppMapVariant, element: SourceElement, sectionValue: string): boolean {
  if (!(element.safety === 'safe' && element.stable && isLikelyTapElement(element))) {
    return false;
  }
  if (!coordinateArgsForElement(element)) {
    return false;
  }
  if (isBackControl(element) || elementLabelMatchesValue(element, sectionValue)) {
    return false;
  }

  const target = normalizeControlTarget(plainTapTargets(element)[0] ?? element.selector);
  if (isNavigationTarget(variant, target) || target === 'see all') {
    return false;
  }

  return true;
}

function isLikelySectionHeading(variant: AppMapVariant, element: SourceElement): boolean {
  if (isHighValueContentCard(element)) {
    return false;
  }

  const labels = element.labels.map(normalizeControlTarget);
  if (labels.some((label) => label === 'see all' || isNavigationTarget(variant, label))) {
    return false;
  }

  return labels.some((label) => {
    if (!/[a-z]/i.test(label)) {
      return false;
    }
    const words = label.split(/\s+/).filter(Boolean);
    const lineCount = label.split(/\n+/).filter(Boolean).length;
    return words.length <= 8 && lineCount <= 2;
  });
}

function elementLabelMatchesValue(element: SourceElement, value: string): boolean {
  const normalizedValue = normalizeControlTarget(value);
  if (!normalizedValue) {
    return false;
  }

  return element.labels.some((label) => {
    const normalizedLabel = normalizeControlTarget(label);
    return (
      normalizedLabel === normalizedValue ||
      normalizedLabel.includes(normalizedValue) ||
      label.split(/\n+/).some((line) => normalizeControlTarget(line) === normalizedValue)
    );
  });
}

function coordinateArgsForElement(element: SourceElement): Record<string, unknown> | null {
  if (
    element.x === null ||
    element.y === null ||
    element.width === null ||
    element.height === null ||
    element.width <= 0 ||
    element.height <= 0
  ) {
    return null;
  }

  if (isBackControl(element)) {
    return {
      x: Math.round(element.x + Math.min(40, element.width / 2)),
      y: Math.round(element.y + element.height / 2)
    };
  }

  return {
    x: Math.round(element.x + element.width / 2),
    y: Math.round(element.y + element.height / 2)
  };
}

function isBackControl(element: SourceElement): boolean {
  if (!element.tag.toLowerCase().includes('button')) {
    return false;
  }

  return element.labels.some((label) =>
    label.split(/\n+/).some((line) => line.trim().toLowerCase() === 'back')
  );
}

function plainTapTargets(element: SourceElement): string[] {
  return element.targets
    .filter((target) => !target.includes('='))
    .sort((left, right) => tapTargetScore(left) - tapTargetScore(right));
}

function tapTargetScore(target: string): number {
  let score = target.length;
  if (target.includes('\n')) {
    score += 1000;
  }
  return score;
}

function isLikelyTapElement(element: SourceElement): boolean {
  if (element.enabled === false || element.visible === false) {
    return false;
  }
  if (
    element.width !== null &&
    element.height !== null &&
    (element.width <= 0 || element.height <= 0)
  ) {
    return false;
  }

  const tag = element.tag.toLowerCase();
  if (
    tag.includes('statictext') ||
    tag.includes('image') ||
    tag.includes('textfield') ||
    tag.includes('scrollview')
  ) {
    return false;
  }

  if (tag.includes('button') || element.clickable) {
    return true;
  }

  if (tag.includes('other')) {
    const width = element.width ?? 0;
    const height = element.height ?? 0;
    return width >= 20 && height >= 20 && element.labels.length > 0;
  }

  return false;
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
      const candidate = safeTapCandidates(cursor.variant).find(
        (tapCandidate) =>
          !blockedTargets.has(tapCandidate.target) &&
          !blockedTargets.has(tapCandidate.key) &&
          !attemptsForVariant.has(tapCandidate.key)
      );
      if (!candidate) {
        return { found: false, current: cursor, route: routeSoFar, remainingDepth: depthLeft };
      }

      attemptsForVariant.add(candidate.key);
      const args = candidate.args;
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
      const nextRoute = [...routeSoFar, summarizeControl('tap', candidate.target, 0.45)];
      const nested = await attemptFrom(observed, depthLeft - 1, nextRoute);
      if (nested.found) {
        return nested;
      }
      if (nested.current.variant.id === cursor.variant.id) {
        cursor = nested.current;
        routeSoFar = nested.route;
        continue;
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

  if (descriptor.kind === 'unknown') {
    const details = await context.adapter[command](args);
    return { ...details, map: metadata };
  }

  let before = await observeCurrentScreen(context);
  if (descriptor.kind === 'coordinate' || command === 'scroll') {
    const details = await context.adapter[command](args);
    const after = await observeCurrentScreen(context);
    assertObservedEffect(command, args, before, after, descriptor);
    recordEdgeSuccess(context, before.variant, after.variant, command, args, false);
    return { ...details, map: metadata };
  }

  let liveTargetVisible = await liveContainsTarget(context, descriptor);
  if (!variantContainsTarget(before.variant, descriptor) && !liveTargetVisible) {
    if (before.variant.auth_required) {
      throw new Error(`Target '${descriptor.target ?? descriptor.value}' requires authentication from the current screen`);
    }

    if (routeableDescriptor(descriptor)) {
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
        if (route.diagnostics) {
          metadata.diagnostics = route.diagnostics;
        }
        const driven = await driveRoute(context, before, route.edges);
        before = driven.current;
        liveTargetVisible = await liveContainsTarget(context, descriptor);
        const targetReachedDespiteStaleContract = variantContainsTarget(before.variant, descriptor) || liveTargetVisible;
        if (driven.failedEdge && !targetReachedDespiteStaleContract) {
          if (!context.options.repair) {
            throw new Error(
              `Cached app-map route for '${driven.failedEdge.target ?? driven.failedEdge.command}' failed; rerun with repair enabled to explore an alternate route`
            );
          }
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
          liveTargetVisible = await liveContainsTarget(context, descriptor);
        }
      } else if (context.options.repair) {
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
          liveTargetVisible = await liveContainsTarget(context, descriptor);
        }
      }
    }
  }

  if (!variantContainsTarget(before.variant, descriptor) && !liveTargetVisible) {
    throw new Error(`Target '${descriptor.target ?? descriptor.value}' is not reachable from the current app-map state`);
  }

  const executableArgs =
    command === 'tap' && !liveTargetVisible
      ? currentScreenTapArgs(before.variant, descriptor) ?? args
      : args;
  const details = await context.adapter[command](executableArgs);
  const after = await observeCurrentScreen(context);
  assertObservedEffect(command, executableArgs, before, after, descriptor);
  recordEdgeSuccess(context, before.variant, after.variant, command, executableArgs, false);
  return { ...details, map: metadata };
}

function restoreAttemptDiagnostic(
  strategy: string,
  result: 'matched' | 'mismatched' | 'error',
  observed?: ObservedVariant,
  match?: RestoreMatch | null,
  target?: string,
  command?: CommandName | 'act',
  error?: unknown
): RestoreAttemptDiagnostic {
  return {
    strategy,
    result,
    ...(command ? { command } : {}),
    ...(target ? { target } : {}),
    ...(observed
      ? {
          observed_variant_id: observed.variant.id,
          observed_screen_id: observed.variant.screen_id
        }
      : {}),
    ...(match ? { accepted_by: match.acceptedBy } : {}),
    ...(error instanceof Error ? { error: error.message } : {})
  };
}

function makeRestoreDiagnostic(from: ObservedVariant, target: ObservedVariant): RestoreDiagnostic {
  return {
    from_variant_id: from.variant.id,
    target_variant_id: target.variant.id,
    result: 'failed',
    attempts: []
  };
}

async function tryTapRestoreCandidate(
  context: AppMapContext,
  current: ObservedVariant,
  target: ObservedVariant,
  candidate: TapCandidate,
  strategy: string,
  diagnostic: RestoreDiagnostic
): Promise<{ current: ObservedVariant; match: RestoreMatch | null }> {
  const args = candidate.args;
  try {
    await context.adapter.tap(args);
    const observed = await observeAfterAction(context, target);
    recordEdgeSuccess(context, current.variant, observed.variant, 'tap', args, true);
    const match = restoreMatch(observed, target);
    diagnostic.attempts.push(
      restoreAttemptDiagnostic(
        strategy,
        match ? 'matched' : 'mismatched',
        observed,
        match,
        targetDescriptor('tap', args).target ?? candidate.target,
        'tap'
      )
    );
    return { current: observed, match };
  } catch (error) {
    diagnostic.attempts.push(
      restoreAttemptDiagnostic(strategy, 'error', undefined, null, candidate.target, 'tap', error)
    );
    try {
      return { current: await observeCurrentScreen(context), match: null };
    } catch {
      return { current, match: null };
    }
  }
}

function targetRestoreCandidates(current: ObservedVariant, target: ObservedVariant): TapCandidate[] {
  const preferredTarget = preferredNavigationTarget(target.variant);
  return safeTapCandidates(current.variant).filter((candidate) => {
    if (/^(back|close|dismiss|done)$/i.test(candidate.target)) {
      return false;
    }
    const normalizedTarget = normalizeControlTarget(candidate.target);
    if (preferredTarget) {
      return normalizedTarget === preferredTarget;
    }
    if (isGlobalIdentityLabel(candidate.target)) {
      return false;
    }
    const descriptor = targetDescriptor('tap', { target: candidate.target });
    return descriptor.kind !== 'unknown' && variantContainsTarget(target.variant, descriptor);
  });
}

function navigationResetCandidates(current: ObservedVariant, root: ObservedVariant): TapCandidate[] {
  const rootTarget = preferredNavigationTarget(root.variant);
  if (!rootTarget) {
    return [];
  }
  return safeTapCandidates(current.variant).filter(
    (candidate) => normalizeControlTarget(candidate.target) === rootTarget
  );
}

function shortestRouteToVariant(map: AppMapFile, fromVariantId: string, toVariantId: string): AppMapEdge[] | null {
  if (fromVariantId === toVariantId) {
    return [];
  }

  const visited = new Set<string>([fromVariantId]);
  const queue: Array<{ variantId: string; edges: AppMapEdge[] }> = [{ variantId: fromVariantId, edges: [] }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const variant = map.variants.find((candidate) => candidate.id === current.variantId);
    const outgoing = [
      ...map.edges,
      ...navigationVirtualEdges(map, variant)
    ]
      .filter((edge) => edge.from_variant_id === current.variantId && !edge.stale && edge.confidence >= 0.25 && replayableEdge(edge))
      .sort((left, right) => right.confidence - left.confidence);
    for (const edge of outgoing) {
      if (visited.has(edge.to_variant_id)) {
        continue;
      }
      const edges = [...current.edges, edge];
      if (edge.to_variant_id === toVariantId) {
        return edges;
      }
      visited.add(edge.to_variant_id);
      queue.push({ variantId: edge.to_variant_id, edges });
    }
  }

  return null;
}

async function restoreViaRootRoute(
  context: AppMapContext,
  current: ObservedVariant,
  target: ObservedVariant,
  root: ObservedVariant,
  diagnostic: RestoreDiagnostic
): Promise<RestoreResult | null> {
  let resetCurrent = current;
  const rootMatch = restoreMatch(resetCurrent, root);
  if (!rootMatch) {
    for (const candidate of navigationResetCandidates(resetCurrent, root)) {
      const restored = await tryTapRestoreCandidate(context, resetCurrent, root, candidate, 'root-navigation', diagnostic);
      resetCurrent = restored.current;
      if (restored.match) {
        break;
      }
    }
  }

  const matchedRoot = restoreMatch(resetCurrent, root);
  if (!matchedRoot) {
    return null;
  }
  if (restoreMatch(resetCurrent, target)) {
    diagnostic.result = 'restored';
    diagnostic.accepted_by = 'root';
    return { current: target, restored: true, acceptedBy: 'root', diagnostic };
  }

  const route = shortestRouteToVariant(context.map, root.variant.id, target.variant.id);
  if (!route || route.length === 0) {
    return null;
  }

  const driven = await driveRoute(context, root, route);
  const match = restoreMatch(driven.current, target);
  diagnostic.attempts.push(
    restoreAttemptDiagnostic(
      'root-route',
      match ? 'matched' : 'mismatched',
      driven.current,
      match ? { ...match, acceptedBy: 'root-route' } : null,
      route.map((edge) => edge.target ?? edge.command).join(' -> '),
      'tap'
    )
  );
  if (!match) {
    return { current: driven.current, restored: false, diagnostic };
  }

  diagnostic.result = 'restored';
  diagnostic.accepted_by = 'root-route';
  return { current: target, restored: true, acceptedBy: 'root-route', diagnostic };
}

async function restoreToVariant(
  context: AppMapContext,
  current: ObservedVariant,
  target: ObservedVariant,
  root?: ObservedVariant
): Promise<RestoreResult> {
  const diagnostic = makeRestoreDiagnostic(current, target);
  const initialMatch = restoreMatch(current, target);
  if (initialMatch) {
    diagnostic.result = 'restored';
    diagnostic.accepted_by = initialMatch.acceptedBy;
    return { current: target, restored: true, acceptedBy: initialMatch.acceptedBy, diagnostic };
  }

  const restoreTargets = safeTapCandidates(current.variant).filter((candidate) =>
    /^(back|close|dismiss|done)$/i.test(candidate.target)
  );

  for (const restoreCandidate of restoreTargets) {
    const restored = await tryTapRestoreCandidate(
      context,
      current,
      target,
      restoreCandidate,
      'dismiss-control',
      diagnostic
    );
    current = restored.current;
    if (restored.match) {
      diagnostic.result = 'restored';
      diagnostic.accepted_by = restored.match.acceptedBy;
      return { current: target, restored: true, acceptedBy: restored.match.acceptedBy, diagnostic };
    }
  }

  for (const restoreCandidate of targetRestoreCandidates(current, target)) {
    const restored = await tryTapRestoreCandidate(
      context,
      current,
      target,
      restoreCandidate,
      'target-navigation',
      diagnostic
    );
    current = restored.current;
    if (restored.match) {
      diagnostic.result = 'restored';
      diagnostic.accepted_by = restored.match.acceptedBy;
      return { current: target, restored: true, acceptedBy: restored.match.acceptedBy, diagnostic };
    }
  }

  try {
    await context.adapter.act({ name: 'back' });
    const observed = await observeAfterAction(context, target);
    const match = restoreMatch(observed, target);
    diagnostic.attempts.push(
      restoreAttemptDiagnostic('platform-back', match ? 'matched' : 'mismatched', observed, match, 'back', 'act')
    );
    if (match) {
      diagnostic.result = 'restored';
      diagnostic.accepted_by = match.acceptedBy;
      return { current: target, restored: true, acceptedBy: match.acceptedBy, diagnostic };
    }
    current = observed;
  } catch (error) {
    diagnostic.attempts.push(restoreAttemptDiagnostic('platform-back', 'error', undefined, null, 'back', 'act', error));
  }

  if (root) {
    const rooted = await restoreViaRootRoute(context, current, target, root, diagnostic);
    if (rooted) {
      return rooted;
    }
  }

  return { current, restored: false, diagnostic };
}

async function crawlAppMap(context: AppMapContext, start: ObservedVariant): Promise<CrawlSummary> {
  const visited = new Set<string>();
  const attemptedTargets = new Map<string, Set<string>>();
  const restoreDiagnostics: RestoreDiagnostic[] = [];
  let restoreFailures = 0;
  let actions = 0;
  let stoppedReason = 'complete';

  const restore = async (current: ObservedVariant, target: ObservedVariant): Promise<RestoreResult> => {
    const result = await restoreToVariant(context, current, target, start);
    if (result.diagnostic.attempts.length > 0 || result.diagnostic.accepted_by) {
      restoreDiagnostics.push(result.diagnostic);
    }
    if (!result.restored) {
      restoreFailures += 1;
    }
    return result;
  };
  const markPartial = (): void => {
    if (stoppedReason === 'complete') {
      stoppedReason = 'partial';
    }
  };

  const visit = async (origin: ObservedVariant, depth: number): Promise<ObservedVariant> => {
    if (depth <= 0) {
      return origin;
    }
    if (actions >= context.options.crawlLimit) {
      stoppedReason = 'limit';
      return origin;
    }

    visited.add(origin.variant.id);
    const attemptsForVariant = attemptedTargets.get(origin.variant.id) ?? new Set<string>();
    attemptedTargets.set(origin.variant.id, attemptsForVariant);
    const candidates = safeTapCandidates(origin.variant, crawlCandidateOptions(origin.variant))
      .filter((candidate) => !attemptsForVariant.has(candidate.key));
    let current = origin;

    for (const candidate of candidates) {
      if (actions >= context.options.crawlLimit) {
        stoppedReason = 'limit';
        return current;
      }
      if (!restoreMatch(current, origin)) {
        if (restoreMatch(current, start)) {
          markPartial();
          return start;
        }
        stoppedReason = 'restore_failed';
        return current;
      }
      current = origin;

      attemptsForVariant.add(candidate.key);
      const args = candidate.args;
      let observed: ObservedVariant;
      try {
        await context.adapter.tap(args);
        actions += 1;
        observed = await observeAfterAction(context);
      } catch {
        try {
          current = await observeCurrentScreen(context);
        } catch {
          // Stay on the last known origin if a failed tap also prevents source capture.
        }
        continue;
      }

      recordEdgeSuccess(context, origin.variant, observed.variant, 'tap', args, true);
      visited.add(observed.variant.id);

      if (observed.variant.id !== origin.variant.id && depth > 1) {
        const nestedCurrent = await visit(observed, depth - 1);
        const restored = await restore(nestedCurrent, origin);
        current = restored.current;
        if (!restored.restored) {
          if (restoreMatch(current, start)) {
            markPartial();
            return start;
          }
          stoppedReason = 'restore_failed';
          return current;
        }
      } else {
        const restored = restoreMatch(observed, origin)
          ? { current: origin, restored: true } as RestoreResult
          : await restore(observed, origin);
        current = restored.current;
        if (!restored.restored) {
          if (restoreMatch(current, start)) {
            markPartial();
            if (restoreMatch(origin, start)) {
              current = origin;
              continue;
            }
            return start;
          }
          stoppedReason = 'restore_failed';
          return current;
        }
      }
    }

    return current;
  };

  await visit(start, context.options.crawlDepth);

  return {
    enabled: true,
    actions,
    variants: visited.size,
    stopped_reason: stoppedReason,
    ...(restoreFailures > 0 ? { restore_failures: restoreFailures } : {}),
    ...(restoreDiagnostics.length > 0 ? { restore_diagnostics: restoreDiagnostics } : {})
  };
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
    const crawl = context.options.crawl ? await crawlAppMap(context, observed) : undefined;
    const summary = persistAppMapContext(context);
    return {
      action: 'discover',
      map: summary,
      ...(crawl ? { crawl } : {}),
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
