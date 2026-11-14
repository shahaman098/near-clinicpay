// Shared UI helpers for the ClinicPay pages: network config, JSON-RPC views,
// formatting, icons, and small DOM components. Browser APIs only, no build step.

export const NETWORKS = {
  testnet: { label: "Testnet", rpc: "https://rpc.testnet.near.org", explorer: "https://testnet.nearblocks.io" },
  mainnet: { label: "Mainnet", rpc: "https://rpc.mainnet.near.org", explorer: "https://nearblocks.io" },
};

/** Read ?contract=&rpc=&network= into one config. A custom rpc wins over a network name. */
export function config(params = new URLSearchParams(location.search)) {
  const rpc = params.get("rpc");
  const network = params.get("network") || (rpc ? (/127\.0\.0\.1|localhost/.test(rpc) ? "sandbox" : "custom") : "testnet");
  const net = NETWORKS[network];
  return {
    contract: params.get("contract") || "",
    network,
    networkLabel: net?.label ?? (network === "sandbox" ? "Local sandbox" : "Custom RPC"),
    rpc: rpc || net?.rpc || NETWORKS.testnet.rpc,
    explorer: net?.explorer ?? null,
  };
}

/** Build a page URL that carries the same contract and network. */
export function pageUrl(page, cfg, extra = {}) {
  const p = new URLSearchParams({ contract: cfg.contract });
  if (NETWORKS[cfg.network]) { if (cfg.network !== "testnet") p.set("network", cfg.network); }
  else p.set("rpc", cfg.rpc);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== "") p.set(k, v);
  return `${page}?${p}`;
}

export async function view(rpc, account, method, args = {}) {
  let r;
  try {
    r = await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "clinicpay", method: "query",
        params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) } }),
    });
  } catch {
    throw new Error(`Cannot reach the NEAR RPC at ${rpc}. Check the network or that the local node is running.`);
  }
  const b = await r.json();
  if (b.error) {
    const cause = b.error.cause?.name;
    if (cause === "UNKNOWN_ACCOUNT") throw new Error(`Account ${account} does not exist on this network.`);
    if (cause === "NO_CONTRACT_CODE") throw new Error(`${account} has no contract deployed.`);
    throw new Error(b.error.data || b.error.message || JSON.stringify(b.error));
  }
  if (b.result.error) {
    if (/MethodNotFound/.test(b.result.error)) throw new Error(`${account} is not a ClinicPay contract.`);
    throw new Error(b.result.error);
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(b.result.result)));
}

// ---- formatting -----------------------------------------------------------------
export function units(v, decimals) {
  const B = 10n ** BigInt(decimals), x = BigInt(v);
  const whole = (x / B).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = decimals ? (x % B).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6) : "";
  return frac ? `${whole}.${frac}` : whole;
}
export const money = (v, meta) => `${units(v, meta.decimals)} ${meta.symbol}`;
export const pct = (part, whole) => (BigInt(whole) === 0n ? 0 : Number((BigInt(part) * 1000n) / BigInt(whole)) / 10);
export function date(ms, withTime = false) {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  return withTime
    ? d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
export function ago(ms) {
  const s = Math.round((Date.now() - Number(ms)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
/** "dev-20261114164845-90337467912753.test.near" -> "dev-2026…12753.test.near" */
export function shortAcct(id) {
  if (!id || id.length <= 26) return id ?? "";
  const dot = id.indexOf(".");
  const head = dot > 0 ? id.slice(0, dot) : id, tail = dot > 0 ? id.slice(dot) : "";
  if (head.length <= 16) return id;
  return `${head.slice(0, 8)}…${head.slice(-5)}${tail}`;
}

/** Status text -> pill tone and human label. */
export const STATUS = {
  Open: ["info", "Open"], PartiallyPaid: ["warn", "Partially paid"], Paid: ["ok", "Paid"],
  Overdue: ["bad", "Overdue"], Cancelled: ["", "Cancelled"], Refunded: ["bad", "Refunded"], Denied: ["bad", "Denied"],
};

// ---- DOM ---------------------------------------------------------------------------
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v; // only ever used with our own static icon strings
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== undefined && k !== null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

const PATHS = {
  logo: '<path d="M12 3v18M3 12h18"/><path d="M7 7l10 10M17 7 7 17" opacity=".0"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2Z"/><path d="M16 14h.01"/>',
  coins: '<circle cx="9" cy="9" r="6"/><path d="M15.5 9.5a6 6 0 1 1-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  scale: '<path d="M12 3v18M5 7h14"/><path d="m5 7-3 7a4 4 0 0 0 6 0L5 7Zm14 0-3 7a4 4 0 0 0 6 0l-3-7Z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="M19 12H5m6 6-6-6 6-6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
};
export const icon = (name, cls = "i") => h("span", { "aria-hidden": "true", style: "display:inline-flex",
  html: `<svg class="${cls}" viewBox="0 0 24 24">${PATHS[name] ?? ""}</svg>` });

export function pill(status, big = false) {
  const [tone, label] = STATUS[status] ?? ["", status];
  return h("span", { class: `pill ${tone}${big ? " lg" : ""}` }, label);
}

const PALETTE = ["#0d7c6c", "#4f46e5", "#c2410c", "#0369a1", "#9333ea", "#be123c", "#15803d", "#a16207"];
export function avatar(id, big = false) {
  let hsh = 0; for (const c of id ?? "?") hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  const clean = (id ?? "?").replace(/^dev-\d+-/, "").replace(/[^a-z0-9]/gi, "");
  const initials = (clean.slice(0, 2) || "?").toUpperCase();
  return h("span", { class: `avatar${big ? " lg" : ""}`, style: `background:${PALETTE[hsh % PALETTE.length]}`, "aria-hidden": "true" }, initials);
}

let toastTimer;
export function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = h("div", { class: "toast", role: "status", "aria-live": "polite" }); document.body.append(t); }
  t.replaceChildren(icon("check"), msg);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

export function copyBtn(text, label = "Copy") {
  return h("button", { class: "copy", type: "button", title: label, "aria-label": label,
    onclick: async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); } catch { toast("Copy failed: select and copy manually"); } } },
  icon("copy"));
}

/** An account: avatar (optional), middle-truncated name with the full id on hover, copy. */
export function acct(id, { avatar: withAvatar = false, cfg = null } = {}) {
  if (!id) return h("span", { class: "muted" }, "Anyone");
  const name = cfg?.explorer
    ? h("a", { class: "name", href: `${cfg.explorer}/address/${id}`, target: "_blank", rel: "noopener", title: id }, shortAcct(id))
    : h("span", { class: "name", title: id }, shortAcct(id));
  return h("span", { class: "acct" }, withAvatar ? avatar(id) : null, name, copyBtn(id, "Copy account id"));
}

export function codeBlock(text) {
  return h("div", { class: "code" }, h("pre", {}, text), copyBtn(text, "Copy command"));
}

export function emptyState(iconName, title, text) {
  return h("div", { class: "empty" }, h("div", { class: "ico" }, icon(iconName)), h("h3", {}, title), text ? h("p", { style: "margin:0" }, text) : null);
}

export function errorBanner(message, onRetry) {
  return h("div", { class: "banner", role: "alert" }, icon("alert"), h("div", { class: "grow" }, h("b", {}, "Couldn't load data. "), message),
    onRetry ? h("button", { class: "btn btn-sm", type: "button", onclick: onRetry }, icon("refresh"), "Retry") : null);
}

/** Top navigation shared by every page. `active` is "dashboard" | "invoice". */
export function topbar(cfg, active, { clinic } = {}) {
  const dash = cfg.contract && clinic ? pageUrl("clinic.html", cfg, { clinic }) : "clinic.html";
  const net = h("span", { class: "net", id: "net", title: cfg.rpc }, h("span", { class: "dot" }), h("span", { class: "label" }, cfg.networkLabel));
  return h("header", { class: "topbar" }, h("div", { class: "topbar-inner" },
    h("a", { class: "logo", href: "index.html" }, h("span", { class: "logo-mark", html: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' }), "ClinicPay"),
    h("nav", { class: "nav", "aria-label": "Main" },
      h("a", { href: dash, "aria-current": active === "dashboard" ? "page" : null }, "Dashboard"),
      h("a", { href: "index.html#how", "aria-current": null }, "How it works")),
    h("div", { class: "topbar-right" }, net, cfg.contract ? h("span", { class: "tag hide-sm", title: cfg.contract }, icon("file"), shortAcct(cfg.contract)) : null)));
}

export function setNetworkState(ok) { document.getElementById("net")?.classList.toggle("off", !ok); }
