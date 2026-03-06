"use strict";

const STORAGE_KEYS = {
  settings: "hcpSettings",
  recents: "hcpRecents",
  favorites: "hcpFavorites"
};

const DEFAULT_SETTINGS = Object.freeze({
  defaultFormat: "hex",
  copyOnClick: true,
  showAlpha: true,
  rememberRecents: true,
  recentLimit: 12,
  keepOverlayOpen: true,
  theme: "system"
});

let sessionState = {
  tabId: null,
  isPicking: false,
  selection: null,
  lastError: "",
  activeUrl: ""
};

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaults();
});

chrome.runtime.onStartup?.addListener(() => {
  void ensureDefaults();
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "start-picker") {
    return;
  }

  void startPickerOnActiveTab();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessionState.tabId === tabId) {
    clearSession();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (sessionState.tabId !== tabId) {
    return;
  }

  if (changeInfo.status === "loading") {
    sessionState = {
      tabId,
      isPicking: false,
      selection: null,
      lastError: "",
      activeUrl: tab.url || ""
    };
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: toMessage(error) }));

  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "GET_STATE":
      return getState();
    case "GET_SETTINGS":
      return { settings: await getSettings() };
    case "START_PICKER":
      return startPickerOnActiveTab();
    case "STOP_PICKER":
      return stopPickerOnActiveTab();
    case "UPDATE_SETTINGS":
      return { settings: await updateSettings(message.settings || {}) };
    case "TOGGLE_FAVORITE":
      return toggleFavorite(message.entry || message.selection || null);
    case "CLEAR_HISTORY":
      return clearSaved(message.scope || "recents");
    case "PICKER_REQUEST_CAPTURE":
      return requestCaptureForSender(sender);
    case "PICKER_ENABLED":
      return handlePickerEnabled(sender, message);
    case "PICKER_SELECTION_LOCKED":
      return handleSelectionLocked(sender, message.selection);
    case "PICKER_SELECTION_RESET":
      return handleSelectionReset(sender);
    case "PICKER_EXITED":
      return handlePickerExited(sender);
    default:
      throw new Error("Unsupported message type.");
  }
}

async function ensureDefaults() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!stored[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: DEFAULT_SETTINGS });
  }
}

async function getState() {
  const [settings, recents, favorites, tab] = await Promise.all([
    getSettings(),
    getRecents(),
    getFavorites(),
    getActiveTab()
  ]);

  const isSupported = isSupportedUrl(tab && tab.url);
  return {
    settings,
    recents,
    favorites,
    session: {
      ...sessionState,
      activeUrl: (tab && tab.url) || sessionState.activeUrl
    },
    activeTab: tab
      ? {
          id: tab.id,
          url: tab.url || "",
          title: tab.title || "",
          supported: isSupported
        }
      : null
  };
}

async function startPickerOnActiveTab() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    throw new Error("No active tab available.");
  }

  if (!isSupportedUrl(tab.url)) {
    clearSession();
    throw new Error("Chrome blocks extensions on this page type.");
  }

  const settings = await getSettings();
  const capture = await captureForTab(tab);

  sessionState.tabId = tab.id;
  sessionState.isPicking = true;
  sessionState.lastError = "";
  sessionState.activeUrl = tab.url || "";

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"]
  });

  await sendToTab(tab.id, {
    type: "PICKER_ENABLE",
    settings,
    selection: sessionState.selection,
    capture
  });

  return getState();
}

async function stopPickerOnActiveTab() {
  const tab = await getActiveTab();
  const tabId = sessionState.tabId || (tab && tab.id);

  if (tabId) {
    try {
      await sendToTab(tabId, { type: "PICKER_DISABLE" });
    } catch (_) {}
  }

  clearSession();
  return getState();
}

async function requestCaptureForSender(sender) {
  if (!sender.tab || !sender.tab.id) {
    throw new Error("No sender tab available for capture.");
  }

  return {
    capture: await captureForTab(sender.tab)
  };
}

async function captureForTab(tab) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return {
      dataUrl,
      capturedAt: Date.now()
    };
  } catch (error) {
    throw new Error(toMessage(error) || "Unable to capture the current page.");
  }
}

async function handlePickerEnabled(sender, message) {
  sessionState.tabId = sender.tab ? sender.tab.id : sessionState.tabId;
  sessionState.isPicking = true;
  sessionState.lastError = "";
  sessionState.activeUrl = (sender.tab && sender.tab.url) || sessionState.activeUrl;

  sessionState.selection = message && message.selection ? sanitizeSelection(message.selection) : null;

  return { session: sessionState };
}

async function handleSelectionLocked(sender, selection) {
  const sanitized = sanitizeSelection(selection);
  sessionState.tabId = sender.tab ? sender.tab.id : sessionState.tabId;
  sessionState.isPicking = true;
  sessionState.selection = sanitized;
  sessionState.activeUrl = (sender.tab && sender.tab.url) || sessionState.activeUrl;
  sessionState.lastError = "";

  if (sanitized && sanitized.primary) {
    const settings = await getSettings();
    if (settings.rememberRecents) {
      await addRecentEntry(sanitized, settings);
    }
  }

  return {
    session: sessionState,
    recents: await getRecents(),
    favorites: await getFavorites()
  };
}

async function handleSelectionReset(sender) {
  sessionState.tabId = sender.tab ? sender.tab.id : sessionState.tabId;
  sessionState.isPicking = true;
  sessionState.selection = null;
  sessionState.activeUrl = (sender.tab && sender.tab.url) || sessionState.activeUrl;
  sessionState.lastError = "";

  return { session: sessionState };
}

async function handlePickerExited(sender) {
  if (!sender.tab || sessionState.tabId === sender.tab.id) {
    sessionState.isPicking = false;
  }

  return { session: sessionState };
}

async function updateSettings(nextSettings) {
  const merged = {
    ...(await getSettings()),
    ...sanitizeSettings(nextSettings)
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: merged });

  if (sessionState.tabId && sessionState.isPicking) {
    try {
      await sendToTab(sessionState.tabId, {
        type: "PICKER_ENABLE",
        settings: merged,
        selection: sessionState.selection
      });
    } catch (_) {}
  }

  const recents = await getRecents();
  const limited = recents.slice(0, merged.recentLimit);
  if (limited.length !== recents.length) {
    await chrome.storage.local.set({ [STORAGE_KEYS.recents]: limited });
  }

  return merged;
}

async function toggleFavorite(input) {
  const candidate = normalizeFavoritePayload(input);
  if (!candidate) {
    throw new Error("No color available to favorite.");
  }

  const favorites = await getFavorites();
  const matchIndex = favorites.findIndex((entry) => entry.entryKey === candidate.entryKey);

  if (matchIndex >= 0) {
    favorites.splice(matchIndex, 1);
  } else {
    favorites.unshift(candidate);
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.favorites]: favorites });

  return {
    favorites,
    recents: await getRecents()
  };
}

async function clearSaved(scope) {
  if (scope === "favorites") {
    await chrome.storage.local.set({ [STORAGE_KEYS.favorites]: [] });
  } else if (scope === "all") {
    await chrome.storage.local.set({
      [STORAGE_KEYS.recents]: [],
      [STORAGE_KEYS.favorites]: []
    });
  } else {
    await chrome.storage.local.set({ [STORAGE_KEYS.recents]: [] });
  }

  return {
    recents: await getRecents(),
    favorites: await getFavorites()
  };
}

async function addRecentEntry(selection, settings) {
  if (!selection.primary) {
    return;
  }

  const entry = buildHistoryEntry(selection.primary, selection.elementMeta, settings);
  const recents = await getRecents();
  const filtered = recents.filter((item) => item.entryKey !== entry.entryKey);
  filtered.unshift(entry);
  const limited = filtered.slice(0, settings.recentLimit);
  await chrome.storage.local.set({ [STORAGE_KEYS.recents]: limited });
}

function buildHistoryEntry(color, elementMeta, settings) {
  const formats = buildFormats(color, settings);
  const sourceLabel = elementMeta && elementMeta.label ? elementMeta.label : "Selected color";
  const sourceRole = color.label || color.source || "primary";
  const entryKey = colorKey(color, sourceRole);

  return {
    id: `${entryKey}-${Date.now()}`,
    entryKey,
    color,
    formats,
    sourceLabel,
    sourceRole,
    createdAt: Date.now()
  };
}

function normalizeFavoritePayload(input) {
  if (!input) {
    return null;
  }

  if (input.color && input.entryKey) {
    return input;
  }

  if (input.primary) {
    const color = sanitizeColor(input.primary);
    if (!color) {
      return null;
    }

    return {
      ...buildHistoryEntry(color, input.elementMeta || null, DEFAULT_SETTINGS)
    };
  }

  return null;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.settings] || {})
  };
}

async function getRecents() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.recents);
  return Array.isArray(stored[STORAGE_KEYS.recents]) ? stored[STORAGE_KEYS.recents] : [];
}

async function getFavorites() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.favorites);
  return Array.isArray(stored[STORAGE_KEYS.favorites]) ? stored[STORAGE_KEYS.favorites] : [];
}

function sanitizeSettings(value) {
  const next = {};

  if (value.defaultFormat === "hex" || value.defaultFormat === "rgb" || value.defaultFormat === "hsl") {
    next.defaultFormat = value.defaultFormat;
  }

  if (typeof value.copyOnClick === "boolean") {
    next.copyOnClick = value.copyOnClick;
  }

  if (typeof value.showAlpha === "boolean") {
    next.showAlpha = value.showAlpha;
  }

  if (typeof value.rememberRecents === "boolean") {
    next.rememberRecents = value.rememberRecents;
  }

  if (Number.isFinite(value.recentLimit)) {
    next.recentLimit = clamp(Math.round(value.recentLimit), 5, 50);
  }

  if (typeof value.keepOverlayOpen === "boolean") {
    next.keepOverlayOpen = value.keepOverlayOpen;
  }

  if (value.theme === "system" || value.theme === "light" || value.theme === "dark") {
    next.theme = value.theme;
  }

  return next;
}

function sanitizeSelection(selection) {
  if (!selection || typeof selection !== "object") {
    return null;
  }

  return {
    primary: sanitizeColor(selection.primary),
    text: sanitizeColor(selection.text),
    background: sanitizeColor(selection.background),
    border: sanitizeColor(selection.border),
    notes: Array.isArray(selection.notes) ? selection.notes.slice(0, 4).map(String) : [],
    elementMeta: selection.elementMeta
      ? {
          tagName: String(selection.elementMeta.tagName || ""),
          id: String(selection.elementMeta.id || ""),
          className: String(selection.elementMeta.className || ""),
          label: String(selection.elementMeta.label || ""),
          path: String(selection.elementMeta.path || "")
        }
      : null
  };
}

function sanitizeColor(color) {
  if (!color || typeof color !== "object") {
    return null;
  }

  const r = clampChannel(color.r);
  const g = clampChannel(color.g);
  const b = clampChannel(color.b);
  const a = clampAlpha(color.a);

  return {
    r,
    g,
    b,
    a,
    label: String(color.label || ""),
    source: String(color.source || ""),
    cssText: String(color.cssText || "")
  };
}

function buildFormats(color, settings) {
  return {
    hex: formatHex(color, settings.showAlpha),
    rgb: formatRgb(color),
    hsl: formatHsl(color)
  };
}

function colorKey(color, role) {
  return [role || "primary", color.r, color.g, color.b, Math.round(color.a * 1000)].join(":");
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
  const l = (max + min) / 2;
  let s = 0;

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

function toHex(value) {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

function trimAlpha(value) {
  return Number(value.toFixed(3)).toString();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampChannel(value) {
  return clamp(Math.round(Number(value) || 0), 0, 255);
}

function clampAlpha(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 1;
  }
  return Math.min(1, Math.max(0, Number(num.toFixed(3))));
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function isSupportedUrl(url) {
  return Boolean(url) && /^(https?|file):/i.test(url);
}

async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function clearSession() {
  sessionState = {
    tabId: null,
    isPicking: false,
    selection: null,
    lastError: "",
    activeUrl: ""
  };
}

function toMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  return error.message || String(error);
}


