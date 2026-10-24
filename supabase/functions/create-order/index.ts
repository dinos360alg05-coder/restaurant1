import { errorResponse, json, preflight, requireStaff, toHex } from "../_shared/http.ts";

function asBytea(hex: string): string { return `\\x${hex}`; }

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const { user, admin } = await requireStaff(request);
    const body = await request.json();
    const items = body?.items;
    const minutes = Number(body?.estimated_prep_minutes ?? 15);
    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
    const customerName = typeof body?.customer_name === "string" ? body.customer_name.trim() : "";
    const serviceType = body?.service_type;
    const tableNumber = body?.table_number == null ? null : Number(body.table_number);
    if (!Array.isArray(items) || items.length < 1 || items.length > 100 ||
        !Number.isInteger(minutes) || minutes < 5 || minutes > 240 || notes.length > 2000 ||
        customerName.length < 1 || customerName.length > 120 ||
        !["dine_in", "takeaway"].includes(serviceType) ||
        (serviceType === "dine_in" && (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 999)) ||
        (serviceType === "takeaway" && tableNumber !== null)) {
      return json({ error: "invalid_order" }, 400);
    }
    const cleanItems = items.map((item: Record<string, unknown>) => ({
      menu_item_id: typeof item?.menu_item_id === "string" ? item.menu_item_id : "",
      quantity: Number(item?.quantity),
    }));
    if (cleanItems.some((item: { menu_item_id: string; quantity: number }) =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.menu_item_id) ||
      !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)) {
      return json({ error: "invalid_order_items" }, 400);
    }

    const pepper = Deno.env.get("TRACKING_CODE_PEPPER");
    if (!pepper || pepper.length < 32) throw new Error("server_configuration_missing");
    const codeBytes = crypto.getRandomValues(new Uint32Array(1));
    const accessCode = String(codeBytes[0] % 1_000_000).padStart(6, "0");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const pepperKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", pepperKey, new TextEncoder().encode(`${toHex(salt)}:${accessCode}`)));
    const { data, error } = await admin.rpc("create_order_secure", {
      p_actor_id: user.id,
      p_items: cleanItems,
      p_notes: notes || null,
      p_estimated_prep_minutes: minutes,
      p_code_salt: asBytea(toHex(salt)),
      p_code_digest: asBytea(toHex(digest)),
      p_customer_name: customerName,
      p_service_type: serviceType,
      p_table_number: tableNumber,
      p_pepper_version: 1,
    });
    if (error) throw error;
    const created = Array.isArray(data) ? data[0] : data;
    if (!created) throw new Error("order_creation_failed");
    const { data: savedItems, error: savedItemsError } = await admin.from("order_items")
      .select("item_name,quantity,unit_price,position").eq("order_id", created.order_id).order("position");
    if (savedItemsError) throw savedItemsError;
    return json({
      order: {
        id: created.order_id,
        business_date: created.business_date,
        order_number: created.order_number,
        estimated_ready_at: created.estimated_ready_at,
        estimated_prep_minutes: minutes,
        customer_name: customerName,
        service_type: serviceType,
        table_number: tableNumber,
        subtotal_amount: Number(created.subtotal_amount),
        total_amount: Number(created.total_amount),
        notes: notes || null,
        items: savedItems || [],
        created_at: new Date().toISOString(),
      },
      access_code: accessCode,
    }, 201);
  } catch (error) {
    return errorResponse(error);
  }
});
