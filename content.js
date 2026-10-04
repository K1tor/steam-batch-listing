(() => {
  "use strict";
  if (window.__sblLoaded) return;
  window.__sblLoaded = true;

  const ITEM_ID_RE = /^(\d+)_(\d+)_(\d+)$/; // 元素 id: appid_contextid_assetid
  const SELL_URL = "https://steamcommunity.com/market/sellitem/";
  const SYMBOLS = { 1: "$", 2: "£", 3: "€", 5: "₽", 7: "R$", 23: "¥" };

  /* 分类:用 Steam 物品标签的内部名自动归类 */
  const CAT_LABELS = {
    weapon: "枪械皮肤", knife: "刀具", gloves: "手套", case: "箱子/容器",
    sticker: "贴纸", key: "钥匙", music: "音乐盒", graffiti: "涂鸦",
    patch: "布章", agent: "特工", charm: "挂件", card: "卡牌",
    booster: "补充包", background: "资料背景", emoticon: "表情",
    community: "社区物品", other: "其他",
  };

  function classify(d) {
    const tags = d.tags || [];
    const type = tags.find((t) => t.category === "Type");
    if (type) {
      const n = d.market_hash_name || d.name || "";
      switch (type.internal_name) {
        case "Type_Knife": return "knife";
        case "Type_Gloves": return "gloves";
        case "Type_Container": return "case";
        case "Type_Sticker": return "sticker";
        case "Type_Key": return "key";
        case "Type_MusicKit": return "music";
        case "Type_Graffiti": return "graffiti";
        case "Type_Patch": return "patch";
        case "Type_Agent": return "agent";
        case "Type_Charm": return "charm";
        case "Type_Weapon": return n.startsWith("★") ? "knife" : "weapon";
        default: return "other";
      }
    }
    const ic = tags.find((t) => t.category === "item_class");
    if (ic) {
      const m = {
        item_class_2: "card", item_class_5: "card", item_class_3: "booster",
        item_class_1: "background", item_class_4: "emoticon",
      };
      return m[ic.internal_name] || "community";
    }
    const n = (d.market_hash_name || d.name || "").toLowerCase();
    if (/trading card|交换卡片|foil card/.test(n)) return "card";
    if (/case|capsule|package|胶囊|武器箱/.test(n)) return "case";
    if (/sticker|贴纸/.test(n)) return "sticker";
    return "other";
  }

  const state = {
    multiMode: false,
    selected: new Map(), // assetid -> { appid, contextid, assetid }
    running: false,
    stopFlag: false,
    armed: false,
    armTimer: 0,
    pageSteamId: null,
    currency: "",
    catFilter: null, // 当前分类,null = 全部
    currentInvKey: null, // "appid_ctx" -> invCache 键
    invCache: new Map(), // "appid_ctx" -> Map(assetid -> { name, marketable, cat })
    settings: { strategy: "market", fixedPrice: "", offset: "0", delay: "800" },
  };

  const ui = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (cents) =>
    (cents / 100).toFixed(2) + (state.currency ? " " + state.currency : "");

  /* ---------------- 会话信息 ---------------- */

  let cachedCookies = null;
  async function getCookies() {
    if (cachedCookies) return cachedCookies;
    try {
      const res = await chrome.runtime.sendMessage({ type: "getSteamCookies" });
      if (res && res.sessionid) {
        cachedCookies = res;
        return res;
      }
    } catch (e) {
      /* 扩展重载后连接失效,退回 document.cookie */
    }
    const jar = document.cookie;
    const pick = (name) => {
      const m = jar.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
      return m ? decodeURIComponent(m[1]) : null;
    };
    cachedCookies = { sessionid: pick("sessionid"), login: pick("steamLoginSecure") };
    return cachedCookies;
  }

  async function getOwnSteamId() {
    const c = await getCookies();
    if (c && c.login) {
      try {
        const first = decodeURIComponent(c.login).split("||")[0];
        if (/^\d{17}$/.test(first)) return first;
      } catch (e) {}
    }
    return state.pageSteamId;
  }

  function detectPageContext() {
    const html = document.documentElement.innerHTML;
    const m = html.match(/g_steamID\s*=\s*["'](\d{17})["']/);
    state.pageSteamId = m ? m[1] : null;
    const w = html.match(/"wallet_currency"\s*:\s*(\d+)/);
    if (w && SYMBOLS[+w[1]]) state.currency = SYMBOLS[+w[1]];
  }

  /* ---------------- 日志 ---------------- */

  function logLine(cls, text) {
    if (!ui.log) return;
    const div = document.createElement("div");
    div.className = cls;
    div.textContent = text;
    ui.log.appendChild(div);
    while (ui.log.childElementCount > 300) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  /* ---------------- 库存元素选择 ---------------- */

  function getItemElements() {
    return Array.from(document.querySelectorAll(".item")).filter((el) =>
      ITEM_ID_RE.test(el.id)
    );
  }

  function applyMarks() {
    const inv = state.currentInvKey ? state.invCache.get(state.currentInvKey) : null;
    for (const el of getItemElements()) {
      const assetid = el.id.split("_")[2];
      const on = state.selected.has(assetid);
      if (on !== el.classList.contains("sbl-item-selected"))
        el.classList.toggle("sbl-item-selected", on);
      // 分类过滤:不在当前分类的物品置灰(仅在分类数据已加载时)
      const info = inv && inv.get(assetid);
      const dim = !!(state.catFilter && info && info.cat !== state.catFilter);
      if (dim !== el.classList.contains("sbl-dim")) el.classList.toggle("sbl-dim", dim);
    }
  }

  function updateCount() {
    if (ui.badge) ui.badge.textContent = String(state.selected.size);
  }

  function markSold(assetid) {
    for (const el of getItemElements()) {
      if (el.id.split("_")[2] === assetid) el.classList.add("sbl-item-sold");
    }
  }

  // 多选模式下拦截物品点击(捕获阶段,先于 Steam 自己的 React 处理器)
  document.addEventListener(
    "click",
    (e) => {
      if (!state.multiMode || state.running) return;
      const el = e.target && e.target.closest ? e.target.closest(".item") : null;
      if (!el || !ITEM_ID_RE.test(el.id)) return;
      e.preventDefault();
      e.stopPropagation();
      const m = el.id.match(ITEM_ID_RE);
      const assetid = m[3];
      if (state.selected.has(assetid)) state.selected.delete(assetid);
      else state.selected.set(assetid, { appid: m[1], contextid: m[2], assetid });
      applyMarks();
      updateCount();
    },
    true
  );

  let scanTimer = 0;
  function observeDom() {
    const mo = new MutationObserver(() => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(applyMarks, 250);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", () =>
      setTimeout(() => {
        // 切换游戏/库存后:清空分类过滤并重新加载分类数据
        state.catFilter = null;
        state.currentInvKey = null;
        renderCats(null);
        applyMarks();
        if (state.multiMode) ensureInv();
      }, 300)
    );
  }

  /* ---------------- 分类数据 ---------------- */

  function currentAppCtx() {
    const el = getItemElements()[0];
    if (el) {
      const m = el.id.match(ITEM_ID_RE);
      return m[1] + "_" + m[2];
    }
    const hm = (location.hash || "").match(/^#(\d+)_(\d+)/);
    return hm ? hm[1] + "_" + hm[2] : null;
  }

  async function ensureInv() {
    const key = currentAppCtx();
    if (!key) return null;
    if (state.invCache.has(key)) {
      state.currentInvKey = key;
      renderCats(key);
      applyMarks();
      return state.invCache.get(key);
    }
    const own = await getOwnSteamId();
    if (!own) {
      logLine("warn", "未检测到登录状态,无法加载分类");
      return null;
    }
    logLine("dim", "正在获取分类信息…");
    try {
      const [appid, ctx] = key.split("_");
      const inv = await fetchInventory(own, appid, ctx);
      state.invCache.set(key, inv);
      state.currentInvKey = key;
      renderCats(key);
      applyMarks();
      return inv;
    } catch (e) {
      logLine("err", "获取分类失败: " + e.message);
      return null;
    }
  }

  function renderCats(key) {
    state.currentInvKey = key || null;
    if (!ui.catRow) return;
    const inv = key ? state.invCache.get(key) : null;
    if (!inv) {
      ui.catRow.innerHTML = '<span class="tip">分类:开启多选后自动加载</span>';
      return;
    }
    const counts = {};
    let total = 0;
    for (const info of inv.values()) {
      counts[info.cat] = (counts[info.cat] || 0) + 1;
      total++;
    }
    const chips = [
      `<button class="cat ${!state.catFilter ? "on" : ""}" data-cat="all">全部 ${total}</button>`,
    ];
    Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a])
      .forEach((c) => {
        const label = CAT_LABELS[c] || c;
        chips.push(
          `<button class="cat ${state.catFilter === c ? "on" : ""}" data-cat="${c}">${label} ${counts[c]}</button>`
        );
      });
    ui.catRow.innerHTML = chips.join("");
  }

  /* ---------------- Steam 接口 ---------------- */

  async function fetchInventory(steamid, appid, ctx) {
    const map = new Map(); // assetid -> { name, marketable }
    let start = 0;
    for (let page = 0; page < 20; page++) {
      const url =
        "https://steamcommunity.com/inventory/" + steamid + "/" + appid + "/" + ctx +
        "?l=english&count=2000&start=" + start;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("库存接口 HTTP " + res.status);
      const data = await res.json();
      const assets = data.assets || [];
      const descs = new Map();
      for (const d of data.descriptions || [])
        descs.set(d.classid + "_" + (d.instanceid || "0"), d);
      for (const a of assets) {
        const d = descs.get(a.classid + "_" + (a.instanceid || "0"));
        if (d)
          map.set(a.assetid, {
            name: d.market_hash_name || d.name || a.assetid,
            marketable: d.marketable === 1,
            cat: classify(d),
          });
      }
      if (!assets.length) break;
      start += assets.length;
      if (data.total_inventory_count && map.size >= data.total_inventory_count) break;
    }
    return map;
  }

  // 兼容各语言的价格文本,如 "¥ 12.50" / "12,50€" / "$1,234.56"
  function parsePrice(str) {
    if (str == null) return null;
    let s = String(str).replace(/[^\d.,]/g, "");
    if (!s) return null;
    if (s.includes(",") && s.includes(".")) {
      s =
        s.lastIndexOf(",") > s.lastIndexOf(".")
          ? s.replace(/\./g, "").replace(/,/g, ".")
          : s.replace(/,/g, "");
    } else if (s.includes(",")) {
      const parts = s.split(",");
      s = parts[parts.length - 1].length === 2 ? s.replace(/,/g, ".") : s.replace(/,/g, "");
    }
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  }

  const priceCache = new Map();
  async function getLowestPrice(appid, name) {
    const key = appid + "|" + name;
    if (priceCache.has(key)) return priceCache.get(key);
    const url =
      "https://steamcommunity.com/market/priceoverview/?appid=" + appid +
      "&market_hash_name=" + encodeURIComponent(name);
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data || !data.success || !data.lowest_price) throw new Error("市场暂无挂单");
    const cents = Math.round(parsePrice(data.lowest_price) * 100);
    if (!Number.isFinite(cents) || cents <= 0)
      throw new Error("价格解析失败: " + data.lowest_price);
    priceCache.set(key, cents);
    return cents;
  }

  async function sellItem(sessionid, appid, ctx, assetid, priceCents) {
    const body = new URLSearchParams({
      sessionid,
      appid,
      contextid: ctx,
      assetid,
      amount: "1",
      price: String(priceCents),
    });
    let res;
    try {
      res = await fetch(SELL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: body.toString(),
        credentials: "include",
      });
    } catch (e) {
      return { ok: false, error: "网络错误 " + e.message, retryable: true };
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {}
    if (res.ok && data && data.success) {
      return { ok: true, needsConfirm: !!data.requires_confirmation };
    }
    const msg = (data && (data.message || data.detail)) || "HTTP " + res.status;
    return {
      ok: false,
      error: msg,
      retryable: res.status === 429 || res.status === 502 || res.status === 503,
    };
  }

  /* ---------------- 批量上架流程 ---------------- */

  function readSettings() {
    return {
      strategy: ui.strategy.value,
      fixedPrice: ui.fixedPrice.value.trim(),
      offset: ui.offset.value.trim(),
      delay: ui.delay.value.trim(),
    };
  }

  async function startListing() {
    if (state.running) return;
    const cookies = await getCookies();
    const own = await getOwnSteamId();
    if (!cookies.sessionid) {
      logLine("err", "未获取到 sessionid,请确认已在 steamcommunity.com 登录后刷新页面");
      return;
    }
    if (!own) {
      logLine("err", "未识别到 SteamID,请刷新页面重试");
      return;
    }
    if (state.pageSteamId && state.pageSteamId !== own) {
      logLine("err", "当前不是你自己的库存页,请先打开自己的库存");
      return;
    }

    const items = Array.from(state.selected.values());
    if (!items.length) {
      logLine("warn", "请先选择要上架的物品");
      return;
    }

    const st = readSettings();
    let fixedCents = 0;
    if (st.strategy === "fixed") {
      const v = parsePrice(st.fixedPrice);
      if (v == null || v <= 0) {
        logLine("err", "请输入有效的固定价格");
        return;
      }
      fixedCents = Math.max(3, Math.round(v * 100));
      if (Math.round(v * 100) < 3) logLine("warn", "价格低于最低价 0.03,已按 0.03 上架");
    }
    const offset =
      st.strategy === "market" ? Math.min(90, Math.max(0, parsePrice(st.offset) || 0)) : 0;
    const delay = Math.min(10000, Math.max(300, parseInt(st.delay, 10) || 800));

    state.running = true;
    state.stopFlag = false;
    setBusy(true);
    setProgress(0, 0);

    try {
      // 1. 按 app/context 分组读取库存元数据(名称、是否可售)
      const groups = new Map();
      for (const it of items) {
        const key = it.appid + "_" + it.contextid;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it.assetid);
      }
      const info = new Map();
      for (const [key, ids] of groups) {
        const [appid, ctx] = key.split("_");
        logLine("dim", "读取库存信息 " + appid + "/" + ctx + " (" + ids.length + " 件)…");
        try {
          const inv = await fetchInventory(own, appid, ctx);
          for (const id of ids) info.set(id, inv.get(id) || null);
        } catch (err) {
          logLine("err", "读取库存失败: " + err.message);
          for (const id of ids) info.set(id, null);
        }
        await sleep(300);
      }

      // 2. 过滤
      const jobs = [];
      for (const it of items) {
        const d = info.get(it.assetid);
        if (!d) {
          logLine("warn", "跳过 #" + it.assetid + ": 库存中未找到(可能已售出/转出)");
          continue;
        }
        if (!d.marketable) {
          logLine("warn", "跳过 " + d.name + ": 该物品不可出售");
          continue;
        }
        jobs.push({ ...it, name: d.name, price: 0 });
      }
      if (!jobs.length) {
        logLine("err", "没有可上架的物品");
        return;
      }

      // 3. 定价
      if (st.strategy === "fixed") {
        for (const j of jobs) j.price = fixedCents;
        logLine("dim", "固定价格: " + fmt(fixedCents) + " × " + jobs.length + " 件");
      } else {
        const names = Array.from(new Set(jobs.map((j) => j.name)));
        logLine("dim", "查询市场价格: " + names.length + " 种物品…");
        const byName = new Map();
        for (let i = 0; i < names.length; i++) {
          if (state.stopFlag) break;
          const n = names[i];
          try {
            const cents = await getLowestPrice(jobs.find((j) => j.name === n).appid, n);
            byName.set(n, cents);
            logLine("dim", "[" + (i + 1) + "/" + names.length + "] " + n + " 最低 " + fmt(cents));
          } catch (err) {
            byName.set(n, null);
            logLine("warn", "[" + (i + 1) + "/" + names.length + "] " + n + ": " + err.message);
          }
          if (i < names.length - 1) await sleep(300);
        }
        for (const j of jobs) {
          const cents = byName.get(j.name);
          if (!cents) continue;
          j.price = Math.max(3, Math.round(cents * (1 - offset / 100)));
        }
        const noPrice = jobs.filter((j) => !j.price).length;
        if (noPrice) logLine("warn", noPrice + " 件无市场价格,将跳过");
      }

      const sellable = jobs.filter((j) => j.price > 0);
      if (!sellable.length) {
        logLine("err", "没有可上架的物品");
        return;
      }

      // 4. 逐件上架
      logLine("info", "开始上架 " + sellable.length + " 件 (间隔 " + delay + "ms)…");
      let ok = 0,
        fail = 0,
        done = 0,
        hintConfirm = false;
      for (const j of sellable) {
        if (state.stopFlag) {
          logLine("warn", "已手动停止");
          break;
        }
        let result = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          result = await sellItem(cookies.sessionid, j.appid, j.contextid, j.assetid, j.price);
          if (result.ok) break;
          if (result.retryable && attempt < 3) {
            logLine("warn", j.name + ": " + result.error + ",5 秒后重试…");
            await sleep(5000);
          } else break;
        }
        done++;
        if (result && result.ok) {
          ok++;
          if (result.needsConfirm) hintConfirm = true;
          markSold(j.assetid);
          state.selected.delete(j.assetid);
          logLine("ok", "✅ " + j.name + " @ " + fmt(j.price));
        } else {
          fail++;
          logLine("err", "❌ " + j.name + ": " + (result ? result.error : "未知错误"));
        }
        updateCount();
        setProgress(done, sellable.length);
        if (done < sellable.length && !state.stopFlag)
          await sleep(delay + Math.random() * 250);
      }
      logLine("info", "完成: 成功 " + ok + ",失败 " + fail + (state.stopFlag ? "(已停止)" : ""));
      if (hintConfirm) logLine("warn", "部分挂单需要手机确认,请到 Steam 手机 App 处理");
      if (ok) logLine("dim", "建议刷新库存页查看最新状态");
    } finally {
      state.running = false;
      setBusy(false);
      disarmStart();
    }
  }

  /* ---------------- 面板 UI ---------------- */

  const HTML_TEXT =
    '<div class="panel">' +
    '<div class="head" id="head">' +
    '<span class="title">📦 批量上架</span>' +
    '<span class="badge" id="badge">0</span>' +
    '<button class="mini" id="collapse" title="折叠">−</button>' +
    "</div>" +
    '<div class="body" id="body">' +
    '<div class="row">' +
    '<button class="btn" id="multiBtn">开启多选</button>' +
    '<button class="btn" id="pageAll">全选本页</button>' +
    '<button class="btn" id="catAll">全选本类</button>' +
    '<button class="btn ghost" id="clearSel">清空</button>' +
    "</div>" +
    '<div class="cats" id="catRow"><span class="tip">分类:开启多选后自动加载</span></div>' +
    '<div class="row">' +
    '<span class="lbl">定价</span>' +
    '<select id="strategy">' +
    '<option value="market">市场最低价(可偏移)</option>' +
    '<option value="fixed">固定价格</option>' +
    "</select>" +
    "</div>" +
    '<div class="row" id="rowFixed" hidden>' +
    '<span class="lbl">价格</span>' +
    '<input id="fixedPrice" placeholder="钱包币种,如 12.50">' +
    "</div>" +
    '<div class="row" id="rowOffset">' +
    '<span class="lbl">偏移%</span>' +
    '<input id="offset" placeholder="0=同价">' +
    '<span class="tip">低于最低价 N%</span>' +
    "</div>" +
    '<div class="row">' +
    '<span class="lbl">间隔</span>' +
    '<input id="delay">' +
    '<span class="tip">ms/件(≥300)</span>' +
    "</div>" +
    '<div class="row">' +
    '<button class="btn primary" id="startBtn">开始上架</button>' +
    '<button class="btn danger" id="stopBtn" disabled>停止</button>' +
    "</div>" +
    '<div class="progress"><div id="bar"></div></div>' +
    '<div class="progtext" id="progText"></div>' +
    '<div class="log" id="log"></div>' +
    '<div class="hint">如开启“手机确认”,上架后需在 Steam App 确认 · 堆叠物品每次上架 1 个 · 建议先用 1 件试跑</div>' +
    "</div>" +
    "</div>";

  const CSS_TEXT = `
    :host { all: initial; position: fixed; right: 16px; bottom: 16px; width: 330px;
            z-index: 2147483647; font: 13px/1.45 "Segoe UI", "Microsoft YaHei", sans-serif; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }
    .panel { background: rgba(23,26,33,.97); border: 1px solid #3c4653; border-radius: 8px;
             box-shadow: 0 8px 28px rgba(0,0,0,.55); overflow: hidden; color: #c7d5e0; }
    .head { display: flex; align-items: center; gap: 8px; padding: 9px 12px;
            background: linear-gradient(90deg,#1b2838,#2a3f55); cursor: move;
            user-select: none; touch-action: none; }
    .title { font-weight: 600; color: #fff; flex: 1; }
    .badge { background: #66c0f4; color: #10202f; font-weight: 700; border-radius: 10px;
             padding: 0 8px; font-size: 12px; }
    .mini { background: transparent; border: none; color: #c7d5e0; cursor: pointer;
            font-size: 15px; width: 22px; height: 22px; border-radius: 4px; }
    .mini:hover { background: rgba(255,255,255,.12); }
    .body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .lbl { width: 42px; color: #8f98a0; flex: none; }
    .tip { color: #7c8791; font-size: 11px; }
    .cats { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .cat { background: #1d2733; border: 1px solid #3c4653; color: #c7d5e0;
           font-size: 11px; padding: 2px 8px; border-radius: 10px; cursor: pointer; }
    .cat:hover { border-color: #66c0f4; }
    .cat.on { background: #31648c; border-color: #66c0f4; color: #fff; }
    select, input { background: #10161d; color: #c7d5e0; border: 1px solid #3c4653;
                    border-radius: 4px; padding: 4px 7px; outline: none; }
    select:focus, input:focus { border-color: #66c0f4; }
    select { flex: 1; min-width: 0; }
    input { width: 70px; }
    #fixedPrice { flex: 1; width: auto; }
    .btn { background: #2e3a48; color: #c7d5e0; border: 1px solid #45505e;
           border-radius: 4px; padding: 5px 10px; cursor: pointer; }
    .btn:hover { background: #3a4859; }
    .btn.primary { background: linear-gradient(135deg,#4c8fbd,#31648c); color: #fff;
                   border-color: #5aa0d0; }
    .btn.danger { background: #7a3131; border-color: #a24141; color: #ffd7d7; }
    .btn.ghost { background: transparent; }
    .btn.on { background: #31648c; color: #fff; border-color: #66c0f4; }
    .btn.armed { animation: pulse 1s infinite; }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    @keyframes pulse { 50% { filter: brightness(1.35); } }
    .progress { height: 4px; background: #10161d; border-radius: 2px; overflow: hidden; }
    #bar { height: 100%; width: 0; background: #66c0f4; transition: width .2s; }
    .progtext { font-size: 11px; color: #7c8791; min-height: 13px; }
    .log { height: 130px; overflow-y: auto; background: #10161d; border: 1px solid #2e3540;
           border-radius: 4px; padding: 6px 8px; font-size: 12px; }
    .log div { margin: 1px 0; word-break: break-all; }
    .log .ok { color: #7fd99a; } .log .err { color: #ff7d7d; }
    .log .warn { color: #f0c674; } .log .dim { color: #7c8791; }
    .log .info { color: #66c0f4; }
    .hint { color: #66707a; font-size: 11px; }
  `;

  function buildPanel() {
    const host = document.createElement("div");
    host.id = "sbl-host";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS_TEXT;
    const holder = document.createElement("div");
    holder.innerHTML = HTML_TEXT;
    const panel = holder.querySelector(".panel");
    shadow.append(style, panel);
    document.body.appendChild(host);

    const q = (id) => shadow.getElementById(id);
    ui.head = q("head");
    ui.badge = q("badge");
    ui.body = q("body");
    ui.multiBtn = q("multiBtn");
    ui.pageAll = q("pageAll");
    ui.catAll = q("catAll");
    ui.catRow = q("catRow");
    ui.clearSel = q("clearSel");
    ui.strategy = q("strategy");
    ui.rowFixed = q("rowFixed");
    ui.rowOffset = q("rowOffset");
    ui.fixedPrice = q("fixedPrice");
    ui.offset = q("offset");
    ui.delay = q("delay");
    ui.startBtn = q("startBtn");
    ui.stopBtn = q("stopBtn");
    ui.bar = q("bar");
    ui.progText = q("progText");
    ui.log = q("log");
    ui.collapse = q("collapse");

    // 多选开关
    ui.multiBtn.addEventListener("click", () => {
      state.multiMode = !state.multiMode;
      ui.multiBtn.textContent = state.multiMode ? "多选中(点选物品)" : "开启多选";
      ui.multiBtn.classList.toggle("on", state.multiMode);
      document.body.classList.toggle("sbl-multimode", state.multiMode);
      if (state.multiMode && !state.currentInvKey) ensureInv();
    });

    // 分类芯片
    ui.catRow.addEventListener("click", (e) => {
      const b = e.target.closest("button.cat");
      if (!b || state.running) return;
      state.catFilter = b.dataset.cat === "all" ? null : b.dataset.cat;
      renderCats(state.currentInvKey);
      applyMarks();
    });

    // 全选本页可见物品(分类过滤生效时只选当前分类)
    ui.pageAll.addEventListener("click", () => {
      const inv = state.currentInvKey ? state.invCache.get(state.currentInvKey) : null;
      let added = 0;
      for (const el of getItemElements()) {
        if (el.offsetParent === null) continue; // 跳过隐藏分页
        const m = el.id.match(ITEM_ID_RE);
        const assetid = m[3];
        if (state.catFilter) {
          const info = inv && inv.get(assetid);
          if (!info || info.cat !== state.catFilter) continue;
        }
        if (!state.selected.has(assetid)) {
          state.selected.set(assetid, { appid: m[1], contextid: m[2], assetid });
          added++;
        }
      }
      applyMarks();
      updateCount();
      logLine("dim", "本页新增选择 " + added + " 件,共 " + state.selected.size + " 件");
    });

    // 全选当前分类(整个库存 DOM 范围内)
    ui.catAll.addEventListener("click", async () => {
      if (state.running) return;
      if (!state.catFilter) {
        logLine("warn", "先在分类里点选一个分类,再点「全选本类」");
        return;
      }
      if (!state.currentInvKey) {
        const inv = await ensureInv();
        if (!inv) {
          logLine("err", "无法获取库存分类信息");
          return;
        }
      }
      const inv = state.invCache.get(state.currentInvKey);
      let added = 0;
      for (const el of getItemElements()) {
        const m = el.id.match(ITEM_ID_RE);
        if (!m) continue;
        const assetid = m[3];
        const info = inv && inv.get(assetid);
        if (!info || info.cat !== state.catFilter) continue;
        if (!state.selected.has(assetid)) {
          state.selected.set(assetid, { appid: m[1], contextid: m[2], assetid });
          added++;
        }
      }
      applyMarks();
      updateCount();
      logLine("dim", "按分类新增选择 " + added + " 件,共 " + state.selected.size + " 件");
    });

    ui.clearSel.addEventListener("click", () => {
      state.selected.clear();
      applyMarks();
      updateCount();
    });

    ui.strategy.addEventListener("change", () => {
      syncStrategyRows();
      saveSettings();
    });
    for (const el of [ui.fixedPrice, ui.offset, ui.delay])
      el.addEventListener("change", saveSettings);

    // 两次点击确认,防误触
    ui.startBtn.addEventListener("click", () => {
      if (state.running) return;
      if (!state.armed) {
        const n = state.selected.size;
        if (!n) {
          logLine("warn", "请先选择要上架的物品");
          return;
        }
        state.armed = true;
        ui.startBtn.classList.add("armed");
        ui.startBtn.textContent = "确认上架 " + n + " 件?";
        state.armTimer = setTimeout(disarmStart, 6000);
        return;
      }
      disarmStart();
      startListing();
    });

    ui.stopBtn.addEventListener("click", () => {
      state.stopFlag = true;
      logLine("warn", "停止中,当前件完成后退出…");
    });

    ui.collapse.addEventListener("click", () => {
      const hidden = ui.body.style.display === "none";
      ui.body.style.display = hidden ? "" : "none";
      ui.collapse.textContent = hidden ? "−" : "+";
    });

    // 拖动面板
    let drag = null;
    ui.head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      ui.head.setPointerCapture(e.pointerId);
    });
    ui.head.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const x = Math.min(Math.max(0, e.clientX - drag.dx), innerWidth - host.offsetWidth);
      const y = Math.min(Math.max(0, e.clientY - drag.dy), innerHeight - host.offsetHeight);
      host.style.left = x + "px";
      host.style.top = y + "px";
    });
    ui.head.addEventListener("pointerup", () => (drag = null));
  }

  function syncStrategyRows() {
    const isFixed = ui.strategy.value === "fixed";
    ui.rowFixed.hidden = !isFixed;
    ui.rowOffset.hidden = isFixed;
  }

  function disarmStart() {
    state.armed = false;
    clearTimeout(state.armTimer);
    if (ui.startBtn) {
      ui.startBtn.classList.remove("armed");
      ui.startBtn.textContent = "开始上架";
    }
  }

  function setBusy(busy) {
    for (const el of [ui.multiBtn, ui.pageAll, ui.catAll, ui.catRow, ui.clearSel, ui.strategy, ui.fixedPrice, ui.offset, ui.delay, ui.startBtn])
      el.disabled = busy;
    ui.stopBtn.disabled = !busy;
  }

  function setProgress(done, total) {
    ui.bar.style.width = total ? (done / total) * 100 + "%" : "0";
    ui.progText.textContent = total ? done + "/" + total : "";
  }

  async function saveSettings() {
    state.settings = readSettings();
    try {
      await chrome.storage.local.set({ sblSettings: state.settings });
    } catch (e) {}
  }

  async function loadSettings() {
    try {
      const o = await chrome.storage.local.get("sblSettings");
      if (o && o.sblSettings) Object.assign(state.settings, o.sblSettings);
    } catch (e) {}
    ui.strategy.value = state.settings.strategy;
    ui.fixedPrice.value = state.settings.fixedPrice;
    ui.offset.value = state.settings.offset;
    ui.delay.value = state.settings.delay;
    syncStrategyRows();
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    detectPageContext();
    buildPanel();
    observeDom();
    await loadSettings();
    const own = await getOwnSteamId();
    if (!own) logLine("warn", "未检测到 Steam 登录,请先登录");
    else if (state.pageSteamId && state.pageSteamId !== own)
      logLine("warn", "当前是他人库存页,请打开自己的库存使用");
    else logLine("dim", "就绪:开启多选后点选物品,或用「全选本页」");
    setTimeout(() => {
      if (!getItemElements().length)
        logLine("warn", "未检测到库存物品:请确认当前在库存页;若 Steam 改版需更新选择器");
    }, 4000);
  }

  init();
})();
