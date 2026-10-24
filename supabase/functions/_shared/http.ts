import { createClient, type User } from "npm:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function preflight(request: Request): Response | null {
  return request.method === "OPTIONS" ? new Response("ok", { headers: corsHeaders }) : null;
}

function namedKey(environmentName: string, legacyName: string): string | undefined {
  const raw = Deno.env.get(environmentName);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.default === "string") return parsed.default;
    } catch (_) {
      // Some runtimes expose a single key directly instead of a named-key map.
      return raw;
    }
  }
  return Deno.env.get(legacyName) || undefined;
}

export function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = namedKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("server_configuration_missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function requireUser(request: Request): Promise<User> {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("unauthorized");
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = namedKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !anonKey) throw new Error("server_configuration_missing");
  const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await authClient.auth.getUser(match[1]);
  if (error || !data.user) throw new Error("unauthorized");
  return data.user;
}

export async function requireStaff(request: Request): Promise<{ user: User; admin: ReturnType<typeof serviceClient> }> {
  const user = await requireUser(request);
  const admin = serviceClient();
  const { data: staff, error: staffError } = await admin.from("staff_members")
    .select("active").eq("user_id", user.id).maybeSingle();
  if (staffError || !staff?.active) throw new Error("staff_authorization_required");
  return { user, admin };
}

export function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "request_failed";
  if (message === "unauthorized") return json({ error: "sign_in_required" }, 401);
  if (message === "staff_authorization_required") return json({ error: "staff_access_required" }, 403);
  if (message === "server_configuration_missing") return json({ error: "server_configuration_missing" }, 500);
  const maybeError = error as { code?: unknown; name?: unknown; message?: unknown };
  const rawCode = typeof maybeError?.code === "string" ? maybeError.code : "unknown";
  const diagnosticCode = /^[A-Za-z0-9_.-]{1,32}$/.test(rawCode) ? rawCode : "unknown";
  const errorName = typeof maybeError?.name === "string" ? maybeError.name : "Error";
  // Keep the response generic, but record the database message in protected function logs
  // so SQLSTATE failures can be diagnosed without exposing internals in the browser.
  const diagnosticMessage = typeof maybeError?.message === "string"
    ? maybeError.message.slice(0, 300)
    : message.slice(0, 300);
  console.error("edge_request_failed", JSON.stringify({ name: errorName, code: diagnosticCode, message: diagnosticMessage }));
  return json({ error: "request_failed", diagnostic_code: diagnosticCode }, 500);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
