(() => {
  "use strict";

  if (window.__HAROONE_COLOR_PICKER__) {
    window.__HAROONE_COLOR_PICKER__.reconnect();
    return;
  }

  const ROOT_ID = "haroone-color-picker-root";
  const CURSOR_STYLE_ID = "haroone-color-picker-cursor-style";
  const ACTIVE_CURSOR_ATTR = "data-hcp-picker-active";
  const HOVER_SETTLE_DELAY = 96;
  const VIEWPORT_REFRESH_DELAY = 120;
  const RETICLE_SIZE = 28;
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
    hoverTimer: null,
    refreshPromise: null,
    pendingRefresh: false,
    statusTimer: null,
    captureMaskDepth: 0
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
    createOverlay();
    bindUi();
    window.__HAROONE_COLOR_PICKER__ = {
      reconnect() {
        ensureOverlay();
        if (state.enabled) {
          applyTheme();
          applyPickerCursor(true);
          positionPanel(state.lockedPoint || state.hoverPoint);
        }
      }
    };
  }

  function ensureOverlay() {
    const root = document.getElementById(ROOT_ID);
    if (!root || !root.shadowRoot) {
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
    state.pendingRefresh = false;
    state.refreshPromise = null;
    state.captureMaskDepth = 0;
    clearRefreshTimer();
    clearHoverTimer();
    clearStatusTimer();

    if (dom.root) {
      delete dom.root.dataset.capturing;
      dom.root.hidden = false;
      dom.root.setAttribute("aria-hidden", "false");
    }

    applyTheme();
    applyPickerCursor(true);
    positionPanel(state.lockedPoint || state.hoverPoint);

    if (capture && capture.dataUrl) {
      await loadCapture(capture, getViewportMetrics());
    } else if (!state.captureContext) {
      await refreshCapture({ force: true, silent: true, skipUpdate: true });
    }

    attachListeners();
    renderSelection(state.selection, false);

    if (!state.selection && dom.reticle) {
      dom.reticle.style.display = "none";
    }

    await chrome.runtime.sendMessage({
      type: "PICKER_ENABLED",
      selection: state.selection
    }).catch(() => {});
  }

  function disablePicker(emitExit) {
    state.enabled = false;
    state.hoverPoint = null;
    state.lockedPoint = null;
    state.pendingRefresh = false;
    state.refreshPromise = null;
    state.captureMaskDepth = 0;
    clearRefreshTimer();
    clearHoverTimer();
    clearStatusTimer();
    detachListeners();
    applyPickerCursor(false);

    if (dom.root) {
      delete dom.root.dataset.capturing;
      dom.root.hidden = true;
      dom.root.setAttribute("aria-hidden", "true");
    }

    if (dom.reticle) {
      dom.reticle.style.display = "none";
    }

    if (emitExit) {
      void chrome.runtime.sendMessage({ type: "PICKER_EXITED" }).catch(() => {});
    }
  }

  function attachListeners() {
    detachListeners();
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeydown, true);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange, true);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleViewportChange, true);
      window.visualViewport.addEventListener("scroll", handleViewportChange, true);
    }
  }

  function detachListeners() {
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("keydown", handleKeydown, true);
    window.removeEventListener("scroll", handleViewportChange, true);
    window.removeEventListener("resize", handleViewportChange, true);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", handleViewportChange, true);
      window.visualViewport.removeEventListener("scroll", handleViewportChange, true);
    }
  }

  function handleMouseMove(event) {
    if (!state.enabled || state.lockedPoint) {
      return;
    }

    if (isOverlayInteractive(event)) {
      return;
    }

    const point = createPoint(event.clientX, event.clientY);
    state.hoverPoint = point;
    updateFromPoint(point, false);
    scheduleHoverSettleRefresh();
  }

  async function handleClick(event) {
    if (!state.enabled) {
      return;
    }

    if (isOverlayInteractive(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (state.lockedPoint) {
      flashStatus("Color already locked. Press Reset to sample another color.", 1800, "locked");
      return;
    }
    clearHoverTimer();
    state.pendingRefresh = false;
    const point = createPoint(event.clientX, event.clientY);
    state.hoverPoint = point;
    const previousLockedPoint = state.lockedPoint;
    const previousSelection = state.selection;

    state.lockedPoint = point;
    clearStatusTimer();
    setStatusText("Locking sampled pixel...", "default");

    const refreshed = await refreshCapture({
      point,
      locked: true,
      force: true,
      skipUpdate: true,
      preserveStatus: true
    });

    if (!refreshed) {
      restoreSelectionState(previousLockedPoint, previousSelection);
      flashStatus("Unable to lock the current pixel. Try again.", 2200, "error");
      return;
    }

    if (!updateFromPoint(point, true)) {
      restoreSelectionState(previousLockedPoint, previousSelection);
      flashStatus("Unable to sample the current pixel. Try again.", 2200, "error");
      return;
    }

    void chrome.runtime.sendMessage({
      type: "PICKER_SELECTION_LOCKED",
      selection: state.selection
    }).catch(() => {});

    if (state.settings.copyOnClick && state.selection && state.selection.primary) {
      void copyCurrent(state.settings.defaultFormat).catch(() => {});
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
      void copyCurrent(state.settings.defaultFormat).catch(() => {});
    }
  }

  function handleViewportChange() {
    if (!state.enabled) {
      return;
    }

    positionPanel(state.lockedPoint || state.hoverPoint);

    if (state.lockedPoint) {
      clearRefreshTimer();
      clearHoverTimer();
      if (dom.reticle) {
        dom.reticle.style.display = "none";
      }
      restoreStatusText();
      return;
    }

    clearStatusTimer();
    setStatusText("Refreshing sampled view...", "default");
    scheduleCaptureRefresh();
  }

  function scheduleCaptureRefresh() {
    clearRefreshTimer();
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      state.pendingRefresh = true;
      void refreshCapture().catch(() => {});
    }, VIEWPORT_REFRESH_DELAY);
  }

  function clearRefreshTimer() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  function scheduleHoverSettleRefresh() {
    clearHoverTimer();
    state.hoverTimer = setTimeout(() => {
      state.hoverTimer = null;
      if (!state.enabled || state.lockedPoint || !state.hoverPoint) {
        return;
      }

      void refreshCapture({
        point: state.hoverPoint,
        locked: false,
        silent: true,
        maskMode: "reticle"
      }).catch(() => {});
    }, HOVER_SETTLE_DELAY);
  }

  function clearHoverTimer() {
    clearTimeout(state.hoverTimer);
    state.hoverTimer = null;
  }

  async function refreshCapture(options = {}) {
    if (!state.enabled && !options.force) {
      return false;
    }

    if (state.refreshPromise) {
      state.pendingRefresh = true;
      await state.refreshPromise.catch(() => {});
      if (!state.enabled && !options.force) {
        return false;
      }
    }

    state.pendingRefresh = false;
    const task = performCaptureRefresh(options);
    state.refreshPromise = task;

    try {
      return await task;
    } finally {
      if (state.refreshPromise === task) {
        state.refreshPromise = null;
      }

      if (state.pendingRefresh && state.enabled && !state.lockedPoint) {
        state.pendingRefresh = false;
        void refreshCapture({ silent: true }).catch(() => {});
      }
    }
  }

  async function performCaptureRefresh(options = {}) {
    const point = options.point || state.lockedPoint || state.hoverPoint;
    const locked = Object.prototype.hasOwnProperty.call(options, "locked")
      ? Boolean(options.locked)
      : Boolean(state.lockedPoint);
    const silent = Boolean(options.silent);
    const skipUpdate = Boolean(options.skipUpdate);
    const preserveStatus = Boolean(options.preserveStatus);
    const maskMode = options.maskMode || (locked ? "full" : "reticle");
    let releaseMask = null;

    try {
      releaseMask = beginCaptureMask(maskMode);
      await nextAnimationFrame();
      await nextAnimationFrame();

      const response = await chrome.runtime.sendMessage({ type: "PICKER_REQUEST_CAPTURE" });
      if (!response || !response.ok || !response.capture || !response.capture.dataUrl) {
        throw new Error((response && response.error) || "Unable to refresh the page capture.");
      }

      await loadCapture(response.capture, getViewportMetrics());

      if (!locked && state.lockedPoint) {
        return true;
      }

      if (locked && !state.lockedPoint) {
        return true;
      }

      if (!skipUpdate) {
        if (point) {
          updateFromPoint(point, locked);
        } else {
          renderSelection(state.selection, locked);
          if (!state.selection) {
            clearZoom();
          }
        }
      }

      if (!preserveStatus && !silent && state.selection && state.selection.primary) {
        restoreStatusText();
      }

      return true;
    } catch (error) {
      if (!silent) {
        clearStatusTimer();
        setStatusText(toMessage(error), "error");
      }
      return false;
    } finally {
      if (releaseMask) {
        releaseMask();
      }
    }
  }

  async function loadCapture(capture, viewportSnapshot) {
    if (!capture || !capture.dataUrl) {
      throw new Error("No screen capture was provided.");
    }

    const image = await loadImage(capture.dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Unable to create a canvas context for sampling.");
    }

    context.drawImage(image, 0, 0);

    const viewport = viewportSnapshot || getViewportMetrics();
    state.captureCanvas = canvas;
    state.captureContext = context;
    state.capture = {
      dataUrl: capture.dataUrl,
      width: canvas.width,
      height: canvas.height,
      capturedAt: capture.capturedAt || viewport.capturedAt || Date.now(),
      viewport
    };
  }

  function getViewportMetrics() {
    const viewport = window.visualViewport;
    return {
      width: Math.max(1, viewport ? viewport.width : window.innerWidth),
      height: Math.max(1, viewport ? viewport.height : window.innerHeight),
      offsetLeft: viewport ? viewport.offsetLeft : 0,
      offsetTop: viewport ? viewport.offsetTop : 0,
      scale: viewport ? viewport.scale || 1 : 1,
      devicePixelRatio: window.devicePixelRatio || 1,
      capturedAt: Date.now()
    };
  }

  function updateFromPoint(point, locked) {
    const sample = samplePoint(point.x, point.y);
    if (!sample) {
      renderSelection(null, locked);
      clearZoom();
      if (dom.reticle) {
        dom.reticle.style.display = "none";
      }
      return false;
    }

    state.selection = buildSelection(sample);
    renderSelection(state.selection, locked);
    positionReticle(sample);
    positionPanel(state.lockedPoint || state.hoverPoint);
    renderZoom(sample);
    return true;
  }

  function samplePoint(clientX, clientY) {
    if (!state.captureContext || !state.capture) {
      return null;
    }

    const mapped = mapClientPointToCapture(clientX, clientY);
    if (!mapped) {
      return null;
    }

    const data = state.captureContext.getImageData(mapped.imageX, mapped.imageY, 1, 1).data;
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
      ...mapped,
      color
    };
  }

  function mapClientPointToCapture(clientX, clientY) {
    if (!state.capture || !state.capture.viewport) {
      return null;
    }

    const viewport = state.capture.viewport;
    const clampedX = clamp(Number(clientX) || 0, 0, Math.max(0, viewport.width - 1));
    const clampedY = clamp(Number(clientY) || 0, 0, Math.max(0, viewport.height - 1));

    return {
      clientX: Math.round(clampedX),
      clientY: Math.round(clampedY),
      pageX: Math.round(clampedX + viewport.offsetLeft),
      pageY: Math.round(clampedY + viewport.offsetTop),
      imageX: mapAxisToCapture(clampedX, viewport.width, state.capture.width),
      imageY: mapAxisToCapture(clampedY, viewport.height, state.capture.height)
    };
  }

  function mapAxisToCapture(clientValue, viewportSize, captureSize) {
    if (captureSize <= 1 || viewportSize <= 1) {
      return 0;
    }

    const clamped = clamp(clientValue, 0, viewportSize - 1);
    const maxViewport = viewportSize - 1;
    const maxCapture = captureSize - 1;
    return clamp(Math.round((clamped / maxViewport) * maxCapture), 0, maxCapture);
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
      notes: ["Pixel sampled from the visible page. Final lock uses a fresh capture for accuracy."],
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

    if (dom.panel) {
      dom.panel.hidden = !active;
      dom.panel.setAttribute("aria-hidden", active ? "false" : "true");
    }

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
    const crosshairX = centerX + Math.floor(cellSize / 2);
    const crosshairY = centerY + Math.floor(cellSize / 2);

    ctx.clearRect(0, 0, width, height);

    for (let y = 0; y < sourceSize; y += 1) {
      for (let x = 0; x < sourceSize; x += 1) {
        const index = (y * sourceSize + x) * 4;
        const alpha = clampAlpha(pixels[index + 3] / 255);
        ctx.fillStyle = alpha < 1
          ? `rgba(${pixels[index]}, ${pixels[index + 1]}, ${pixels[index + 2]}, ${trimAlpha(alpha)})`
          : `rgb(${pixels[index]}, ${pixels[index + 1]}, ${pixels[index + 2]})`;
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

    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(crosshairX, offsetY);
    ctx.lineTo(crosshairX, offsetY + gridSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(offsetX, crosshairY);
    ctx.lineTo(offsetX + gridSize, crosshairY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(29, 78, 216, 0.95)";
    ctx.lineWidth = 1;
    ctx.strokeRect(centerX + 1, centerY + 1, Math.max(1, cellSize - 2), Math.max(1, cellSize - 2));
    ctx.strokeRect(centerX + 3, centerY + 3, Math.max(1, cellSize - 6), Math.max(1, cellSize - 6));
  }

  function clearZoom() {
    const metrics = syncZoomCanvasSize();
    if (!metrics) {
      return;
    }

    metrics.ctx.clearRect(0, 0, metrics.width, metrics.height);
  }

  function positionReticle(sample) {
    if (!dom.reticle) {
      return;
    }

    dom.reticle.style.display = "block";
    dom.reticle.style.left = `${Math.round(sample.clientX - RETICLE_SIZE / 2)}px`;
    dom.reticle.style.top = `${Math.round(sample.clientY - RETICLE_SIZE / 2)}px`;
  }

  function positionPanel(anchorPoint) {
    if (!dom.panel || dom.panel.hidden) {
      return;
    }

    const viewport = getViewportMetrics();
    if (viewport.width <= 420) {
      dom.panel.style.top = "auto";
      dom.panel.style.right = "10px";
      dom.panel.style.bottom = "10px";
      dom.panel.style.left = "10px";
      return;
    }

    const point = anchorPoint || state.lockedPoint || state.hoverPoint;
    if (!point) {
      dom.panel.style.top = "16px";
      dom.panel.style.right = "16px";
      dom.panel.style.bottom = "auto";
      dom.panel.style.left = "auto";
      return;
    }

    const anchorX = typeof point.clientX === "number" ? point.clientX : point.x;
    const anchorY = typeof point.clientY === "number" ? point.clientY : point.y;
    const padding = 16;
    const offset = 24;
    const panelWidth = Math.min(dom.panel.offsetWidth || 340, Math.max(260, viewport.width - padding * 2));
    const panelHeight = dom.panel.offsetHeight || 320;
    let left = anchorX + offset;
    let top = anchorY + offset;

    if (left + panelWidth > viewport.width - padding) {
      left = anchorX - panelWidth - offset;
    }

    if (top + panelHeight > viewport.height - padding) {
      top = anchorY - panelHeight - offset;
    }

    left = clamp(left, padding, Math.max(padding, viewport.width - panelWidth - padding));
    top = clamp(top, padding, Math.max(padding, viewport.height - panelHeight - padding));

    dom.panel.style.top = `${Math.round(top)}px`;
    dom.panel.style.right = "auto";
    dom.panel.style.bottom = "auto";
    dom.panel.style.left = `${Math.round(left)}px`;
  }

  async function resetSelection() {
    if (!state.enabled) {
      return;
    }

    state.lockedPoint = null;
    state.hoverPoint = null;
    state.selection = null;
    clearRefreshTimer();
    clearHoverTimer();
    clearStatusTimer();

    try {
      await chrome.runtime.sendMessage({ type: "PICKER_SELECTION_RESET" });
    } catch (_) {}

    renderSelection(null, false);
    clearZoom();
    if (dom.reticle) {
      dom.reticle.style.display = "none";
    }

    void refreshCapture({
      force: true,
      silent: true,
      skipUpdate: true,
      maskMode: "reticle"
    }).catch(() => {});

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
      void resetSelection().catch(() => {});
    });
    dom.copyButtons.forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyCurrent(button.dataset.format || "hex").catch(() => {});
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

    const shadow = root.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${getOverlayStyles()}</style>
      <div class="hcp-reticle" aria-hidden="true">
        <span class="hcp-reticle-grid"></span>
        <span class="hcp-reticle-dot"></span>
      </div>
      <div class="hcp-panel" hidden aria-hidden="true">
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
            <span class="hcp-zoom-note">Live preview uses the latest capture. Final lock refreshes before sampling.</span>
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
    dom.shadow = shadow;
    dom.reticle = shadow.querySelector(".hcp-reticle");
    dom.panel = shadow.querySelector(".hcp-panel");
    dom.status = shadow.querySelector(".hcp-status");
    dom.hint = shadow.querySelector(".hcp-hint");
    dom.path = shadow.querySelector(".hcp-path");
    dom.note = shadow.querySelector(".hcp-note");
    dom.close = shadow.querySelector(".hcp-close");
    dom.zoom = shadow.querySelector(".hcp-zoom");
    dom.zoomContext = dom.zoom.getContext("2d");
    dom.zoomLabel = shadow.querySelector(".hcp-zoom-label");
    dom.zoomCoords = shadow.querySelector(".hcp-zoom-coords");
    dom.primary = shadow.querySelector(".hcp-primary");
    dom.resetButton = shadow.querySelector(".hcp-reset");
    dom.copyButtons = Array.from(shadow.querySelectorAll(".hcp-actions button[data-format]"));
  }

  function getOverlayStyles() {
    return `
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        pointer-events: none;
        color-scheme: light dark;
        color: #f8fafc;
        font-family: "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 16px;
        line-height: 1.4;
        -webkit-font-smoothing: antialiased;
        text-size-adjust: 100%;
      }
      :host([hidden]) { display: none !important; }
      :host([data-capturing="full"]) { visibility: hidden !important; }
      :host([data-capturing="reticle"]) .hcp-reticle { display: none !important; }
      :host([data-capturing="reticle"]) .hcp-panel { box-shadow: none !important; backdrop-filter: none !important; }
      :host, :host *, :host *::before, :host *::after { box-sizing: border-box; }
      .hcp-reticle {
        position: fixed;
        display: none;
        width: ${RETICLE_SIZE}px;
        height: ${RETICLE_SIZE}px;
        border-radius: 999px;
        border: 2px solid rgba(255, 255, 255, 0.95);
        background: rgba(15, 23, 42, 0.08);
        box-shadow: 0 0 0 2px rgba(29, 78, 216, 0.85), 0 0 18px rgba(15, 23, 42, 0.25);
        pointer-events: none;
      }
      .hcp-reticle-grid {
        position: absolute;
        inset: 3px;
        border-radius: 999px;
        background:
          linear-gradient(90deg, transparent calc(50% - 0.5px), rgba(255, 255, 255, 0.82) calc(50% - 0.5px), rgba(255, 255, 255, 0.82) calc(50% + 0.5px), transparent calc(50% + 0.5px)),
          linear-gradient(0deg, transparent calc(50% - 0.5px), rgba(255, 255, 255, 0.82) calc(50% - 0.5px), rgba(255, 255, 255, 0.82) calc(50% + 0.5px), transparent calc(50% + 0.5px));
      }
      .hcp-reticle-dot {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 8px;
        height: 8px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 0 0 2px rgba(29, 78, 216, 0.92), 0 0 0 4px rgba(15, 23, 42, 0.55);
        transform: translate(-50%, -50%);
      }
      .hcp-panel {
        position: fixed;
        top: 16px;
        right: 16px;
        left: auto;
        bottom: auto;
        width: min(360px, calc(100vw - 32px));
        max-width: calc(100vw - 32px);
        max-height: calc(100vh - 16px);
        overflow: auto;
        overscroll-behavior: contain;
        padding: 14px;
        border-radius: 16px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        background: rgba(15, 23, 42, 0.96);
        color: #f8fafc;
        pointer-events: auto;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.35);
        backdrop-filter: blur(14px);
      }
      :host([data-theme="light"]) .hcp-panel { background: rgba(255, 255, 255, 0.97); color: #0f172a; }
      .hcp-head, .hcp-brand, .hcp-swatch, .hcp-actions, .hcp-sample-strip { display: flex; align-items: center; }
      .hcp-head { justify-content: space-between; gap: 12px; margin-bottom: 8px; }
      .hcp-brand { gap: 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
      .hcp-dot { width: 10px; height: 10px; border-radius: 999px; background: linear-gradient(135deg, #fb7185 0%, #f59e0b 45%, #22c55e 100%); }
      .hcp-close {
        appearance: none;
        -webkit-appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 0;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.18);
        color: inherit;
        font: inherit;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        transition: background 140ms ease, box-shadow 140ms ease, transform 140ms ease, color 140ms ease;
      }
      .hcp-close:hover,
      .hcp-close:focus-visible,
      .hcp-close:active {
        background: rgba(148, 163, 184, 0.28);
        color: #ffffff;
        box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.18);
        transform: translateY(-1px);
      }
      :host([data-theme="light"]) .hcp-close:hover,
      :host([data-theme="light"]) .hcp-close:focus-visible,
      :host([data-theme="light"]) .hcp-close:active {
        background: rgba(226, 232, 240, 0.98);
        color: #0f172a;
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.14);
      }
      .hcp-close:focus-visible { outline: none; }
      .hcp-status { margin-top: 10px; padding: 10px 12px; border-radius: 12px; font-size: 13px; font-weight: 800; line-height: 1.35; color: #e0f2fe; background: rgba(37, 99, 235, 0.28); border: 1px solid rgba(96, 165, 250, 0.34); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08); }
      :host([data-theme="light"]) .hcp-status { color: #0f172a; background: rgba(219, 234, 254, 0.96); border-color: rgba(96, 165, 250, 0.42); }
      .hcp-status[data-tone="locked"] { color: #ecfeff; background: linear-gradient(135deg, rgba(37, 99, 235, 0.9) 0%, rgba(14, 116, 144, 0.9) 100%); border-color: rgba(125, 211, 252, 0.45); box-shadow: 0 12px 26px rgba(14, 116, 144, 0.24); }
      .hcp-status[data-tone="success"] { color: #ecfeff; background: linear-gradient(135deg, rgba(22, 163, 74, 0.96) 0%, rgba(13, 148, 136, 0.94) 100%); border-color: rgba(110, 231, 183, 0.46); box-shadow: 0 12px 26px rgba(13, 148, 136, 0.24); }
      .hcp-status[data-tone="error"] { color: #fff1f2; background: linear-gradient(135deg, rgba(190, 24, 93, 0.96) 0%, rgba(225, 29, 72, 0.9) 100%); border-color: rgba(253, 164, 175, 0.46); box-shadow: 0 12px 26px rgba(190, 24, 93, 0.24); }
      .hcp-path, .hcp-note, .hcp-zoom-note { font-size: 11px; color: #cbd5e1; }
      :host([data-theme="light"]) .hcp-path, :host([data-theme="light"]) .hcp-note, :host([data-theme="light"]) .hcp-zoom-note { color: #475569; }
      .hcp-hint { margin-top: 4px; font-size: 14px; font-weight: 700; word-break: break-word; }
      .hcp-path { margin-top: 2px; overflow-wrap: anywhere; }
      .hcp-sample-strip { gap: 12px; margin-top: 12px; align-items: stretch; flex-wrap: wrap; }
      .hcp-zoom {
        width: 110px;
        height: 110px;
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        background: linear-gradient(45deg, rgba(148, 163, 184, 0.25) 25%, transparent 25%), linear-gradient(-45deg, rgba(148, 163, 184, 0.25) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148, 163, 184, 0.25) 75%), linear-gradient(-45deg, transparent 75%, rgba(148, 163, 184, 0.25) 75%);
        background-size: 12px 12px;
        background-position: 0 0, 0 6px, 6px -6px, -6px 0;
        image-rendering: pixelated;
        flex: 0 0 auto;
      }
      .hcp-zoom-meta { display: flex; flex-direction: column; justify-content: center; gap: 4px; min-width: 0; }
      .hcp-zoom-label { font-size: 13px; }
      .hcp-zoom-coords { font-size: 11px; color: inherit; opacity: 0.85; }
      .hcp-primary { margin-top: 12px; align-items: center; }
      .hcp-swatch { gap: 8px; border: 1px solid rgba(148, 163, 184, 0.18); border-radius: 12px; padding: 9px; background: rgba(255, 255, 255, 0.06); min-width: 0; }
      :host([data-theme="light"]) .hcp-swatch { background: rgba(248, 250, 252, 0.94); }
      .hcp-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .hcp-meta strong { font-size: 11px; }
      .hcp-meta span { font-size: 10px; opacity: 0.86; overflow-wrap: anywhere; }
      .hcp-chip { width: 24px; height: 24px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.4); background: linear-gradient(135deg, #d7dfea 0%, #edf2f7 100%); flex: 0 0 auto; }
      .hcp-primary .hcp-chip { width: 30px; height: 30px; }
      .hcp-actions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
      .hcp-actions button {
        appearance: none;
        -webkit-appearance: none;
        width: 100%;
        min-width: 0;
        height: 36px;
        padding: 0 10px;
        border: 0;
        border-radius: 10px;
        cursor: pointer;
        background: linear-gradient(135deg, #1d4ed8 0%, #0f766e 100%);
        color: #fff;
        font: inherit;
        font-weight: 700;
        text-decoration: none;
        box-shadow: none;
        outline: none;
        overflow: hidden;
        transition: filter 140ms ease, box-shadow 140ms ease, transform 140ms ease, opacity 140ms ease;
      }
      .hcp-actions button:hover,
      .hcp-actions button:focus-visible,
      .hcp-actions button:active {
        background: linear-gradient(135deg, #1d4ed8 0%, #0f766e 100%);
        color: #fff;
        box-shadow: 0 8px 18px rgba(15, 118, 110, 0.24), 0 0 0 3px rgba(96, 165, 250, 0.12);
        filter: brightness(1.05);
        transform: translateY(-1px);
      }
      .hcp-actions button:focus-visible { outline: none; }
      .hcp-actions button:disabled { opacity: 0.55; cursor: default; }
      .hcp-actions button:disabled:hover,
      .hcp-actions button:disabled:focus-visible,
      .hcp-actions button:disabled:active {
        box-shadow: none;
        filter: none;
        transform: none;
      }
      .hcp-actions .hcp-reset { background: rgba(148, 163, 184, 0.12); color: inherit; border: 1px solid rgba(148, 163, 184, 0.24); }
      :host([data-theme="light"]) .hcp-actions .hcp-reset { background: rgba(241, 245, 249, 0.96); color: #0f172a; border-color: rgba(148, 163, 184, 0.4); }
      .hcp-actions .hcp-reset:hover,
      .hcp-actions .hcp-reset:focus-visible,
      .hcp-actions .hcp-reset:active {
        background: rgba(148, 163, 184, 0.18);
        color: inherit;
        border: 1px solid rgba(148, 163, 184, 0.32);
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.12), 0 0 0 3px rgba(148, 163, 184, 0.12);
        filter: none;
      }
      .hcp-note { margin-top: 10px; }
      .hcp-panel::-webkit-scrollbar { width: 8px; }
      .hcp-panel::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.34); border-radius: 999px; }
      @media (max-width: 420px) {
        .hcp-panel {
          top: auto;
          right: 8px;
          bottom: 8px;
          left: 8px;
          width: auto;
          max-width: none;
          max-height: min(74vh, calc(100vh - 12px));
          padding: 12px;
          border-radius: 18px;
        }
        .hcp-head { gap: 8px; }
        .hcp-brand { font-size: 11px; letter-spacing: 0.06em; }
        .hcp-sample-strip { flex-direction: column; align-items: stretch; }
        .hcp-zoom { width: 100%; height: auto; aspect-ratio: 1 / 1; }
        .hcp-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 320px) {
        .hcp-panel {
          right: 6px;
          left: 6px;
          bottom: 6px;
          max-height: calc(100vh - 8px);
          padding: 10px;
          border-radius: 14px;
        }
        .hcp-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    `;
  }

  function applyTheme() {
    let theme = state.settings.theme;
    if (theme === "system") {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    dom.root.dataset.theme = theme === "dark" ? "dark" : "light";
  }

  function applyPickerCursor(active) {
    let style = document.getElementById(CURSOR_STYLE_ID);

    if (!active) {
      document.documentElement.removeAttribute(ACTIVE_CURSOR_ATTR);
      if (style) {
        style.remove();
      }
      return;
    }

    if (!style) {
      style = document.createElement("style");
      style.id = CURSOR_STYLE_ID;
      style.textContent = `
        html[${ACTIVE_CURSOR_ATTR}],
        html[${ACTIVE_CURSOR_ATTR}] body,
        html[${ACTIVE_CURSOR_ATTR}] body * {
          cursor: crosshair !important;
        }
      `;
      document.documentElement.appendChild(style);
    }

    document.documentElement.setAttribute(ACTIVE_CURSOR_ATTR, "true");
  }

  function beginCaptureMask(mode) {
    if (!dom.root) {
      return null;
    }

    state.captureMaskDepth += 1;
    dom.root.dataset.capturing = mode || "full";

    return () => {
      state.captureMaskDepth = Math.max(0, state.captureMaskDepth - 1);
      if (!state.captureMaskDepth && dom.root) {
        delete dom.root.dataset.capturing;
      }
    };
  }

  function restoreSelectionState(previousLockedPoint, previousSelection) {
    state.lockedPoint = previousLockedPoint || null;
    state.selection = previousSelection || null;

    if (state.lockedPoint) {
      updateFromPoint(state.lockedPoint, true);
      return;
    }

    if (state.hoverPoint) {
      updateFromPoint(state.hoverPoint, false);
      return;
    }

    renderSelection(previousSelection || null, false);
    if (!previousSelection) {
      clearZoom();
      if (dom.reticle) {
        dom.reticle.style.display = "none";
      }
    }
  }

  function createPoint(clientX, clientY) {
    return {
      x: Math.round(Number(clientX) || 0),
      y: Math.round(Number(clientY) || 0)
    };
  }

  function isOverlayInteractive(event) {
    return Boolean(
      event &&
      dom.root &&
      (
        event.target === dom.root ||
        (typeof event.composedPath === "function" && event.composedPath().includes(dom.root))
      )
    );
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

  function nextAnimationFrame() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
})();


















