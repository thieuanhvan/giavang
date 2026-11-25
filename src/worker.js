// giavang Worker: hourly price snapshot into KV, served to the page as /api/data.
// Sources (free, no key): vang.today (Vietnamese brands + world XAU/USD, with daily history),
// PNJ price board, Vietcombank USD rate (fallback open.er-api.com).

const LUONG_PER_OZ = 37.5 / 31.1034768; // 1 lượng = 37.5 g, 1 troy ounce = 31.1034768 g
const KEEP_DAYS = 1100;
const UA = { "user-agent": "giavang.thieuanhvan.com (daily price board)" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/data") {
      let data = await env.GIA.get("data", "json");
      if (!data) data = await update(env);
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(update(env));
  },
};

function vnDate(ms = Date.now()) {
  return new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function usdRate(errors) {
  try {
    const r = await fetch("https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx", { headers: UA });
    const xml = await r.text();
    const m = xml.match(/CurrencyCode="USD"[^>]*Sell="([\d,.]+)"/);
    if (m) return { usd: Number(m[1].replace(/,/g, "")), usdSource: "Vietcombank (giá bán)" };
    errors.push("Vietcombank: không đọc được tỷ giá USD");
  } catch (e) { errors.push(`Vietcombank: ${e.message}`); }
  try {
    const j = await getJson("https://open.er-api.com/v6/latest/USD");
    if (j.rates?.VND) return { usd: j.rates.VND, usdSource: "open.er-api.com (tỷ giá tham chiếu)" };
  } catch (e) { errors.push(`open.er-api.com: ${e.message}`); }
  return { usd: null, usdSource: null };
}

async function backfill(errors) {
  // One year of daily closes from vang.today, so the chart is not empty on the first day.
  const out = {};
  for (const [type, key] of [["SJL1L10", "sjc"], ["SJ9999", "nhan"], ["XAUUSD", "xau"]]) {
    try {
      const j = await getJson(`https://www.vang.today/api/prices?days=365&type=${type}`);
      for (const h of j.history || []) {
        const p = h.prices?.[type];
        if (!p) continue;
        const row = (out[h.date] ||= { d: h.date });
        if (key === "xau") row.xau = p.buy || null;
        else { row[key + "B"] = p.buy || null; row[key + "S"] = p.sell || null; }
      }
    } catch (e) { errors.push(`vang.today lịch sử ${type}: ${e.message}`); }
  }
  return Object.values(out);
}

export async function update(env) {
  const errors = [];
  const old = (await env.GIA.get("data", "json")) || {};

  let brands = null, vtTime = null;
  try {
    const j = await getJson("https://www.vang.today/api/prices");
    if (j.success && j.prices) { brands = j.prices; vtTime = `${j.date} ${j.time}`; }
    else errors.push("vang.today: dữ liệu rỗng");
  } catch (e) { errors.push(`vang.today: ${e.message}`); }

  let pnj = null;
  try {
    const j = await getJson("https://edge-api.pnj.io/ecom-frontend/v1/get-gold-price?zone=00");
    if (Array.isArray(j.data)) {
      // PNJ quotes thousand đồng per chỉ; ×10 000 gives đồng per lượng.
      pnj = {
        time: j.updateDate || null,
        items: j.data.map((x) => ({
          name: x.tensp,
          buy: typeof x.giamua === "number" ? x.giamua * 10000 : null,
          sell: typeof x.giaban === "number" ? x.giaban * 10000 : null,
        })),
      };
    }
  } catch (e) { errors.push(`PNJ: ${e.message}`); }

  const { usd, usdSource } = await usdRate(errors);

  const pick = (k) => brands?.[k] || null;
  const sjcVt = pick("SJL1L10");
  const pnjSjc = pnj?.items.find((x) => /SJC/.test(x.name));
  const now = {
    sjcB: sjcVt?.buy || pnjSjc?.buy || old.now?.sjcB || null,
    sjcS: sjcVt?.sell || pnjSjc?.sell || old.now?.sjcS || null,
    nhanB: pick("SJ9999")?.buy || old.now?.nhanB || null,
    nhanS: pick("SJ9999")?.sell || old.now?.nhanS || null,
    xau: pick("XAUUSD")?.buy || old.now?.xau || null,
    usd: usd || old.now?.usd || null,
  };

  let history = old.history || [];
  if (history.length < 30) {
    const back = await backfill(errors);
    const byDate = Object.fromEntries(back.map((r) => [r.d, r]));
    for (const r of history) byDate[r.d] = { ...byDate[r.d], ...r };
    history = Object.values(byDate);
  }
  const today = vnDate();
  const row = { d: today, sjcB: now.sjcB, sjcS: now.sjcS, nhanB: now.nhanB, nhanS: now.nhanS, xau: now.xau, usd: now.usd };
  history = history.filter((r) => r.d !== today);
  history.push(row);
  history.sort((a, b) => a.d.localeCompare(b.d));
  history = history.slice(-KEEP_DAYS);

  const brandList = brands
    ? Object.entries(brands)
        .filter(([k, v]) => v.currency === "VND")
        .map(([k, v]) => ({ code: k, name: v.name, buy: v.buy || null, sell: v.sell || null, changeSell: v.change_sell ?? null }))
    : old.brands || [];

  const data = {
    updated: new Date().toISOString(),
    vangTodayTime: vtTime || old.vangTodayTime || null,
    pnjTime: pnj?.time || old.pnjTime || null,
    usdSource: usdSource || old.usdSource || null,
    luongPerOz: LUONG_PER_OZ,
    now,
    brands: brandList,
    pnj: pnj?.items || old.pnj || [],
    history,
    errors,
  };
  await env.GIA.put("data", JSON.stringify(data));
  return data;
}
