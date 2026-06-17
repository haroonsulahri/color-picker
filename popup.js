(() => {
  "use strict";

  const state = {
    session: null,
    activeTab: null,
    busy: false
  };

  const dom = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheDom();
    bindEvents();
    await refresh();
  }

  function cacheDom() {
    dom.statusText = document.getElementById("statusText");
    dom.startBtn = document.getElementById("startBtn");
    dom.stopBtn = document.getElementById("stopBtn");
  }

  function bindEvents() {
    dom.startBtn.addEventListener("click", async () => {
      await runAction("START_PICKER", "Picker started.");
    });

    dom.stopBtn.addEventListener("click", async () => {
      await runAction("STOP_PICKER", "Picker stopped.");
    });
  }

  async function runAction(type, successMessage) {
    setBusy(true);

    try {
      await send(type);
      await refresh(successMessage);
    } catch (error) {
      setStatus(toMessage(error), true);
      setBusy(false);
    }
  }

  async function refresh(message) {
    try {
      const response = await send("GET_STATE");
      state.session = response.session || null;
      state.activeTab = response.activeTab || null;
      state.busy = false;
      renderState(message);
    } catch (error) {
      setStatus(toMessage(error), true);
      setBusy(false);
    }
  }

  function renderState(message) {
    const { supported, isPicking } = renderButtons();

    if (!state.activeTab) {
      setStatus("Open a webpage tab.", true);
      return;
    }

    if (!supported) {
      setStatus("Chrome blocks this page.", true);
      return;
    }

    setStatus(message || (isPicking ? "Picker is running." : "Ready."), false);
  }

  function setBusy(busy) {
    state.busy = Boolean(busy);
    document.body.dataset.busy = busy ? "true" : "false";
    renderButtons();
  }

  function renderButtons() {
    const supported = Boolean(state.activeTab && state.activeTab.supported);
    const isPicking = Boolean(
      state.session &&
      state.session.isPicking &&
      state.activeTab &&
      state.session.tabId === state.activeTab.id
    );

    dom.startBtn.disabled = state.busy || !supported || isPicking;
    dom.stopBtn.disabled = state.busy || !isPicking;
    dom.startBtn.classList.toggle("hidden", isPicking);
    dom.stopBtn.classList.toggle("hidden", !isPicking);

    return { supported, isPicking };
  }

  function setStatus(text, isError) {
    dom.statusText.textContent = text;
    dom.statusText.dataset.error = isError ? "true" : "false";
    state.busy = false;
    document.body.dataset.busy = "false";
    renderButtons();
  }

  async function send(type) {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Request failed.");
    }
    return response;
  }

  function toMessage(error) {
    if (!error) {
      return "Unknown error";
    }
    return typeof error === "string" ? error : error.message || String(error);
  }
})();
