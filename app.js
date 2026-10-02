"use strict";

const CONFIG = Object.freeze({
  spreadsheetId: "1Pd5zXSzLWfAibWLDg_7U27orR2V4M73jem7M6uoyXYg",
  sheetName: "Respuestas de formulario 2",
  refreshMs: 60_000,
  requestTimeoutMs: 18_000,
  cacheKey: "sheraton-guest-experience-sheet-v2"
});

const AREA_DEFS = [
  { key: "reception", name: "Recepción", short: "Recepción", aliases: ["recepcion", "front desk", "check-in"] },
  { key: "rooms", name: "Habitaciones / Housekeeping", short: "Habitaciones", aliases: ["habitaciones", "housekeeping", "habitacion"] },
  { key: "reservations", name: "Reservas", short: "Reservas", aliases: ["reservas", "reserva"] },
  { key: "breakfast", name: "Desayuno", short: "Desayuno", aliases: ["desayuno"] },
  { key: "food", name: "Almuerzo / Cena", short: "Almuerzo / Cena", aliases: ["almuerzo", "cena", "restaurante", "gastronomia"] },
  { key: "facilities", name: "Instalaciones / Áreas comunes", short: "Instalaciones", aliases: ["instalaciones", "areas comunes", "spa", "piscina"] }
];

const state = {
  headers: [],
  records: [],
  filtered: [],
  loadedAt: null,
  refreshTimer: null,
  loading: false
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", () => {
  bindNavigation();
  bindFilters();
  $("#refreshButton").addEventListener("click", () => loadData({ manual: true }));
  $("#exportButton").addEventListener("click", () => window.print());
  $$('[data-go-view]').forEach(button => button.addEventListener("click", () => showView(button.dataset.goView)));
  loadData();
  state.refreshTimer = window.setInterval(() => {
    if (!document.hidden) loadData();
  }, CONFIG.refreshMs);
});

function bindNavigation() {
  $$(".nav-item").forEach(button => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });
}

function showView(view) {
  $$(".nav-item").forEach(button => button.classList.toggle("is-active", button.dataset.view === view));
  $$("[data-view-panel]").forEach(panel => panel.classList.toggle("is-active", panel.dataset.viewPanel === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindFilters() {
  ["periodFilter", "reasonFilter", "companyFilter", "nightsFilter", "bonvoyFilter"].forEach(id => {
    $("#" + id).addEventListener("change", applyFilters);
  });
  $("#resetFilters").addEventListener("click", () => {
    $("#periodFilter").value = "30";
    ["reasonFilter", "companyFilter", "nightsFilter", "bonvoyFilter"].forEach(id => { $("#" + id).value = "all"; });
    applyFilters();
  });
}

async function loadData({ manual = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  setStatus("loading", manual ? "Actualizando datos…" : "Conectando con Google Sheets…");
  $("#refreshButton").classList.add("is-spinning");

  try {
    const table = await fetchGoogleSheetTable();
    const parsed = parseGoogleTable(table);
    state.headers = parsed.headers;
    state.records = normalizeRecords(parsed.headers, parsed.rows);
    state.loadedAt = new Date();
    saveCache(parsed);
    populateFilterOptions();
    applyFilters();
    setStatus("live", `Sincronizado · ${state.records.length} ${plural(state.records.length, "respuesta", "respuestas")}`);
    hideNotice();
  } catch (error) {
    const cached = readCache();
    if (cached) {
      state.headers = cached.headers;
      state.records = normalizeRecords(cached.headers, cached.rows);
      state.loadedAt = new Date(cached.savedAt);
      populateFilterOptions();
      applyFilters();
      setStatus("cached", "Mostrando última copia guardada");
      showNotice("No fue posible consultar la hoja en este momento. Se muestran los últimos datos guardados en este navegador.");
    } else {
      state.headers = [];
      state.records = [];
      state.filtered = [];
      renderAll();
      setStatus("error", "No se pudo leer Google Sheets");
      showNotice("No se pudo leer la hoja. Confirme que esté compartida como “Cualquier persona con el enlace · Lector” y vuelva a actualizar.", true);
    }
    console.error("Error al actualizar el dashboard:", error);
  } finally {
    state.loading = false;
    $("#refreshButton").classList.remove("is-spinning");
  }
}

function fetchGoogleSheetTable() {
  return new Promise((resolve, reject) => {
    const callbackName = `__guestSheet_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const params = new URLSearchParams({
      sheet: CONFIG.sheetName,
      headers: "1",
      tqx: `out:json;responseHandler:${callbackName}`,
      tq: "select * where A is not null",
      cacheBust: String(Date.now())
    });
    const url = `https://docs.google.com/spreadsheets/d/${CONFIG.spreadsheetId}/gviz/tq?${params.toString()}`;
    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      script.remove();
    };

    window[callbackName] = response => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!response || response.status === "error" || !response.table) {
        reject(new Error(response?.errors?.[0]?.detailed_message || "Respuesta inválida de Google Sheets"));
        return;
      }
      resolve(response.table);
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Google Sheets rechazó o no completó la solicitud"));
    };

    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Tiempo de espera agotado al leer Google Sheets"));
    }, CONFIG.requestTimeoutMs);

    script.src = url;
    script.async = true;
    document.head.appendChild(script);
  });
}

function parseGoogleTable(table) {
  const columns = table.cols || [];
  const headers = columns.map((column, index) => cleanText(column.label || column.id || `Columna ${index + 1}`));
  const rows = (table.rows || []).map(row => columns.map((column, index) => {
    const cell = row.c?.[index];
    if (!cell || cell.v === null || cell.v === undefined) return "";
    if (["date", "datetime", "timeofday"].includes(column.type)) return cell.f || cell.v;
    return cell.v;
  }));
  return { headers, rows };
}

function normalizeRecords(headers, rows) {
  const normalizedHeaders = headers.map(normalizeText);
  const findIndex = (...terms) => normalizedHeaders.findIndex(header => terms.every(term => header.includes(normalizeText(term))));
  const findAnyIndex = candidateGroups => {
    for (const terms of candidateGroups) {
      const index = findIndex(...terms);
      if (index >= 0) return index;
    }
    return -1;
  };
  const indexes = {
    timestamp: findIndex("marca temporal"),
    reason: findIndex("motivo principal"),
    company: findIndex("con quien viajo"),
    nights: findIndex("cuantas noches"),
    bonvoy: findIndex("miembro de marriott bonvoy"),
    nps: findAnyIndex([
      ["que tan probable", "recomiende"],
      ["probabilidad", "recomendar"],
      ["net promoter score"],
      ["nps"]
    ]),
    positiveArea: findIndex("area considera", "destaco mas positivamente"),
    improvementArea: findIndex("area considera", "oportunidad de mejora"),
    special: findIndex("momento", "detalle especial"),
    suggestion: findIndex("sugerencia", "futura visita"),
    wantsContact: findIndex("gustaria", "contacte"),
    contact: findIndex("correo electronico", "telefono")
  };

  const areaIndexes = Object.fromEntries(AREA_DEFS.map(area => {
    const matches = normalizedHeaders
      .map((header, index) => ({ header, index }))
      .filter(item => item.header.includes("como evaluaria") && area.aliases.some(alias => item.header.includes(normalizeText(alias))))
      .map(item => item.index);
    return [area.key, matches];
  }));

  const valueAt = (row, index) => index >= 0 ? row[index] ?? "" : "";
  return rows.map((row, rowIndex) => {
    const areas = {};
    AREA_DEFS.forEach(area => {
      const values = areaIndexes[area.key].map(index => ratingFrom(valueAt(row, index))).filter(Number.isFinite);
      areas[area.key] = values.length ? values[0] : null;
    });
    const wantsContact = cleanText(valueAt(row, indexes.wantsContact));
    const contact = cleanText(valueAt(row, indexes.contact));
    return {
      id: rowIndex + 2,
      timestampRaw: valueAt(row, indexes.timestamp),
      date: parseSheetDate(valueAt(row, indexes.timestamp)),
      reason: cleanText(valueAt(row, indexes.reason)) || "Sin información",
      company: cleanText(valueAt(row, indexes.company)) || "Sin información",
      nights: cleanText(valueAt(row, indexes.nights)) || "Sin información",
      bonvoy: cleanText(valueAt(row, indexes.bonvoy)) || "Sin información",
      nps: npsFrom(valueAt(row, indexes.nps)),
      positiveArea: cleanText(valueAt(row, indexes.positiveArea)),
      improvementArea: cleanText(valueAt(row, indexes.improvementArea)),
      special: cleanText(valueAt(row, indexes.special)),
      suggestion: cleanText(valueAt(row, indexes.suggestion)),
      wantsContact,
      contact,
      contactRequested: isAffirmative(wantsContact) || Boolean(contact),
      areas
    };
  }).filter(record => record.date || Object.values(record.areas).some(Number.isFinite) || Number.isFinite(record.nps));
}

function applyFilters() {
  const period = $("#periodFilter").value;
  const reason = $("#reasonFilter").value;
  const company = $("#companyFilter").value;
  const nights = $("#nightsFilter").value;
  const bonvoy = $("#bonvoyFilter").value;
  const latestDataDate = state.records.reduce((latest, record) => record.date && record.date > latest ? record.date : latest, new Date(0));
  const now = new Date();
  const referenceDate = latestDataDate > new Date(now.getTime() + 86_400_000) ? latestDataDate : now;
  const cutoff = period === "all" ? null : new Date(referenceDate.getTime() - Number(period) * 86_400_000);

  state.filtered = state.records.filter(record => {
    const inPeriod = !cutoff || (record.date && record.date >= cutoff);
    return inPeriod &&
      (reason === "all" || record.reason === reason) &&
      (company === "all" || record.company === company) &&
      (nights === "all" || record.nights === nights) &&
      (bonvoy === "all" || record.bonvoy === bonvoy);
  });
  renderAll();
}

function populateFilterOptions() {
  const configs = [
    ["reasonFilter", "reason", "Todos"],
    ["companyFilter", "company", "Todas"],
    ["nightsFilter", "nights", "Todas"],
    ["bonvoyFilter", "bonvoy", "Todos"]
  ];
  configs.forEach(([id, field, allLabel]) => {
    const select = $("#" + id);
    const current = select.value;
    const values = [...new Set(state.records.map(record => record[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
    select.innerHTML = `<option value="all">${allLabel}</option>${values.map(value => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join("")}`;
    select.value = values.includes(current) ? current : "all";
  });
}

function renderAll() {
  const summary = summarize(state.filtered);
  renderOverview(summary);
  renderAreas(summary);
  renderSegments(summary);
  renderFeedback(summary);
  renderMeta(summary);
}

function summarize(records) {
  const npsValues = records.map(record => record.nps).filter(Number.isFinite);
  const promoters = npsValues.filter(value => value >= 9).length;
  const passives = npsValues.filter(value => value >= 7 && value <= 8).length;
  const detractors = npsValues.filter(value => value <= 6).length;
  const nps = calculateNpsScore(promoters, detractors, npsValues.length);

  const areaStats = AREA_DEFS.map(area => {
    const values = records.map(record => record.areas[area.key]).filter(Number.isFinite);
    const bestMentions = records.filter(record => textMatchesArea(record.positiveArea, area)).length;
    const improvementMentions = records.filter(record => textMatchesArea(record.improvementArea, area)).length;
    return {
      ...area,
      values,
      count: values.length,
      avg: average(values),
      positiveRate: values.length ? values.filter(value => value >= 4).length / values.length * 100 : null,
      bestMentions,
      improvementMentions
    };
  });
  const allRatings = areaStats.flatMap(area => area.values);
  const topArea = [...areaStats].filter(area => area.avg !== null).sort((a, b) => b.avg - a.avg || b.bestMentions - a.bestMentions)[0] || null;
  const explicitOpportunity = [...areaStats].sort((a, b) => b.improvementMentions - a.improvementMentions)[0];
  const lowestArea = [...areaStats].filter(area => area.avg !== null).sort((a, b) => a.avg - b.avg || b.improvementMentions - a.improvementMentions)[0] || null;
  const opportunityArea = explicitOpportunity?.improvementMentions
    ? explicitOpportunity
    : (lowestArea?.avg !== null && lowestArea?.avg < 4 ? lowestArea : null);
  const contacts = records.filter(record => record.contactRequested);
  const comments = records.flatMap(record => {
    const items = [];
    if (record.special) items.push({ ...record, type: "Momento destacado", text: record.special });
    if (record.suggestion && normalizeText(record.suggestion) !== normalizeText(record.special)) items.push({ ...record, type: "Sugerencia", text: record.suggestion });
    return items;
  }).sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

  return {
    records,
    total: records.length,
    satisfaction: average(allRatings),
    approvalRate: allRatings.length ? allRatings.filter(value => value >= 4).length / allRatings.length * 100 : null,
    nps,
    npsValues,
    promoters,
    passives,
    detractors,
    areaStats,
    topArea,
    opportunityArea,
    contacts,
    comments,
    trend: buildMonthlyTrend(records)
  };
}

function renderMeta(summary) {
  $("#overviewSubtitle").textContent = summary.total
    ? `${summary.total} ${plural(summary.total, "respuesta válida", "respuestas válidas")} en la vista actual.`
    : "No hay respuestas que coincidan con los filtros seleccionados.";
  $("#areaSample").textContent = `${summary.total} ${plural(summary.total, "respuesta", "respuestas")}`;
  $("#segmentSample").textContent = `${summary.total} ${plural(summary.total, "huésped", "huéspedes")}`;
  $("#lastUpdated").textContent = state.loadedAt
    ? `Última lectura: ${state.loadedAt.toLocaleString("es-CL", { dateStyle: "medium", timeStyle: "short" })}`
    : "Sin actualización todavía";
}

function renderOverview(summary) {
  const top = summary.topArea;
  const opportunity = summary.opportunityArea;
  $("#overviewKpis").innerHTML = [
    kpiCard("Muestra activa", integer(summary.total), plural(summary.total, "respuesta procesada", "respuestas procesadas"), "neutral"),
    kpiCard("Net Promoter Score", signed(summary.nps), npsKpiDetail(summary), npsTone(summary.nps)),
    kpiCard("Satisfacción global", score(summary.satisfaction), "promedio de áreas evaluadas", scoreTone(summary.satisfaction)),
    kpiCard("Tasa de aprobación", percent(summary.approvalRate), "evaluaciones con nota 4 o 5", scoreTone(summary.approvalRate === null ? null : summary.approvalRate / 20)),
    kpiCard("Principal fortaleza", top?.short || "Sin datos", top ? `${score(top.avg)} · ${top.bestMentions} ${plural(top.bestMentions, "mención", "menciones")}` : "Aún sin evaluaciones", "green", true),
    kpiCard("Oportunidad clave", opportunity?.short || "Sin señal", opportunity ? `${score(opportunity.avg)} · ${opportunity.improvementMentions} ${plural(opportunity.improvementMentions, "mención", "menciones")}` : "No se detectan alertas de mejora", opportunity ? "red" : "green", true)
  ].join("");

  renderNps(summary);
  renderAreaRanking(summary.areaStats);
  renderTrend(summary.trend);

  $("#contactCount").textContent = integer(summary.contacts.length);
  if (!summary.total) {
    $("#executiveInsightTitle").textContent = "Sin respuestas para analizar";
    $("#executiveInsight").textContent = "Ajuste los filtros o espere nuevas respuestas del formulario.";
  } else {
    const npsText = summary.nps === null ? "todavía no cuenta con NPS válido" : `registra un NPS de ${signed(summary.nps)}`;
    const topText = top ? `${top.short} lidera con ${score(top.avg)}` : "aún no hay evaluaciones por área";
    const opportunityText = opportunity ? `${opportunity.short} concentra la principal señal de mejora` : "no aparece una oportunidad dominante";
    $("#executiveInsightTitle").textContent = `${top?.short || "La experiencia"} marca la pauta`;
    $("#executiveInsight").textContent = `La muestra ${npsText}. ${topText}; ${opportunityText}.`;
  }
}

function renderNps(summary) {
  const total = summary.npsValues.length;
  const parts = [
    ["promoter", summary.promoters, "Promotores"],
    ["passive", summary.passives, "Pasivos"],
    ["detractor", summary.detractors, "Detractores"]
  ];
  $("#npsBadge").textContent = `${signed(summary.nps)} NPS`;
  $("#npsStack").innerHTML = total
    ? parts.map(([className, count]) => `<span class="${className}" style="width:${count / total * 100}%">${count / total * 100 >= 10 ? Math.round(count / total * 100) + "%" : ""}</span>`).join("")
    : `<span class="muted" style="width:100%;color:#66737e">Sin respuestas NPS</span>`;
  $("#npsLegend").innerHTML = parts.map(([, count, label]) => `<div><strong>${integer(count)}</strong><span>${label}${total ? ` · ${Math.round(count / total * 100)}%` : ""}</span></div>`).join("");
}

function renderAreaRanking(areaStats) {
  const ranked = [...areaStats].sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
  $("#areaRanking").innerHTML = ranked.some(area => area.count)
    ? ranked.map((area, index) => {
      const tone = area.avg === null ? "" : area.avg >= 4.3 ? "green" : area.avg >= 3.8 ? "gold" : "red";
      return `<div class="area-row">
        <div class="area-row-head"><strong>${index + 1}. ${escapeHtml(area.name)}</strong><b>${score(area.avg)}</b></div>
        <div class="bar-track"><div class="bar-fill ${tone}" style="width:${area.avg ? area.avg / 5 * 100 : 0}%"></div></div>
        <small><span>${percent(area.positiveRate)} satisfacción 4–5</span><span>n=${area.count}</span></small>
      </div>`;
    }).join("")
    : emptyState("Aún no hay calificaciones por área en esta selección.");
}

function renderTrend(trend) {
  const root = $("#trendChart");
  if (!trend.length) {
    root.innerHTML = emptyState("No hay suficientes fechas para construir la evolución.");
    return;
  }
  const width = 620;
  const height = 145;
  const pad = { left: 28, right: 18, top: 16, bottom: 29 };
  const usableW = width - pad.left - pad.right;
  const usableH = height - pad.top - pad.bottom;
  const x = index => trend.length === 1 ? width / 2 : pad.left + index * usableW / (trend.length - 1);
  const y = value => pad.top + (5 - value) / 4 * usableH;
  const points = trend.map((item, index) => `${x(index)},${y(item.satisfaction)}`).join(" ");
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Evolución mensual de satisfacción">
    <line class="axis" x1="${pad.left}" y1="${y(5)}" x2="${width - pad.right}" y2="${y(5)}"/>
    <line class="axis" x1="${pad.left}" y1="${y(3)}" x2="${width - pad.right}" y2="${y(3)}"/>
    <line class="axis" x1="${pad.left}" y1="${y(1)}" x2="${width - pad.right}" y2="${y(1)}"/>
    ${trend.length > 1 ? `<polyline class="line" points="${points}"/>` : ""}
    ${trend.map((item, index) => `<circle class="point" cx="${x(index)}" cy="${y(item.satisfaction)}" r="4"/><text x="${x(index)}" y="${y(item.satisfaction) - 10}" text-anchor="middle">${formatNumber(item.satisfaction, 1)}</text><text x="${x(index)}" y="${height - 8}" text-anchor="middle">${escapeHtml(item.label)}</text>`).join("")}
    <text x="5" y="${y(5) + 4}">5</text><text x="5" y="${y(3) + 4}">3</text><text x="5" y="${y(1) + 4}">1</text>
  </svg>`;
}

function renderAreas(summary) {
  const stats = summary.areaStats;
  const top = summary.topArea;
  const opportunity = summary.opportunityArea;
  const answeredAreas = stats.filter(area => area.count);
  const avgCoverage = answeredAreas.length && summary.total
    ? average(answeredAreas.map(area => area.count / summary.total * 100))
    : null;
  $("#areaKpis").innerHTML = [
    kpiCard("Área mejor evaluada", top?.short || "Sin datos", top ? score(top.avg) : "Sin evaluaciones", "green", true),
    kpiCard("Foco de intervención", opportunity?.short || "Sin datos", opportunity ? `${opportunity.improvementMentions} menciones de mejora` : "Sin señales", "red", true),
    kpiCard("Promedio general", score(summary.satisfaction), "sobre 5 puntos", scoreTone(summary.satisfaction)),
    kpiCard("Cobertura de evaluación", percent(avgCoverage), "respuestas por área", "neutral")
  ].join("");

  $("#areaTable").innerHTML = stats.some(area => area.count)
    ? [...stats].sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1)).map(area => {
      const diagnostic = area.avg >= 4.3 ? ["Fortaleza", "green"] : area.avg >= 3.8 ? ["En observación", "amber"] : ["Prioridad", "red"];
      return `<tr>
        <td class="area-name"><strong>${escapeHtml(area.name)}</strong><span>${escapeHtml(areaDescription(area.key))}</span></td>
        <td class="score-cell">${score(area.avg)}</td>
        <td><div class="mini-progress"><span><b>${percent(area.positiveRate)}</b><em>${area.avg >= 4.3 ? "Alta" : area.avg >= 3.8 ? "Media" : "Baja"}</em></span><div class="bar-track"><div class="bar-fill ${barTone(area.avg)}" style="width:${area.positiveRate || 0}%"></div></div></div></td>
        <td>${integer(area.count)}</td><td>${integer(area.bestMentions)}</td><td>${integer(area.improvementMentions)}</td>
        <td><span class="pill ${diagnostic[1]}">${diagnostic[0]}</span></td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="7">${emptyState("Sin calificaciones por área para esta vista.")}</td></tr>`;

  renderPriorityMatrix(stats);
  renderHorizontalList($("#strengthList"), [...stats].sort((a, b) => b.bestMentions - a.bestMentions || (b.avg ?? 0) - (a.avg ?? 0)), area => ({ label: area.name, value: `${area.bestMentions} menc.`, width: summary.total ? area.bestMentions / summary.total * 100 : 0, tone: "green" }));
}

function renderPriorityMatrix(stats) {
  const active = stats.filter(area => area.count);
  if (!active.length) {
    $("#priorityMatrix").innerHTML = emptyState("Sin datos para posicionar áreas.");
    return;
  }
  const maxMentions = Math.max(1, ...active.map(area => area.improvementMentions));
  $("#priorityMatrix").innerHTML = `<span class="matrix-axis y">Mejor calificación ↑</span><span class="matrix-axis x">Más menciones de mejora →</span>${active.map(area => {
    const left = 12 + area.improvementMentions / maxMentions * 76;
    const bottom = 12 + ((area.avg ?? 1) - 1) / 4 * 72;
    return `<span class="matrix-point" style="left:${left}%;bottom:${bottom}%"><i></i>${escapeHtml(area.short)} · ${score(area.avg)}</span>`;
  }).join("")}`;
}

function renderSegments(summary) {
  const members = summary.records.filter(record => isAffirmative(record.bonvoy));
  const nonMembers = summary.records.filter(record => !isAffirmative(record.bonvoy));
  const memberSummary = summarizeGroup(members);
  const nonMemberSummary = summarizeGroup(nonMembers);
  const gap = memberSummary.nps !== null && nonMemberSummary.nps !== null ? memberSummary.nps - nonMemberSummary.nps : null;
  $("#loyaltyGap").textContent = gap === null ? "Brecha no disponible" : `Brecha ${signed(gap)} pts NPS`;
  $("#loyaltyCards").innerHTML = [
    loyaltyCard("Miembros Marriott Bonvoy", memberSummary),
    loyaltyCard("Huéspedes sin afiliación", nonMemberSummary)
  ].join("");

  const dimensions = [
    ["Motivo de viaje", "reason", "Motivación principal"],
    ["Compañía de estadía", "company", "Composición del grupo"],
    ["Duración de estadía", "nights", "Ventana de permanencia"],
    ["Nivel de membresía", "bonvoy", "Relación con Bonvoy"]
  ];
  $("#segmentCards").innerHTML = dimensions.map(([title, field, subtitle]) => segmentCard(title, subtitle, summarizeDimension(summary.records, field))).join("");
  renderSegmentTable(summary.records);
}

function renderSegmentTable(records) {
  const groups = summarizeDimension(records, "reason").slice(0, 6);
  const header = `<thead><tr><th>Segmento</th><th>Muestra</th><th>NPS</th><th>Sat. global</th>${AREA_DEFS.map(area => `<th>${escapeHtml(area.short)}</th>`).join("")}</tr></thead>`;
  const body = groups.length ? groups.map(group => {
    const groupRecords = records.filter(record => record.reason === group.label);
    const groupSummary = summarizeGroup(groupRecords);
    return `<tr><td class="area-name"><strong>${escapeHtml(group.label)}</strong><span>Motivo de viaje</span></td><td>n=${group.count}</td><td>${signed(groupSummary.nps)}</td><td>${score(groupSummary.satisfaction)}</td>${AREA_DEFS.map(area => {
      const value = average(groupRecords.map(record => record.areas[area.key]).filter(Number.isFinite));
      return `<td><span class="heat ${heatTone(value)}">${score(value, false)}</span></td>`;
    }).join("")}</tr>`;
  }).join("") : `<tr><td colspan="${AREA_DEFS.length + 4}">${emptyState("Sin segmentos para mostrar.")}</td></tr>`;
  $("#segmentTable").innerHTML = `${header}<tbody>${body}</tbody>`;
}

function renderFeedback(summary) {
  const suggestions = summary.records.filter(record => record.suggestion).length;
  const critical = summary.records.filter(record => record.nps !== null && record.nps <= 6).length;
  $("#feedbackKpis").innerHTML = [
    kpiCard("Comentarios abiertos", integer(summary.comments.length), "entradas cualitativas", "neutral"),
    kpiCard("Sugerencias concretas", integer(suggestions), "oportunidades declaradas", "gold"),
    kpiCard("Solicitudes de contacto", integer(summary.contacts.length), "requieren seguimiento", summary.contacts.length ? "red" : "green"),
    kpiCard("Respuestas detractoras", integer(critical), "NPS entre 0 y 6", critical ? "red" : "green")
  ].join("");

  renderHorizontalList($("#themeList"), [...summary.areaStats].sort((a, b) => b.improvementMentions - a.improvementMentions), area => ({ label: area.name, value: `${area.improvementMentions}`, width: summary.total ? area.improvementMentions / summary.total * 100 : 0, tone: area.improvementMentions ? "red" : "" }));
  renderHorizontalList($("#positiveMentionList"), [...summary.areaStats].sort((a, b) => b.bestMentions - a.bestMentions), area => ({ label: area.name, value: `${area.bestMentions}`, width: summary.total ? area.bestMentions / summary.total * 100 : 0, tone: "green" }));

  $("#priorityBadge").textContent = `${summary.contacts.length} ${plural(summary.contacts.length, "caso", "casos")}`;
  $("#contactTable").innerHTML = summary.contacts.length ? summary.contacts.map(record => {
    const signal = record.nps === null ? "Sin NPS" : record.nps <= 6 ? `NPS ${record.nps} · Detractor` : record.nps <= 8 ? `NPS ${record.nps} · Pasivo` : `NPS ${record.nps} · Promotor`;
    const comment = record.suggestion || record.special || "Solicitud de contacto sin comentario abierto.";
    return `<tr><td>${formatDate(record.date)}</td><td class="area-name"><strong>${escapeHtml(record.reason)}</strong><span>${escapeHtml(record.company)} · ${escapeHtml(record.nights)}</span></td><td><span class="pill ${record.nps !== null && record.nps <= 6 ? "red" : record.nps !== null && record.nps <= 8 ? "amber" : "green"}">${escapeHtml(signal)}</span></td><td>${escapeHtml(truncate(comment, 180))}</td><td><span class="pill gray">${escapeHtml(maskContact(record.contact) || "Dato no informado")}</span></td></tr>`;
  }).join("") : `<tr><td colspan="5">${emptyState("No hay solicitudes de contacto en la selección actual.")}</td></tr>`;

  $("#commentCount").textContent = `${summary.comments.length} ${plural(summary.comments.length, "comentario", "comentarios")}`;
  $("#feedbackGrid").innerHTML = summary.comments.length ? summary.comments.slice(0, 12).map(item => {
    const sentiment = item.nps === null ? ["Sin NPS", "gray"] : item.nps <= 6 ? ["Detractor", "red"] : item.nps <= 8 ? ["Pasivo", "amber"] : ["Promotor", "green"];
    return `<article class="feedback-card"><header><span class="pill ${sentiment[1]}">${sentiment[0]}${item.nps !== null ? ` · NPS ${item.nps}` : ""}</span><time>${formatDate(item.date)}</time></header><blockquote>“${escapeHtml(truncate(item.text, 360))}”</blockquote><footer><span>${escapeHtml(item.type)}</span><span>${escapeHtml(item.reason)}</span></footer></article>`;
  }).join("") : emptyState("Aún no hay comentarios abiertos en esta selección.");
}

function buildMonthlyTrend(records) {
  const buckets = new Map();
  records.filter(record => record.date).forEach(record => {
    const key = `${record.date.getFullYear()}-${String(record.date.getMonth() + 1).padStart(2, "0")}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  });
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-6).map(([key, monthRecords]) => {
    const ratings = monthRecords.flatMap(record => Object.values(record.areas).filter(Number.isFinite));
    const [year, month] = key.split("-").map(Number);
    return {
      key,
      label: new Intl.DateTimeFormat("es-CL", { month: "short" }).format(new Date(year, month - 1, 1)).replace(".", ""),
      satisfaction: average(ratings) ?? 1
    };
  });
}

function summarizeDimension(records, field) {
  const groups = new Map();
  records.forEach(record => {
    const label = record[field] || "Sin información";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(record);
  });
  return [...groups.entries()].map(([label, groupRecords]) => ({ label, count: groupRecords.length, ...summarizeGroup(groupRecords) })).sort((a, b) => b.count - a.count || (b.nps ?? -101) - (a.nps ?? -101));
}

function summarizeGroup(records) {
  const npsValues = records.map(record => record.nps).filter(Number.isFinite);
  const promoters = npsValues.filter(value => value >= 9).length;
  const passives = npsValues.filter(value => value >= 7 && value <= 8).length;
  const detractors = npsValues.filter(value => value <= 6).length;
  const ratings = records.flatMap(record => Object.values(record.areas).filter(Number.isFinite));
  return {
    count: records.length,
    satisfaction: average(ratings),
    nps: calculateNpsScore(promoters, detractors, npsValues.length),
    promoters,
    passives,
    detractors,
    npsTotal: npsValues.length
  };
}

function loyaltyCard(title, data) {
  const total = data.npsTotal || 1;
  return `<div class="loyalty-card"><h4>${escapeHtml(title)}</h4><span class="muted">${data.count} ${plural(data.count, "huésped", "huéspedes")}</span><div class="big">${signed(data.nps)} <span class="kpi-unit">NPS</span></div><p class="muted">Satisfacción general: <strong>${score(data.satisfaction)}</strong></p><div class="split"><span style="width:${data.promoters / total * 100}%"></span><span style="width:${data.passives / total * 100}%"></span><span style="width:${data.detractors / total * 100}%"></span></div><footer><span>${Math.round(data.promoters / total * 100)}% promotores</span><span>${Math.round(data.passives / total * 100)}% pasivos</span><span>${Math.round(data.detractors / total * 100)}% detractores</span></footer></div>`;
}

function segmentCard(title, subtitle, groups) {
  return `<article class="card segment-card"><p class="eyebrow">Dimensión</p><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p>${groups.length ? groups.slice(0, 5).map(group => `<div class="segment-item"><strong>${escapeHtml(group.label)}</strong><b>${signed(group.nps)} NPS</b><small>n=${group.count} · Sat. ${score(group.satisfaction, false)}</small><small></small></div>`).join("") : emptyState("Sin datos")}</article>`;
}

function renderHorizontalList(root, items, mapper) {
  const mapped = items.map(mapper);
  root.innerHTML = mapped.some(item => item.width > 0)
    ? mapped.map(item => `<div class="horizontal-row"><div class="row-head"><strong>${escapeHtml(item.label)}</strong><strong>${escapeHtml(item.value)}</strong></div><div class="bar-track"><div class="bar-fill ${item.tone}" style="width:${Math.min(100, item.width)}%"></div></div></div>`).join("")
    : emptyState("No hay menciones categorizables en la selección actual.");
}

function kpiCard(label, value, note, tone = "neutral", long = false) {
  return `<article class="card kpi-card" data-tone="${tone}"><p class="kpi-label">${escapeHtml(label)}</p><p class="kpi-value${long ? " long" : ""}">${escapeHtml(String(value))}</p><p class="kpi-note">${escapeHtml(note)}</p></article>`;
}

function saveCache(parsed) {
  try { localStorage.setItem(CONFIG.cacheKey, JSON.stringify({ ...parsed, savedAt: new Date().toISOString() })); } catch { /* cache opcional */ }
}

function readCache() {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIG.cacheKey));
    return value?.headers && value?.rows ? value : null;
  } catch { return null; }
}

function setStatus(status, text) {
  $("#syncPill").dataset.status = status;
  $("#syncText").textContent = text;
}

function showNotice(text, error = false) {
  const notice = $("#notice");
  notice.textContent = text;
  notice.classList.remove("is-hidden");
  notice.classList.toggle("is-error", error);
}

function hideNotice() { $("#notice").classList.add("is-hidden"); }

function parseSheetDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number") return new Date((value - 25569) * 86_400_000);
  const text = cleanText(value);
  if (!text) return null;
  const googleDate = text.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})(?:,(\d{1,2}),(\d{1,2}),(\d{1,2}))?\)$/);
  if (googleDate) return new Date(Number(googleDate[1]), Number(googleDate[2]), Number(googleDate[3]), Number(googleDate[4] || 0), Number(googleDate[5] || 0), Number(googleDate[6] || 0));
  const localDate = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (localDate) return new Date(Number(localDate[3]), Number(localDate[2]) - 1, Number(localDate[1]), Number(localDate[4] || 0), Number(localDate[5] || 0), Number(localDate[6] || 0));
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ratingFrom(value) {
  if (typeof value === "number" && value >= 1 && value <= 5) return value;
  const match = cleanText(value).match(/(^|\D)([1-5])(?:\D|$)/);
  return match ? Number(match[2]) : null;
}

function npsFrom(value) {
  if (typeof value === "number" && value >= 0 && value <= 10) return value;
  const match = cleanText(value).match(/(^|\D)(10|[0-9])(?:\D|$)/);
  return match ? Number(match[2]) : null;
}

function textMatchesArea(text, area) {
  const normalized = normalizeText(text);
  return normalized && area.aliases.some(alias => normalized.includes(normalizeText(alias)));
}

function isAffirmative(value) {
  const text = normalizeText(value);
  return /^(si|yes|miembro|member)/.test(text) || text.includes("bonvoy") && !text.includes("no");
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function calculateNpsScore(promoters, detractors, total) {
  if (!total) return null;
  const rawScore = (promoters - detractors) / total * 100;
  return rawScore < 0 ? -Math.round(Math.abs(rawScore)) : Math.round(rawScore);
}

function npsKpiDetail(summary) {
  if (!summary.npsValues.length) return "sin respuestas NPS";
  const averageScore = average(summary.npsValues);
  return `${summary.promoters} ${plural(summary.promoters, "promotor", "promotores")} · ${summary.detractors} ${plural(summary.detractors, "detractor", "detractores")} · promedio ${formatNumber(averageScore, 1)}/10`;
}

function score(value, withUnit = true) { return value === null || value === undefined ? "—" : `${formatNumber(value, 1)}${withUnit ? " / 5" : ""}`; }
function percent(value) { return value === null || value === undefined ? "—" : `${Math.round(value)}%`; }
function integer(value) { return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(value || 0); }
function signed(value) { return value === null || value === undefined ? "—" : `${value > 0 ? "+" : ""}${Math.round(value)}`; }
function formatNumber(value, digits = 1) { return new Intl.NumberFormat("es-CL", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value); }
function formatDate(date) { return date ? new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date) : "Sin fecha"; }
function plural(count, singular, pluralForm) { return count === 1 ? singular : pluralForm; }
function cleanText(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function normalizeText(value) { return cleanText(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function truncate(value, length) { const text = cleanText(value); return text.length > length ? text.slice(0, length - 1).trimEnd() + "…" : text; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function escapeAttr(value) { return escapeHtml(value); }
function emptyState(message) { return `<div class="empty-state">${escapeHtml(message)}</div>`; }
function scoreTone(value) { return value === null ? "neutral" : value >= 4.3 ? "green" : value >= 3.8 ? "gold" : "red"; }
function npsTone(value) { return value === null ? "neutral" : value >= 50 ? "green" : value >= 0 ? "gold" : "red"; }
function barTone(value) { return value === null ? "" : value >= 4.3 ? "green" : value >= 3.8 ? "gold" : "red"; }
function heatTone(value) { return value === null ? "mid" : value >= 4.3 ? "high" : value >= 3.8 ? "mid" : "low"; }
function npsLabel(value) { return value === null ? "sin respuestas NPS" : value >= 50 ? "excelente" : value > 0 ? "positivo" : value === 0 ? "en equilibrio" : "requiere atención"; }
function maskContact(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (text.includes("@")) {
    const [name, domain] = text.split("@");
    return `${name.slice(0, 2)}${"•".repeat(Math.max(3, name.length - 2))}@${domain}`;
  }
  const digits = text.replace(/\D/g, "");
  return digits.length >= 4 ? `••••••${digits.slice(-4)}` : "Dato protegido";
}
function areaDescription(key) {
  return ({ reception: "Check-in, atención y salida", rooms: "Limpieza, comodidad y preparación", reservations: "Facilidad y proceso de reserva", breakfast: "Calidad, variedad y atención", food: "Alimentos, bebidas y servicio", facilities: "Espacios comunes e instalaciones" })[key] || "";
}
