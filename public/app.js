// Progestimo — vanilla JS SPA
// Data lives in localStorage. Views are hash-routed.

const STORE_KEY = "progestimo:v1";

const DEFAULT_STATE = {
  schemaVersion: 2,
  currencies: [
    { code: "USD", name: "Dollar", isPrimary: true, presets: [1, 5, 10, 20, 50, 100] },
    { code: "CDF", name: "Franc congolais", isPrimary: false, presets: [500, 1000, 2000, 5000, 10000, 20000] }
  ],
  // rate[code] = value of 1 unit in one shared internal reference.
  // Only ratios matter: rate[USD] / rate[CDF] = how many CDF equal 1 USD.
  // This keeps conversions stable when the primary display currency changes.
  rates: { USD: 1, CDF: 1 / 2800 },
  transactions: []
};

// --- Storage ---------------------------------------------------------------
function cleanCurrency(item, fallback) {
  const code = String(item?.code || fallback?.code || "").trim().toUpperCase();
  if (!code) return null;
  const presets = Array.isArray(item?.presets) ? item.presets : fallback?.presets;
  return {
    code,
    name: String(item?.name || fallback?.name || code).trim() || code,
    isPrimary: Boolean(item?.isPrimary),
    presets: (Array.isArray(presets) ? presets : [])
      .map(Number)
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b)
  };
}

function normalizeState(input) {
  const fallback = structuredClone(DEFAULT_STATE);
  const raw = input && typeof input === "object" ? input : {};
  const sourceCurrencies = Array.isArray(raw.currencies) && raw.currencies.length ? raw.currencies : fallback.currencies;
  const currencies = [];
  const seen = new Set();

  sourceCurrencies.forEach((item, index) => {
    const cleaned = cleanCurrency(item, fallback.currencies[index]);
    if (!cleaned || seen.has(cleaned.code)) return;
    seen.add(cleaned.code);
    currencies.push(cleaned);
  });
  if (!currencies.length) currencies.push(...fallback.currencies);

  let primarySeen = false;
  currencies.forEach((c, index) => {
    if (c.isPrimary && !primarySeen) primarySeen = true;
    else c.isPrimary = false;
    if (!primarySeen && index === currencies.length - 1) currencies[0].isPrimary = true;
  });

  const rawRates = raw.rates && typeof raw.rates === "object" ? raw.rates : {};
  const rates = {};
  const primaryCode = currencies.find((c) => c.isPrimary)?.code || currencies[0].code;
  const primaryRawRate = Number(rawRates[primaryCode]);
  const primaryRate = Number.isFinite(primaryRawRate) && primaryRawRate > 0
    ? primaryRawRate
    : (DEFAULT_STATE.rates[primaryCode] || 1);

  currencies.forEach((c) => {
    const rawRate = Number(rawRates[c.code]);
    if (Number.isFinite(rawRate) && rawRate > 0) rates[c.code] = rawRate;
    else if (DEFAULT_STATE.rates[c.code]) rates[c.code] = DEFAULT_STATE.rates[c.code];
    else rates[c.code] = primaryRate;
  });

  const transactions = Array.isArray(raw.transactions) ? raw.transactions
    .map((t) => ({
      id: String(t?.id || (crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random())),
      amount: Number(t?.amount),
      currency: String(t?.currency || primaryCode).trim().toUpperCase(),
      type: ["income", "expense", "loan", "borrow"].includes(t?.type) ? t.type : "expense",
      label: String(t?.label || ""),
      createdAt: Number(t?.createdAt) || Date.now(),
      repaid: Boolean(t?.repaid),
      repaidAt: Number(t?.repaidAt) || null
    }))
    .filter((t) => Number.isFinite(t.amount) && t.amount > 0 && currencies.some((c) => c.code === t.currency))
    : [];

  return { schemaVersion: DEFAULT_STATE.schemaVersion, currencies, rates, transactions };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return normalizeState(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch { return normalizeState(DEFAULT_STATE); }
}
function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

let state = loadState();

// --- Helpers ---------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    n.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
  }
  return n;
}
function primary() { return state.currencies.find(c => c.isPrimary) || state.currencies[0]; }
function currency(code) { return state.currencies.find(c => c.code === code); }
function rateOf(code) {
  const rate = Number(state.rates?.[code]);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}
function exchangeRate(from, to) { return rateOf(from) / rateOf(to); }
function setExchangeRate(from, to, oneUnitFromInTo) {
  const value = Number(oneUnitFromInTo);
  if (!Number.isFinite(value) || value <= 0 || !currency(from) || !currency(to)) return false;

  const p = primary().code;
  if (from === p && to !== p) {
    state.rates[to] = rateOf(from) / value;
  } else {
    state.rates[from] = value * rateOf(to);
  }
  return true;
}

function fmt(amount, code) {
  const opts = { maximumFractionDigits: code === "USD" ? 2 : 0, minimumFractionDigits: 0 };
  try { return new Intl.NumberFormat("fr-FR", opts).format(amount) + " " + code; }
  catch { return amount.toFixed(2) + " " + code; }
}
function convert(amount, from, to) {
  return amount * exchangeRate(from, to);
}

function totals() {
  const p = primary();
  let sumBase = 0;
  let loansBase = 0;
  let debtsBase = 0;
  for (const t of state.transactions) {
    const inBase = t.amount * rateOf(t.currency);
    if (t.type === "income") sumBase += inBase;
    else if (t.type === "expense") sumBase -= inBase;
    else if (t.type === "loan") {
      // Money out. If repaid, the debtor returned it -> net 0 on balance.
      if (!t.repaid) { sumBase -= inBase; loansBase += inBase; }
    }
    else if (t.type === "borrow") {
      // Money in. If repaid, we returned it -> net 0 on balance.
      if (!t.repaid) { sumBase += inBase; debtsBase += inBase; }
    }
  }
  const pRate = rateOf(p.code);
  return {
    balancePrimary: sumBase / pRate,
    loansOut: loansBase / pRate,
    debts: debtsBase / pRate
  };
}

function showToast(msg, actionLabel, onAction) {
  const t = $("#toast");
  t.textContent = "";
  t.appendChild(document.createTextNode(msg));
  if (actionLabel) {
    const b = el("button", { onclick: () => { onAction?.(); hideToast(); }, style: "margin-left:12px;font-weight:700;color:inherit;" }, actionLabel);
    t.appendChild(b);
  }
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(hideToast, 4000);
}
function hideToast() { $("#toast").classList.remove("show"); }

// --- Modal -----------------------------------------------------------------
function openModal({ title, message, confirmLabel = "Confirmer", cancelLabel = "Annuler", tone = "primary", onConfirm }) {
  const previouslyFocused = document.activeElement;
  const overlay = el("div", { class: "modal-overlay", role: "presentation" });
  const dialog = el("div", {
    class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "modal-title", tabindex: "-1"
  });
  const close = () => {
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 180);
    document.removeEventListener("keydown", onKey);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Enter") { e.preventDefault(); confirmBtn.click(); }
  };
  const cancelBtn = el("button", { class: "modal-btn ghost", onclick: close }, cancelLabel);
  const confirmBtn = el("button", {
    class: "modal-btn " + tone,
    onclick: () => { close(); onConfirm?.(); }
  }, confirmLabel);

  dialog.appendChild(el("h3", { id: "modal-title", class: "modal-title" }, title));
  if (message) dialog.appendChild(el("p", { class: "modal-message" }, message));
  dialog.appendChild(el("div", { class: "modal-actions" }, cancelBtn, confirmBtn));
  overlay.appendChild(dialog);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey);
  requestAnimationFrame(() => {
    overlay.classList.add("show");
    confirmBtn.focus();
  });
}

// --- Router ----------------------------------------------------------------
const routes = {
  "": renderHome,
  "home": renderHome,
  "new/income": () => renderEntry("income"),
  "new/expense": () => renderEntry("expense"),
  "new/loan": () => renderEntry("loan"),
  "new/borrow": () => renderEntry("borrow"),
  "history": renderHistory,
  "settings": renderSettings
};
function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const view = routes[hash] || routes[""];
  const root = $("#app");
  root.innerHTML = "";
  view(root);
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// --- Views -----------------------------------------------------------------
function topbar({ title, back = false, right } = {}) {
  return el("div", { class: "topbar" },
    back
      ? el("button", { class: "back", onclick: () => history.length > 1 ? history.back() : (location.hash = "") }, "‹ Retour")
      : el("h1", {}, title || "Progestimo"),
    right || el("button", { class: "icon-btn", onclick: () => location.hash = "#/settings", "aria-label": "Paramètres" }, "⚙")
  );
}

function renderHome(root) {
  const { balancePrimary, loansOut, debts } = totals();
  const p = primary();
  const others = state.currencies.filter(c => c.code !== p.code);

  root.appendChild(topbar());

  const balance = el("div", { class: "balance" },
    el("div", { class: "label" }, "Solde disponible"),
    el("div", { class: "main-amount" }, fmt(balancePrimary, p.code)),
    ...others.map(c => el("div", { class: "sub" }, "≈ " + fmt(convert(balancePrimary, p.code, c.code), c.code))),
    loansOut > 0 ? el("div", { class: "loans" }, "Prêts en cours : " + fmt(loansOut, p.code)) : null,
    debts > 0 ? el("div", { class: "loans debts" }, "Emprunts à rembourser : " + fmt(debts, p.code)) : null
  );
  root.appendChild(balance);

  root.appendChild(el("div", { class: "actions" },
    el("button", { class: "big-btn income", onclick: () => location.hash = "#/new/income" },
      el("span", { class: "icn" }, "↑"), el("span", {}, "Entrée")),
    el("button", { class: "big-btn expense", onclick: () => location.hash = "#/new/expense" },
      el("span", { class: "icn" }, "↓"), el("span", {}, "Dépense")),
    el("button", { class: "big-btn loan", onclick: () => location.hash = "#/new/loan" },
      el("span", { class: "icn" }, "🤝"), el("span", {}, "Prêt accordé")),
    el("button", { class: "big-btn borrow", onclick: () => location.hash = "#/new/borrow" },
      el("span", { class: "icn" }, "🏦"), el("span", {}, "Emprunt"))
  ));

  root.appendChild(el("div", { class: "section-title" },
    el("h2", {}, "Récents"),
    state.transactions.length > 5 ? el("a", { href: "#/history" }, "Tout voir") : null
  ));
  root.appendChild(renderTxList(state.transactions.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 6)));
}

function renderTxList(list) {
  if (!list.length) return el("div", { class: "tx-list" }, el("div", { class: "empty" }, "Aucune transaction. Ajoutez-en une !"));
  return el("div", { class: "tx-list" },
    ...list.map(t => {
      const iconMap = { income: "↑", expense: "↓", loan: "→", borrow: "←" };
      const signMap = { income: "+", expense: "−", loan: "−", borrow: "+" };
      const date = new Date(t.createdAt);
      const dateStr = date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      const defaultLabels = { income: "Entrée", expense: "Dépense", loan: "Prêt accordé", borrow: "Emprunt" };
      const label = t.label || defaultLabels[t.type];
      const isRepayable = t.type === "loan" || t.type === "borrow";
      let suffix = "";
      if (t.type === "loan") suffix = t.repaid ? " · remboursé" : " · prêt en cours";
      else if (t.type === "borrow") suffix = t.repaid ? " · remboursé" : " · à rembourser";
      return el("div", { class: "tx " + t.type + (t.repaid ? " repaid" : "") },
        el("div", { class: "dot" }, iconMap[t.type]),
        el("div", { class: "meta" },
          el("div", { class: "label" }, label),
          el("div", { class: "sublabel" }, dateStr + suffix)),
        el("div", { class: "amount" }, signMap[t.type] + fmt(t.amount, t.currency)),
        isRepayable && !t.repaid
          ? el("button", { class: "repay", title: "Marquer remboursé", "aria-label": "Marquer remboursé", onclick: () => confirmRepay(t) }, "✓")
          : null,
        el("button", { class: "undo", title: "Annuler", "aria-label": "Annuler", onclick: () => confirmDelete(t) }, "×")
      );
    })
  );
}

function confirmRepay(t) {
  const isLoan = t.type === "loan";
  openModal({
    title: isLoan ? "Prêt remboursé ?" : "Emprunt remboursé ?",
    message: (isLoan
      ? "Confirmez que ce prêt vous a été remboursé. Le montant sera retiré de vos prêts en cours."
      : "Confirmez que vous avez remboursé cet emprunt. Le montant sera retiré de vos dettes.")
      + "\n\nMontant : " + fmt(t.amount, t.currency),
    confirmLabel: "Oui, remboursé",
    tone: "success",
    onConfirm: () => {
      const tx = state.transactions.find(x => x.id === t.id);
      if (!tx) return;
      tx.repaid = true;
      tx.repaidAt = Date.now();
      saveState();
      route();
      showToast("Remboursement enregistré", "Annuler", () => {
        tx.repaid = false;
        tx.repaidAt = null;
        saveState();
        route();
      });
    }
  });
}

function confirmDelete(t) {
  const idx = state.transactions.findIndex(x => x.id === t.id);
  if (idx === -1) return;
  const removed = state.transactions.splice(idx, 1)[0];
  saveState();
  route();
  showToast("Transaction annulée", "Rétablir", () => {
    state.transactions.push(removed);
    saveState();
    route();
  });
}

// --- Entry view ------------------------------------------------------------
let entryDraft = { amount: null, currency: null, label: "" };

function renderEntry(type) {
  const root = $("#app");
  root.innerHTML = "";
  const labels = {
    income: { title: "Nouvelle entrée", verb: "Ajouter", cls: "income", placeholder: "ex : Salaire" },
    expense: { title: "Nouvelle dépense", verb: "Ajouter", cls: "expense", placeholder: "ex : Achat biscuit" },
    loan: { title: "Prêt accordé", verb: "Enregistrer", cls: "loan", placeholder: "ex : Prêt à Jean" },
    borrow: { title: "Nouvel emprunt", verb: "Enregistrer", cls: "borrow", placeholder: "ex : Emprunt à Marie" }
  }[type];

  entryDraft = { amount: null, currency: (entryDraft.currency && currency(entryDraft.currency)) ? entryDraft.currency : primary().code, label: "" };

  root.appendChild(topbar({ back: true }));
  root.appendChild(el("h2", { style: "margin:0;font-size:22px;letter-spacing:-.02em;" }, labels.title));
  root.appendChild(el("p", { class: "hint" }, "Choisissez un montant rapide ou tapez le vôtre."));

  // Currency tabs
  const tabs = el("div", { class: "currency-tabs" });
  state.currencies.forEach(c => {
    const b = el("button", {
      class: entryDraft.currency === c.code ? "active" : "",
      onclick: () => { entryDraft.currency = c.code; renderEntry(type); }
    }, c.code);
    tabs.appendChild(b);
  });
  root.appendChild(tabs);

  // Presets
  const cur = currency(entryDraft.currency);
  const presetGrid = el("div", { class: "preset-grid" });
  (cur.presets || []).forEach(p => {
    const b = el("button", {
      class: entryDraft.amount === p ? "selected" : "",
      onclick: () => { entryDraft.amount = p; input.value = ""; refresh(); }
    }, fmt(p, cur.code));
    presetGrid.appendChild(b);
  });
  root.appendChild(presetGrid);

  // Custom input
  const input = el("input", {
    type: "number", inputmode: "decimal", min: "0", step: "any",
    placeholder: "Autre montant",
    oninput: (e) => { const v = parseFloat(e.target.value); entryDraft.amount = isFinite(v) && v > 0 ? v : null; refreshBtn(); refreshPresets(); }
  });
  root.appendChild(el("div", { class: "custom-amount" }, input, el("span", { class: "cur" }, cur.code)));

  // Label
  const labelInput = el("input", {
    type: "text", placeholder: labels.placeholder, maxlength: "60",
    oninput: (e) => { entryDraft.label = e.target.value; }
  });
  root.appendChild(el("div", { class: "field" },
    el("label", {}, "Libellé (facultatif)"), labelInput));

  // Submit bar
  const btn = el("button", { class: "submit-btn " + labels.cls, disabled: true, onclick: submit }, labels.verb);
  root.appendChild(el("div", { class: "submit-bar" }, el("div", { class: "inner" }, btn)));

  function refreshBtn() { btn.disabled = !(entryDraft.amount > 0); btn.textContent = entryDraft.amount > 0 ? labels.verb + " " + fmt(entryDraft.amount, entryDraft.currency) : labels.verb; }
  function refreshPresets() {
    [...presetGrid.children].forEach((b, i) => {
      const p = cur.presets[i];
      b.classList.toggle("selected", entryDraft.amount === p && !input.value);
    });
  }
  function refresh() { refreshBtn(); refreshPresets(); }
  refresh();

  function submit() {
    if (!(entryDraft.amount > 0)) return;
    state.transactions.push({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
      amount: entryDraft.amount,
      currency: entryDraft.currency,
      type,
      label: entryDraft.label.trim(),
      createdAt: Date.now()
    });
    saveState();
    location.hash = "";
    setTimeout(() => showToast(labels.title + " enregistrée"), 50);
  }
}

// --- History ---------------------------------------------------------------
function renderHistory(root) {
  root.appendChild(topbar({ back: true }));
  root.appendChild(el("h2", { style: "margin:0;font-size:22px;letter-spacing:-.02em;" }, "Historique"));
  const sorted = state.transactions.slice().sort((a, b) => b.createdAt - a.createdAt);
  root.appendChild(renderTxList(sorted));
}

// --- Settings --------------------------------------------------------------
function renderSettings(root) {
  root.appendChild(topbar({ back: true }));
  root.appendChild(el("h2", { style: "margin:0;font-size:22px;letter-spacing:-.02em;" }, "Paramètres"));

  // Currencies
  const currCard = el("div", { class: "card" }, el("h3", {}, "Devises"));
  const chips = el("div", { class: "chip-list" });
  state.currencies.forEach(c => {
    const chip = el("div", { class: "chip" + (c.isPrimary ? " primary" : "") },
      el("span", {}, c.code + (c.isPrimary ? " · principale" : "")),
      !c.isPrimary ? el("button", { title: "Définir principale", onclick: () => { state.currencies.forEach(x => x.isPrimary = false); c.isPrimary = true; saveState(); route(); } }, "★") : null,
      state.currencies.length > 1 && !c.isPrimary ? el("button", { title: "Supprimer", onclick: () => openModal({
        title: "Supprimer " + c.code + " ?",
        message: "Cette devise sera retirée. Les transactions déjà enregistrées dans " + c.code + " resteront visibles.",
        confirmLabel: "Supprimer",
        tone: "danger",
        onConfirm: () => {
          state.currencies = state.currencies.filter(x => x.code !== c.code);
          delete state.rates[c.code];
          saveState(); route();
        }
      }) }, "×") : null
    );
    chips.appendChild(chip);
  });
  currCard.appendChild(chips);

  const codeIn = el("input", { placeholder: "Code (ex : EUR)", maxlength: "5" });
  const nameIn = el("input", { placeholder: "Nom (facultatif)" });
  currCard.appendChild(el("div", { class: "row" }, codeIn, nameIn,
    el("button", { class: "add", onclick: () => {
      const code = codeIn.value.trim().toUpperCase();
      if (!code) return;
      if (currency(code)) { showToast("Devise déjà présente"); return; }
      state.currencies.push({ code, name: nameIn.value.trim() || code, isPrimary: false, presets: [10, 50, 100, 500, 1000, 5000] });
      state.rates[code] = rateOf(primary().code); // start at 1:1 relative to primary
      saveState(); route();
    }}, "+")));
  root.appendChild(currCard);

  // Rates
  const p = primary();
  const rateCard = el("div", { class: "card" },
    el("h3", {}, "Taux de conversion"),
    el("div", { style: "font-size:12px;color:var(--muted);" }, "Un seul taux suffit : l'autre sens est calculé automatiquement et reste stable si la devise principale change."));
  state.currencies.filter(c => c.code !== p.code).forEach(c => {
    const base = c.code === "USD" ? c : p;
    const quote = base.code === p.code ? c : p;
    const ratio = exchangeRate(base.code, quote.code); // 1 base = ratio quote
    const inverse = ratio > 0 ? 1 / ratio : 0; // 1 quote = inverse base

    const inpDirect = el("input", { type: "number", step: "any", min: "0", value: ratio });
    const inpInverse = el("input", { type: "number", step: "any", min: "0", value: inverse });

    inpDirect.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (!setExchangeRate(base.code, quote.code, v)) return;
      inpInverse.value = 1 / v;
      saveState();
    });
    inpInverse.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (!isFinite(v) || v <= 0 || !setExchangeRate(quote.code, base.code, v)) return;
      inpDirect.value = 1 / v;
      saveState();
    });

    rateCard.appendChild(el("div", { class: "rate-row" },
      el("div", {}, "1 " + base.code), el("div", { class: "eq" }, "="), inpDirect, el("div", {}, quote.code)));
    rateCard.appendChild(el("div", { class: "rate-row" },
      el("div", {}, "1 " + quote.code), el("div", { class: "eq" }, "="), inpInverse, el("div", {}, base.code)));
  });
  if (state.currencies.length === 1) rateCard.appendChild(el("div", { style: "font-size:13px;color:var(--muted);" }, "Ajoutez une deuxième devise pour définir un taux."));
  root.appendChild(rateCard);

  // Presets per currency
  state.currencies.forEach(c => {
    const presetCard = el("div", { class: "card preset-editor" },
      el("h3", {}, "Montants rapides — " + c.code));
    const items = el("div", { class: "items" });
    (c.presets || []).forEach(p => {
      items.appendChild(el("div", { class: "chip" }, el("span", {}, fmt(p, c.code)),
        el("button", { onclick: () => { c.presets = c.presets.filter(x => x !== p); saveState(); route(); } }, "×")));
    });
    presetCard.appendChild(items);
    const inp = el("input", { type: "number", inputmode: "decimal", min: "0", step: "any", placeholder: "Ajouter un montant" });
    presetCard.appendChild(el("div", { class: "row" }, inp,
      el("button", { class: "add", onclick: () => {
        const v = parseFloat(inp.value);
        if (!(v > 0)) return;
        if (!c.presets.includes(v)) c.presets.push(v);
        c.presets.sort((a, b) => a - b);
        saveState(); route();
      }}, "+")));
    root.appendChild(presetCard);
  });

  // Danger zone
  root.appendChild(el("div", { class: "card" },
    el("h3", {}, "Données"),
    el("button", { class: "add", style: "padding:12px 14px;border-radius:12px;background:var(--danger);color:white;font-weight:600;",
      onclick: () => openModal({
        title: "Réinitialiser l'application ?",
        message: "Toutes vos devises, taux et transactions seront effacés définitivement. Cette action est irréversible.",
        confirmLabel: "Tout effacer",
        tone: "danger",
        onConfirm: () => { localStorage.removeItem(STORE_KEY); state = loadState(); route(); }
      }) },
      "Réinitialiser l'application")));
}

// --- Init ------------------------------------------------------------------
route();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}