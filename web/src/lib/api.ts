// Local Compose exposes the API on port 4000. Deriving the host from the page
// works for LAN installs too; public deployments should provide their API URL.
const defaultApiUrl = typeof window === 'undefined'
  ? 'http://localhost:4000'
  : `${window.location.protocol}//${window.location.hostname}:4000`;
export const API = (process.env.NEXT_PUBLIC_API_URL || defaultApiUrl).replace(/\/$/, '');
export class ApiError extends Error { constructor(public status: number, message: string, public code?: string, public details?: any) { super(message); this.name = 'ApiError'; } }
export async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response: Response;
  try { response = await fetch(`${API}/api${path}`, { credentials: 'include', cache: 'no-store', ...options, headers }); }
  catch (cause) {
    const endpoint = `${API || (typeof window !== 'undefined' ? window.location.origin : '(panel origin)')}/api${path}`;
    const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : '';
    throw new ApiError(0, `Could not reach the Fledge API at ${endpoint}${detail}. Check that the panel can reach its API and that NEXT_PUBLIC_API_URL points to a browser-accessible address.`);
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`, code: string | undefined, details: any;
    try { const body = await response.json(); message = body.message || body.error || message; code = typeof body.error === 'string' ? body.error : undefined; details = body.details; } catch { /* non-JSON error */ }
    throw new ApiError(response.status, message, code, details);
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') || '';
  return (type.includes('application/json') ? await response.json() : await response.text()) as T;
}
export const json = (method: string, path: string, body?: unknown) => request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
export function items<T>(value: T[] | {items:T[]} | null | undefined): T[] { return Array.isArray(value) ? value : value?.items || []; }
export const fmtDate = (s?: string) => s ? new Date(s).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const fmtSize = (n?: number) => n == null ? '—' : n >= 1024 * 1024 * 1024 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 * 1024 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${n} B`;
export type User = { id:string; email:string; role:'admin'|'customer'; has2fa:boolean; passkeys?:number };
export type ServerPermission = 'view'|'console'|'files'|'backups'|'manage';
export type Server = {id:string;name:string;status:string;observedStatus:string;ownerId:string;nodeId:string;nodeName:string;location:string;templateId:string;supportsRcon?:boolean;memoryMb:number;cpuPercent:number;diskMb:number;port:number;suspended:boolean;desiredStatus?:string;usage?:{diskBytes?:number;diskEnforced?:boolean;cpuPercent?:number;memoryBytes?:number;memoryLimitBytes?:number;sampledAt?:string};variables?:Record<string,string>;effectivePermissions?:ServerPermission[];createdAt?:string};
export type Node = {id:string;name:string;location:string;status:string;lastSeenAt?:string;draining:boolean;headroomMb:number;capacity:{memoryMb:number;cpuPercent:number;diskMb:number};reserved:{memoryMb:number;cpuPercent:number;diskMb:number};usage?:Record<string,unknown>;version?:string;publicHost?:string|null;agent?:{os?:string;arch?:string;updatable?:boolean;updateBlocker?:string;quota?:{mode:string;supported:boolean;enforced:boolean;reason?:string};sftp?:{listening:boolean;port:number;error?:string;fingerprint?:string}}};
export type AgentReleases = {latest:string|null;error:string|null;auto:boolean;nodes:{id:string;version:string|null;available:boolean;blocker:string|null;pending:boolean}[]};
export type Template = {id:string;name:string;memoryMb:number;cpuPercent:number;diskMb:number;editableVariables?:string[]};
export type Job = {id:string;kind:string;state:string;error?:string;createdAt:string;serverId?:string};
/* ---------- Plugins and server add-ons ---------- */
export type PluginTier = 'bundled' | 'verified' | 'community';
export type PluginPermission = { id: string; text: string };
export type PluginField = { key: string; label: string; type: 'string' | 'number' | 'boolean' | 'select' | 'secret'; default?: string | number | boolean; options?: { value: string; label: string }[]; required?: boolean; help?: string; min?: number; max?: number; pattern?: string; placeholder?: string };
export type PluginInfo = { id: string; name: string; version: string; tier: PluginTier; source: string; description: string; author: string; license?: string | null; homepage?: string | null; icon: string | null; enabled: boolean; catalogs: { id: string; label: string; kind: string }[]; hooks?: string[]; permissions: (PluginPermission & { granted: boolean })[]; settingsSchema: PluginField[]; settings: Record<string, string | number | boolean | { set: boolean } | null | undefined>; missingSettings: string[]; failureCount: number; lastError: string | null; disabledReason: string | null; hasPrevious: boolean; previousVersion: string | null; installedAt: string; updatedAt: string; readme?: string | null; changelog?: string | null };
export type StoreItem = { id: string; name: string; version: string; description: string; author: string; license: string | null; homepage: string | null; icon: string | null; tier: PluginTier; source: 'bundled' | 'registry'; permissions: PluginPermission[]; catalogs: { id: string; label: string; kind: string }[]; compatible: boolean; incompatibleReason: string | null; installed: null | { version: string; enabled: boolean; tier: PluginTier; updateAvailable: boolean }; installable: boolean; blockedReason: string | null };
export type PluginStore = { items: StoreItem[]; registry: { url: string; error: string | null; fetchedAt: string | null; entries: number }; allowCommunity: boolean };
export type PluginList = { host: { ok: boolean; version?: string; sandbox?: string; error?: string }; plugins: PluginInfo[] };
export type PluginLog = { id: number | string; level: string; message: string; at: string };
export type AddonCapability = { supported: boolean; reason?: string; kind?: 'mod' | 'plugin'; dir?: string; loaders?: string[]; gameVersion?: string; type?: string };
export type Addon = { id: string; pluginId: string; kind: string; projectId: string; title: string; slug: string | null; iconUrl: string | null; versionId: string; versionLabel: string; filename: string; sizeBytes: number | null; state: 'pending' | 'installed' | 'failed' | 'removing'; disabled: boolean; pinned: boolean; isDependency: boolean; error: string | null; installedAt: string; updatedAt: string };
export type AddonOverview = { capability: AddonCapability; agentOk: boolean; agentVersion: string | null; requiredAgent: string | null; writable: boolean; providers: { pluginId: string; name: string; icon: string | null; catalogId: string; canInstall: boolean }[]; installed: Addon[] };
export type AddonHit = { id: string; slug: string; title: string; summary: string; iconUrl: string | null; author: string; downloads: number; follows: number; categories: string[]; clientSide?: string; serverSide?: string; updatedAt?: string; url?: string; installedAddonId: string | null; installedVersion: string | null };
export type AddonSearch = { total: number; offset: number; limit: number; items: AddonHit[] };
export type AddonProject = { id: string; slug: string; title: string; summary: string; description: string; iconUrl: string | null; categories: string[]; license: string | null; clientSide?: string; serverSide?: string; downloads: number; follows: number; updatedAt?: string; gallery: { url: string; title?: string }[]; links: { page?: string; source?: string; issues?: string; wiki?: string; discord?: string } };
export type AddonVersion = { id: string; label: string; name: string; channel: 'release' | 'beta' | 'alpha'; publishedAt: string; gameVersions: string[]; loaders: string[]; downloads: number; changelog: string; files: { filename: string; size: number; primary: boolean }[] };
export type AddonPlanItem = { role: 'main' | 'required' | 'optional'; projectId: string; title: string; slug: string | null; iconUrl: string | null; versionId: string; versionLabel: string; channel: string; file: { url: string; filename: string; sha512: string; size: number } | null; alreadyInstalled: boolean; selected: boolean };
export type AddonPlan = { items: AddonPlanItem[]; blockers: string[]; warnings: string[] };
export type AddonUpdate = { addonId: string; pluginId: string; projectId: string; title: string; iconUrl: string | null; pinned: boolean; disabled: boolean; current: { versionId: string; label: string }; latest: { id: string; label: string; channel: string; publishedAt: string; changelog: string; files: { filename: string; size: number; primary: boolean }[] } };
export type AddonUpdates = { updates: AddonUpdate[]; checkedAt: string | null };
export type AddonUnmanaged = { dir: string; items: { name: string; size: number; modifiedAt: string; disabled: boolean }[] };
/* ---------- Templates v2 and startup ---------- */
export type VariableDef = { key: string; label: string; description?: string; type: 'string' | 'number' | 'boolean' | 'select'; options?: { value: string; label: string }[]; min?: number; max?: number; pattern?: string; secret?: boolean; userEditable: boolean; required?: boolean };
export type QuickCommand = { label: string; command: string };
export type TemplateFull = { id: string; name: string; description: string | null; image: string; startup: string | null; internalPorts: { container: number; offset: number; protocol: 'tcp' | 'udp' }[]; env: Record<string, string>; memoryMb: number; cpuPercent: number; diskMb: number; editableVariables: string[]; variables: VariableDef[]; stopCommand: string | null; official: boolean; version: number; addons: Record<string, any> | null; quickCommands: QuickCommand[]; updatedAt: string };
export type TemplateOutdated = { template: { id: string; name: string; version: number }; servers: { id: string; name: string; ownerEmail: string; fromVersion: number; toVersion: number; changes: string[]; canApply: boolean; blocker: string | null }[] };
export type ServerStartup = { image: string; startup: string | null; stopCommand: string | null; env: { key: string; value: string | null; hidden: boolean; source: 'template' | 'server'; editable: boolean; label: string | null; type: string | null }[]; ports: { base: number; mapping: { host: number; container: number; protocol: string }[] }[]; templateId: string; templateName: string; templateVersion: number; currentTemplateVersion: number; outdated: boolean; variables: VariableDef[] };
export type PluginInspect = { id: string; name: string; version: string; description: string; author: string; license: string | null; homepage: string | null; icon: string | null; tier: PluginTier; source: string; permissions: PluginPermission[]; catalogs: { id: string; label: string; kind: string }[]; settingsSchema: PluginField[]; installed: null | { version: string; tier: PluginTier }; blockedReason: string | null };
/* ---------- Notifications, automation, crash protection, ports, metrics ---------- */
export type NotificationItem = { id: number; kind: string; severity: 'info' | 'warn' | 'bad' | 'ok'; title: string; body: string; serverId: string | null; serverName: string | null; nodeId: string | null; createdAt: string; unread: boolean };
export type NotificationList = { items: NotificationItem[]; unread: number; seenId: number };
export type ScheduleTask = { action: 'power'; power: 'start' | 'stop' | 'restart' | 'kill' } | { action: 'command'; command: string } | { action: 'backup' } | { action: 'wait'; seconds: number };
export type Schedule = { id: string; name: string | null; kind: 'chain' | 'backup' | 'command'; cron: string | null; intervalMinutes: number | null; timezone: string; tasks: ScheduleTask[]; missed: 'skip' | 'run'; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null; lastError: string | null; createdAt: string; command?: string };
export type ScheduleRun = { id: string; state: string; step: number; error: string | null; results: { step: number; action: string; ok: boolean; detail: string; at: string }[] | null; trigger: string | null; startedAt: string; finishedAt: string | null };
export type CrashPolicy = { mode: 'off' | 'on-failure' | 'always'; maxRestarts: number; windowMinutes: number; backoffSeconds: number[] };
export type CrashInfo = { policy: CrashPolicy; loop: boolean; restartsInWindow: number; lastExit: { code: number | null; oomKilled?: boolean; finishedAt?: string; logTail?: string } | null };
export type ServerEvent = { id: number; kind: 'crash' | 'restart' | 'crashloop' | 'recovered' | string; message: string; detail: Record<string, any> | null; at: string };
export type ServerPorts = { basePort: number; publicHost: string | null; mappings: { source: 'template' | 'extra'; container: number; offset: number; hostPort: number; protocol: 'tcp' | 'udp'; label: string | null; removable: boolean }[]; quota: { limit: number | null; used: number }; canAdd: boolean; restartRequired?: boolean };
export type MetricsPoint = { t: number; cpu: number; cpuMax: number; memory: number; memoryMax: number; disk: number | null; samples: number };
export type ServerMetrics = { range: string; resolutionSeconds: number; memoryLimitBytes: number; points: MetricsPoint[] };
/* ---------- Accounts, quotas, notifications, audit, API reference ---------- */
export type AuthSession = { id: string; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string | null; expiresAt: string; current: boolean };
export type Passkey = { id: string; name: string; deviceType: string | null; backedUp: boolean; createdAt: string; lastUsedAt: string | null };
export type Quota = { maxServers?: number | null; maxMemoryMb?: number | null; maxCpuPercent?: number | null; maxDiskMb?: number | null; maxBackups?: number | null; maxExtraPorts?: number | null };
export type QuotaUsage = { servers: number; memoryMb: number; cpuPercent: number; diskMb: number; backups?: number; extraPorts?: number };
export type AccountUsage = { quota: Quota; usage: QuotaUsage };
export type NotificationEvent = { id: string; label: string; scope: 'server' | 'panel'; severity: 'info' | 'warn' | 'bad' | 'ok' };
export type NotificationKind = 'webhook' | 'discord' | 'slack' | 'email';
export type NotificationChannel = { id: string; scope: 'panel' | 'user'; name: string; kind: NotificationKind; events: string[]; serverIds: string[] | null; enabled: boolean; to: string | null; urlHost: string | null; lastStatus: 'sent' | 'failed' | null; lastError: string | null; lastSentAt: string | null; createdAt: string; mine: boolean };
export type EmailSettings = { enabled: boolean; host: string; port: number; security: 'none' | 'starttls' | 'tls'; user: string; passwordSet: boolean; from: string };
export type SecuritySettings = { adminAllowedCidrs: string[]; auditRetentionDays: number };
export type OpenApiOperation = { tags?: string[]; summary?: string; description?: string; operationId?: string; parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: { type?: string } }[]; requestBody?: { description?: string; required?: boolean; content?: Record<string, { schema?: { description?: string } }> }; 'x-access'?: 'public' | 'session' | 'admin' | 'agent'; 'x-token-scope'?: string };
export type OpenApiDoc = { openapi: string; info: { title?: string; version?: string; description?: string }; tags?: { name: string; description?: string }[]; paths: Record<string, Record<string, OpenApiOperation>> };
