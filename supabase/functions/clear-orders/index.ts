import { errorResponse, json, preflight, requireStaff } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const { user, admin } = await requireStaff(request);
    const body = await request.json();
    if (body?.confirm !== true) return json({ error: "confirmation_required" }, 400);

    const { data, error } = await admin.rpc("clear_orders_secure", { p_actor_id: user.id });
    if (error) {
      if (error.message.includes("staff_access_required")) return json({ error: "staff_access_required" }, 403);
      throw error;
    }
    const result = Array.isArray(data) ? data[0] : data;
    return json({ deleted_orders: Number(result?.deleted_orders) || 0 });
  } catch (error) {
    return errorResponse(error);
  }
});
