import { errorResponse, json, preflight, requireUser, serviceClient } from "../_shared/http.ts";

function toBytea(hex: string): string { return `\\x${hex}`; }

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const user = await requireUser(request);
    if ((user as typeof user & { is_anonymous?: boolean }).is_anonymous !== true) {
      return json({ error: "customer_session_required" }, 401);
    }
    const body = await request.json();
    const token = typeof body?.tracking_token === "string" ? body.tracking_token : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return json({ error: "tracking_unavailable" }, 404);

    const rawToken = Uint8Array.from(atob(token.replace(/-/g, "+").replace(/_/g, "/") + "="), (char) => char.charCodeAt(0));
    const tokenHash = new Uint8Array(await crypto.subtle.digest("SHA-256", rawToken));
    const hex = Array.from(tokenHash, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const admin = serviceClient();
    if (body?.revoke === true) {
      const { error } = await admin.rpc("revoke_tracking_order", {
        p_auth_user_id: user.id,
        p_token_hash: toBytea(hex),
      });
      if (error) throw error;
      return json({ revoked: true });
    }
    const { data, error } = await admin.rpc("get_tracking_order", {
      p_auth_user_id: user.id,
      p_token_hash: toBytea(hex),
    });
    if (error) throw error;
    if (!data) return json({ error: "tracking_unavailable" }, 404);
    return json({ order: data });
  } catch (error) {
    return errorResponse(error);
  }
});
