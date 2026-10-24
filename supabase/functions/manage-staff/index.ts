import { errorResponse, json, preflight, requireAdmin } from "../_shared/http.ts";

function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;

  try {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const { user, admin } = await requireAdmin(request);
    const body = await request.json().catch(() => ({}));

    if (body.action === "list") {
      const { data: staff, error: staffError } = await admin.from("staff_members")
        .select("user_id, active, is_admin, display_name, created_at, last_seen_at")
        .order("created_at", { ascending: false });
      if (staffError) throw staffError;

      const authUsers = new Map<string, { email: string | null }>();
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        for (const authUser of data.users) authUsers.set(authUser.id, { email: authUser.email || null });
        if (data.users.length < 1000) break;
      }

      const now = Date.now();
      return json({ staff: (staff || []).map((member) => ({
        user_id: member.user_id,
        email: authUsers.get(member.user_id)?.email || "",
        display_name: member.display_name || "",
        active: member.active,
        is_admin: member.is_admin,
        created_at: member.created_at,
        last_seen_at: member.last_seen_at,
        online: Boolean(member.active && member.last_seen_at && now - new Date(member.last_seen_at).getTime() < 90_000),
        is_self: member.user_id === user.id,
      })) });
    }

    if (body.action === "create") {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
      if (!validEmail(email)) return json({ error: "invalid_email" }, 400);
      if (password.length < 10 || password.length > 72) return json({ error: "invalid_password" }, 400);
      if (!displayName || displayName.length > 120) return json({ error: "invalid_display_name" }, 400);

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName },
      });
      if (createError) throw createError;
      if (!created.user) throw new Error("staff_user_creation_failed");

      const { error: staffError } = await admin.from("staff_members").insert({
        user_id: created.user.id,
        display_name: displayName,
        active: true,
        is_admin: false,
      });
      if (staffError) {
        await admin.auth.admin.deleteUser(created.user.id);
        throw staffError;
      }
      return json({ success: true, staff: { user_id: created.user.id, email, display_name: displayName, active: true, is_admin: false } }, 201);
    }

    if (body.action === "set_active") {
      const targetId = typeof body.user_id === "string" ? body.user_id : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)
        || typeof body.active !== "boolean") return json({ error: "invalid_staff_change" }, 400);

      const { error } = await admin.rpc("set_staff_active_secure", {
        p_actor_id: user.id,
        p_target_id: targetId,
        p_active: body.active,
      });
      if (error) {
        const messages: Record<string, { status: number; text: string }> = {
          cannot_disable_last_admin: { status: 409, text: "cannot_disable_last_admin" },
          cannot_change_own_access: { status: 400, text: "cannot_change_own_access" },
          staff_not_found: { status: 404, text: "staff_not_found" },
          admin_access_required: { status: 403, text: "admin_access_required" },
        };
        const known = Object.entries(messages).find(([key]) => error.message.includes(key))?.[1];
        if (known) return json({ error: known.text }, known.status);
        throw error;
      }
      return json({ success: true });
    }

    return json({ error: "invalid_action" }, 400);
  } catch (error) {
    return errorResponse(error);
  }
});
