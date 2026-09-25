export const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; } }
export async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response: Response;
  try { response = await fetch(`${API}/api${path}`, { credentials: 'include', cache: 'no-store', ...options, headers }); }
  catch { throw new ApiError(0, 'The API is unreachable. Check your connection and NEXT_PUBLIC_API_URL.'); }
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
