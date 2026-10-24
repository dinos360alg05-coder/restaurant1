import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const config = window.RESTAURANT_CONFIG;
const supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const $ = (selector) => document.querySelector(selector);
const list = $("#orders-list");
const menuDialog = $("#menu-item-dialog");
const menuForm = $("#menu-item-form");
const clearOrdersDialog = $("#clear-orders-dialog");
const categories = { all: "الكل", main: "أطباق رئيسية", salad: "سلطات", soup: "شوربات", dessert: "حلويات", drink: "مشروبات", other: "أخرى" };
const categoryIcons = { main: "♨", salad: "❋", soup: "◉", dessert: "✿", drink: "◌", other: "✦" };
const statusKeys = { received: "status.received", preparing: "status.preparing", ready: "status.ready", delivered: "status.delivered", cancelled: "status.cancelled" };
const statusIcons = { received: "◷", preparing: "◌", ready: "✓", delivered: "▣", cancelled: "×" };
let prepMinutes = 15;
let currentOrders = [];
let menuItems = [];
let cart = new Map();
let categoryFilter = "all";
let liveChannel;
let editingMenuItemId = null;
let recentlyCreatedOrderId = null;
let pendingImageFile = null;
let imagePreviewObjectUrl = null;

const t = (key) => window.restaurantTranslate?.(key) || key;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (value) => new Intl.NumberFormat(document.documentElement.lang || "ar", { maximumFractionDigits: 2 }).format(Number(value) || 0) + " دج";

function directImageUrl(value) {
  try {
    const url = new URL(value);
    if (["drive.google.com", "docs.google.com"].includes(url.hostname.toLowerCase())) {
      const id = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || url.searchParams.get("id");
      if (id) return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}`;
    }
    return url.href;
  } catch (_) { return value; }
}

function showMessage(element, message, kind = "info") {
  element.textContent = message;
  element.className = `form-message ${kind}`;
  element.hidden = !message;
  if (kind === "success" && message) {
    element.classList.remove("form-message-pop");
    void element.offsetWidth;
    element.classList.add("form-message-pop");
  } else {
    element.classList.remove("form-message-pop");
  }
}

async function functionErrorMessage(error, fallbackKey) {
  if (/failed to send a request to the edge function|failed to fetch|networkerror/i.test(error?.message || "")) {
    return t("admin.error.functionUnavailable");
  }
  try {
    const response = error?.context;
    if (response instanceof Response) {
      const body = await response.clone().json();
      const translations = {
        server_configuration_missing: "admin.error.secret", staff_access_required: "admin.error.staff",
        sign_in_required: "admin.error.signin", invalid_order: "admin.error.invalidOrder",
        invalid_order_items: "admin.error.invalidItems", invalid_status_transition: "admin.error.transition",
        order_unavailable: "admin.error.unavailable", request_failed: "admin.error.server",
      };
      if (body?.error && translations[body.error]) {
        const message = t(translations[body.error]);
        return body.diagnostic_code ? `${message} (${body.diagnostic_code})` : message;
      }
      return `${t("admin.error.http")} ${response.status}`;
    }
  } catch (_) { /* Network errors may not have a response body. */ }
  return error?.message || t(fallbackKey);
}

function orderDateLabel() {
  return new Intl.DateTimeFormat(document.documentElement.lang || "ar", { timeZone: config.timeZone || "Africa/Algiers", dateStyle: "full" }).format(new Date());
}

function formatTime(value) {
  return new Intl.DateTimeFormat(document.documentElement.lang || "ar", { timeZone: config.timeZone || "Africa/Algiers", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function openReceipt(order, code) {
  const itemMarkup = order.items.map((item) => `<li><span>${escapeHtml(item.item_name)} × ${Number(item.quantity)}</span><b>${money(Number(item.unit_price) * Number(item.quantity))}</b></li>`).join("");
  const serviceLabel = order.service_type === "dine_in" ? `محلي • طاولة ${Number(order.table_number)}` : "سفري";
  const receipt = $("#receipt");
  receipt.innerHTML = `<div class="receipt-content"><h1>${escapeHtml(config.restaurantName || "Restaurant")}</h1><p>${escapeHtml(t("receipt.heading"))}</p><hr><p>${escapeHtml(t("receipt.order"))}: <strong>${String(order.order_number).padStart(3, "0")}</strong></p><p>الزبون: ${escapeHtml(order.customer_name)}</p><p>${serviceLabel}</p><ul>${itemMarkup}</ul><p><strong>الإجمالي: ${money(order.total_amount)}</strong></p>${order.notes ? `<p>${escapeHtml(t("receipt.notes"))}: ${escapeHtml(order.notes)}</p>` : ""}<p>${escapeHtml(t("receipt.prep"))}: ${Number(order.estimated_prep_minutes)} ${escapeHtml(t("receipt.minutes"))}</p><p>${escapeHtml(t("receipt.code"))}: <strong class="receipt-code">${escapeHtml(code)}</strong></p><hr><p>${escapeHtml(t("receipt.scan"))}</p><p>${escapeHtml(location.origin + location.pathname.replace(/admin\.html$/, "customer.html"))}</p></div>`;
  receipt.hidden = false;
  window.print();
  receipt.hidden = true;
}

function renderMenu() {
  const categoryBox = $("#menu-categories");
  const visible = menuItems.filter((item) => item.active && (categoryFilter === "all" || item.category === categoryFilter));
  const usedCategories = [...new Set(menuItems.filter((item) => item.active).map((item) => item.category))];
  categoryBox.innerHTML = [{ id: "all", name: categories.all }, ...usedCategories.map((id) => ({ id, name: categories[id] || id }))]
    .map((item) => `<button type="button" class="category-chip ${categoryFilter === item.id ? "is-active" : ""}" data-category="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button>`).join("");
  $("#menu-grid").innerHTML = visible.map((item) => {
    const imageUrl = item.image_url ? directImageUrl(item.image_url) : "";
    const image = imageUrl && /^https?:\/\//i.test(imageUrl)
      ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(item.name)}" loading="lazy" referrerpolicy="no-referrer"><span class="menu-image-failure" hidden>تعذر تحميل الصورة</span>`
      : `<span class="menu-art-placeholder" aria-hidden="true">${categoryIcons[item.category] || "✦"}</span>`;
    return `<article class="menu-card"><div class="menu-photo menu-photo-${escapeHtml(item.category)}">${image}<span class="menu-price">${money(item.price)}</span><button class="menu-edit" type="button" data-edit-menu="${item.id}" aria-label="تعديل ${escapeHtml(item.name)}" title="تعديل الصنف">✎</button></div><div class="menu-card-copy"><span class="menu-category-label">${escapeHtml(categories[item.category] || "أخرى")}</span><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description || "")}</p><div class="menu-card-actions"><button class="button button-secondary menu-add" type="button" data-add-menu="${item.id}">＋ إضافة للطلب</button><button class="menu-availability" type="button" data-edit-menu="${item.id}" aria-label="تعديل التوفر">إدارة</button></div></div></article>`;
  }).join("");
  $("#menu-grid").querySelectorAll(".menu-photo img").forEach((image) => image.addEventListener("error", () => {
    image.hidden = true;
    image.closest(".menu-photo").querySelector(".menu-image-failure").hidden = false;
  }, { once: true }));
  $("#menu-empty").hidden = visible.length > 0;
}

function renderCart() {
  const entries = [...cart.entries()].map(([id, quantity]) => ({ item: menuItems.find((menuItem) => menuItem.id === id), quantity })).filter((entry) => entry.item);
  const total = entries.reduce((sum, entry) => sum + Number(entry.item.price) * entry.quantity, 0);
  $("#cart-count").textContent = entries.reduce((sum, entry) => sum + entry.quantity, 0);
  $("#cart-total").textContent = money(total);
  $("#cart-empty").hidden = entries.length > 0;
  $("#cart-items").innerHTML = entries.map(({ item, quantity }) => `<li class="cart-item"><div><strong>${escapeHtml(item.name)}</strong><small>${money(item.price)} × ${quantity}</small></div><div class="quantity-stepper"><button type="button" data-cart-change="-1" data-id="${item.id}" aria-label="إنقاص ${escapeHtml(item.name)}">−</button><span>${quantity}</span><button type="button" data-cart-change="1" data-id="${item.id}" aria-label="زيادة ${escapeHtml(item.name)}">＋</button><button type="button" class="cart-remove" data-cart-remove="${item.id}" aria-label="حذف ${escapeHtml(item.name)}">×</button></div></li>`).join("");
}

function resetOrder() {
  cart.clear();
  $("#customer-name").value = "";
  $("#service-type").value = "dine_in";
  $("#table-number").value = "";
  $("#cart-notes").value = "";
  prepMinutes = 15;
  $("#prep-value").value = prepMinutes;
  showMessage($("#order-form-message"), "");
  updateTableVisibility();
  renderCart();
}

function updateTableVisibility() {
  const dineIn = $("#service-type").value === "dine_in";
  $("#table-field").hidden = !dineIn;
  $("#table-number").required = dineIn;
}

function renderOrders() {
  const filter = $("#order-filter").value;
  const filtered = currentOrders.filter((order) => filter === "active"
    ? ["received", "preparing", "ready"].includes(order.status)
    : filter === "all" || order.status === filter);
  list.innerHTML = filtered.map((order) => {
    const itemText = (order.order_items || []).map((item) => `<li><span>${escapeHtml(item.item_name)} × ${Number(item.quantity)}</span><b>${money(Number(item.unit_price) * Number(item.quantity))}</b></li>`).join("");
    const actions = order.status === "received" ? `<button class="button button-primary" data-action="preparing" data-id="${order.id}">${escapeHtml(t("action.start"))}</button><button class="button button-secondary" data-action="cancelled" data-id="${order.id}">${escapeHtml(t("action.cancel"))}</button>`
      : order.status === "preparing" ? `<button class="button button-primary" data-action="ready" data-id="${order.id}">${escapeHtml(t("action.ready"))}</button><button class="button button-secondary" data-action="cancelled" data-id="${order.id}">${escapeHtml(t("action.cancel"))}</button>`
      : order.status === "ready" ? `<button class="button button-primary" data-action="delivered" data-id="${order.id}">${escapeHtml(t("action.delivered"))}</button><button class="button button-secondary" data-action="cancelled" data-id="${order.id}">${escapeHtml(t("action.cancel"))}</button>` : "";
    const overdue = ["received", "preparing"].includes(order.status) && Date.now() > new Date(order.estimated_ready_at).getTime();
    const service = order.service_type === "dine_in" ? `محلي • طاولة ${Number(order.table_number)}` : order.service_type === "takeaway" ? "سفري" : "";
    const arriving = order.id === recentlyCreatedOrderId;
    return `<article data-order-id="${order.id}" class="order-card glass-panel ${overdue ? "order-overdue" : ""} ${arriving ? "order-card-arrive" : ""}"><div class="order-card-top"><div><span class="order-number">#${String(order.order_number).padStart(3, "0")}</span><span class="status-pill status-${order.status}">${statusIcons[order.status]} ${escapeHtml(t(statusKeys[order.status]))}</span></div><time datetime="${escapeHtml(order.created_at)}">${escapeHtml(formatTime(order.created_at))}</time></div><div class="order-customer-meta"><strong>${escapeHtml(order.customer_name || "زبون")}</strong><span>${service}</span></div><ul class="order-items">${itemText}</ul><div class="order-total"><span>الإجمالي</span><strong>${money(order.total_amount)}</strong></div>${order.notes ? `<p class="order-notes">${escapeHtml(order.notes)}</p>` : ""}<div class="order-meta"><span>${escapeHtml(t("order.estimate"))}: ${Number(order.estimated_prep_minutes)} ${escapeHtml(t("receipt.minutes"))}</span><span>${overdue ? escapeHtml(t("order.late")) : `${escapeHtml(t("order.readyAt"))}: ${escapeHtml(formatTime(order.estimated_ready_at))}`}</span></div>${actions ? `<div class="order-actions">${actions}</div>` : ""}</article>`;
  }).join("");
  $("#orders-empty").hidden = filtered.length > 0;
  const active = currentOrders.filter((order) => ["received", "preparing", "ready"].includes(order.status));
  $("#active-count").textContent = active.length;
  $("#ready-count").textContent = currentOrders.filter((order) => order.status === "ready").length;
  $("#late-count").textContent = currentOrders.filter((order) => ["received", "preparing"].includes(order.status) && Date.now() > new Date(order.estimated_ready_at).getTime()).length;
}

async function loadOrders() {
  const { data, error } = await supabase.from("orders")
    .select("*, order_items(item_name, quantity, position, unit_price)")
    .order("created_at", { ascending: false }).limit(300);
  if (error) throw error;
  currentOrders = data || [];
  renderOrders();
  if (recentlyCreatedOrderId) {
    const newCard = list.querySelector(`[data-order-id="${recentlyCreatedOrderId}"]`);
    if (newCard) {
      newCard.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      window.setTimeout(() => newCard.classList.remove("order-card-arrive"), 1500);
    }
    recentlyCreatedOrderId = null;
  }
}

async function loadMenu() {
  const { data, error } = await supabase.from("menu_items").select("*").order("position").order("name");
  if (error) throw error;
  menuItems = data || [];
  renderMenu();
  renderCart();
}

async function startDashboard(user) {
  $("#signin-panel").hidden = true;
  $("#dashboard").hidden = false;
  $("#staff-email-label").textContent = user.email || "";
  $("#today-label").textContent = orderDateLabel();
  showMessage($("#dashboard-message"), t("admin.loading"));
  try {
    await Promise.all([loadOrders(), loadMenu()]);
    showMessage($("#dashboard-message"), "");
    window.setRestaurantConnectionStatus?.("staff");
  } catch (error) {
    const detail = ["42P01", "PGRST205"].includes(error?.code)
      ? "حدّث قاعدة البيانات بتشغيل ملف supabase/migrations/20261024030000_cashier_menu_and_order_totals.sql في SQL Editor."
      : error.message;
    showMessage($("#dashboard-message"), `${t("admin.loadError")} ${detail}`, "error");
    window.setRestaurantConnectionStatus?.("reachable");
  }
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) await supabase.realtime.setAuth(sessionData.session.access_token);
  if (liveChannel) await supabase.removeChannel(liveChannel);
  liveChannel = supabase.channel("staff-orders-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => loadOrders().catch(() => {}))
    .on("postgres_changes", { event: "*", schema: "public", table: "menu_items" }, () => loadMenu().catch(() => {}))
    .subscribe();
}

function openMenuEditor(item = null) {
  editingMenuItemId = item?.id || null;
  $("#menu-dialog-title").textContent = item ? "تعديل صنف المنيو" : "إضافة صنف جديد";
  $("#menu-name").value = item?.name || "";
  $("#menu-description").value = item?.description || "";
  $("#menu-price").value = item?.price ?? "";
  $("#menu-category").value = item?.category || "main";
  $("#menu-image").value = item?.image_url || "";
  $("#menu-image-file").value = "";
  pendingImageFile = null;
  $("#menu-available").checked = item?.active ?? true;
  showMessage($("#menu-form-message"), "");
  updateMenuImagePreview();
  menuDialog.showModal();
}

function updateMenuImagePreview() {
  const url = $("#menu-image").value.trim();
  const box = $("#menu-image-preview");
  const image = $("#menu-image-preview-img");
  const error = $("#menu-image-preview-error");
  if (imagePreviewObjectUrl) { URL.revokeObjectURL(imagePreviewObjectUrl); imagePreviewObjectUrl = null; }
  if (pendingImageFile) imagePreviewObjectUrl = URL.createObjectURL(pendingImageFile);
  const previewUrl = imagePreviewObjectUrl || (url ? directImageUrl(url) : "");
  if (!previewUrl) { box.hidden = true; image.removeAttribute("src"); return; }
  box.hidden = false;
  error.hidden = true;
  image.hidden = false;
  image.onload = () => { error.hidden = true; };
  image.onerror = () => { image.hidden = true; error.hidden = false; };
  if (!imagePreviewObjectUrl && !/^https?:\/\//i.test(previewUrl)) {
    image.removeAttribute("src");
    image.hidden = true;
    error.hidden = false;
    return;
  }
  image.src = previewUrl;
}

$("#signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  showMessage($("#signin-message"), t("admin.signin.working"));
  const { data, error } = await supabase.auth.signInWithPassword({ email: $("#staff-email").value.trim(), password: $("#staff-password").value });
  button.disabled = false;
  if (error) return showMessage($("#signin-message"), t("admin.signin.error"), "error");
  $("#staff-password").value = "";
  await startDashboard(data.user);
});

$("#signout-button").addEventListener("click", async () => {
  if (liveChannel) await supabase.removeChannel(liveChannel);
  await supabase.auth.signOut();
  window.setRestaurantConnectionStatus?.("reachable");
  $("#dashboard").hidden = true;
  $("#signin-panel").hidden = false;
  showMessage($("#signin-message"), t("admin.signout.done"));
});

$("#new-order-button").addEventListener("click", () => { resetOrder(); $("#customer-name").focus(); });
$("#add-menu-item").addEventListener("click", () => openMenuEditor());
$("#close-menu-dialog").addEventListener("click", () => menuDialog.close());
$("#cancel-menu-dialog").addEventListener("click", () => menuDialog.close());
$("#menu-image").addEventListener("input", () => {
  if ($("#menu-image").value.trim()) {
    pendingImageFile = null;
    $("#menu-image-file").value = "";
  }
  updateMenuImagePreview();
});
$("#menu-image-file").addEventListener("change", () => {
  const file = $("#menu-image-file").files[0] || null;
  if (file && (!/^image\/(jpeg|png|webp|avif)$/.test(file.type) || file.size > 5 * 1024 * 1024)) {
    pendingImageFile = null;
    $("#menu-image-file").value = "";
    return showMessage($("#menu-form-message"), "اختر صورة JPG أو PNG أو WebP أو AVIF بحجم أقل من 5 ميغابايت.", "error");
  }
  pendingImageFile = file;
  showMessage($("#menu-form-message"), "");
  updateMenuImagePreview();
});
$("#order-filter").addEventListener("change", renderOrders);
$("#service-type").addEventListener("change", updateTableVisibility);
$("#prep-minus").addEventListener("click", () => { prepMinutes = Math.max(5, prepMinutes - 5); $("#prep-value").value = prepMinutes; });
$("#prep-plus").addEventListener("click", () => { prepMinutes = Math.min(240, prepMinutes + 5); $("#prep-value").value = prepMinutes; });

$("#menu-categories").addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  categoryFilter = button.dataset.category;
  renderMenu();
});

$("#menu-grid").addEventListener("click", (event) => {
  const add = event.target.closest("[data-add-menu]");
  if (add) {
    const id = add.dataset.addMenu;
    cart.set(id, Math.min(99, (cart.get(id) || 0) + 1));
    renderCart();
    return;
  }
  const edit = event.target.closest("[data-edit-menu]");
  if (edit) openMenuEditor(menuItems.find((item) => item.id === edit.dataset.editMenu));
});

$("#cart-items").addEventListener("click", (event) => {
  const remove = event.target.closest("[data-cart-remove]");
  if (remove) cart.delete(remove.dataset.cartRemove);
  const change = event.target.closest("[data-cart-change]");
  if (change) {
    const id = change.dataset.id;
    const next = (cart.get(id) || 0) + Number(change.dataset.cartChange);
    if (next < 1) cart.delete(id); else cart.set(id, Math.min(99, next));
  }
  renderCart();
});

menuForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#save-menu-item");
  button.disabled = true;
  showMessage($("#menu-form-message"), "جارٍ حفظ الصنف…");
  const imageUrl = directImageUrl($("#menu-image").value.trim());
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    button.disabled = false;
    return showMessage($("#menu-form-message"), "رابط الصورة يجب أن يبدأ بـ https:// أو http://", "error");
  }
  const item = {
    name: $("#menu-name").value.trim(), description: $("#menu-description").value.trim() || null,
    price: Number($("#menu-price").value), category: $("#menu-category").value,
    image_url: imageUrl || null, active: $("#menu-available").checked,
    position: editingMenuItemId ? undefined : menuItems.length + 1
  };
  let uploadedPath = null;
  if (pendingImageFile) {
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" }[pendingImageFile.type];
    uploadedPath = `${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from("menu-images").upload(uploadedPath, pendingImageFile, {
      cacheControl: "31536000", contentType: pendingImageFile.type, upsert: false
    });
    if (uploadError) {
      button.disabled = false;
      const detail = uploadError.message.toLowerCase().includes("bucket")
        ? "شغّل ملف supabase/migrations/20261024040000_menu_image_storage.sql في Supabase SQL Editor أولاً."
        : uploadError.message;
      return showMessage($("#menu-form-message"), `تعذر رفع الصورة: ${detail}`, "error");
    }
    item.image_url = supabase.storage.from("menu-images").getPublicUrl(uploadedPath).data.publicUrl;
  }
  let result;
  if (editingMenuItemId) result = await supabase.from("menu_items").update(item).eq("id", editingMenuItemId);
  else result = await supabase.from("menu_items").insert({ ...item, slug: `menu-${crypto.randomUUID()}` });
  button.disabled = false;
  if (result.error) {
    if (uploadedPath) await supabase.storage.from("menu-images").remove([uploadedPath]);
    return showMessage($("#menu-form-message"), `تعذر حفظ الصنف: ${result.error.message}`, "error");
  }
  if (imagePreviewObjectUrl) { URL.revokeObjectURL(imagePreviewObjectUrl); imagePreviewObjectUrl = null; }
  pendingImageFile = null;
  menuDialog.close();
  await loadMenu();
  showMessage($("#dashboard-message"), "تم حفظ صنف المنيو.", "success");
});

$("#submit-order").addEventListener("click", async () => {
  const customerName = $("#customer-name").value.trim();
  const serviceType = $("#service-type").value;
  const tableNumber = serviceType === "dine_in" ? Number($("#table-number").value) : null;
  const items = [...cart.entries()].map(([menu_item_id, quantity]) => ({ menu_item_id, quantity }));
  if (!customerName) return showMessage($("#order-form-message"), "أدخل اسم الزبون.", "error");
  if (serviceType === "dine_in" && (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 999)) return showMessage($("#order-form-message"), "أدخل رقم الطاولة.", "error");
  if (!items.length) return showMessage($("#order-form-message"), "أضف صنفاً واحداً على الأقل.", "error");
  const button = $("#submit-order");
  button.disabled = true;
  showMessage($("#order-form-message"), "جارٍ حفظ الطلب…");
  const { data, error } = await supabase.functions.invoke("create-order", {
    body: { items, customer_name: customerName, service_type: serviceType, table_number: tableNumber, notes: $("#cart-notes").value.trim(), estimated_prep_minutes: prepMinutes }
  });
  button.disabled = false;
  if (error) return showMessage($("#order-form-message"), await functionErrorMessage(error, "admin.create.error"), "error");
  if (!data?.order) return showMessage($("#order-form-message"), data?.error || t("admin.create.error"), "error");
  openReceipt(data.order, data.access_code);
  resetOrder();
  $("#order-filter").value = "active";
  recentlyCreatedOrderId = data.order.id;
  showMessage($("#dashboard-message"), `${t("admin.create.success")} #${String(data.order.order_number).padStart(3, "0")}`, "success");
  await loadOrders();
});

$("#clear-orders-button").addEventListener("click", () => {
  showMessage($("#clear-orders-message"), "");
  clearOrdersDialog.showModal();
});

$("#confirm-clear-orders").addEventListener("click", async () => {
  const confirmButton = $("#confirm-clear-orders");
  const cancelButton = $("#cancel-clear-orders");
  confirmButton.disabled = true;
  cancelButton.disabled = true;
  confirmButton.textContent = t("admin.clearOrders.working");
  showMessage($("#clear-orders-message"), t("admin.clearOrders.working"));
  try {
    const { data, error } = await supabase.functions.invoke("clear-orders", { body: { confirm: true } });
    if (error || data?.error) {
      const detail = error
        ? await functionErrorMessage(error, "admin.clearOrders.error")
        : t("admin.clearOrders.error");
      showMessage($("#clear-orders-message"), detail, "error");
      return;
    }
    clearOrdersDialog.close();
    $("#order-filter").value = "active";
    await loadOrders();
    const count = new Intl.NumberFormat(document.documentElement.lang || "ar").format(Number(data?.deleted_orders) || 0);
    showMessage($("#dashboard-message"), t("admin.clearOrders.success").replace("{count}", count), "success");
  } catch (_) {
    showMessage($("#clear-orders-message"), t("admin.clearOrders.error"), "error");
  } finally {
    confirmButton.disabled = false;
    cancelButton.disabled = false;
    confirmButton.textContent = t("admin.clearOrders.confirm");
  }
});

list.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "cancelled" && !window.confirm(t("action.confirmCancel"))) return;
  button.disabled = true;
  const { data, error } = await supabase.functions.invoke("transition-order", { body: { order_id: button.dataset.id, next_status: button.dataset.action } });
  if (error || data?.error) {
    button.disabled = false;
    return showMessage($("#dashboard-message"), error ? await functionErrorMessage(error, "admin.updateError") : data?.error || t("admin.updateError"), "error");
  }
  await loadOrders();
});

const { data: initialSession } = await supabase.auth.getSession();
if (initialSession.session) {
  const { data: userData } = await supabase.auth.getUser();
  if (userData.user) await startDashboard(userData.user);
}
supabase.auth.onAuthStateChange((_event, session) => {
  if (!session && !$("#signin-panel").hidden) return;
  if (!session) { $("#dashboard").hidden = true; $("#signin-panel").hidden = false; }
});
