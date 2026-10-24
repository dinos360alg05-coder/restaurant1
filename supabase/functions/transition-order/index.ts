import { errorResponse, json, preflight, requireStaff } from "../_shared/http.ts";

const allowed = new Set(["preparing", "ready", "delivered", "cancelled"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const { user, admin } = await requireStaff(request);
    const body = await request.json();
    if (typeof body?.order_id !== "string" || !uuidPattern.test(body.order_id) || !allowed.has(body?.next_status)) {
      return json({ error: "invalid_transition_request" }, 400);
    }
    const { data, error } = await admin.rpc("transition_order_secure", {
      p_actor_id: user.id,
      p_order_id: body.order_id,
      p_next_status: body.next_status,
      p_estimated_prep_minutes: null,
    });
    if (error) {
      if (error.message.includes("invalid_status_transition")) return json({ error: "invalid_status_transition" }, 409);
      if (error.message.includes("order_unavailable")) return json({ error: "order_unavailable" }, 404);
      throw error;
    }
    return json({ order: data });
  } catch (error) {
    return errorResponse(error);
  }
});
