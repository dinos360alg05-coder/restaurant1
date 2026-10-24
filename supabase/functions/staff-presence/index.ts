import { errorResponse, json, preflight, requireStaff } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  try {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const { user, admin } = await requireStaff(request);
    const { error } = await admin.from("staff_members")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("user_id", user.id).eq("active", true);
    if (error) throw error;
    return json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
});
