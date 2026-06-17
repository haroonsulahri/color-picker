(() => {
  "use strict";

  if (window.__HAROONE_COLOR_PICKER__) {
    window.__HAROONE_COLOR_PICKER__.reconnect();
    return;
  }

  const ROOT_ID = "haroone-color-picker-root";
  const CURSOR_STYLE_ID = "haroone-color-picker-cursor-style";
  const ACTIVE_CURSOR_ATTR = "data-hcp-picker-active";
  const HOVER_SETTLE_DELAY = 72;
  const VIEWPORT_REFRESH_DELAY = 120;
  const RETICLE_SIZE = 34;
  const PANEL_EDGE_PADDING = 14;
  const PANEL_ANCHOR_GAP = 30;
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
    const layoutWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const layoutHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const visualWidth = Math.max(1, viewport ? viewport.width : layoutWidth);
    const visualHeight = Math.max(1, viewport ? viewport.height : layoutHeight);

    return {
      width: layoutWidth,
      height: layoutHeight,
      visualWidth,
      visualHeight,
      offsetLeft: viewport ? viewport.offsetLeft : 0,
      offsetTop: viewport ? viewport.offsetTop : 0,
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0,
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
    positionPanel(sample);
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
    const normalized = normalizeClientPoint(clientX, clientY, viewport);
    const captureSpace = getCaptureCoordinateSpace(viewport);
    const imageX = mapCssPixelToCapture(normalized.captureX, captureSpace.width, state.capture.width);
    const imageY = mapCssPixelToCapture(normalized.captureY, captureSpace.height, state.capture.height);
    const scaleX = state.capture.width / captureSpace.width;
    const scaleY = state.capture.height / captureSpace.height;

    return {
      clientX: normalized.clientX,
      clientY: normalized.clientY,
      pageX: normalized.pageX,
      pageY: normalized.pageY,
      imageX,
      imageY,
      scaleX,
      scaleY
    };
  }

  function normalizeClientPoint(clientX, clientY, viewport) {
    const clientBounds = getPanelViewportBounds(viewport);
    const rawX = Number.isFinite(Number(clientX)) ? Number(clientX) : 0;
    const rawY = Number.isFinite(Number(clientY)) ? Number(clientY) : 0;
    const clientClampedX = clamp(rawX, 0, Math.max(0, clientBounds.width - 0.01));
    const clientClampedY = clamp(rawY, 0, Math.max(0, clientBounds.height - 0.01));
    const captureSpace = getCaptureCoordinateSpace(viewport);
    const captureX = clamp(clientClampedX - captureSpace.originX, 0, Math.max(0, captureSpace.width - 0.01));
    const captureY = clamp(clientClampedY - captureSpace.originY, 0, Math.max(0, captureSpace.height - 0.01));

    return {
      clientX: clientClampedX,
      clientY: clientClampedY,
      captureX,
      captureY,
      pageX: (viewport.scrollX || 0) + clientClampedX,
      pageY: (viewport.scrollY || 0) + clientClampedY
    };
  }

  function getCaptureCoordinateSpace(viewport) {
    const useVisualViewport = Boolean(
      viewport &&
      (
        Math.abs((viewport.visualWidth || viewport.width) - viewport.width) > 0.5 ||
        Math.abs((viewport.visualHeight || viewport.height) - viewport.height) > 0.5 ||
        Math.abs(viewport.offsetLeft || 0) > 0.5 ||
        Math.abs(viewport.offsetTop || 0) > 0.5
      )
    );

    if (useVisualViewport) {
      return {
        width: Math.max(1, viewport.visualWidth || viewport.width || 1),
        height: Math.max(1, viewport.visualHeight || viewport.height || 1),
        originX: viewport.offsetLeft || 0,
        originY: viewport.offsetTop || 0
      };
    }

    return {
      width: Math.max(1, viewport.width || 1),
      height: Math.max(1, viewport.height || 1),
      originX: 0,
      originY: 0
    };
  }

  function mapCssPixelToCapture(clientValue, viewportSize, captureSize) {
    if (captureSize <= 1 || viewportSize <= 1) {
      return 0;
    }

    const clamped = clamp(clientValue, 0, Math.max(0, viewportSize - 0.01));
    return clamp(Math.floor((clamped / viewportSize) * captureSize), 0, captureSize - 1);
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
      notes: ["Pixel sampled from a fresh visible-tab capture with device-pixel mapping."],
      elementMeta: {
        tagName: "pixel",
        id: "",
        className: "",
        label: `Viewport ${Math.round(sample.clientX)}, ${Math.round(sample.clientY)}`,
        path: `Image ${sample.imageX}, ${sample.imageY} - ${sample.scaleX.toFixed(2)}x`
      }
    };
  }

  function clearStatusTimer() {
    clearTimeout(state.statusTimer);
    state.statusTimer = null;
  }

  function getDefaultStatusText() {
    return state.lockedPoint && state.selection && state.selection.primary
      ? "Locked sample"
      : "Sampling live pixels";
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
    dom.hint.textContent = active ? formatHex(active, state.settings.showAlpha) : "No color selected";
    dom.path.textContent = selection && selection.elementMeta
      ? `${selection.elementMeta.label} - ${selection.elementMeta.path}`
      : "Waiting for page movement";
    dom.zoomLabel.textContent = selection && selection.elementMeta ? selection.elementMeta.label : "Pixel matrix";
    dom.zoomCoords.textContent = selection && selection.elementMeta ? selection.elementMeta.path : "Image pixel";

    if (active) {
      dom.note.textContent = isLocked
        ? `${baseNote} Sample pinned.`
        : `${baseNote} Live preview.`;
    } else {
      dom.note.textContent = "Ready.";
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
    const sourceSize = 15;
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
    const focusX = sample.imageX - startX;
    const focusY = sample.imageY - startY;
    const centerX = offsetX + focusX * cellSize;
    const centerY = offsetY + focusY * cellSize;
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

    ctx.strokeStyle = "rgba(255, 255, 255, 0.94)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(crosshairX, offsetY);
    ctx.lineTo(crosshairX, offsetY + gridSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(offsetX, crosshairY);
    ctx.lineTo(offsetX + gridSize, crosshairY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(20, 184, 166, 0.98)";
    ctx.lineWidth = 2;
    ctx.strokeRect(centerX + 1, centerY + 1, Math.max(1, cellSize - 2), Math.max(1, cellSize - 2));
    ctx.strokeStyle = "rgba(15, 23, 42, 0.82)";
    ctx.lineWidth = 1;
    ctx.strokeRect(centerX + 4, centerY + 4, Math.max(1, cellSize - 8), Math.max(1, cellSize - 8));
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
    dom.reticle.style.left = `${roundCss(sample.clientX)}px`;
    dom.reticle.style.top = `${roundCss(sample.clientY)}px`;
  }

  function positionPanel(anchorPoint) {
    if (!dom.panel || dom.panel.hidden) {
      return;
    }

    const viewport = getViewportMetrics();
    const bounds = getPanelViewportBounds(viewport);
    if (bounds.width <= 420) {
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
    const padding = PANEL_EDGE_PADDING;
    const offset = PANEL_ANCHOR_GAP;
    const panelWidth = Math.min(dom.panel.offsetWidth || 340, Math.max(260, bounds.width - padding * 2));
    const panelHeight = dom.panel.offsetHeight || 320;
    const placement = choosePanelPlacement(anchorX, anchorY, panelWidth, panelHeight, bounds, padding, offset);

    dom.panel.style.top = `${Math.round(placement.top)}px`;
    dom.panel.style.right = "auto";
    dom.panel.style.bottom = "auto";
    dom.panel.style.left = `${Math.round(placement.left)}px`;
  }

  function getPanelViewportBounds(viewport) {
    return {
      width: Math.max(1, viewport.width || window.innerWidth || 1),
      height: Math.max(1, viewport.height || window.innerHeight || 1)
    };
  }

  function choosePanelPlacement(anchorX, anchorY, panelWidth, panelHeight, bounds, padding, offset) {
    const candidates = [
      { left: anchorX + offset, top: anchorY + offset },
      { left: anchorX - panelWidth - offset, top: anchorY + offset },
      { left: anchorX + offset, top: anchorY - panelHeight - offset },
      { left: anchorX - panelWidth - offset, top: anchorY - panelHeight - offset }
    ];

    const fitting = candidates.find((candidate) => (
      candidate.left >= padding &&
      candidate.top >= padding &&
      candidate.left + panelWidth <= bounds.width - padding &&
      candidate.top + panelHeight <= bounds.height - padding
    ));

    if (fitting) {
      return fitting;
    }

    const clampedCandidates = candidates
      .map((candidate) => ({
        left: clamp(candidate.left, padding, Math.max(padding, bounds.width - panelWidth - padding)),
        top: clamp(candidate.top, padding, Math.max(padding, bounds.height - panelHeight - padding))
      }));

    const nonCovering = clampedCandidates.find((candidate) => !isPointInsideRect(anchorX, anchorY, {
      left: candidate.left,
      top: candidate.top,
      right: candidate.left + panelWidth,
      bottom: candidate.top + panelHeight
    }));

    const chosen = nonCovering || clampedCandidates
      .sort((a, b) => distanceFromAnchor(b, anchorX, anchorY) - distanceFromAnchor(a, anchorX, anchorY))[0];

    return chosen || {
      left: padding,
      top: padding
    };
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

    flashStatus("Picker reset.", 1600, "default");
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
          <div class="hcp-brand">
            <span class="hcp-dot"></span>
            <span class="hcp-brand-copy">
              <span>Haroone</span>
              <strong>Pixel lens</strong>
            </span>
          </div>
          <button type="button" class="hcp-close" aria-label="Close picker">&times;</button>
        </div>
        <div class="hcp-readout">
          <div class="hcp-status">Sampling live pixels</div>
          <div class="hcp-hint">No color selected</div>
          <div class="hcp-path">Waiting for page movement</div>
        </div>
        <div class="hcp-sample-strip">
          <canvas class="hcp-zoom" width="110" height="110" aria-hidden="true"></canvas>
          <div class="hcp-zoom-meta">
            <strong class="hcp-zoom-label">Pixel matrix</strong>
            <span class="hcp-zoom-coords">Image pixel</span>
            <span class="hcp-zoom-note">Fresh capture on lock</span>
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
        <div class="hcp-note">Ready.</div>
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
        color: #f7fbf8;
        font-family: "Aptos", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
        font-size: 16px;
        line-height: 1.4;
        -webkit-font-smoothing: antialiased;
        text-size-adjust: 100%;
        font-variant-numeric: tabular-nums;
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
        border: 1px solid rgba(255, 255, 255, 0.98);
        background:
          radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.96) 0 2px, transparent 3px),
          conic-gradient(from 90deg, rgba(20, 184, 166, 0.95), rgba(245, 158, 11, 0.96), rgba(244, 63, 94, 0.92), rgba(20, 184, 166, 0.95));
        box-shadow:
          0 0 0 2px rgba(17, 19, 21, 0.72),
          0 10px 26px rgba(17, 19, 21, 0.26),
          0 0 0 6px rgba(20, 184, 166, 0.12);
        pointer-events: none;
        transform: translate(-50%, -50%);
        will-change: left, top;
      }
      .hcp-reticle-grid {
        position: absolute;
        inset: 5px;
        border-radius: 999px;
        background:
          linear-gradient(90deg, transparent calc(50% - 0.5px), rgba(17, 19, 21, 0.72) calc(50% - 0.5px), rgba(17, 19, 21, 0.72) calc(50% + 0.5px), transparent calc(50% + 0.5px)),
          linear-gradient(0deg, transparent calc(50% - 0.5px), rgba(17, 19, 21, 0.72) calc(50% - 0.5px), rgba(17, 19, 21, 0.72) calc(50% + 0.5px), transparent calc(50% + 0.5px));
      }
      .hcp-reticle-dot {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: #f8fafc;
        box-shadow: 0 0 0 2px rgba(17, 19, 21, 0.9), 0 0 0 4px rgba(255, 255, 255, 0.42);
        transform: translate(-50%, -50%);
      }
      .hcp-panel {
        position: fixed;
        top: 16px;
        right: 16px;
        left: auto;
        bottom: auto;
        width: min(382px, calc(100vw - 28px));
        max-width: calc(100vw - 32px);
        max-height: calc(100vh - 16px);
        overflow: auto;
        overscroll-behavior: contain;
        padding: 12px;
        border-radius: 12px;
        border: 1px solid rgba(212, 218, 209, 0.2);
        background:
          linear-gradient(145deg, rgba(18, 21, 22, 0.96), rgba(31, 34, 34, 0.94)),
          radial-gradient(circle at 10% 0%, rgba(20, 184, 166, 0.16), transparent 38%);
        color: #f7fbf8;
        pointer-events: auto;
        box-shadow: 0 24px 60px rgba(17, 19, 21, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.08);
        backdrop-filter: blur(18px) saturate(1.25);
      }
      :host([data-theme="light"]) .hcp-panel {
        background:
          linear-gradient(145deg, rgba(255, 252, 245, 0.98), rgba(244, 247, 242, 0.96)),
          radial-gradient(circle at 10% 0%, rgba(20, 184, 166, 0.12), transparent 38%);
        color: #171a1c;
        border-color: rgba(68, 78, 72, 0.14);
        box-shadow: 0 22px 54px rgba(37, 44, 40, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.78);
      }
      .hcp-head, .hcp-brand, .hcp-swatch, .hcp-actions, .hcp-sample-strip { display: flex; align-items: center; }
      .hcp-head { justify-content: space-between; gap: 12px; margin-bottom: 10px; }
      .hcp-brand { gap: 9px; min-width: 0; }
      .hcp-brand-copy { display: grid; gap: 1px; min-width: 0; }
      .hcp-brand-copy span { font-size: 10px; color: #98a8a1; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 700; }
      .hcp-brand-copy strong { font-size: 14px; letter-spacing: 0; line-height: 1.1; }
      :host([data-theme="light"]) .hcp-brand-copy span { color: #66746c; }
      .hcp-dot {
        width: 18px;
        height: 18px;
        border-radius: 7px;
        background: conic-gradient(from 45deg, #14b8a6, #f59e0b, #f43f5e, #14b8a6);
        box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.34), 0 8px 18px rgba(20, 184, 166, 0.16);
        flex: 0 0 auto;
      }
      .hcp-close {
        appearance: none;
        -webkit-appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        padding: 0;
        border: 0;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.08);
        color: inherit;
        font: inherit;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        transition: background 160ms ease, box-shadow 160ms ease, transform 160ms ease, color 160ms ease;
      }
      .hcp-close:hover,
      .hcp-close:focus-visible,
      .hcp-close:active {
        background: rgba(255, 255, 255, 0.14);
        color: #ffffff;
        box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.16);
        transform: translateY(-1px);
      }
      :host([data-theme="light"]) .hcp-close:hover,
      :host([data-theme="light"]) .hcp-close:focus-visible,
      :host([data-theme="light"]) .hcp-close:active {
        background: rgba(232, 237, 229, 0.98);
        color: #171a1c;
        box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.14);
      }
      .hcp-close:focus-visible { outline: none; }
      .hcp-readout {
        padding: 11px;
        border-radius: 10px;
        border: 1px solid rgba(212, 218, 209, 0.16);
        background: rgba(255, 255, 255, 0.06);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
      }
      :host([data-theme="light"]) .hcp-readout { background: rgba(255, 255, 255, 0.62); border-color: rgba(68, 78, 72, 0.12); }
      .hcp-status { font-size: 11px; font-weight: 800; line-height: 1.25; color: #8ce4d7; letter-spacing: 0.08em; text-transform: uppercase; }
      :host([data-theme="light"]) .hcp-status { color: #087d72; }
      .hcp-status[data-tone="locked"] { color: #f6c85f; }
      .hcp-status[data-tone="success"] { color: #9ae6b4; }
      :host([data-theme="light"]) .hcp-status[data-tone="success"] { color: #15803d; }
      .hcp-status[data-tone="error"] { color: #fda4af; }
      :host([data-theme="light"]) .hcp-status[data-tone="error"] { color: #be123c; }
      .hcp-path, .hcp-note, .hcp-zoom-note { font-size: 11px; color: #aebbb5; }
      :host([data-theme="light"]) .hcp-path, :host([data-theme="light"]) .hcp-note, :host([data-theme="light"]) .hcp-zoom-note { color: #66746c; }
      .hcp-hint { margin-top: 5px; font-size: 22px; line-height: 1.05; font-weight: 850; letter-spacing: 0; word-break: break-word; }
      .hcp-path { margin-top: 6px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
      .hcp-sample-strip { gap: 12px; margin-top: 12px; align-items: stretch; flex-wrap: wrap; }
      .hcp-zoom {
        width: 126px;
        height: 126px;
        border-radius: 10px;
        border: 1px solid rgba(212, 218, 209, 0.18);
        background: linear-gradient(45deg, rgba(148, 163, 184, 0.22) 25%, transparent 25%), linear-gradient(-45deg, rgba(148, 163, 184, 0.22) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148, 163, 184, 0.22) 75%), linear-gradient(-45deg, transparent 75%, rgba(148, 163, 184, 0.22) 75%);
        background-size: 12px 12px;
        background-position: 0 0, 0 6px, 6px -6px, -6px 0;
        image-rendering: pixelated;
        flex: 0 0 auto;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05);
      }
      .hcp-zoom-meta { display: flex; flex-direction: column; justify-content: center; gap: 5px; min-width: 0; flex: 1; }
      .hcp-zoom-label { font-size: 13px; letter-spacing: 0; }
      .hcp-zoom-coords { font-size: 11px; color: inherit; opacity: 0.85; }
      .hcp-primary { margin-top: 12px; align-items: center; }
      .hcp-swatch { gap: 10px; border: 1px solid rgba(212, 218, 209, 0.16); border-radius: 10px; padding: 10px; background: rgba(255, 255, 255, 0.06); min-width: 0; }
      :host([data-theme="light"]) .hcp-swatch { background: rgba(255, 255, 255, 0.68); border-color: rgba(68, 78, 72, 0.12); }
      .hcp-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .hcp-meta strong { font-size: 11px; color: #aebbb5; }
      :host([data-theme="light"]) .hcp-meta strong { color: #66746c; }
      .hcp-meta span { font-size: 13px; font-weight: 750; opacity: 0.96; overflow-wrap: anywhere; }
      .hcp-chip { width: 26px; height: 26px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.38); background: linear-gradient(135deg, #d7dfea 0%, #edf2f7 100%); flex: 0 0 auto; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08); }
      .hcp-primary .hcp-chip { width: 36px; height: 36px; }
      .hcp-actions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
      .hcp-actions button {
        appearance: none;
        -webkit-appearance: none;
        width: 100%;
        min-width: 0;
        height: 38px;
        padding: 0 10px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        cursor: pointer;
        background: linear-gradient(135deg, #0f9f8d 0%, #0d766f 100%);
        color: #fff;
        font: inherit;
        font-size: 12px;
        font-weight: 800;
        text-decoration: none;
        box-shadow: none;
        outline: none;
        overflow: hidden;
        transition: filter 160ms ease, box-shadow 160ms ease, transform 160ms ease, opacity 160ms ease, background 160ms ease;
      }
      .hcp-actions button:hover,
      .hcp-actions button:focus-visible,
      .hcp-actions button:active {
        background: linear-gradient(135deg, #12b8a4 0%, #0d766f 100%);
        color: #fff;
        box-shadow: 0 10px 22px rgba(13, 118, 111, 0.25), 0 0 0 3px rgba(20, 184, 166, 0.12);
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
      .hcp-actions .hcp-reset { background: rgba(255, 255, 255, 0.07); color: inherit; border: 1px solid rgba(212, 218, 209, 0.18); }
      :host([data-theme="light"]) .hcp-actions .hcp-reset { background: rgba(255, 255, 255, 0.8); color: #171a1c; border-color: rgba(68, 78, 72, 0.14); }
      .hcp-actions .hcp-reset:hover,
      .hcp-actions .hcp-reset:focus-visible,
      .hcp-actions .hcp-reset:active {
        background: rgba(255, 255, 255, 0.12);
        color: inherit;
        border: 1px solid rgba(212, 218, 209, 0.24);
        box-shadow: 0 8px 18px rgba(17, 19, 21, 0.14), 0 0 0 3px rgba(212, 218, 209, 0.1);
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
          border-radius: 12px;
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
          border-radius: 10px;
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
    const x = Number(clientX);
    const y = Number(clientY);
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      clientX: Number.isFinite(x) ? x : 0,
      clientY: Number.isFinite(y) ? y : 0
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

  function roundCss(value) {
    return String(Math.round(Number(value || 0) * 100) / 100);
  }

  function distanceFromAnchor(candidate, anchorX, anchorY) {
    const dx = candidate.left - anchorX;
    const dy = candidate.top - anchorY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function isPointInsideRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
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


















