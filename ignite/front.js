/**
 * UI controller for the Ignite Analyzer.
 *
 * Manages report/fight selection, Plotly graphs, and summary tables.
 */

import { fetchWCLv1 } from "./wcl.js";
import { IgniteAnalysis } from "./ignite-engine.js";
import { getColor } from "./colors.js";

const SCROLLBAR_WIDTH = 16;

/** Convert a hex color like "#ff8800" to "rgba(255, 136, 0, alpha)" */
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** @type {Record<string, ReportData>} */
const reports = {};

/** @type {IgniteAnalysis | null} */
let currentAnalysis = null;

/**
 * @typedef {{
 *   data: any;
 *   units: Record<number, any>;
 *   fights: any[];
 * }} ReportData
 */

// ── Helpers ──

function getParam(name, url = window.location.href) {
  const match = new RegExp("[?&]" + name + "=([^&#]*)").exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

function printError(e) {
  console.error(e);
  alert("Error:\n" + e + "\n\nRefresh the page to start again.");
}

function enableInput(enable = true) {
  for (const tag of ["input", "button", "select"]) {
    for (const el of document.querySelectorAll(tag)) {
      el.disabled = !enable;
    }
  }
}

// ── Fetch events directly (bypassing the threat engine's config-dependent fetch) ──

async function fetchIgniteEvents(reportId, start, end) {
  let t = start;
  let events = [];
  const filter = encodeURI(
    `(type = "damage" AND source.type = "Player" AND ability.type = 4)` +
    ` OR (type = "damage" AND ability.id = 12654)` +
    ` OR (type IN ("applydebuff", "refreshdebuff", "removedebuff") AND ability.id IN (12654, 1490, 11721, 11722, 22959, 23605, 9658))` +
    ` OR (type IN ("applybuff", "removebuff") AND ability.id IN (25909, 10060, 23271, 24659, 23723, 28779, 29977, 12043))` +
    ` OR (type = "death" AND target.type != "Player")` +
    ` OR type = "combatantinfo"`
  );
  while (typeof t === "number") {
    const json = await fetchWCLv1(
      `report/events/${reportId}?start=${t}&end=${end}&filter=${filter}`
    );
    if (!json.events) throw "Could not parse events for " + reportId;
    events.push(...json.events);
    t = json.nextPageTimestamp;
  }
  return events;
}

// ── Report Selection ──

export function selectReport() {
  const el = document.getElementById("reportSelect");
  const el_fight = document.getElementById("fightSelect");
  el_fight.innerHTML = "";

  let reportId = el.value.trim();
  const urlMatch = reportId.match(
    /https:\/\/(?:[a-z]+\.)?(?:classic\.|www\.)?warcraftlogs\.com\/reports\/((?:a:)?\w+)/
  );
  if (urlMatch) reportId = urlMatch[1];
  if (!reportId || (reportId.length !== 16 && reportId.length !== 18)) {
    el.style.borderColor = "red";
    return;
  }
  el.style.borderColor = null;

  // Update URL
  const currentId = getParam("id");
  if (!currentId || currentId !== el.value.trim()) {
    window.history.replaceState(null, "", "?id=" + el.value.trim());
  }

  enableInput(false);
  fetchWCLv1(`report/fights/${reportId}?`)
    .then((data) => {
      const units = {};
      for (const u of [...data.friendlies, ...data.friendlyPets, ...data.enemies, ...data.enemyPets]) {
        units[u.id] = u;
      }

      reports[reportId] = { data, units, fights: data.fights };

      const fights = data.fights.slice().sort((a, b) => {
        const aSort = a.boss === 0 ? 9999999 + a.id : a.boss + a.id;
        const bSort = b.boss === 0 ? 9999999 + b.id : b.boss + b.id;
        return aSort - bSort;
      });

      let lastWasBoss = true;
      for (const f of fights) {
        if (f.boss === 0 && lastWasBoss) {
          const sep = document.createElement("option");
          sep.textContent = "--- TRASH ---";
          sep.disabled = true;
          el_fight.appendChild(sep);
          lastWasBoss = false;
        }
        if (f.boss !== 0) lastWasBoss = true;

        const opt = document.createElement("option");
        opt.value = reportId + ";" + f.id;
        opt.textContent = f.name + " - " + f.id;
        el_fight.appendChild(opt);
      }
      enableInput(true);
    })
    .catch(printError);
}

// ── Fight Selection ──

export function selectFight() {
  const el = document.getElementById("fightSelect");
  const el_enemy = document.getElementById("enemySelect");
  const i = el.selectedIndex;
  if (i === -1) return;

  const [reportId, fightId] = el.options[i].value.split(";");
  const report = reports[reportId];
  const fight = report.fights.find((f) => f.id === parseInt(fightId));
  if (!fight) return;

  enableInput(false);
  document.getElementById("statusText").textContent = "Fetching events...";

  fetchIgniteEvents(reportId, fight.start_time, fight.end_time)
    .then((events) => {
      document.getElementById("statusText").textContent = "Processing...";

      // Build enemy list from events
      const fightEnemies = {};
      for (const u of report.data.enemies) {
        const participated = u.fights && u.fights.some((f) => f.id === parseInt(fightId));
        if (participated) fightEnemies[u.id] = u;
      }

      currentAnalysis = new IgniteAnalysis({
        events,
        fightStart: fight.start_time,
        fightEnd: fight.end_time,
        units: report.units,
        enemies: fightEnemies,
      });
      currentAnalysis.process();

      // Populate enemy dropdown
      el_enemy.innerHTML = "";
      for (const [id, timeline] of currentAnalysis.timelines) {
        if (timeline.totalIgniteDamage === 0 && timeline.segments.length === 0) continue;
        const opt = document.createElement("option");
        opt.value = String(id);
        opt.textContent = timeline.enemyName + ` (${timeline.totalIgniteDamage.toFixed(0)} Ignite dmg)`;
        el_enemy.appendChild(opt);
      }

      selectEnemy();
      enableInput(true);
      document.getElementById("statusText").textContent = "";
    })
    .catch((e) => {
      document.getElementById("statusText").textContent = "";
      printError(e);
    });
}

// ── Enemy Selection ──

export function selectEnemy() {
  if (!currentAnalysis) return;
  const el = document.getElementById("enemySelect");
  const i = el.selectedIndex;
  if (i === -1) return;

  const enemyId = parseInt(el.options[i].value);
  const timeline = currentAnalysis.timelines.get(enemyId);
  if (!timeline) return;

  plotIgniteValue(timeline);
  plotCooldownTimeline(timeline);
  plotDebuffTimeline(timeline);
  plotIgniteThreat(timeline);
  plotCritTimeline(timeline);
  renderSummaryTable(timeline);
  renderSegmentsTable(timeline);
  renderFightStats(timeline);
}

// ── Graph: Ignite Value Over Time ──

function plotIgniteValue(timeline) {
  const el = document.getElementById("igniteValueGraph");
  el.innerHTML = "";

  if (timeline.history.length === 0) {
    el.textContent = "No Ignite data for this target.";
    return;
  }

  // Build the main line trace from all history points (single continuous line)
  const lineX = [], lineY = [], lineText = [];
  // Separate marker arrays for crits, ticks, drops, and refresh-only crits
  const critX = [], critY = [], critText = [], critColors = [];
  const refreshX = [], refreshY = [], refreshText = [];
  const dropX = [], dropY = [], dropText = [];

  // Assign colors per mage
  let colorIdx = 0;
  const mageColors = new Map();
  function getMageColor(mageId) {
    if (!mageColors.has(mageId)) {
      mageColors.set(mageId, getColor(colorIdx++));
    }
    return mageColors.get(mageId);
  }

  for (const point of timeline.history) {
    const t = (point.time - timeline.fightStart) / 1000;

    // Always add to the line trace
    lineX.push(t);
    lineY.push(point.value);
    lineText.push(point.event);

    // Categorize into marker buckets
    if (point.event.startsWith("Ignite dropped")) {
      dropX.push(t);
      dropY.push(0);
      dropText.push(point.event);
    } else if (point.refreshOnly) {
      refreshX.push(t);
      refreshY.push(point.value);
      refreshText.push(point.event);
    } else if (point.event.includes("crit") && point.event.includes("ignite")) {
      // Contributing crit
      critX.push(t);
      critY.push(point.value);
      critText.push(point.event);
      critColors.push(getMageColor(point.owner));
    }
  }

  const plotData = [];

  // Main Ignite value line
  plotData.push({
    x: lineX,
    y: lineY,
    text: lineText,
    type: "scatter",
    mode: "lines",
    name: "Ignite Value",
    hoverinfo: "text",
    line: { color: "#ff8800", shape: "hv", width: 2 },
  });

  // Contributing crit markers (colored per mage)
  if (critX.length > 0) {
    plotData.push({
      x: critX,
      y: critY,
      text: critText,
      type: "scatter",
      mode: "markers",
      name: "Contributing Crit",
      hoverinfo: "name+text",
      marker: { color: critColors, size: 9, symbol: "triangle-up",
        line: { width: 1, color: "#fff" } },
    });
  }

  // Refresh-only crit markers (capped at 5 stacks, no damage added)
  if (refreshX.length > 0) {
    plotData.push({
      x: refreshX,
      y: refreshY,
      text: refreshText,
      type: "scatter",
      mode: "markers",
      name: "Refresh Only (5/5 stacks)",
      hoverinfo: "name+text",
      marker: { color: "#888888", size: 8, symbol: "diamond",
        line: { width: 1, color: "#ffcc00" } },
    });
  }

  // Per-mage legend entries (so you can see which triangle color = which mage)
  for (const [mageId, color] of mageColors) {
    const mage = currentAnalysis.mageStats.get(mageId);
    if (!mage) continue;
    plotData.push({
      x: [null],
      y: [null],
      type: "scatter",
      mode: "markers",
      name: mage.name,
      hoverinfo: "none",
      marker: { color, size: 9, symbol: "triangle-up" },
    });
  }

  // Drop markers
  if (dropX.length > 0) {
    plotData.push({
      x: dropX,
      y: dropY,
      text: dropText,
      type: "scatter",
      mode: "markers",
      name: "Ignite Dropped",
      hoverinfo: "name+text",
      marker: { color: "#ff4444", size: 12, symbol: "x",
        line: { width: 2, color: "#ff4444" } },
    });
  }

  const fightDuration = (timeline.fightEnd - timeline.fightStart) / 1000;

  globalThis.Plotly.newPlot(el, plotData, {
    title: `Ignite Stack Value - ${timeline.enemyName}`,
    titlefont: { color: "#fff" },
    xaxis: {
      title: "Time (s)",
      titlefont: { color: "#fff" },
      tickcolor: "#666",
      tickfont: { color: "#fff" },
      rangemode: "tozero",
      gridcolor: "#666",
      linecolor: "#999",
      range: [0, fightDuration],
    },
    yaxis: {
      title: "Ignite Value",
      titlefont: { color: "#fff" },
      tickcolor: "#666",
      tickfont: { color: "#fff" },
      rangemode: "tozero",
      gridcolor: "#666",
      linecolor: "#999",
    },
    width: window.innerWidth - SCROLLBAR_WIDTH,
    height: 400,
    hovermode: "closest",
    plot_bgcolor: "#222",
    paper_bgcolor: "#222",
    legend: { font: { color: "#fff" } },
  });
}

// ── Subplot: Trinket/Cooldown Usage Timeline ──

function plotCooldownTimeline(timeline) {
  const el = document.getElementById("cooldownTimeline");
  el.innerHTML = "";

  if (!currentAnalysis) return;

  // Collect mages that have any cooldown usage
  const magesWithCooldowns = [];
  for (const [mageId, mage] of currentAnalysis.mageStats) {
    const intervals = currentAnalysis.cooldownIntervals.get(mageId);
    const piIntervals = currentAnalysis.powerInfusionIntervals.get(mageId);
    const hasCooldowns = (intervals && intervals.length > 0) || (piIntervals && piIntervals.length > 0);
    if (hasCooldowns) {
      magesWithCooldowns.push({ mageId, mage });
    }
  }

  if (magesWithCooldowns.length === 0) {
    el.textContent = "No trinket/cooldown usage detected.";
    return;
  }

  const fightDuration = (timeline.fightEnd - timeline.fightStart) / 1000;

  // Each mage gets a horizontal "lane" (y-value).
  const yLabels = [];

  // Group intervals by cooldown name so each becomes a toggleable trace
  // Each entry also collects label positions for a paired text trace
  const tracesByName = new Map(); // name -> { color, opacity, rects, labels }

  for (let i = 0; i < magesWithCooldowns.length; i++) {
    const { mageId, mage } = magesWithCooldowns[i];
    const y = i;
    yLabels.push(mage.name);

    // Trinket/cooldown intervals
    const intervals = currentAnalysis.cooldownIntervals.get(mageId) || [];
    for (const cd of intervals) {
      const x0 = Math.max(0, (cd.start - timeline.fightStart) / 1000);
      const x1 = Math.min(fightDuration, (cd.end - timeline.fightStart) / 1000);
      if (x1 <= 0 || x0 >= fightDuration) continue;

      if (!tracesByName.has(cd.name)) {
        tracesByName.set(cd.name, { color: cd.color, opacity: 0.7, textColor: "#fff", rects: [], labels: [] });
      }
      const entry = tracesByName.get(cd.name);
      entry.rects.push({ x0, x1, y });
      entry.labels.push({ x: (x0 + x1) / 2, y, text: cd.name });
    }

    // Power Infusion intervals
    const piIntervals = currentAnalysis.powerInfusionIntervals.get(mageId) || [];
    for (const pi of piIntervals) {
      const x0 = Math.max(0, (pi.start - timeline.fightStart) / 1000);
      const x1 = Math.min(fightDuration, (pi.end - timeline.fightStart) / 1000);
      if (x1 <= 0 || x0 >= fightDuration) continue;

      if (!tracesByName.has("Power Infusion")) {
        tracesByName.set("Power Infusion", { color: "#ffffff", opacity: 0.5, textColor: "#222", rects: [], labels: [] });
      }
      const entry = tracesByName.get("Power Infusion");
      entry.rects.push({ x0, x1, y });
      entry.labels.push({ x: (x0 + x1) / 2, y, text: "PI" });
    }
  }

  // Build one fill trace + one text trace per cooldown type, linked by legendgroup
  const plotData = [];
  for (const [name, { color, opacity, textColor, rects, labels }] of tracesByName) {
    const xs = [];
    const ys = [];
    for (const r of rects) {
      xs.push(r.x0, r.x1, r.x1, r.x0, r.x0, null);
      ys.push(r.y - 0.35, r.y - 0.35, r.y + 0.35, r.y + 0.35, r.y - 0.35, null);
    }
    plotData.push({
      x: xs,
      y: ys,
      fill: "toself",
      fillcolor: hexToRgba(color, opacity),
      line: { width: 1, color: "#fff" },
      mode: "lines",
      name,
      hoverinfo: "name",
      legendgroup: name,
    });
    // Text trace for labels — same legendgroup so it toggles with the bars
    plotData.push({
      x: labels.map((l) => l.x),
      y: labels.map((l) => l.y),
      text: labels.map((l) => l.text),
      mode: "text",
      textfont: { color: textColor, size: 10 },
      hoverinfo: "none",
      showlegend: false,
      legendgroup: name,
    });
  }

  // Add an invisible dummy trace if empty to ensure axes render
  if (plotData.length === 0) {
    plotData.push({
      x: [null], y: [null], type: "scatter", mode: "markers",
      hoverinfo: "none", showlegend: false,
    });
  }

  globalThis.Plotly.newPlot(el, plotData, {
    title: "Trinket / Cooldown Usage",
    titlefont: { color: "#fff", size: 13 },
    xaxis: {
      title: "Time (s)",
      titlefont: { color: "#fff", size: 11 },
      tickcolor: "#666",
      tickfont: { color: "#fff" },
      rangemode: "tozero",
      gridcolor: "#444",
      linecolor: "#999",
      range: [0, fightDuration],
    },
    yaxis: {
      tickmode: "array",
      tickvals: yLabels.map((_, i) => i),
      ticktext: yLabels,
      tickfont: { color: "#fff", size: 11 },
      gridcolor: "#333",
      linecolor: "#999",
      range: [-0.5, magesWithCooldowns.length - 0.5],
      fixedrange: true,
    },
    width: window.innerWidth - SCROLLBAR_WIDTH,
    height: 300,
    hovermode: false,
    plot_bgcolor: "#222",
    paper_bgcolor: "#222",
    legend: { font: { color: "#fff" }, orientation: "h", y: -0.15 },
  });
}

// ── Subplot: Enemy Debuff Timeline ──

function plotDebuffTimeline(timeline) {
  const el = document.getElementById("debuffTimeline");
  el.innerHTML = "";

  if (!currentAnalysis) return;

  const intervals = currentAnalysis.debuffIntervals.get(timeline.enemyId) || [];
  if (intervals.length === 0) {
    el.textContent = "No tracked debuffs detected on this target.";
    return;
  }

  const fightDuration = (timeline.fightEnd - timeline.fightStart) / 1000;

  // Group intervals by debuff name — each gets a horizontal lane
  const debuffNames = [];
  const tracesByName = new Map();

  for (const db of intervals) {
    if (!tracesByName.has(db.name)) {
      tracesByName.set(db.name, { color: db.color, rects: [], labels: [] });
      debuffNames.push(db.name);
    }
    const entry = tracesByName.get(db.name);
    const x0 = Math.max(0, (db.start - timeline.fightStart) / 1000);
    const x1 = Math.min(fightDuration, (db.end - timeline.fightStart) / 1000);
    if (x1 <= 0 || x0 >= fightDuration) continue;

    const y = debuffNames.indexOf(db.name);
    entry.rects.push({ x0, x1, y });
  }

  const plotData = [];
  for (const [name, { color, rects }] of tracesByName) {
    const xs = [];
    const ys = [];
    for (const r of rects) {
      xs.push(r.x0, r.x1, r.x1, r.x0, r.x0, null);
      ys.push(r.y - 0.35, r.y - 0.35, r.y + 0.35, r.y + 0.35, r.y - 0.35, null);
    }
    plotData.push({
      x: xs,
      y: ys,
      fill: "toself",
      fillcolor: hexToRgba(color, 0.7),
      line: { width: 1, color: "#fff" },
      mode: "lines",
      name,
      hoverinfo: "name",
    });
  }

  globalThis.Plotly.newPlot(el, plotData, {
    title: `Enemy Debuffs - ${timeline.enemyName}`,
    titlefont: { color: "#fff", size: 13 },
    xaxis: {
      title: "Time (s)",
      titlefont: { color: "#fff", size: 11 },
      tickcolor: "#666",
      tickfont: { color: "#fff" },
      rangemode: "tozero",
      gridcolor: "#444",
      linecolor: "#999",
      range: [0, fightDuration],
    },
    yaxis: {
      tickmode: "array",
      tickvals: debuffNames.map((_, i) => i),
      ticktext: debuffNames,
      tickfont: { color: "#fff", size: 11 },
      gridcolor: "#333",
      linecolor: "#999",
      range: [-0.5, debuffNames.length - 0.5],
      fixedrange: true,
    },
    width: window.innerWidth - SCROLLBAR_WIDTH,
    height: 200 + debuffNames.length * 30,
    hovermode: false,
    plot_bgcolor: "#222",
    paper_bgcolor: "#222",
    legend: { font: { color: "#fff" }, orientation: "h", y: -0.2 },
  });
}

// ── Graph: Ignite Threat Over Time ──

function plotIgniteThreat(timeline) {
  const el = document.getElementById("igniteThreatGraph");
  el.innerHTML = "";

  if (!currentAnalysis || timeline.threatHistory.length === 0) {
    el.textContent = "No Ignite threat data for this target.";
    return;
  }

  // Build one trace per mage showing cumulative threat over time
  // First, collect all mage IDs that appear in threat history
  const mageIds = new Set(timeline.threatHistory.map((h) => h.mageId));

  const plotData = [];
  let colorIdx = 0;

  for (const mageId of mageIds) {
    const mage = currentAnalysis.mageStats.get(mageId);
    const name = mage ? mage.name : `Mage ${mageId}`;
    const color = getColor(colorIdx++);

    // Filter threat events for this mage and build cumulative trace
    const x = [0], y = [0], text = [""];
    for (const h of timeline.threatHistory) {
      if (h.mageId !== mageId) continue;
      const t = (h.time - timeline.fightStart) / 1000;
      x.push(t);
      y.push(h.cumulative);
      text.push(`Tick: ${h.tickDamage} threat<br>Total: ${h.cumulative.toFixed(0)}`);
    }

    plotData.push({
      x,
      y,
      text,
      type: "scatter",
      mode: "lines+markers",
      name,
      hoverinfo: "name+text",
      line: { color, shape: "hv", width: 2 },
      marker: { color, size: 5 },
    });
  }

  // Build Tranquil Air shaded regions.
  // For each Ignite segment, the threat owner is the first crit mage.
  // Find where that mage had Tranquil Air active during their ownership period.
  const taShapes = [];
  for (const seg of timeline.segments) {
    if (seg.rolls.length === 0) continue;
    const ownerId = seg.rolls[0].mageId;
    const taIntervals = currentAnalysis.tranquilAirIntervals.get(ownerId);
    if (!taIntervals) continue;

    const segStart = seg.startTime;
    const segEnd = seg.endTime;

    for (const interval of taIntervals) {
      // Find overlap between TA interval and segment ownership period
      const overlapStart = Math.max(interval.start, segStart);
      const overlapEnd = Math.min(interval.end, segEnd);
      if (overlapStart >= overlapEnd) continue;

      taShapes.push({
        type: "rect",
        xref: "x",
        yref: "paper",
        x0: (overlapStart - timeline.fightStart) / 1000,
        x1: (overlapEnd - timeline.fightStart) / 1000,
        y0: 0,
        y1: 1,
        fillcolor: "rgba(0, 112, 222, 0.15)",
        line: { width: 0 },
      });
    }
  }

  // Add a dummy trace for the Tranquil Air legend entry if there are any regions
  if (taShapes.length > 0) {
    plotData.push({
      x: [null],
      y: [null],
      type: "scatter",
      mode: "markers",
      name: "Tranquil Air Active",
      hoverinfo: "none",
      marker: { color: "rgba(0, 112, 222, 0.4)", size: 12, symbol: "square" },
    });
  }

  const fightDuration = (timeline.fightEnd - timeline.fightStart) / 1000;

  globalThis.Plotly.newPlot(el, plotData, {
    title: `Ignite Threat - ${timeline.enemyName}`,
    titlefont: { color: "#fff" },
    xaxis: {
      title: "Time (s)",
      titlefont: { color: "#fff" },
      tickcolor: "#666",
      tickfont: { color: "#fff" },
      rangemode: "tozero",
      gridcolor: "#666",
      linecolor: "#999",
      range: [0, fightDuration],
    },
    yaxis: {
      title: "Cumulative Ignite Threat",
      titlefont: { color: "#fff" },
      tickcolor: "#666",
      tickfont: { color: "#fff" },
      rangemode: "tozero",
      gridcolor: "#666",
      linecolor: "#999",
    },
    shapes: taShapes,
    width: window.innerWidth - SCROLLBAR_WIDTH,
    height: 350,
    hovermode: "closest",
    plot_bgcolor: "#222",
    paper_bgcolor: "#222",
    legend: { font: { color: "#fff" } },
  });
}

// ── Graph: Crit Timeline ──

function plotCritTimeline(timeline) {
  const el = document.getElementById("critTimelineGraph");
  el.innerHTML = "";

  if (!currentAnalysis) return;

  const plotData = [];
  let colorIdx = 0;
  const mageColors = new Map();

  for (const [mageId, mage] of currentAnalysis.mageStats) {
    if (mage.fireSpellCrits === 0) continue;
    if (!mageColors.has(mageId)) mageColors.set(mageId, getColor(colorIdx++));

    const x = [], y = [], text = [];
    for (const ts of mage.critTimestamps) {
      if (ts < timeline.fightStart || ts > timeline.fightEnd) continue;
      x.push((ts - timeline.fightStart) / 1000);
      // Find the crit damage at this timestamp
      const hit = mage.allFireHits.find((h) => h.time === ts);
      const dmg = hit ? hit.damage : 0;
      y.push(dmg);
      text.push(`${hit ? hit.spell : "Fire"}: ${dmg} crit`);
    }

    if (x.length === 0) continue;

    plotData.push({
      x,
      y,
      text,
      type: "scatter",
      mode: "markers",
      name: mage.name,
      hoverinfo: "name+text",
      marker: { color: mageColors.get(mageId), size: 8 },
    });
  }

  // Build Power Infusion bands — shaded per mage in their color, very translucent
  const piShapes = [];
  for (const [mageId, color] of mageColors) {
    const piIntervals = currentAnalysis.powerInfusionIntervals.get(mageId);
    if (!piIntervals) continue;

    const rgba = hexToRgba(color, 0.12);
    for (const interval of piIntervals) {
      const x0 = (interval.start - timeline.fightStart) / 1000;
      const x1 = (interval.end - timeline.fightStart) / 1000;
      if (x1 <= 0 || x0 >= (timeline.fightEnd - timeline.fightStart) / 1000) continue;
      piShapes.push({
        type: "rect",
        xref: "x",
        yref: "paper",
        x0: Math.max(0, x0),
        x1,
        y0: 0,
        y1: 1,
        fillcolor: rgba,
        line: { width: 1, color: hexToRgba(color, 0.35) },
      });
    }
  }

  // Add PI legend entry if any bands exist
  if (piShapes.length > 0) {
    plotData.push({
      x: [null],
      y: [null],
      type: "scatter",
      mode: "markers",
      name: "Power Infusion",
      hoverinfo: "none",
      marker: { color: "rgba(255, 255, 255, 0.3)", size: 12, symbol: "square" },
    });
  }

  const fightDuration = (timeline.fightEnd - timeline.fightStart) / 1000;

  globalThis.Plotly.newPlot(el, plotData, {
    title: "Fire Crit Timeline",
    titlefont: { color: "#fff" },
    xaxis: {
      title: "Time (s)",
      titlefont: { color: "#fff" },
      tickcolor: "#666",
      tickfont: { color: "#fff" },
      rangemode: "tozero",
      gridcolor: "#666",
      linecolor: "#999",
      range: [0, fightDuration],
    },
    yaxis: {
      title: "Crit Damage",
      titlefont: { color: "#fff" },
      tickcolor: "#666",
      tickfont: { color: "#fff" },
      rangemode: "tozero",
      gridcolor: "#666",
      linecolor: "#999",
    },
    shapes: piShapes,
    width: window.innerWidth - SCROLLBAR_WIDTH,
    height: 300,
    hovermode: "closest",
    plot_bgcolor: "#222",
    paper_bgcolor: "#222",
    legend: { font: { color: "#fff" } },
  });
}

// ── Summary Table ──

function renderSummaryTable(timeline) {
  const el = document.getElementById("summaryTable");
  el.innerHTML = "";

  if (!currentAnalysis) return;
  const fightDuration = (timeline.fightEnd - timeline.fightStart) / 1000;

  const table = document.createElement("table");
  table.innerHTML = `
    <tr>
      <th>Mage</th>
      <th>Fire Crits</th>
      <th>Refresh Only</th>
      <th>Crit Damage</th>
      <th>Ignite Contributed</th>
      <th>Ownership %</th>
      <th>Ignite Threat</th>
      <th>Avg Crit Gap (s)</th>
    </tr>
  `;

  const mages = [...currentAnalysis.mageStats.values()]
    .filter((m) => m.fireSpellCrits > 0)
    .sort((a, b) => b.igniteContributed - a.igniteContributed);

  for (const mage of mages) {
    const ownershipPct = fightDuration > 0
      ? ((mage.ownershipTimeMs / 1000) / fightDuration * 100).toFixed(1)
      : "0.0";
    const avgGap = mage.avgTimeBetweenCrits > 0
      ? (mage.avgTimeBetweenCrits / 1000).toFixed(2)
      : "-";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${mage.name}</td>
      <td style="text-align:right">${mage.fireSpellCrits}</td>
      <td style="text-align:right">${mage.refreshOnlyCrits}</td>
      <td style="text-align:right">${mage.fireCritDamage.toFixed(0)}</td>
      <td style="text-align:right">${mage.igniteContributed.toFixed(0)}</td>
      <td style="text-align:right">${ownershipPct}%</td>
      <td style="text-align:right">${mage.igniteThreat.toFixed(0)}</td>
      <td style="text-align:right">${avgGap}</td>
    `;
    table.appendChild(tr);
  }

  el.appendChild(table);
}

// ── Segments Table ──

function renderSegmentsTable(timeline) {
  const el = document.getElementById("segmentsTable");
  el.innerHTML = "";

  if (timeline.segments.length === 0) return;

  const table = document.createElement("table");
  table.innerHTML = `
    <tr>
      <th>#</th>
      <th>Start (s)</th>
      <th>Duration (s)</th>
      <th>Peak Value</th>
      <th>Total Damage</th>
      <th>Crit 1</th>
      <th>Crit 2</th>
      <th>Crit 3</th>
      <th>Crit 4</th>
      <th>Crit 5</th>
    </tr>
  `;

  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = timeline.segments[i];
    const startSec = ((seg.startTime - timeline.fightStart) / 1000).toFixed(1);
    const duration = (seg.duration / 1000).toFixed(1);

    // Get the first 5 contributing crits (non-refresh-only)
    const contributing = seg.rolls.filter((r) => !r.refreshOnly).slice(0, 5);

    const critCells = [];
    for (let c = 0; c < 5; c++) {
      if (c < contributing.length) {
        const r = contributing[c];
        critCells.push(`<td>${r.mageName}<br>${r.spellName} ${r.critDamage}</td>`);
      } else {
        critCells.push(`<td></td>`);
      }
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align:right">${i + 1}</td>
      <td style="text-align:right">${startSec}</td>
      <td style="text-align:right">${duration}</td>
      <td style="text-align:right">${seg.peakValue.toFixed(0)}</td>
      <td style="text-align:right">${seg.totalTickDamage.toFixed(0)}</td>
      ${critCells.join("\n      ")}
    `;
    table.appendChild(tr);
  }

  el.appendChild(table);
}

// ── Fight Stats Panel ──

function renderFightStats(timeline) {
  const el = document.getElementById("fightStats");
  el.innerHTML = "";

  const fightDuration = (timeline.fightEnd - timeline.fightStart) / 1000;
  const longest = timeline.longestSegment;
  const longestDur = longest ? (longest.duration / 1000).toFixed(1) : "0";

  // Calculate total fire damage from mages
  let totalFireDamage = 0;
  if (currentAnalysis) {
    for (const [, mage] of currentAnalysis.mageStats) {
      for (const hit of mage.allFireHits) {
        totalFireDamage += hit.damage;
      }
    }
  }

  const contributingRolls = timeline.allRolls.filter((r) => !r.refreshOnly).length;
  const refreshOnlyRolls = timeline.allRolls.filter((r) => r.refreshOnly).length;

  const stats = [
    ["Ignite Uptime", `${timeline.uptimePercent.toFixed(1)}%`],
    ["Total Ignite Damage", timeline.totalIgniteDamage.toFixed(0)],
    ["Total Lost Damage", timeline.totalLostDamage.toFixed(0)],
    ["Drops", timeline.drops.length],
    ["Segments", timeline.segments.length],
    ["Contributing Crits", `${contributingRolls} (added damage)`],
    ["Refresh-Only Crits", `${refreshOnlyRolls} (at 5 stacks, duration only)`],
    ["Longest Segment", `${longestDur}s`],
    ["Fight Duration", `${fightDuration.toFixed(1)}s`],
    totalFireDamage > 0
      ? ["Ignite % of Fire Damage", `${((timeline.totalIgniteDamage / totalFireDamage) * 100).toFixed(1)}%`]
      : null,
  ].filter(Boolean);

  const table = document.createElement("table");
  for (const [label, value] of stats) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = label;
    th.style.textAlign = "left";
    const td = document.createElement("td");
    td.textContent = value;
    tr.appendChild(th);
    tr.appendChild(td);
    table.appendChild(tr);
  }
  el.appendChild(table);
}

// ── Page Load ──

export function loadPage() {
  const idParam = getParam("id");
  if (idParam) {
    document.getElementById("reportSelect").value = idParam;
    selectReport();
  }
}
