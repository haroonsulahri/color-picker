(() => {
  "use strict";

  if (window.__HAROONE_COLOR_PICKER__) {
    window.__HAROONE_COLOR_PICKER__.reconnect();
    return;
  }

  const ROOT_ID = "haroone-color-picker-root";
  const STYLE_ID = "haroone-color-picker-style";
  const DEFAULT_SETTINGS = {
    defaultFormat: "hex",
    copyOnClick: true,
    showAlpha: true,
    keepOverlayOpen: true,
    theme: "system"
  };

  const state = {
    enabled: false,
    settings: { ...DEFAULT_SETTINGS },
    hoverPoint: null,
    lockedPoint: null,
    selection: null,
    capture: null,
    captureCanvas: null,
    captureContext: null,
    refreshTimer: null,
    refreshing: false,
    pendingRefresh: false,
    statusTimer: null
  };

  const dom = {};

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "PICKER_ENABLE") {
      enablePicker(message.settings || {}, message.selection || null, message.capture || null)
        .then(() => sendResponse({ ok: true, selection: state.selection }))
        .catch((error) => sendResponse({ ok: false, error: toMessage(error) }));
      return true;
    }

    if (message.type === "PICKER_DISABLE") {
      disablePicker(true);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  install();

  function install() {
    injectStyles();
    createOverlay();
    bindUi();
    window.__HAROONE_COLOR_PICKER__ = {
      reconnect() {
        ensureOverlay();
      }
    };
  }

  function ensureOverlay() {
    if (!document.getElementById(STYLE_ID)) {
      injectStyles();
    }
    if (!document.getElementById(ROOT_ID)) {
      createOverlay();
      bindUi();
    }
  }

  async function enablePicker(settings, selection, capture) {
    ensureOverlay();
    state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    state.enabled = true;
    state.hoverPoint = null;
    state.lockedPoint = null;
    state.selection = selection && selection.primary ? selection : null;
    state.refreshing = false;
    state.pendingRefresh = false;
    clearTimeout(state.refreshTimer);
    clearStatusTimer();
    applyTheme();

    if (capture && capture.dataUrl) {
      await loadCapture(capture);
    } else if (!state.captureContext) {
      await refreshCapture();
    }

    attachListeners();
    dom.root.hidden = false;
    dom.root.setAttribute("aria-hidden", "false");
    renderSelection(state.selection, Boolean(state.selection));

    await chrome.runtime.sendMessage({
      type: "PICKER_ENABLED",
      selection: state.selection
    });
  }

  function disablePicker(emitExit) {
    state.enabled = false;
    state.hoverPoint = null;
    state.lockedPoint = null;
    state.refreshing = false;
    state.pendingRefresh = false;
    clearTimeout(state.refreshTimer);
    clearStatusTimer();
    detachListeners();

    if (dom.root) {
      dom.root.hidden = true;
      dom.root.setAttribute("aria-hidden", "true");
    }

    if (dom.reticle) {
      dom.reticle.style.display = "none";
    }

    if (emitExit) {
      void chrome.runtime.sendMessage({ type: "PICKER_EXITED" });
    }
  }

  function attachListeners() {
    detachListeners();
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeydown, true);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange, true);
  }

  function detachListeners() {
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("keydown", handleKeydown, true);
    window.removeEventListener("scroll", handleViewportChange, true);
    window.removeEventListener("resize", handleViewportChange, true);
  }

  function handleMouseMove(event) {
    if (!state.enabled || state.lockedPoint) {
      return;
    }

    if (isOverlayInteractive(event.target)) {
      return;
    }

    const point = {
      x: event.clientX,
      y: event.clientY
    };

    state.hoverPoint = point;
    updateFromPoint(point, false);
  }

  function handleClick(event) {
    if (!state.enabled) {
      return;
    }

    if (isOverlayInteractive(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const point = state.hoverPoint || { x: event.clientX, y: event.clientY };
    state.lockedPoint = point;

    if (!updateFromPoint(point, true)) {
      state.lockedPoint = null;
      return;
    }

    void chrome.runtime.sendMessage({
      type: "PICKER_SELECTION_LOCKED",
      selection: state.selection
    });

    if (state.settings.copyOnClick && state.selection && state.selection.primary) {
      void copyCurrent(state.settings.defaultFormat);
    }
  }

  function handleKeydown(event) {
    if (!state.enabled) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      disablePicker(true);
      return;
    }

    if (event.key === "Enter" && state.selection && state.selection.primary) {
      event.preventDefault();
      void copyCurrent(state.settings.defaultFormat);
    }
  }

  function handleViewportChange() {
    if (!state.enabled) {
      return;
    }

    clearStatusTimer();
    setStatusText(state.lockedPoint ? "Refreshing locked sample..." : "Refreshing sampled view...", "default");

    scheduleCaptureRefresh();
  }

  function scheduleCaptureRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      state.pendingRefresh = true;
      void refreshCapture();
    }, 120);
  }

  async function refreshCapture() {
    if (!state.enabled) {
      return;
    }

    if (state.refreshing) {
      state.pendingRefresh = true;
      return;
    }

    state.refreshing = true;
    state.pendingRefresh = false;

    try {
      const response = await chrome.runtime.sendMessage({ type: "PICKER_REQUEST_CAPTURE" });
      if (!response || !response.ok || !response.capture || !response.capture.dataUrl) {
        throw new Error((response && response.error) || "Unable to refresh the page capture.");
      }

      await loadCapture(response.capture);
      const point = state.lockedPoint || state.hoverPoint;
      if (point) {
        updateFromPoint(point, Boolean(state.lockedPoint));
      } else {
        renderSelection(state.selection, Boolean(state.lockedPoint));
      }
    } catch (error) {
      clearStatusTimer();
      setStatusText(toMessage(error), "error");
    } finally {
      state.refreshing = false;
      if (state.pendingRefresh && state.enabled) {
        state.pendingRefresh = false;
        void refreshCapture();
      }
    }
  }

  async function loadCapture(capture) {
    if (!capture || !capture.dataUrl) {
      throw new Error("No screen capture was provided.");
    }

    const image = await loadImage(capture.dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);

    state.captureCanvas = canvas;
    state.captureContext = context;
    state.capture = {
      dataUrl: capture.dataUrl,
      width: canvas.width,
      height: canvas.height,
      capturedAt: capture.capturedAt || Date.now(),
      scaleX: canvas.width / Math.max(1, window.innerWidth),
      scaleY: canvas.height / Math.max(1, window.innerHeight)
    };
  }

  function updateFromPoint(point, locked) {
    const sample = samplePoint(point.x, point.y);
    if (!sample) {
      renderSelection(null, locked);
      return false;
    }

    state.selection = buildSelection(sample);
    renderSelection(state.selection, locked);
    positionReticle(point);
    positionPanel(point);
    renderZoom(sample);
    return true;
  }

  function samplePoint(clientX, clientY) {
    if (!state.captureContext || !state.capture) {
      return null;
    }

    const imageX = clamp(Math.round(clientX * state.capture.scaleX), 0, state.capture.width - 1);
    const imageY = clamp(Math.round(clientY * state.capture.scaleY), 0, state.capture.height - 1);
    const data = state.captureContext.getImageData(imageX, imageY, 1, 1).data;
    const alpha = clampAlpha(data[3] / 255);
    const color = {
      r: data[0],
      g: data[1],
      b: data[2],
      a: alpha,
      label: "Primary",
      source: "pixel",
      cssText: alpha < 1
        ? `rgba(${data[0]}, ${data[1]}, ${data[2]}, ${trimAlpha(alpha)})`
        : `rgb(${data[0]}, ${data[1]}, ${data[2]})`
    };

    return {
      clientX: Math.round(clientX),
      clientY: Math.round(clientY),
      imageX,
      imageY,
      color
    };
  }

  function buildSelection(sample) {
    const primary = sample.color;

    return {
      primary,
      text: null,
      background: {
        ...primary,
        label: "Sample"
      },
      border: null,
      notes: ["Pixel sampled from the visible page. Scroll or resize refreshes the zoom capture."],
      elementMeta: {
        tagName: "pixel",
        id: "",
        className: "",
        label: `Viewport ${sample.clientX}, ${sample.clientY}`,
        path: `Image pixel ${sample.imageX}, ${sample.imageY}`
      }
    };
  }

  function clearStatusTimer() {
    clearTimeout(state.statusTimer);
    state.statusTimer = null;
  }

  function getDefaultStatusText() {
    return state.lockedPoint && state.selection && state.selection.primary
      ? "Color locked. Choose a format or press Reset."
      : "Move over the page and click to lock a color";
  }

  function setStatusText(text, tone) {
    if (dom.status) {
      dom.status.textContent = text;
      dom.status.dataset.tone = tone || "default";
    }
  }

  function restoreStatusText() {
    clearStatusTimer();
    setStatusText(
      getDefaultStatusText(),
      state.lockedPoint && state.selection && state.selection.primary ? "locked" : "default"
    );
  }

  function flashStatus(text, delay, tone) {
    clearStatusTimer();
    setStatusText(text, tone || "default");

    if (!delay) {
      return;
    }

    state.statusTimer = setTimeout(() => {
      state.statusTimer = null;
      if (state.enabled) {
        restoreStatusText();
      }
    }, delay);
  }

  function renderSelection(selection, locked) {
    const active = selection && selection.primary;
    const isLocked = Boolean(locked && active);
    const baseNote = selection && selection.notes && selection.notes.length
      ? selection.notes[0]
      : "Pixel sampled from the visible page.";

    restoreStatusText();
    dom.hint.textContent = active ? formatHex(active, state.settings.showAlpha) : "Move over the page";
    dom.path.textContent = selection && selection.elementMeta
      ? `${selection.elementMeta.label} - ${selection.elementMeta.path}`
      : "Click to lock a pixel sample";
    dom.zoomLabel.textContent = selection && selection.elementMeta ? selection.elementMeta.label : "Zoom preview";
    dom.zoomCoords.textContent = selection && selection.elementMeta ? selection.elementMeta.path : "Image pixel";

    if (active) {
      dom.note.textContent = isLocked
        ? `${baseNote} Copy a format or press Reset to sample another color.`
        : `${baseNote} Click to lock this color.`;
    } else {
      dom.note.textContent = "Move over the page and click to lock a color. Esc exits. Enter copies the default format.";
    }

    renderSwatch(dom.primary, active, "Primary");

    dom.copyButtons.forEach((button) => {
      button.disabled = !active;
    });

    if (dom.resetButton) {
      dom.resetButton.disabled = !isLocked;
    }

    if (!active) {
      clearZoom();
    }
  }

  function renderSwatch(node, color, label) {
    const preview = node.querySelector("[data-role='preview']");
    const title = node.querySelector("[data-role='title']");
    const value = node.querySelector("[data-role='value']");

    title.textContent = label;

    if (!color) {
      preview.style.background = "linear-gradient(135deg, #d7dfea 0%, #edf2f7 100%)";
      value.textContent = "Unavailable";
      return;
    }

    preview.style.background = formatRgb(color);
    value.textContent = formatHex(color, state.settings.showAlpha);
  }

  function syncZoomCanvasSize() {
    if (!dom.zoom) {
      return null;
    }

    const rect = dom.zoom.getBoundingClientRect();
    const width = Math.max(96, Math.round(rect.width || dom.zoom.clientWidth || 110));
    const height = Math.max(96, Math.round(rect.height || dom.zoom.clientHeight || width));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));

    if (dom.zoom.width !== pixelWidth || dom.zoom.height !== pixelHeight) {
      dom.zoom.width = pixelWidth;
      dom.zoom.height = pixelHeight;
    }

    dom.zoomContext = dom.zoom.getContext("2d");
    dom.zoomContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    dom.zoomContext.imageSmoothingEnabled = false;

    return {
      ctx: dom.zoomContext,
      width,
      height
    };
  }

  function renderZoom(sample) {
    if (!state.captureContext || !state.capture || !sample) {
      return;
    }

    const metrics = syncZoomCanvasSize();
    if (!metrics) {
      return;
    }

    const ctx = metrics.ctx;
    const width = metrics.width;
    const height = metrics.height;
    const sourceSize = 11;
    const half = Math.floor(sourceSize / 2);
    const maxX = Math.max(0, state.capture.width - sourceSize);
    const maxY = Math.max(0, state.capture.height - sourceSize);
    const startX = clamp(sample.imageX - half, 0, maxX);
    const startY = clamp(sample.imageY - half, 0, maxY);
    const pixels = state.captureContext.getImageData(startX, startY, sourceSize, sourceSize).data;
    const cellSize = Math.max(4, Math.floor(Math.min(width, height) / sourceSize));
    const gridSize = cellSize * sourceSize;
    const offsetX = Math.floor((width - gridSize) / 2);
    const offsetY = Math.floor((height - gridSize) / 2);
    const centerX = offsetX + half * cellSize;
    const centerY = offsetY + half * cellSize;

    ctx.clearRect(0, 0, width, height);

    for (let y = 0; y < sourceSize; y += 1) {
      for (let x = 0; x < sourceSize; x += 1) {
        const index = (y * sourceSize + x) * 4;
        const alpha = clampAlpha(pixels[index + 3] / 255);
        ctx.fillStyle = alpha < 1
          ? "rgba(" + pixels[index] + ", " + pixels[index + 1] + ", " + pixels[index + 2] + ", " + trimAlpha(alpha) + ")"
          : "rgb(" + pixels[index] + ", " + pixels[index + 1] + ", " + pixels[index + 2] + ")";
        ctx.fillRect(offsetX + x * cellSize, offsetY + y * cellSize, cellSize, cellSize);
      }
    }

    ctx.strokeStyle = "rgba(15, 23, 42, 0.22)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= sourceSize; i += 1) {
      const lineX = offsetX + i * cellSize;
      const lineY = offsetY + i * cellSize;
      ctx.beginPath();
      ctx.moveTo(lineX, offsetY);
      ctx.lineTo(lineX, offsetY + gridSize);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(offsetX, lineY);
      ctx.lineTo(offsetX + gridSize, lineY);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(centerX + 1, centerY + 1, Math.max(1, cellSize - 2), Math.max(1, cellSize - 2));
    ctx.strokeStyle = "rgba(29, 78, 216, 0.95)";
    ctx.lineWidth = 1;
    ctx.strokeRect(centerX + 3, centerY + 3, Math.max(1, cellSize - 6), Math.max(1, cellSize - 6));
  }

  function clearZoom() {
    const metrics = syncZoomCanvasSize();
    if (!metrics) {
      return;
    }

    metrics.ctx.clearRect(0, 0, metrics.width, metrics.height);
  }

  function positionReticle(point) {
    const size = 18;
    dom.reticle.style.display = "block";
    dom.reticle.style.left = `${Math.round(point.x - size / 2)}px`;
    dom.reticle.style.top = `${Math.round(point.y - size / 2)}px`;
  }

  function positionPanel(point) {
    const padding = 16;
    const panelWidth = Math.min(dom.panel.offsetWidth || 340, Math.max(240, window.innerWidth - padding * 2));
    const panelHeight = dom.panel.offsetHeight || 320;
    let left = point.x + 18;
    let top = point.y + 18;

    if (left + panelWidth > window.innerWidth - padding) {
      left = point.x - panelWidth - 18;
    }

    if (top + panelHeight > window.innerHeight - padding) {
      top = point.y - panelHeight - 18;
    }

    left = clamp(left, padding, Math.max(padding, window.innerWidth - panelWidth - padding));
    top = clamp(top, padding, Math.max(padding, window.innerHeight - panelHeight - padding));

    dom.panel.style.left = `${Math.round(left)}px`;
    dom.panel.style.top = `${Math.round(top)}px`;
  }

  async function resetSelection() {
    if (!state.enabled) {
      return;
    }

    state.lockedPoint = null;
    state.selection = null;
    clearStatusTimer();

    try {
      await chrome.runtime.sendMessage({ type: "PICKER_SELECTION_RESET" });
    } catch (_) {}

    if (state.hoverPoint) {
      updateFromPoint(state.hoverPoint, false);
    } else {
      renderSelection(null, false);
      if (dom.reticle) {
        dom.reticle.style.display = "none";
      }
    }

    flashStatus("Picker reset. Move over the page and click another color.", 1800, "default");
  }

  async function copyCurrent(format) {
    if (!state.selection || !state.selection.primary) {
      return;
    }

    const text = formatColor(state.selection.primary, format, state.settings.showAlpha);
    const ok = await copyText(text);
    flashStatus(ok ? `${format.toUpperCase()} copied to clipboard.` : "Clipboard unavailable.", ok ? 1800 : 2200, ok ? "success" : "error");

    if (ok && !state.settings.keepOverlayOpen) {
      disablePicker(true);
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "readonly");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      let success = false;
      try {
        success = document.execCommand("copy");
      } catch (_) {
        success = false;
      }
      area.remove();
      return success;
    }
  }

  function bindUi() {
    dom.close.addEventListener("click", () => disablePicker(true));
    dom.resetButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void resetSelection();
    });
    dom.copyButtons.forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyCurrent(button.dataset.format || "hex");
      });
    });
  }

  function createOverlay() {
    const old = document.getElementById(ROOT_ID);
    if (old) {
      old.remove();
    }

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = `
      <div class="hcp-reticle"></div>
      <div class="hcp-panel">
        <div class="hcp-head">
          <div class="hcp-brand"><span class="hcp-dot"></span><span>Haroone Color Picker</span></div>
          <button type="button" class="hcp-close" aria-label="Close picker">&times;</button>
        </div>
        <div class="hcp-status">Move over any pixel</div>
        <div class="hcp-hint">Move over the page</div>
        <div class="hcp-path">Click to lock a pixel sample</div>
        <div class="hcp-sample-strip">
          <canvas class="hcp-zoom" width="110" height="110" aria-hidden="true"></canvas>
          <div class="hcp-zoom-meta">
            <strong class="hcp-zoom-label">Zoom preview</strong>
            <span class="hcp-zoom-coords">Image pixel</span>
            <span class="hcp-zoom-note">Native-style zoom for banners, images, and tiny color areas.</span>
          </div>
        </div>
        <div class="hcp-primary hcp-swatch">
          <span class="hcp-chip" data-role="preview"></span>
          <span class="hcp-meta"><strong data-role="title">Primary</strong><span data-role="value">Unavailable</span></span>
        </div>
        <div class="hcp-actions">
          <button type="button" data-format="hex">HEX</button>
          <button type="button" data-format="rgb">RGB</button>
          <button type="button" data-format="hsl">HSL</button>
          <button type="button" class="hcp-reset" data-action="reset" disabled>Reset</button>
        </div>
        <div class="hcp-note">Esc exits. Enter copies the default format.</div>
      </div>
    `;

    document.documentElement.appendChild(root);

    dom.root = root;
    dom.reticle = root.querySelector(".hcp-reticle");
    dom.panel = root.querySelector(".hcp-panel");
    dom.status = root.querySelector(".hcp-status");
    dom.hint = root.querySelector(".hcp-hint");
    dom.path = root.querySelector(".hcp-path");
    dom.note = root.querySelector(".hcp-note");
    dom.close = root.querySelector(".hcp-close");
    dom.zoom = root.querySelector(".hcp-zoom");
    dom.zoomContext = dom.zoom.getContext("2d");
    dom.zoomLabel = root.querySelector(".hcp-zoom-label");
    dom.zoomCoords = root.querySelector(".hcp-zoom-coords");
    dom.primary = root.querySelector(".hcp-primary");
    dom.resetButton = root.querySelector(".hcp-reset");
    dom.copyButtons = Array.from(root.querySelectorAll(".hcp-actions button[data-format]"));
  }

  function injectStyles() {
    const old = document.getElementById(STYLE_ID);
    if (old) {
      old.remove();
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; font-family: "Trebuchet MS", "Segoe UI", sans-serif; }
      #${ROOT_ID}[hidden] { display: none !important; }
      #${ROOT_ID} .hcp-reticle { position: fixed; display: none; width: 18px; height: 18px; border-radius: 999px; border: 2px solid #ffffff; box-shadow: 0 0 0 2px rgba(29, 78, 216, 0.85), 0 0 18px rgba(15, 23, 42, 0.25); pointer-events: none; }
      #${ROOT_ID} .hcp-panel { position: fixed; width: min(360px, calc(100vw - 16px)); max-width: calc(100vw - 16px); max-height: min(500px, calc(100vh - 16px)); overflow: auto; overscroll-behavior: contain; padding: 14px; border-radius: 16px; border: 1px solid rgba(148, 163, 184, 0.22); background: rgba(15, 23, 42, 0.96); color: #f8fafc; pointer-events: auto; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.35); backdrop-filter: blur(14px); }
      #${ROOT_ID}[data-theme="light"] .hcp-panel { background: rgba(255, 255, 255, 0.97); color: #0f172a; }
      #${ROOT_ID} .hcp-head, #${ROOT_ID} .hcp-brand, #${ROOT_ID} .hcp-swatch, #${ROOT_ID} .hcp-actions, #${ROOT_ID} .hcp-sample-strip { display: flex; align-items: center; }
      #${ROOT_ID} .hcp-head { justify-content: space-between; gap: 12px; margin-bottom: 8px; }
      #${ROOT_ID} .hcp-brand { gap: 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
      #${ROOT_ID} .hcp-dot { width: 10px; height: 10px; border-radius: 999px; background: linear-gradient(135deg, #fb7185 0%, #f59e0b 45%, #22c55e 100%); }
      #${ROOT_ID} .hcp-close { appearance: none; -webkit-appearance: none; width: 28px; height: 28px; border: 0; border-radius: 999px; background: rgba(148, 163, 184, 0.18); color: inherit; font-size: 18px; cursor: pointer; }
      #${ROOT_ID} .hcp-status { margin-top: 10px; padding: 10px 12px; border-radius: 12px; font-size: 13px; font-weight: 800; line-height: 1.35; color: #e0f2fe; background: rgba(37, 99, 235, 0.28); border: 1px solid rgba(96, 165, 250, 0.34); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08); }
      #${ROOT_ID}[data-theme="light"] .hcp-status { color: #0f172a; background: rgba(219, 234, 254, 0.96); border-color: rgba(96, 165, 250, 0.42); }
      #${ROOT_ID} .hcp-status[data-tone="locked"] { color: #ecfeff; background: linear-gradient(135deg, rgba(37, 99, 235, 0.9) 0%, rgba(14, 116, 144, 0.9) 100%); border-color: rgba(125, 211, 252, 0.45); box-shadow: 0 12px 26px rgba(14, 116, 144, 0.24); }
      #${ROOT_ID} .hcp-status[data-tone="success"] { color: #ecfeff; background: linear-gradient(135deg, rgba(22, 163, 74, 0.96) 0%, rgba(13, 148, 136, 0.94) 100%); border-color: rgba(110, 231, 183, 0.46); box-shadow: 0 12px 26px rgba(13, 148, 136, 0.24); }
      #${ROOT_ID} .hcp-status[data-tone="error"] { color: #fff1f2; background: linear-gradient(135deg, rgba(190, 24, 93, 0.96) 0%, rgba(225, 29, 72, 0.9) 100%); border-color: rgba(253, 164, 175, 0.46); box-shadow: 0 12px 26px rgba(190, 24, 93, 0.24); }
      #${ROOT_ID} .hcp-path, #${ROOT_ID} .hcp-note, #${ROOT_ID} .hcp-zoom-note { font-size: 11px; color: #cbd5e1; }
      #${ROOT_ID}[data-theme="light"] .hcp-path, #${ROOT_ID}[data-theme="light"] .hcp-note, #${ROOT_ID}[data-theme="light"] .hcp-zoom-note { color: #475569; }
      #${ROOT_ID} .hcp-hint { margin-top: 4px; font-size: 14px; font-weight: 700; word-break: break-word; }
      #${ROOT_ID} .hcp-path { margin-top: 2px; overflow-wrap: anywhere; }
      #${ROOT_ID} .hcp-sample-strip { gap: 12px; margin-top: 12px; align-items: stretch; flex-wrap: wrap; }
      #${ROOT_ID} .hcp-zoom { width: 110px; height: 110px; border-radius: 14px; border: 1px solid rgba(148, 163, 184, 0.22); background: linear-gradient(45deg, rgba(148, 163, 184, 0.25) 25%, transparent 25%), linear-gradient(-45deg, rgba(148, 163, 184, 0.25) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148, 163, 184, 0.25) 75%), linear-gradient(-45deg, transparent 75%, rgba(148, 163, 184, 0.25) 75%); background-size: 12px 12px; background-position: 0 0, 0 6px, 6px -6px, -6px 0; image-rendering: pixelated; flex: 0 0 auto; }
      #${ROOT_ID} .hcp-zoom-meta { display: flex; flex-direction: column; justify-content: center; gap: 4px; min-width: 0; }
      #${ROOT_ID} .hcp-zoom-label { font-size: 13px; }
      #${ROOT_ID} .hcp-zoom-coords { font-size: 11px; color: inherit; opacity: 0.85; }
      #${ROOT_ID} .hcp-primary { margin-top: 12px; align-items: center; }
      #${ROOT_ID} .hcp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; margin-top: 8px; }
      #${ROOT_ID} .hcp-swatch { gap: 8px; border: 1px solid rgba(148, 163, 184, 0.18); border-radius: 12px; padding: 9px; background: rgba(255, 255, 255, 0.06); min-width: 0; }
      #${ROOT_ID}[data-theme="light"] .hcp-swatch { background: rgba(248, 250, 252, 0.94); }
      #${ROOT_ID} .hcp-grid .hcp-swatch { align-items: flex-start; }
      #${ROOT_ID} .hcp-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      #${ROOT_ID} .hcp-meta strong { font-size: 11px; }
      #${ROOT_ID} .hcp-meta span { font-size: 10px; opacity: 0.86; overflow-wrap: anywhere; }
      #${ROOT_ID} .hcp-chip { width: 24px; height: 24px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.4); background: linear-gradient(135deg, #d7dfea 0%, #edf2f7 100%); flex: 0 0 auto; }
      #${ROOT_ID} .hcp-primary .hcp-chip { width: 30px; height: 30px; }
      #${ROOT_ID} .hcp-actions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
      #${ROOT_ID} .hcp-actions button { appearance: none; -webkit-appearance: none; width: 100%; min-width: 0; height: 36px; border: 0; border-radius: 10px; cursor: pointer; background: linear-gradient(135deg, #1d4ed8 0%, #0f766e 100%); color: #fff; font: inherit; font-weight: 700; text-decoration: none; box-shadow: none; outline: none; overflow: hidden; }
      #${ROOT_ID} .hcp-actions button:hover, #${ROOT_ID} .hcp-actions button:focus-visible, #${ROOT_ID} .hcp-actions button:active { border-radius: 10px; background: linear-gradient(135deg, #1d4ed8 0%, #0f766e 100%); color: #fff; box-shadow: none; transform: none; }
      #${ROOT_ID} .hcp-actions button:disabled { opacity: 0.55; cursor: default; }
      #${ROOT_ID} .hcp-actions .hcp-reset { background: rgba(148, 163, 184, 0.12); color: inherit; border: 1px solid rgba(148, 163, 184, 0.24); }
      #${ROOT_ID}[data-theme="light"] .hcp-actions .hcp-reset { background: rgba(241, 245, 249, 0.96); color: #0f172a; border-color: rgba(148, 163, 184, 0.4); }
      #${ROOT_ID} .hcp-actions .hcp-reset:hover, #${ROOT_ID} .hcp-actions .hcp-reset:focus-visible, #${ROOT_ID} .hcp-actions .hcp-reset:active { background: rgba(148, 163, 184, 0.18); color: inherit; border: 1px solid rgba(148, 163, 184, 0.32); }
      #${ROOT_ID} .hcp-note { margin-top: 10px; }
      #${ROOT_ID} .hcp-panel::-webkit-scrollbar { width: 8px; }
      #${ROOT_ID} .hcp-panel::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.34); border-radius: 999px; }
            @media (max-width: 420px) {
        #${ROOT_ID} .hcp-panel { width: calc(100vw - 20px); max-width: calc(100vw - 20px); max-height: calc(100vh - 20px); padding: 12px; }
        #${ROOT_ID} .hcp-head { gap: 8px; }
        #${ROOT_ID} .hcp-brand { font-size: 11px; letter-spacing: 0.06em; }
        #${ROOT_ID} .hcp-sample-strip { flex-direction: column; align-items: stretch; }
        #${ROOT_ID} .hcp-zoom { width: 100%; height: auto; aspect-ratio: 1 / 1; }
        #${ROOT_ID} .hcp-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        #${ROOT_ID} .hcp-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 320px) {
        #${ROOT_ID} .hcp-panel { width: calc(100vw - 12px); max-width: calc(100vw - 12px); max-height: calc(100vh - 12px); padding: 10px; border-radius: 14px; }
        #${ROOT_ID} .hcp-grid { grid-template-columns: minmax(0, 1fr); }
        #${ROOT_ID} .hcp-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    `;

    document.documentElement.appendChild(style);
  }

  function applyTheme() {
    let theme = state.settings.theme;
    if (theme === "system") {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    dom.root.dataset.theme = theme === "dark" ? "dark" : "light";
  }

  function isOverlayInteractive(node) {
    return Boolean(node && dom.panel && dom.panel.contains(node));
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
    const base = [color.r, color.g, color.b].map(toHex).join("");
    if (showAlpha && color.a < 1) {
      return `#${base}${toHex(Math.round(color.a * 255))}`;
    }
    return `#${base}`;
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

  function toHex(value) {
    return Number(value).toString(16).padStart(2, "0").toUpperCase();
  }

  function trimAlpha(value) {
    return Number(Number(value).toFixed(3)).toString();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clampAlpha(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return 1;
    }
    return Math.min(1, Math.max(0, Number(num.toFixed(3))));
  }

  function toMessage(error) {
    if (!error) {
      return "Unknown error";
    }
    return typeof error === "string" ? error : error.message || String(error);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Unable to load the current screen capture."));
      image.src = src;
    });
  }
})();












