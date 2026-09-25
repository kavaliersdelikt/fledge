// Local Compose exposes the API on port 4000. Deriving the host from the page
// works for LAN installs too; public deployments should provide their API URL.
const defaultApiUrl = typeof window === 'undefined'
  ? 'http://localhost:4000'
  : `${window.location.protocol}//${window.location.hostname}:4000`;
export const API = (process.env.NEXT_PUBLIC_API_URL || defaultApiUrl).replace(/\/$/, '');
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; } }
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
    let message = `Request failed (${response.status})`;
    try { const body = await response.json(); message = body.message || body.error || message; } catch { /* non-JSON error */ }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') || '';
  return (type.includes('application/json') ? await response.json() : await response.text()) as T;
}
export const json = (method: string, path: string, body?: unknown) => request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
export function items<T>(value: T[] | {items:T[]} | null | undefined): T[] { return Array.isArray(value) ? value : value?.items || []; }
export const fmtDate = (s?: string) => s ? new Date(s).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const fmtSize = (n?: number) => n == null ? '—' : n >= 1024 * 1024 * 1024 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 * 1024 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${n} B`;
export type User = { id:string; email:string; role:'admin'|'customer'; has2fa:boolean };
export type ServerPermission = 'view'|'console'|'files'|'backups'|'manage';
export type Server = {id:string;name:string;status:string;observedStatus:string;ownerId:string;nodeId:string;nodeName:string;location:string;templateId:string;supportsRcon?:boolean;memoryMb:number;cpuPercent:number;diskMb:number;port:number;suspended:boolean;usage?:{diskBytes?:number};variables?:Record<string,string>;effectivePermissions?:ServerPermission[]};
export type Node = {id:string;name:string;location:string;status:string;lastSeenAt?:string;draining:boolean;headroomMb:number;capacity:{memoryMb:number;cpuPercent:number;diskMb:number};reserved:{memoryMb:number;cpuPercent:number;diskMb:number};usage?:Record<string,unknown>;version?:string};
export type Template = {id:string;name:string;memoryMb:number;cpuPercent:number;diskMb:number;editableVariables?:string[]};
export type Job = {id:string;kind:string;state:string;error?:string;createdAt:string;serverId?:string};
