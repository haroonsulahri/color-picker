(() => {
  "use strict";

  const DEFAULT_SETTINGS = {
    defaultFormat: "hex",
    copyOnClick: true,
    showAlpha: true,
    rememberRecents: true,
    recentLimit: 12,
    keepOverlayOpen: true,
    theme: "system"
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    session: null,
    recents: [],
    favorites: [],
    activeTab: null
  };

  const dom = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheDom();
    bindEvents();
    await refresh();
    await autoStartPicker();
  }

  function cacheDom() {
    dom.statusText = document.getElementById("statusText");
    dom.startBtn = document.getElementById("startBtn");
    dom.stopBtn = document.getElementById("stopBtn");
    dom.favoriteCurrentBtn = document.getElementById("favoriteCurrentBtn");
    dom.primaryPreview = document.getElementById("primaryPreview");
    dom.selectionTitle = document.getElementById("selectionTitle");
    dom.copyValue = document.getElementById("copyValue");
    dom.copyButtons = Array.from(document.querySelectorAll(".copy-format"));
    dom.swatches = {
      text: document.querySelector("[data-swatch='text']"),
      background: document.querySelector("[data-swatch='background']"),
      border: document.querySelector("[data-swatch='border']")
    };
    dom.favoritesList = document.getElementById("favoritesList");
    dom.recentsList = document.getElementById("recentsList");
    dom.clearFavoritesBtn = document.getElementById("clearFavoritesBtn");
    dom.clearRecentsBtn = document.getElementById("clearRecentsBtn");
    dom.defaultFormat = document.getElementById("defaultFormat");
    dom.copyOnClick = document.getElementById("copyOnClick");
    dom.showAlpha = document.getElementById("showAlpha");
    dom.rememberRecents = document.getElementById("rememberRecents");
    dom.recentLimit = document.getElementById("recentLimit");
    dom.keepOverlayOpen = document.getElementById("keepOverlayOpen");
    dom.theme = document.getElementById("theme");
  }

  function bindEvents() {
    dom.startBtn.addEventListener("click", async () => {
      try {
        await send("START_PICKER");
        await refresh("Picker started on this tab.");
      } catch (error) {
        setStatus(toMessage(error), true);
      }
    });

    dom.stopBtn.addEventListener("click", async () => {
      try {
        await send("STOP_PICKER");
        await refresh("Picker stopped.");
      } catch (error) {
        setStatus(toMessage(error), true);
      }
    });

    dom.copyButtons.forEach((button) => {
      button.addEventListener("click", async () => {
        const selection = state.session && state.session.selection;
        const primary = selection && selection.primary;
        if (!primary) {
          return;
        }

        const text = formatColor(primary, button.dataset.format || "hex", state.settings.showAlpha);
        const ok = await copyText(text);
        setStatus(ok ? `${(button.dataset.format || "hex").toUpperCase()} copied.` : "Clipboard unavailable.", !ok);
        renderCurrentSelection();
      });
    });

    dom.favoriteCurrentBtn.addEventListener("click", async () => {
      const selection = state.session && state.session.selection;
      if (!selection || !selection.primary) {
        return;
      }

      try {
        const response = await send("TOGGLE_FAVORITE", { selection });
        state.favorites = response.favorites || [];
        state.recents = response.recents || state.recents;
        renderSavedLists();
        renderCurrentSelection();
      } catch (error) {
        setStatus(toMessage(error), true);
      }
    });

    dom.clearFavoritesBtn.addEventListener("click", async () => {
      const response = await send("CLEAR_HISTORY", { scope: "favorites" });
      state.favorites = response.favorites || [];
      renderSavedLists();
      setStatus("Favorites cleared.");
    });

    dom.clearRecentsBtn.addEventListener("click", async () => {
      const response = await send("CLEAR_HISTORY", { scope: "recents" });
      state.recents = response.recents || [];
      renderSavedLists();
      setStatus("Recent colors cleared.");
    });

    dom.defaultFormat.addEventListener("change", handleSettingsChange);
    dom.copyOnClick.addEventListener("change", handleSettingsChange);
    dom.showAlpha.addEventListener("change", handleSettingsChange);
    dom.rememberRecents.addEventListener("change", handleSettingsChange);
    dom.recentLimit.addEventListener("change", handleSettingsChange);
    dom.keepOverlayOpen.addEventListener("change", handleSettingsChange);
    dom.theme.addEventListener("change", handleSettingsChange);
  }

  async function handleSettingsChange() {
    const payload = {
      defaultFormat: dom.defaultFormat.value,
      copyOnClick: dom.copyOnClick.checked,
      showAlpha: dom.showAlpha.checked,
      rememberRecents: dom.rememberRecents.checked,
      recentLimit: Number(dom.recentLimit.value),
      keepOverlayOpen: dom.keepOverlayOpen.checked,
      theme: dom.theme.value
    };

    const response = await send("UPDATE_SETTINGS", { settings: payload });
    state.settings = response.settings || state.settings;
    applyTheme();
    renderSettings();
    renderCurrentSelection();
  }

  async function refresh(message) {
    const response = await send("GET_STATE");
    state.settings = { ...DEFAULT_SETTINGS, ...(response.settings || {}) };
    state.session = response.session || null;
    state.recents = Array.isArray(response.recents) ? response.recents : [];
    state.favorites = Array.isArray(response.favorites) ? response.favorites : [];
    state.activeTab = response.activeTab || null;

    applyTheme();
    renderState();

    if (message) {
      setStatus(message);
    }
  }

  function renderState() {
    renderSettings();
    renderCurrentSelection();
    renderSavedLists();

    const supported = state.activeTab && state.activeTab.supported;
    const isPicking = state.session && state.session.isPicking && state.session.tabId === (state.activeTab && state.activeTab.id);

    dom.startBtn.disabled = !supported;
    dom.stopBtn.classList.toggle("hidden", !isPicking);
    dom.startBtn.classList.toggle("hidden", isPicking);

    if (!state.activeTab) {
      setStatus("Open a webpage tab to start picking.", true);
      return;
    }

    if (!supported) {
      setStatus("This page type is blocked by Chrome. Open a regular website or local file.", true);
      return;
    }

    if (!isPicking) {
      setStatus("Ready to inspect this page.");
    } else if (state.session && state.session.selection && state.session.selection.primary) {
      setStatus("Picker active. Selection locked on the page.");
    } else {
      setStatus("Picker active. Hover or click on the page overlay.");
    }
  }

  function renderSettings() {
    dom.defaultFormat.value = state.settings.defaultFormat;
    dom.copyOnClick.checked = Boolean(state.settings.copyOnClick);
    dom.showAlpha.checked = Boolean(state.settings.showAlpha);
    dom.rememberRecents.checked = Boolean(state.settings.rememberRecents);
    dom.recentLimit.value = String(state.settings.recentLimit);
    dom.keepOverlayOpen.checked = Boolean(state.settings.keepOverlayOpen);
    dom.theme.value = state.settings.theme;
  }

  function renderCurrentSelection() {
    const selection = state.session && state.session.selection;
    const primary = selection && selection.primary;

    if (!primary) {
      dom.primaryPreview.style.background = "";
      dom.selectionTitle.textContent = "No color selected";
      dom.copyValue.textContent = "Open the page and click a color.";
      dom.copyButtons.forEach((button) => {
        button.disabled = true;
      });
      renderSwatch("text", null);
      renderSwatch("background", null);
      renderSwatch("border", null);
      dom.favoriteCurrentBtn.disabled = true;
      dom.favoriteCurrentBtn.classList.remove("active");
      return;
    }

    dom.primaryPreview.style.background = formatRgb(primary);
    dom.selectionTitle.textContent = selection.elementMeta ? selection.elementMeta.label : "Locked color";
    dom.copyValue.textContent = formatColor(primary, state.settings.defaultFormat, state.settings.showAlpha);
    dom.copyButtons.forEach((button) => {
      button.disabled = false;
    });
    renderSwatch("text", selection.text);
    renderSwatch("background", selection.background);
    renderSwatch("border", selection.border);

    const key = entryKey(primary, selection.primary.label || selection.primary.source || "primary");
    const isFavorite = state.favorites.some((item) => item.entryKey === key);
    dom.favoriteCurrentBtn.disabled = false;
    dom.favoriteCurrentBtn.classList.toggle("active", isFavorite);
  }

  function renderSwatch(name, color) {
    const node = dom.swatches[name];
    if (!node) {
      return;
    }

    const preview = node.querySelector(".swatch-preview");
    const value = node.querySelector(".swatch-value");

    if (!color) {
      preview.style.background = "";
      value.textContent = "Unavailable";
      return;
    }

    preview.style.background = formatRgb(color);
    value.textContent = formatColor(color, "hex", state.settings.showAlpha);
  }

  function renderSavedLists() {
    renderEntryList(dom.favoritesList, state.favorites, "No favorites saved.");
    renderEntryList(dom.recentsList, state.recents, "No recent colors yet.");
  }

  function renderEntryList(container, items, emptyText) {
    if (!items.length) {
      container.className = "saved-list empty-list";
      container.textContent = emptyText;
      return;
    }

    container.className = "saved-list";
    const fragment = document.createDocumentFragment();

    items.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "saved-entry";
      button.innerHTML = `
        <span class="saved-main">
          <span class="saved-preview"></span>
          <span>
            <strong>${escapeHtml(entry.formats ? entry.formats[state.settings.defaultFormat] || entry.formats.hex : "Unknown")}</strong>
            <span class="saved-subtext">${escapeHtml(entry.sourceLabel || "Saved color")}</span>
          </span>
        </span>
        <span class="saved-copy">Copy</span>
      `;

      button.querySelector(".saved-preview").style.background = formatRgb(entry.color);
      button.addEventListener("click", async () => {
        const text = entry.formats ? entry.formats[state.settings.defaultFormat] || entry.formats.hex : formatColor(entry.color, state.settings.defaultFormat, state.settings.showAlpha);
        const ok = await copyText(text);
        setStatus(ok ? "Color copied." : "Clipboard unavailable.", !ok);
      });

      fragment.appendChild(button);
    });

    container.replaceChildren(fragment);
  }

  function applyTheme() {
    let theme = state.settings.theme;
    if (theme === "system") {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
  }

  function setStatus(text, isError) {
    dom.statusText.textContent = text;
    dom.statusText.dataset.error = isError ? "true" : "false";
  }

  async function send(type, extra) {
    const response = await chrome.runtime.sendMessage({ type, ...(extra || {}) });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Request failed.");
    }
    return response;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "readonly");
      input.style.position = "fixed";
      input.style.left = "-9999px";
      document.body.appendChild(input);
      input.select();

      let success = false;
      try {
        success = document.execCommand("copy");
      } catch (_) {
        success = false;
      }

      input.remove();
      return success;
    }
  }

  function formatColor(color, format, showAlpha) {
    if (format === "rgb") {
      return formatRgb(color);
    }
    if (format === "hsl") {
      return formatHsl(color);
    }
    return formatHex(color, showAlpha);
  }

  function formatHex(color, showAlpha) {
    const head = [color.r, color.g, color.b].map(toHex).join("");
    if (showAlpha && color.a < 1) {
      return `#${head}${toHex(Math.round(color.a * 255))}`;
    }
    return `#${head}`;
  }

  function formatRgb(color) {
    if (color.a < 1) {
      return `rgba(${color.r}, ${color.g}, ${color.b}, ${trimAlpha(color.a)})`;
    }
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }

  function formatHsl(color) {
    const hsl = rgbToHsl(color.r, color.g, color.b);
    if (color.a < 1) {
      return `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${trimAlpha(color.a)})`;
    }
    return `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
  }

  function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;

    if (delta !== 0) {
      s = delta / (1 - Math.abs(2 * l - 1));
      if (max === rn) {
        h = 60 * (((gn - bn) / delta) % 6);
      } else if (max === gn) {
        h = 60 * ((bn - rn) / delta + 2);
      } else {
        h = 60 * ((rn - gn) / delta + 4);
      }
    }

    if (h < 0) {
      h += 360;
    }

    return {
      h: Math.round(h),
      s: Math.round(s * 100),
      l: Math.round(l * 100)
    };
  }

  function entryKey(color, role) {
    return [role || "primary", color.r, color.g, color.b, Math.round(color.a * 1000)].join(":");
  }

  function toHex(value) {
    return Number(value).toString(16).padStart(2, "0").toUpperCase();
  }

  function trimAlpha(value) {
    return Number(Number(value).toFixed(3)).toString();
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toMessage(error) {
    if (!error) {
      return "Unknown error";
    }
    return typeof error === "string" ? error : error.message || String(error);
  }

  async function autoStartPicker() {
    const supported = state.activeTab && state.activeTab.supported;
    const isPicking = state.session && state.session.isPicking && state.session.tabId === (state.activeTab && state.activeTab.id);

    if (!supported || isPicking) {
      return;
    }

    try {
      await send("START_PICKER");
      await refresh("Picker started on this tab.");
    } catch (error) {
      setStatus(toMessage(error), true);
    }
  }
})();

