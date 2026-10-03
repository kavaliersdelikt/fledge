import { apiInternalUrl } from "@/lib/branding-server";

// Custom images are served from the panel's own address so the content security policy can stay on 'self'
// and the API can be reached by its internal address only.
export const dynamic = "force-dynamic";

const KINDS = ["mark", "wordmark", "favicon", "login"];

export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!KINDS.includes(kind)) return new Response("Not found", { status: 404 });
  const v = new URL(req.url).searchParams.get("v") || "";
  let res: Response;
  try {
    res = await fetch(`${apiInternalUrl()}/api/branding/assets/${kind}?v=${encodeURIComponent(v.slice(0, 64))}`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
  } catch {
    res = new Response(null, { status: 502 });
  }
  if (res.status === 404 || !res.ok) {
    // No custom logo: the built-in mark, so custom CSS and old links keep working.
    if (kind === "mark" || kind === "favicon") return Response.redirect(new URL("/fledge-symbol.png", req.url), 307);
    return new Response("Not found", { status: res.status === 404 ? 404 : 502 });
  }
  const headers = new Headers();
  for (const h of ["content-type", "etag", "cache-control", "content-disposition"]) {
    const value = res.headers.get(h);
    if (value) headers.set(h, value);
  }
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  return new Response(res.body, { status: 200, headers });
}
