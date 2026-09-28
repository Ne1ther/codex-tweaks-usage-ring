import "./style.css";
import { findUsageQuery, getResetCreditsQueryKey } from "./usage-query.js";
import { selectRingWindows, ringTone } from "./rings.js";

export function activate({ api, id, root }) {
  // 只读取 Codex 已经维护的用量 Query Cache，不自行请求账号接口。
  // 侧栏用量块只包含包拥有的节点；停用或重新注入时会完整移除。

  const RUNTIME_KEY = Symbol.for(
    "codex-tweaks.codex-usage-ring.runtime",
  );
  const ROOT_MARKER = "data-codex-tweaks-usage-ring-active";
  const WIDGET_MARKER = "data-codex-tweaks-usage-ring";
  const VALUE_MARKER = "data-codex-tweaks-usage-ring-value";
  const TOOLTIP_MARKER = "data-codex-tweaks-usage-ring-tooltip";
  const TOOLTIP_HEADER_MARKER =
    "data-codex-tweaks-usage-ring-tooltip-header";
  const TOOLTIP_TITLE_MARKER =
    "data-codex-tweaks-usage-ring-tooltip-title";
  const TOOLTIP_UPDATED_MARKER =
    "data-codex-tweaks-usage-ring-tooltip-updated";
  const TOOLTIP_GROUP_MARKER =
    "data-codex-tweaks-usage-ring-tooltip-group";
  const TOOLTIP_GROUP_TITLE_MARKER =
    "data-codex-tweaks-usage-ring-tooltip-group-title";
  const TOOLTIP_ROW_MARKER =
    "data-codex-tweaks-usage-ring-tooltip-row";
  const TOOLTIP_RESET_MARKER =
    "data-codex-tweaks-usage-ring-tooltip-reset";
  const TOOLTIP_ID = `${id || "codex-usage-ring"}-details`;
  const FIBER_PROPERTY_PREFIXES = ["__reactFiber$", "__reactContainer$"];
  const RESET_CREDITS_STORAGE_KEY =
    "codex-tweaks:codex-usage-ring:reset-credits";
  const RESET_CREDITS_CACHE_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
  const SCAN_INTERVAL_MS = 10000;
  const runtimeHost = root ?? document.documentElement;

  const previousRuntime = runtimeHost[RUNTIME_KEY];
  const inheritedResetCreditsData =
    previousRuntime?.getResetCreditsCache?.() ?? null;
  previousRuntime?.cleanup?.();

  let disposed = false;
  let syncQueued = false;
  let activeWidget = null;
  let activeTooltip = null;
  let detachWidgetListeners = null;
  let cancelPendingNavigation = null;
  let navigationInProgress = false;
  let tooltipRequested = false;
  let queryClient = null;
  let unsubscribeQueryCache = null;
  let lastRenderKey = null;
  let lastUsageScope = null;
  let lastResetCreditsData =
    inheritedResetCreditsData ?? readPersistedResetCreditsData();
  let warnedAboutQueryData = false;

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    if (element.closest('[inert], [aria-hidden="true"]')) return false;
    if (getComputedStyle(element).visibility !== "visible") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getButtonMode(button) {
    // 字标 SVG 的 title 与屏幕阅读器文本都会进入 textContent。
    const label = button.getAttribute("aria-label") ?? "";
    const mode = label.match(/(?:[：:]\s*)(Codex|ChatGPT)\s*$/)?.[1];
    if (mode) return mode;
    const text = button.textContent.trim();
    return text === "Codex" || text === "ChatGPT" ? text : null;
  }

  function getModeButton() {
    return (
      [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => isVisible(button) && getButtonMode(button),
      ) ?? null
    );
  }

  function getPlacement() {
    const rail = [...document.querySelectorAll('nav[data-app-navigation-rail]')]
      .find(isVisible);
    if (!rail) return null;

    // The flexible navigation list precedes the account/help footer. Insert
    // only our own node as a sibling, leaving React-owned elements in place.
    const footer = [...rail.children].filter((element) =>
      element !== activeWidget &&
      isVisible(element) &&
      getComputedStyle(element).position !== "absolute"
    ).at(-1);
    if (!footer?.querySelector("button")) return null;
    return { rail, footer };
  }

  function isQueryClient(value) {
    return (
      value != null &&
      typeof value === "object" &&
      typeof value.getQueryCache === "function" &&
      typeof value.getQueryData === "function"
    );
  }

  function getReactFibers(element) {
    if (!(element instanceof Element)) return [];

    return Object.getOwnPropertyNames(element)
      .filter((name) =>
        FIBER_PROPERTY_PREFIXES.some((prefix) => name.startsWith(prefix)),
      )
      .map((name) => element[name]?.current ?? element[name])
      .filter(Boolean);
  }

  function getFiberRoot(fiber) {
    let current = fiber;
    while (current?.return) current = current.return;
    return current ?? null;
  }

  function findQueryClient() {
    const modeButton = getModeButton();
    if (!modeButton) return null;

    const roots = new Set();
    for (const element of [modeButton, modeButton.closest("nav")]) {
      for (const fiber of getReactFibers(element)) {
        const fiberRoot = getFiberRoot(fiber);
        if (fiberRoot) roots.add(fiberRoot);
        if (fiberRoot?.alternate) roots.add(fiberRoot.alternate);
      }
    }

    const seen = new Set();
    const stack = [...roots];
    let remainingFibers = 100000;

    while (stack.length > 0 && remainingFibers > 0) {
      const fiber = stack.pop();
      remainingFibers -= 1;
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);

      const props = fiber.memoizedProps ?? fiber.pendingProps;
      for (const candidate of [props?.client, props?.queryClient]) {
        if (isQueryClient(candidate)) return candidate;
      }

      let hook = fiber.memoizedState;
      let remainingHooks = 80;
      while (hook && remainingHooks > 0) {
        remainingHooks -= 1;
        const state = hook.memoizedState;
        if (isQueryClient(state)) return state;
        if (Array.isArray(state)) {
          const client = state.find(isQueryClient);
          if (client) return client;
        }
        hook = hook.next;
      }

      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }

    return null;
  }

  function disconnectQueryClient() {
    unsubscribeQueryCache?.();
    unsubscribeQueryCache = null;
    queryClient = null;
  }

  function connectQueryClient() {
    if (queryClient) return queryClient;

    const nextClient = findQueryClient();
    if (!nextClient) return null;

    queryClient = nextClient;
    const queryCache = queryClient.getQueryCache();
    if (typeof queryCache?.subscribe === "function") {
      // Chat streaming updates many unrelated queries. Only quota changes
      // should wake the ring renderer.
      const unsubscribe = queryCache.subscribe((event) => {
        const key = event?.query?.queryKey;
        if (!Array.isArray(key) ||
          key.some((part) => part === "rate-limit-status" || part === "rate-limit-reset-credits")) {
          queueSync();
        }
      });
      unsubscribeQueryCache =
        typeof unsubscribe === "function" ? unsubscribe : null;
    }
    lastRenderKey = null;
    return queryClient;
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
  }

  function isNear(value, target) {
    return Math.abs(value - target) <= target * 0.05;
  }

  function getLocaleStrings() {
    const locale = document.documentElement.lang || navigator.language || "en";
    const isChinese = locale.toLowerCase().startsWith("zh");

    return {
      locale,
      isChinese,
      generalUsage: isChinese ? "通用使用限额" : "General usage limits",
      additionalUsage: isChinese ? "其他使用限额" : "Additional usage limits",
      usage: isChinese ? "用量" : "Usage",
      openUsage: isChinese
        ? "打开使用情况和计费"
        : "Open usage and billing",
      refreshedAt: isChinese ? "刷新于" : "Refreshed",
      resetCards: isChinese ? "手动重置" : "Manual resets",
      available: isChinese ? "可用" : "Available",
      cards: isChinese ? "张" : "cards",
      nearestExpiry: isChinese ? "最近到期" : "Nearest expiry",
      expiryUnavailable: isChinese
        ? "过期时间尚未加载"
        : "Expiry has not loaded",
      loading: isChinese ? "用量加载中" : "Loading usage",
      unavailable: isChinese ? "用量不可用" : "Usage unavailable",
      noLimits: isChinese ? "暂无用量限额" : "No usage limits",
      remaining: isChinese ? "剩余" : "remaining",
      resetsAt: isChinese ? "重置于" : "resets",
    };
  }

  function describeWindow(seconds, strings) {
    const hour = 60 * 60;
    const day = 24 * hour;
    const week = 7 * day;
    const month = 30 * day;

    if (isNear(seconds, 5 * hour)) {
      return { compact: "5h", full: strings.isChinese ? "5 小时" : "5 hour" };
    }
    if (isNear(seconds, day)) {
      return { compact: strings.isChinese ? "日" : "day", full: strings.isChinese ? "每日" : "daily" };
    }
    if (isNear(seconds, week)) {
      return { compact: strings.isChinese ? "周" : "wk", full: strings.isChinese ? "每周" : "weekly" };
    }
    if (isNear(seconds, month)) {
      return { compact: strings.isChinese ? "月" : "mo", full: strings.isChinese ? "每月" : "monthly" };
    }

    const hours = Math.max(1, Math.round(seconds / hour));
    return {
      compact: `${hours}h`,
      full: strings.isChinese ? `${hours} 小时` : `${hours} hour`,
    };
  }

  function getRateLimitWindows(rateLimit, strings) {
    if (!rateLimit || typeof rateLimit !== "object") return [];

    const byDuration = new Map();
    for (const windowData of [
      rateLimit.primary_window,
      rateLimit.secondary_window,
    ]) {
      const usedPercent = Number(windowData?.used_percent);
      const seconds = Number(windowData?.limit_window_seconds);
      if (!Number.isFinite(usedPercent) || !Number.isFinite(seconds)) continue;
      if (seconds <= 0) continue;

      const current = byDuration.get(seconds);
      if (current && current.usedPercent >= usedPercent) continue;
      byDuration.set(seconds, {
        ...describeWindow(seconds, strings),
        remainingPercent: Math.round(clampPercent(100 - usedPercent)),
        resetAt: Number(windowData?.reset_at),
        seconds,
        usedPercent,
      });
    }

    return [...byDuration.values()].sort(
      (left, right) => left.seconds - right.seconds,
    );
  }

  function getLimitGroups(data, strings) {
    const groups = [];
    const generalWindows = getRateLimitWindows(data?.rate_limit, strings);
    if (generalWindows.length > 0) {
      groups.push({
        id: "general",
        label: strings.generalUsage,
        windows: generalWindows,
      });
    }

    const additionalLimits = Array.isArray(data?.additional_rate_limits)
      ? data.additional_rate_limits
      : [];
    additionalLimits.forEach((entry, index) => {
      const windows = getRateLimitWindows(entry?.rate_limit, strings);
      if (windows.length === 0) return;

      const label =
        (typeof entry?.limit_name === "string" && entry.limit_name.trim()) ||
        (typeof entry?.metered_feature === "string" &&
          entry.metered_feature.trim()) ||
        strings.additionalUsage;
      groups.push({ id: `additional-${index}`, label, windows });
    });

    return groups;
  }

  function getDisplayWindow(windows) {
    const fiveHours = 5 * 60 * 60;
    const oneWeek = 7 * 24 * 60 * 60;

    return (
      windows.find((windowData) => isNear(windowData.seconds, fiveHours)) ??
      windows.find((windowData) => isNear(windowData.seconds, oneWeek)) ??
      windows[0] ??
      null
    );
  }

  function getResetCredits(data, cachedResetCredits) {
    const usageCount = Number(
      data?.rate_limit_reset_credits?.available_count,
    );
    const cachedCount = Number(cachedResetCredits?.available_count);
    const availableCount = Number.isFinite(usageCount)
      ? Math.max(0, Math.round(usageCount))
      : Number.isFinite(cachedCount)
        ? Math.max(0, Math.round(cachedCount))
        : 0;

    if (availableCount === 0) {
      return { availableCount, nearestExpiresAt: null };
    }

    const credits = Array.isArray(cachedResetCredits?.credits)
      ? cachedResetCredits.credits
      : [];
    const nearestExpiresAt = credits
      .filter(
        (credit) =>
          credit?.status === "available" &&
          credit?.is_supported_by_plan !== false,
      )
      .map((credit) => Date.parse(credit?.expires_at))
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > Date.now())
      .sort((left, right) => left - right)[0];

    return {
      availableCount,
      nearestExpiresAt: Number.isFinite(nearestExpiresAt)
        ? nearestExpiresAt
        : null,
    };
  }

  function readPersistedResetCreditsData() {
    try {
      const persisted = JSON.parse(
        window.localStorage.getItem(RESET_CREDITS_STORAGE_KEY) ?? "null",
      );
      if (!persisted || typeof persisted !== "object") return null;
      if (
        !Number.isFinite(persisted.savedAt) ||
        Date.now() - persisted.savedAt > RESET_CREDITS_CACHE_MAX_AGE_MS
      ) {
        window.localStorage.removeItem(RESET_CREDITS_STORAGE_KEY);
        return null;
      }
      return {
        available_count: persisted.availableCount,
        credits: Array.isArray(persisted.credits) ? persisted.credits : [],
      };
    } catch {
      return null;
    }
  }

  function persistResetCreditsData(data) {
    try {
      const availableCount = Number(data?.available_count);
      const credits = Array.isArray(data?.credits)
        ? data.credits.map((credit) => ({
            expires_at: credit?.expires_at ?? null,
            is_supported_by_plan: credit?.is_supported_by_plan !== false,
            status: credit?.status ?? null,
          }))
        : [];
      window.localStorage.setItem(
        RESET_CREDITS_STORAGE_KEY,
        JSON.stringify({
          availableCount: Number.isFinite(availableCount)
            ? Math.max(0, Math.round(availableCount))
            : 0,
          credits,
          savedAt: Date.now(),
        }),
      );
    } catch {
      // 无痕或受限存储环境下仍可继续使用当前内存数据。
    }
  }

  function clearPersistedResetCreditsData() {
    try {
      window.localStorage.removeItem(RESET_CREDITS_STORAGE_KEY);
    } catch {
      // 清理在受限存储环境中无需阻止包停用。
    }
  }

  function getUsageViewModel() {
    const strings = getLocaleStrings();
    const client = connectQueryClient();
    if (!client) return { state: "loading", strings };

    try {
      const usageQuery = findUsageQuery(client);
      const usageScope = usageQuery
        ? JSON.stringify(usageQuery.queryKey.slice(1))
        : null;
      if (usageScope !== lastUsageScope) {
        lastUsageScope = usageScope;
        lastResetCreditsData = null;
        clearPersistedResetCreditsData();
      }
      const queryState = usageQuery?.state;
      const data = queryState?.data;
      if (!data) {
        return {
          state: queryState?.status === "error" ? "error" : "loading",
          strings,
        };
      }

      const groups = getLimitGroups(data, strings);
      const generalWindows =
        groups.find((group) => group.id === "general")?.windows ?? [];
      const displayWindow = getDisplayWindow(generalWindows);
      const resetCreditsData = client.getQueryData(
        getResetCreditsQueryKey(usageQuery),
      );
      const currentResetCreditCount = Number(
        data?.rate_limit_reset_credits?.available_count,
      );
      if (Number.isFinite(currentResetCreditCount) && currentResetCreditCount <= 0) {
        lastResetCreditsData = null;
        clearPersistedResetCreditsData();
      } else if (resetCreditsData && typeof resetCreditsData === "object") {
        lastResetCreditsData = resetCreditsData;
        persistResetCreditsData(resetCreditsData);
      }
      const resetCredits = getResetCredits(data, lastResetCreditsData);

      return {
        state: displayWindow ? "ready" : "empty",
        displayWindow,
        groups,
        refreshing: queryState?.fetchStatus === "fetching",
        resetCredits,
        strings,
        updatedAt: Number(queryState?.dataUpdatedAt),
      };
    } catch (error) {
      if (!warnedAboutQueryData) {
        warnedAboutQueryData = true;
        console.warn(
          "[Codex Tweaks] 无法读取 Codex 用量缓存；客户端内部结构可能已变化。",
          error,
        );
      }
      return { state: "error", strings };
    }
  }

  function formatResetTime(resetAt, locale) {
    if (!Number.isFinite(resetAt)) return null;
    const date = new Date(resetAt * 1000);
    if (!Number.isFinite(date.getTime())) return null;

    return new Intl.DateTimeFormat(locale, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function formatExpiryTime(expiresAt, locale) {
    if (!Number.isFinite(expiresAt)) return null;
    const date = new Date(expiresAt);
    if (!Number.isFinite(date.getTime())) return null;

    return new Intl.DateTimeFormat(locale, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  }

  function formatUpdatedTime(updatedAt, locale) {
    if (!Number.isFinite(updatedAt)) return null;
    const date = new Date(updatedAt);
    if (!Number.isFinite(date.getTime())) return null;

    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }

  function getDetailedLabel(viewModel) {
    const { strings } = viewModel;
    if (viewModel.state === "loading") return strings.loading;
    if (viewModel.state === "error") return strings.unavailable;
    if (viewModel.state === "empty") return strings.noLimits;

    const groupLabels = viewModel.groups.map((group) => {
      const windows = group.windows.map((windowData) => {
        const resetTime = formatResetTime(windowData.resetAt, strings.locale);
        const remaining = strings.isChinese
          ? `${windowData.full} ${windowData.remainingPercent}% ${strings.remaining}`
          : `${windowData.full} ${windowData.remainingPercent}% ${strings.remaining}`;
        return resetTime
          ? `${remaining}${strings.isChinese ? "，" : ", "}${strings.resetsAt} ${resetTime}`
          : remaining;
      });
      return `${group.label}${strings.isChinese ? "：" : ": "}${windows.join(
        strings.isChinese ? "；" : "; ",
      )}`;
    });

    const cardCount = strings.isChinese
      ? `${strings.available} ${viewModel.resetCredits.availableCount} ${strings.cards}`
      : `${strings.available}: ${viewModel.resetCredits.availableCount}`;
    const expiryTime = formatExpiryTime(
      viewModel.resetCredits.nearestExpiresAt,
      strings.locale,
    );
    const resetCards = expiryTime
      ? `${strings.resetCards}${strings.isChinese ? "：" : ": "}${cardCount}${
          strings.isChinese ? "，" : ", "
        }${strings.nearestExpiry} ${expiryTime}`
      : `${strings.resetCards}${strings.isChinese ? "：" : ": "}${cardCount}`;

    return [...groupLabels, resetCards].join(strings.isChinese ? "。" : ". ");
  }

  function positionTooltip() {
    if (!activeWidget?.isConnected || !activeTooltip?.isConnected) return;

    const anchor =
      activeWidget.querySelector(`[${VALUE_MARKER}]`) ?? activeWidget;
    const anchorRect = anchor.getBoundingClientRect();
    const widgetRect = activeWidget.getBoundingClientRect();
    const tooltipRect = activeTooltip.getBoundingClientRect();
    const edgePadding = 12;
    const gap = 8;

    const maxLeft = Math.max(
      edgePadding,
      window.innerWidth - tooltipRect.width - edgePadding,
    );
    const left = Math.max(edgePadding, Math.min(anchorRect.right + gap, maxLeft));
    const maxTop = Math.max(edgePadding, window.innerHeight - tooltipRect.height - edgePadding);
    const top = Math.max(edgePadding, Math.min(widgetRect.top, maxTop));

    activeTooltip.style.left = `${Math.round(left)}px`;
    activeTooltip.style.top = `${Math.round(top)}px`;
  }

  function showTooltip() {
    tooltipRequested = true;
    const tooltip = activeTooltip;
    if (!tooltip?.isConnected) return;
    if (disposed || !tooltipRequested || activeTooltip !== tooltip) return;
    positionTooltip();
    tooltip.setAttribute("data-visible", "");
  }

  function hideTooltip() {
    tooltipRequested = false;
    activeTooltip?.removeAttribute("data-visible");
  }

  function disposeTooltip() {
    activeTooltip?.remove();
    activeTooltip = null;
  }

  function dispatchPointerClick(element) {
    if (!(element instanceof HTMLElement)) return;
    const pointerOptions = {
      bubbles: true,
      button: 0,
      pointerType: "mouse",
    };
    const mouseOptions = { bubbles: true, button: 0 };
    element.dispatchEvent(new PointerEvent("pointerdown", pointerOptions));
    element.dispatchEvent(new MouseEvent("mousedown", mouseOptions));
    element.dispatchEvent(new PointerEvent("pointerup", pointerOptions));
    element.dispatchEvent(new MouseEvent("mouseup", mouseOptions));
    element.dispatchEvent(new MouseEvent("click", mouseOptions));
  }

  function getUsageMenuItem() {
    return (
      [...document.querySelectorAll('[role="menuitem"]')].find((item) => {
        const text = item.textContent.trim();
        return text.startsWith("使用情况") || /^Usage(?:\s|$)/i.test(text);
      }) ?? null
    );
  }

  function waitForUsageMenuItem() {
    const current = getUsageMenuItem();
    if (current) return Promise.resolve(current);

    return new Promise((resolve) => {
      let settled = false;
      let timeoutID = null;
      const observer = new MutationObserver(() => {
        const item = getUsageMenuItem();
        if (item) finish(item);
      });

      function finish(item) {
        if (settled) return;
        settled = true;
        observer.disconnect();
        if (timeoutID != null) window.clearTimeout(timeoutID);
        if (cancelPendingNavigation === cancel) {
          cancelPendingNavigation = null;
        }
        resolve(item);
      }

      function cancel() {
        finish(null);
      }

      cancelPendingNavigation?.();
      cancelPendingNavigation = cancel;
      observer.observe(document.body, { childList: true, subtree: true });
      timeoutID = window.setTimeout(() => finish(null), 1500);
    });
  }

  async function openUsageSettings() {
    if (disposed || navigationInProgress) return;
    navigationInProgress = true;
    hideTooltip();

    try {
      let usageItem = getUsageMenuItem();
      if (!usageItem) {
        const profileButton = [
          ...document.querySelectorAll("button[aria-label]"),
        ].find((button) =>
          /个人资料菜单|profile menu/i.test(
            button.getAttribute("aria-label") ?? "",
          ),
        );
        if (!(profileButton instanceof HTMLElement)) return;
        dispatchPointerClick(profileButton);
        usageItem = await waitForUsageMenuItem();
      }

      if (!disposed && usageItem instanceof HTMLElement) {
        dispatchPointerClick(usageItem);
      }
    } finally {
      navigationInProgress = false;
    }
  }

  function createWidget() {
    const widget = document.createElement("button");
    widget.type = "button";
    widget.setAttribute(WIDGET_MARKER, "");
    // Metal + Beam must leave this independent data control untouched.
    widget.setAttribute("data-codex-tweaks-mb-ignore", "");
    const rings = document.createElement("span");
    rings.setAttribute(VALUE_MARKER, "");
    widget.append(rings);

    const controller = new AbortController();
    widget.addEventListener("mouseenter", showTooltip, {
      signal: controller.signal,
    });
    widget.addEventListener("mouseleave", hideTooltip, {
      signal: controller.signal,
    });
    widget.addEventListener("focus", showTooltip, {
      signal: controller.signal,
    });
    widget.addEventListener("blur", hideTooltip, {
      signal: controller.signal,
    });
    widget.addEventListener("click", openUsageSettings, {
      signal: controller.signal,
    });
    detachWidgetListeners = () => controller.abort();
    return widget;
  }

  function makeRing(index) {
    const slot = document.createElement("span");
    slot.className = "ct-usage-ring-meter";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 36 36");
    svg.setAttribute("aria-hidden", "true");
    const gradientID = `${id || "ct-usage-ring"}-gradient-${index}`;
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const gradient = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
    gradient.id = gradientID;
    gradient.setAttribute("x1", "0%");
    gradient.setAttribute("y1", "100%");
    gradient.setAttribute("x2", "100%");
    gradient.setAttribute("y2", "0%");
    for (const offset of ["0%", "100%"]) {
      const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      stop.setAttribute("offset", offset);
      gradient.append(stop);
    }
    defs.append(gradient);
    svg.append(defs);
    for (const className of ["track", "progress"]) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("class", `ct-usage-ring-${className}`);
      circle.setAttribute("cx", "18");
      circle.setAttribute("cy", "18");
      circle.setAttribute("r", "15");
      if (className === "progress") {
        circle.setAttribute("pathLength", "100");
        circle.setAttribute("stroke", `url(#${gradientID})`);
      }
      svg.append(circle);
    }
    const percent = document.createElement("span");
    percent.className = "ct-usage-ring-percent";
    const label = document.createElement("span");
    label.className = "ct-usage-ring-label";
    slot.append(svg, percent, label);
    return slot;
  }

  function updateRings(windows) {
    const container = activeWidget.querySelector(`[${VALUE_MARKER}]`);
    const key = windows.map((windowData) => windowData.seconds).join(",");
    if (container.dataset.windows !== key) {
      container.replaceChildren(...windows.map((_, index) => makeRing(index)));
      container.dataset.windows = key;
    }
    [...container.children].forEach((slot, index) => {
      const windowData = windows[index];
      const remaining = windowData.remainingPercent;
      slot.dataset.tone = ringTone(remaining);
      slot.querySelector(".ct-usage-ring-progress").style.strokeDashoffset = String(100 - remaining);
      slot.querySelector(".ct-usage-ring-percent").textContent = `${remaining}%`;
      slot.querySelector(".ct-usage-ring-label").textContent = windowData.compact;
    });
    activeWidget.dataset.rings = String(windows.length);
  }

  function renderWidget() {
    if (!activeWidget?.isConnected) return;

    const viewModel = getUsageViewModel();
    const renderKey = JSON.stringify({
      displayWindow: viewModel.displayWindow,
      groups: viewModel.groups,
      locale: viewModel.strings.locale,
      refreshing: viewModel.refreshing,
      resetCredits: viewModel.resetCredits,
      state: viewModel.state,
      updatedAt: viewModel.updatedAt,
    });
    if (renderKey === lastRenderKey) return;
    lastRenderKey = renderKey;

    const detailedLabel = getDetailedLabel(viewModel);
    disposeTooltip();
    activeWidget.setAttribute("data-state", viewModel.state);
    activeWidget.hidden = viewModel.state !== "ready";
    activeWidget.toggleAttribute(
      "data-refreshing",
      viewModel.refreshing === true,
    );

    if (viewModel.state !== "ready") {
      activeWidget.removeAttribute("aria-describedby");
      activeWidget.setAttribute("aria-label", detailedLabel);
      activeWidget.tabIndex = -1;
      return;
    }

    const generalWindows = viewModel.groups.find((group) => group.id === "general")?.windows ?? [];
    const ringWindows = selectRingWindows(generalWindows);
    updateRings(ringWindows);

    const tooltip = document.createElement("span");
    tooltip.id = TOOLTIP_ID;
    tooltip.setAttribute(TOOLTIP_MARKER, "");
    tooltip.setAttribute("role", "tooltip");

    const tooltipHeader = document.createElement("span");
    tooltipHeader.setAttribute(TOOLTIP_HEADER_MARKER, "");

    const tooltipTitle = document.createElement("strong");
    tooltipTitle.textContent = viewModel.strings.usage;
    tooltipTitle.setAttribute(TOOLTIP_TITLE_MARKER, "");
    tooltipHeader.append(tooltipTitle);

    const updatedTime = formatUpdatedTime(
      viewModel.updatedAt,
      viewModel.strings.locale,
    );
    if (updatedTime) {
      const updated = document.createElement("span");
      updated.textContent = `${viewModel.strings.refreshedAt} ${updatedTime}`;
      updated.setAttribute(TOOLTIP_UPDATED_MARKER, "");
      tooltipHeader.append(updated);
    }
    tooltip.append(tooltipHeader);

    for (const groupData of viewModel.groups) {
      const group = document.createElement("span");
      group.setAttribute(TOOLTIP_GROUP_MARKER, groupData.id);

      const groupTitle = document.createElement("strong");
      groupTitle.textContent = groupData.label;
      groupTitle.setAttribute(TOOLTIP_GROUP_TITLE_MARKER, "");
      group.append(groupTitle);

      for (const windowData of groupData.windows) {
        const row = document.createElement("span");
        row.setAttribute(TOOLTIP_ROW_MARKER, "");

        const summary = document.createElement("span");
        summary.textContent = viewModel.strings.isChinese
          ? `${windowData.full} · ${windowData.remainingPercent}% 剩余`
          : `${windowData.full} · ${windowData.remainingPercent}% remaining`;
        row.append(summary);

        const resetTime = formatResetTime(
          windowData.resetAt,
          viewModel.strings.locale,
        );
        if (resetTime) {
          const reset = document.createElement("span");
          reset.textContent = `${viewModel.strings.resetsAt} ${resetTime}`;
          reset.setAttribute(TOOLTIP_RESET_MARKER, "");
          row.append(reset);
        }

        group.append(row);
      }

      tooltip.append(group);
    }

    const resetCardsGroup = document.createElement("span");
    resetCardsGroup.setAttribute(TOOLTIP_GROUP_MARKER, "reset-cards");

    const resetCardsTitle = document.createElement("strong");
    resetCardsTitle.textContent = viewModel.strings.resetCards;
    resetCardsTitle.setAttribute(TOOLTIP_GROUP_TITLE_MARKER, "");
    resetCardsGroup.append(resetCardsTitle);

    const resetCardsRow = document.createElement("span");
    resetCardsRow.setAttribute(TOOLTIP_ROW_MARKER, "");
    const resetCardsCount = document.createElement("span");
    resetCardsCount.textContent = viewModel.strings.isChinese
      ? `${viewModel.strings.available} ${viewModel.resetCredits.availableCount} ${viewModel.strings.cards}`
      : `${viewModel.strings.available}: ${viewModel.resetCredits.availableCount}`;
    resetCardsRow.append(resetCardsCount);

    if (viewModel.resetCredits.availableCount > 0) {
      const expiry = document.createElement("span");
      const expiryTime = formatExpiryTime(
        viewModel.resetCredits.nearestExpiresAt,
        viewModel.strings.locale,
      );
      expiry.textContent = expiryTime
        ? `${viewModel.strings.nearestExpiry} ${expiryTime}`
        : viewModel.strings.expiryUnavailable;
      expiry.setAttribute(TOOLTIP_RESET_MARKER, "");
      resetCardsRow.append(expiry);
    }

    resetCardsGroup.append(resetCardsRow);
    tooltip.append(resetCardsGroup);

    activeTooltip = tooltip;
    document.body.append(tooltip);

    activeWidget.setAttribute(
      "aria-label",
      `${detailedLabel}${viewModel.strings.isChinese ? "。" : ". "}${viewModel.strings.openUsage}`,
    );
    activeWidget.setAttribute("aria-describedby", TOOLTIP_ID);
    activeWidget.tabIndex = 0;
    if (tooltipRequested) showTooltip();
  }

  function disposeWidget() {
    detachWidgetListeners?.();
    detachWidgetListeners = null;
    cancelPendingNavigation?.();
    cancelPendingNavigation = null;
    navigationInProgress = false;
    tooltipRequested = false;
    disposeTooltip();
    activeWidget?.remove();
    activeWidget = null;
    lastRenderKey = null;
    document.documentElement.removeAttribute(ROOT_MARKER);
  }

  function syncUsageOverview() {
    syncQueued = false;
    if (disposed || !document.body) return;

    const placement = getPlacement();
    if (!placement) {
      disposeWidget();
      return;
    }

    if (
      !activeWidget?.isConnected ||
      activeWidget.parentElement !== placement.rail
    ) {
      disposeWidget();
      activeWidget = createWidget();
      lastRenderKey = null;
    }

    if (activeWidget.nextElementSibling !== placement.footer) {
      placement.rail.insertBefore(activeWidget, placement.footer);
    }
    document.documentElement.setAttribute(ROOT_MARKER, "");
    renderWidget();
  }

  function queueSync() {
    if (disposed || syncQueued) return;
    syncQueued = true;
    queueMicrotask(syncUsageOverview);
  }

  const pageObserver = new MutationObserver((records) => {
    if (records.some((record) => {
      const target = record.target;
      if (target.closest?.(`[${WIDGET_MARKER}],[${TOOLTIP_MARKER}]`)) return false;
      if (record.type === "attributes") return target.matches?.('button[aria-haspopup="menu"]');
      if (target.closest?.('nav[data-app-navigation-rail]')) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) =>
        node.nodeType === 1 &&
        (node.matches?.('nav[data-app-navigation-rail]') ||
          node.querySelector?.('nav[data-app-navigation-rail]')),
      );
    })) queueSync();
  });
  pageObserver.observe(document.documentElement, {
    attributeFilter: ["aria-label"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  const scanInterval = window.setInterval(queueSync, SCAN_INTERVAL_MS);

  function cleanup() {
    if (disposed) return;
    disposed = true;
    pageObserver.disconnect();
    window.clearInterval(scanInterval);
    disconnectQueryClient();
    disposeWidget();
    clearPersistedResetCreditsData();

    if (runtimeHost[RUNTIME_KEY]?.cleanup === cleanup) {
      delete runtimeHost[RUNTIME_KEY];
    }
  }

  if (lastResetCreditsData) {
    persistResetCreditsData(lastResetCreditsData);
  }
  runtimeHost[RUNTIME_KEY] = {
    cleanup,
    getResetCreditsCache: () => lastResetCreditsData,
  };
  api.registerCleanup(cleanup);
  syncUsageOverview();
}
