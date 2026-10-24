(function () {
  "use strict";

  const labels = {
    ar: { reachable: "قاعدة البيانات متاحة • دخول الكاشير مطلوب", staff: "متصل • بيانات الكاشير محمّلة", unavailable: "تعذر الاتصال بالمشروع" },
    fr: { reachable: "Base accessible • Connexion caisse requise", staff: "Connecté • données de caisse chargées", unavailable: "Projet inaccessible" },
    en: { reachable: "Database reachable • cashier sign-in required", staff: "Connected • cashier data loaded", unavailable: "Project unavailable" }
  };
  let currentState = "checking";
  let staffSessionActive = false;

  function renderStatus() {
    const chip = document.querySelector(".environment-chip");
    const indicator = document.querySelector("[data-connection-status]");
    if (!chip || !indicator) return;
    const locale = document.documentElement.lang || "ar";
    const words = labels[locale] || labels.ar;
    indicator.textContent = words[currentState] || words.unavailable;
    chip.dataset.connection = currentState === "staff" ? "reachable" : currentState;
  }

  window.setRestaurantConnectionStatus = (state) => {
    staffSessionActive = state === "staff";
    currentState = state === "staff" ? "staff" : state;
    renderStatus();
  };

  async function checkProject() {
    const config = window.RESTAURANT_CONFIG;
    if (!config || !config.supabaseUrl || !config.supabasePublishableKey ||
        config.supabaseUrl.includes("YOUR-PROJECT") || config.supabasePublishableKey.includes("YOUR-")) {
      currentState = "unavailable";
      renderStatus();
      return;
    }

    try {
      const response = await fetch(`${config.supabaseUrl}/auth/v1/settings`, {
        method: "GET",
        headers: { apikey: config.supabasePublishableKey },
        cache: "no-store"
      });
      if (!response.ok) throw new Error("Supabase endpoint returned an error");
      currentState = staffSessionActive ? "staff" : "reachable";
    } catch {
      currentState = "unavailable";
    }
    renderStatus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkProject, { once: true });
  } else {
    checkProject();
  }
  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-language-picker]")) renderStatus();
  });
})();
