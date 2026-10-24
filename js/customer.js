import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const config = window.RESTAURANT_CONFIG;
const TOKEN_KEY = "restaurant-customer-tracking-token";
const supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, {
  auth: {
    storage: window.sessionStorage,
    storageKey: "restaurant-customer-auth",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

const $ = (selector) => document.querySelector(selector);
const form = $("#tracking-form");
const message = $("#customer-message");
const result = $("#tracking-result");
const t = (key) => window.restaurantTranslate?.(key) || key;
const stateKeys = { received: "status.received", preparing: "status.preparing", ready: "status.ready", delivered: "status.delivered", cancelled: "status.cancelled" };
const stateIcons = { received: "◷", preparing: "◌", ready: "✓", delivered: "▣", cancelled: "×" };
let activeOrder = null;
let polling = false;
let pollHandle;
let readyAudioContext = null;
let readySoundEnabled = false;
let readyAlarmInterval;
let readyAlarmDismissed = false;

function normalizeDigits(value) {
  return value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

function showMessage(text, kind = "info") {
  message.textContent = text;
  message.className = `form-message ${kind}`;
  message.hidden = !text;
}

function showForm() {
  form.hidden = false;
  result.hidden = true;
}

function formatTime(value) {
  if (!value) return "—";
  const locale = document.documentElement.lang || "ar";
  return new Intl.DateTimeFormat(locale, {
    timeZone: config.timeZone || "Africa/Algiers",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function renderOrder(order) {
  activeOrder = order;
  form.hidden = true;
  result.hidden = false;
  $("#result-order-number").textContent = `#${String(order.order_number).padStart(3, "0")}`;
  const status = $("#result-status");
  status.className = `status-pill status-${order.status}`;
  status.textContent = `${stateIcons[order.status] || "•"} ${t(stateKeys[order.status] || "customer.statusUnknown")}`;
  $("#result-prep").textContent = String(order.estimated_prep_minutes);
  $("#result-ready-at").textContent = formatTime(order.estimated_ready_at);
  $("#result-updated-at").textContent = formatTime(order.status_updated_at);

  const items = $("#result-items");
  items.replaceChildren();
  for (const item of order.items || []) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    const quantity = document.createElement("b");
    name.textContent = item.item_name;
    quantity.textContent = `× ${Number(item.quantity)}`;
    row.append(name, quantity);
    items.append(row);
  }

  const cancelled = order.status === "cancelled";
  const delivered = order.status === "delivered";
  const terminalMessage = $("#terminal-message");
  terminalMessage.hidden = !cancelled && !delivered;
  terminalMessage.className = `notice ${cancelled ? "notice-warning" : "notice-info"}`;
  terminalMessage.textContent = cancelled ? t("customer.cancelledMessage") : t("customer.deliveredMessage");

  const stages = ["received", "preparing", "ready", "delivered"];
  const currentIndex = stages.indexOf(order.status);
  document.querySelectorAll("#tracking-steps [data-step]").forEach((step) => {
    const index = stages.indexOf(step.dataset.step);
    step.classList.toggle("is-complete", !cancelled && currentIndex >= 0 && index < currentIndex);
    step.classList.toggle("is-current", !cancelled && index === currentIndex);
    step.hidden = cancelled && step.dataset.step === "delivered";
    if (step.classList.contains("is-current")) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
}

async function ensureAnonymousSession() {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const user = sessionData.session?.user;
  if (user?.is_anonymous) return user;
  if (user) await supabase.auth.signOut();
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) throw error || new Error("anonymous_sign_in_failed");
  return data.user;
}

async function readFunctionError(error) {
  try {
    if (error?.context instanceof Response) {
      const response = error.context;
      let body = {};
      try { body = await response.clone().json(); } catch (_) { /* Some gateway errors are plain text. */ }
      const reason = body?.diagnostic_code || body?.error || "request_failed";
      return `${reason} · HTTP ${response.status}`;
    }
  } catch (_) { /* Network failures have no JSON response. */ }
  return typeof error?.message === "string" ? error.message.slice(0, 120) : "network_error";
}

function showConnectionError(error) {
  const detail = error instanceof Error ? error.message : String(error || "network_error");
  console.error("Customer tracking request failed:", error);
  showMessage(`${t("customer.connectionError")} (${detail.slice(0, 140)})`, "error");
}

async function fetchCurrentOrder(token) {
  const { data, error } = await supabase.functions.invoke("get-tracking", {
    body: { tracking_token: token },
  });
  if (error) throw new Error(await readFunctionError(error));
  if (!data?.order) throw new Error("tracking_unavailable");
  return data.order;
}

async function refreshOrder({ notifyReady = false } = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token || polling) return;
  polling = true;
  try {
    await ensureAnonymousSession();
    const latest = await fetchCurrentOrder(token);
    const becameReady = notifyReady && latest.status === "ready" && activeOrder?.status !== "ready";
    renderOrder(latest);
    $("#ready-notice").hidden = latest.status !== "ready";
    if (becameReady) {
      readyAlarmDismissed = false;
      startReadyAlarm();
    }
    if (latest.status !== "ready") stopReadyAlarm();
    showMessage("");
  } catch (error) {
    if (error.message === "tracking_unavailable") {
      sessionStorage.removeItem(TOKEN_KEY);
      activeOrder = null;
      stopPolling();
      stopReadyAlarm();
      $("#ready-notice").hidden = true;
      showForm();
      showMessage(t("customer.expired"), "error");
    } else {
      if (!activeOrder) showForm();
      showConnectionError(error);
    }
  } finally {
    polling = false;
  }
}

async function enableReadySound() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const button = $("#enable-ready-sound");
  if (!AudioContextClass) {
    button.hidden = true;
    return false;
  }
  try {
    if (!readyAudioContext || readyAudioContext.state === "closed") readyAudioContext = new AudioContextClass();
    if (readyAudioContext.state !== "running") await readyAudioContext.resume();
    readySoundEnabled = readyAudioContext.state === "running";
    if (readySoundEnabled) {
      button.textContent = "تنبيه الجاهزية الصوتي مفعّل ✓";
      if (activeOrder?.status === "ready" && !readyAlarmDismissed) startReadyAlarm();
    }
    return readySoundEnabled;
  } catch (_) {
    readySoundEnabled = false;
    button.textContent = "اضغط لتفعيل تنبيه الجاهزية الصوتي";
    return false;
  }
}

function playReadyTone() {
  if (!readySoundEnabled || !readyAudioContext || readyAudioContext.state !== "running") return;
  try {
    const context = readyAudioContext;
    const now = context.currentTime;
    [740, 880, 740].forEach((frequency, index) => {
      const start = now + index * 0.2;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.09, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.17);
    });
    if (navigator.vibrate) navigator.vibrate([130, 70, 130]);
  } catch (_) { /* The visible ready notice remains available if audio is unavailable. */ }
}

function startReadyAlarm() {
  const stopButton = $("#stop-ready-alarm");
  if (readyAlarmDismissed) return;
  if (!readySoundEnabled || !readyAudioContext || readyAudioContext.state !== "running") {
    stopButton.hidden = true;
    return;
  }
  stopButton.hidden = false;
  if (readyAlarmInterval) return;
  playReadyTone();
  readyAlarmInterval = window.setInterval(playReadyTone, 1700);
}

function stopReadyAlarm({ dismissed = false } = {}) {
  if (readyAlarmInterval) window.clearInterval(readyAlarmInterval);
  readyAlarmInterval = undefined;
  if (dismissed) readyAlarmDismissed = true;
  const stopButton = $("#stop-ready-alarm");
  if (stopButton) stopButton.hidden = true;
}

function startPolling() {
  stopPolling();
  pollHandle = window.setInterval(() => refreshOrder({ notifyReady: true }), 12000);
}

function stopPolling() {
  if (pollHandle) window.clearInterval(pollHandle);
  pollHandle = undefined;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  void enableReadySound();
  const button = form.querySelector("button[type=submit]");
  const orderNumber = $("#order-number").value.trim();
  const accessCode = $("#access-code").value.trim();
  if (!/^\d{1,3}$/.test(orderNumber) || Number(orderNumber) < 1 || Number(orderNumber) > 999 || !/^\d{6}$/.test(accessCode)) {
    return showMessage(t("customer.invalid"), "error");
  }

  button.disabled = true;
  showMessage(t("customer.checking"));
  try {
    await ensureAnonymousSession();
    const { data, error } = await supabase.functions.invoke("verify-order", {
      body: { order_number: orderNumber, access_code: accessCode },
    });
    if (error) throw new Error(await readFunctionError(error));
    if (data?.error || !data?.tracking_token) throw new Error("verification_failed");
    sessionStorage.setItem(TOKEN_KEY, data.tracking_token);
    $("#access-code").value = "";
    await refreshOrder({ notifyReady: true });
    if (!result.hidden) startPolling();
  } catch (error) {
    if (error.message === "verification_failed") showMessage(t("customer.invalid"), "error");
    else showConnectionError(error);
  } finally {
    button.disabled = false;
  }
});

["#order-number", "#access-code"].forEach((selector) => {
  $(selector).addEventListener("input", (event) => {
    event.currentTarget.value = normalizeDigits(event.currentTarget.value).replace(/\D/g, "");
  });
});

$("#refresh-tracking").addEventListener("click", () => refreshOrder({ notifyReady: true }));
$("#enable-ready-sound").addEventListener("click", () => { void enableReadySound(); });
$("#stop-ready-alarm").addEventListener("click", () => stopReadyAlarm({ dismissed: true }));
$("#track-another").addEventListener("click", async () => {
  stopPolling();
  stopReadyAlarm();
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (token) {
    try { await supabase.functions.invoke("get-tracking", { body: { tracking_token: token, revoke: true } }); }
    catch (_) { /* The local session is still cleared; the server grant expires automatically. */ }
  }
  sessionStorage.removeItem(TOKEN_KEY);
  await supabase.auth.signOut();
  activeOrder = null;
  readyAlarmDismissed = false;
  $("#ready-notice").hidden = true;
  form.reset();
  showForm();
  showMessage("");
  $("#order-number").focus();
});

window.addEventListener("pagehide", () => {
  stopPolling();
  stopReadyAlarm();
  if (readyAudioContext?.state !== "closed") void readyAudioContext?.close();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshOrder({ notifyReady: true });
});
window.addEventListener("online", () => refreshOrder({ notifyReady: true }));
document.querySelector("[data-language-picker]")?.addEventListener("change", () => {
  if (activeOrder) renderOrder(activeOrder);
});

const savedToken = sessionStorage.getItem(TOKEN_KEY);
if (savedToken) {
  form.hidden = true;
  showMessage(t("customer.checking"));
  refreshOrder({ notifyReady: true }).then(() => { if (!result.hidden) startPolling(); });
}
