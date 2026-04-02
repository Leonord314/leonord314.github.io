/**
 * Core Ignite analysis engine.
 *
 * Processes WCL combat events to reconstruct the shared Ignite debuff timeline
 * on each enemy, tracking ownership, rolls, drops, damage, and per-mage contributions.
 */

import {
  IGNITE_SPELL_ID,
  IGNITE_DURATION_MS,
  IGNITE_DAMAGE_PERCENT,
  FIRE_SPELL_NAMES,
  HitType,
  School,
  TRANQUIL_AIR_BUFF_ID,
  POWER_INFUSION_BUFF_ID,
  TRACKED_COOLDOWN_IDS,
  TRACKED_COOLDOWNS,
} from "./spells.js";

/**
 * @typedef {{
 *   time: number;
 *   damage: number;
 *   owner: number;
 * }} IgniteTick
 */

/** Maximum number of crits that can contribute damage to a single Ignite */
export const MAX_IGNITE_STACKS = 5;

/**
 * @typedef {{
 *   time: number;
 *   mageId: number;
 *   mageName: string;
 *   critDamage: number;
 *   spellName: string;
 *   igniteContribution: number;
 *   newStackValue: number;
 *   stackCount: number;
 *   refreshOnly: boolean;
 * }} IgniteRoll
 */

/**
 * @typedef {{
 *   time: number;
 *   lostValue: number;
 *   reason: string;
 * }} IgniteDrop
 */

/**
 * @typedef {{
 *   time: number;
 *   value: number;
 *   owner: number;
 *   event: string;
 *   stacks: number;
 * }} IgniteHistoryPoint
 */

/**
 * A single continuous Ignite segment — from first application to when it falls off.
 */
export class IgniteSegment {
  /**
   * @param {number} startTime
   * @param {number} firstOwner
   * @param {number} initialValue
   */
  constructor(startTime, firstOwner, initialValue) {
    this.startTime = startTime;
    this.endTime = startTime;
    this.owner = firstOwner;
    this.value = initialValue;
    this.peakValue = initialValue;

    /** @type {IgniteTick[]} */
    this.ticks = [];
    /** @type {IgniteRoll[]} */
    this.rolls = [];
    /** @type {number} */
    this.totalTickDamage = 0;
    /** @type {number} */
    this.lostDamage = 0;
    /** @type {string} */
    this.dropReason = "";

    /** @type {number} */
    this.maxStacks = 1;
    /** @type {number} */
    this.refreshOnlyCrits = 0;

    /** @type {Map<number, {crits: number, critDamage: number, contributed: number, refreshOnlyCrits: number, ownershipTime: number}>} */
    this.mageContributions = new Map();
  }

  get duration() {
    return this.endTime - this.startTime;
  }

  recordContribution(mageId, critDamage, contribution, refreshOnly) {
    let entry = this.mageContributions.get(mageId);
    if (!entry) {
      entry = { crits: 0, critDamage: 0, contributed: 0, refreshOnlyCrits: 0, ownershipTime: 0 };
      this.mageContributions.set(mageId, entry);
    }
    entry.crits++;
    entry.critDamage += critDamage;
    if (refreshOnly) {
      entry.refreshOnlyCrits++;
    } else {
      entry.contributed += contribution;
    }
  }
}

/**
 * Manages the full Ignite timeline for one enemy target across a fight.
 */
export class IgniteTimeline {
  /**
   * @param {number} enemyId
   * @param {string} enemyName
   * @param {number} fightStart
   * @param {number} fightEnd
   */
  constructor(enemyId, enemyName, fightStart, fightEnd) {
    this.enemyId = enemyId;
    this.enemyName = enemyName;
    this.fightStart = fightStart;
    this.fightEnd = fightEnd;

    /** @type {IgniteSegment[]} */
    this.segments = [];
    /** @type {IgniteSegment | null} */
    this.currentSegment = null;

    /** @type {IgniteHistoryPoint[]} */
    this.history = [];
    /** @type {IgniteDrop[]} */
    this.drops = [];
    /** @type {IgniteRoll[]} */
    this.allRolls = [];

    // Current state
    this.active = false;
    this.currentOwner = -1;
    /** The mage who applied the first crit of the current segment — owns all threat */
    this.threatOwner = -1;
    this.currentValue = 0;
    this.lastRefreshTime = 0;
    /** Number of crits currently stored in this Ignite (max 5 contribute damage) */
    this.currentStacks = 0;

    // Aggregate stats
    this.totalIgniteDamage = 0;
    this.totalLostDamage = 0;
    this.totalRefreshOnlyCrits = 0;

    /**
     * Cumulative Ignite threat per mage, recorded at each tick.
     * @type {{time: number, mageId: number, mageName: string, tickDamage: number, cumulative: number}[]}
     */
    this.threatHistory = [];
    /** Running cumulative threat totals per mage ID */
    this._cumulativeThreat = new Map();
  }

  get uptimeMs() {
    let total = 0;
    for (const seg of this.segments) {
      total += seg.duration;
    }
    return total;
  }

  get uptimePercent() {
    const fightDuration = this.fightEnd - this.fightStart;
    if (fightDuration <= 0) return 0;
    return (this.uptimeMs / fightDuration) * 100;
  }

  get longestSegment() {
    let longest = null;
    for (const seg of this.segments) {
      if (!longest || seg.duration > longest.duration) longest = seg;
    }
    return longest;
  }

  /**
   * Handle a fire spell crit hitting this enemy.
   *
   * Ignite mechanics:
   * - Any crit refreshes the 4-second duration
   * - Only the first 5 crits add damage (40% of crit value each)
   * - Crits beyond 5 are "refresh only" — they keep it alive but don't increase damage
   */
  handleFireCrit(time, mageId, mageName, critDamage, spellId) {
    const potentialContribution = critDamage * IGNITE_DAMAGE_PERCENT;
    const spellName = FIRE_SPELL_NAMES[spellId] || `Spell ${spellId}`;

    if (this.active && this.currentSegment) {
      // ROLL: Ignite is already active — refresh duration, maybe add damage
      this.currentStacks++;
      const refreshOnly = this.currentStacks > MAX_IGNITE_STACKS;
      const contribution = refreshOnly ? 0 : potentialContribution;

      if (!refreshOnly) {
        this.currentValue += contribution;
        this.currentSegment.value = this.currentValue;
        if (this.currentValue > this.currentSegment.peakValue) {
          this.currentSegment.peakValue = this.currentValue;
        }
      } else {
        this.totalRefreshOnlyCrits++;
        this.currentSegment.refreshOnlyCrits++;
      }

      // Always refresh duration; currentOwner tracks last crit, threatOwner stays locked
      this.currentOwner = mageId;
      this.lastRefreshTime = time;
      this.currentSegment.endTime = time + IGNITE_DURATION_MS;
      if (this.currentStacks > this.currentSegment.maxStacks) {
        this.currentSegment.maxStacks = this.currentStacks;
      }

      const roll = {
        time,
        mageId,
        mageName,
        critDamage,
        spellName,
        igniteContribution: contribution,
        newStackValue: this.currentValue,
        stackCount: this.currentStacks,
        refreshOnly,
      };
      this.currentSegment.rolls.push(roll);
      this.allRolls.push(roll);
      this.currentSegment.recordContribution(mageId, critDamage, contribution, refreshOnly);
    } else {
      // START: new Ignite segment — first crit always contributes and owns all threat
      this.active = true;
      this.currentOwner = mageId;
      this.threatOwner = mageId;
      this.currentStacks = 1;
      this.currentValue = potentialContribution;
      this.lastRefreshTime = time;

      this.currentSegment = new IgniteSegment(time, mageId, potentialContribution);
      this.segments.push(this.currentSegment);
      this.currentSegment.recordContribution(mageId, critDamage, potentialContribution, false);

      const roll = {
        time,
        mageId,
        mageName,
        critDamage,
        spellName,
        igniteContribution: potentialContribution,
        newStackValue: this.currentValue,
        stackCount: 1,
        refreshOnly: false,
      };
      this.currentSegment.rolls.push(roll);
      this.allRolls.push(roll);
    }

    const refreshOnly = this.currentStacks > MAX_IGNITE_STACKS;
    const actualContribution = refreshOnly ? 0 : potentialContribution;
    const label = refreshOnly
      ? `${mageName}: ${spellName} crit ${critDamage} (${this.currentStacks}/${MAX_IGNITE_STACKS} stacks)`
      : `${mageName}: ${spellName} crit ${critDamage} (+${actualContribution.toFixed(0)} ignite, stack ${this.currentStacks}/${MAX_IGNITE_STACKS})`;

    this.history.push({
      time,
      value: this.currentValue,
      owner: this.currentOwner,
      event: label,
      stacks: this.currentStacks,
      refreshOnly,
    });
  }

  /**
   * Handle an Ignite damage tick.
   *
   * Ticks do not change currentValue — that tracks the accumulated crit
   * contributions (the Ignite's "strength"). Ticks are just the DoT dealing
   * its expected damage and are recorded for stats only.
   */
  handleIgniteTick(time, damage, mageName) {
    this.totalIgniteDamage += damage;
    if (this.currentSegment) {
      this.currentSegment.ticks.push({ time, damage, owner: this.threatOwner });
      this.currentSegment.totalTickDamage += damage;
    }
    // Record threat — all tick threat goes to the segment's first crit owner
    if (this.threatOwner > 0) {
      const prev = this._cumulativeThreat.get(this.threatOwner) || 0;
      const cumulative = prev + damage;
      this._cumulativeThreat.set(this.threatOwner, cumulative);
      this.threatHistory.push({
        time,
        mageId: this.threatOwner,
        mageName: mageName || "",
        tickDamage: damage,
        cumulative,
      });
    }
  }

  /**
   * Handle Ignite falling off (removedebuff or expiry).
   */
  handleIgniteDrop(time, reason = "Expired") {
    if (!this.active) return;

    const lostValue = this.currentValue;
    this.totalLostDamage += lostValue;

    this.drops.push({ time, lostValue, reason });
    if (this.currentSegment) {
      this.currentSegment.endTime = time;
      this.currentSegment.lostDamage = lostValue;
      this.currentSegment.dropReason = reason;
    }

    this.history.push({
      time,
      value: 0,
      owner: this.currentOwner,
      event: `Ignite dropped: ${reason} (lost ${lostValue.toFixed(0)}, had ${this.currentStacks} stacks)`,
      stacks: 0,
    });

    this.active = false;
    this.currentSegment = null;
    this.currentOwner = -1;
    this.threatOwner = -1;
    this.currentValue = 0;
    this.currentStacks = 0;
  }

  /**
   * Finalize at end of fight — close any open segment.
   */
  finalize() {
    if (this.active && this.currentSegment) {
      this.currentSegment.endTime = this.fightEnd;
      this.currentSegment.dropReason = "Fight ended";
      this.active = false;
    }
  }
}

/**
 * Per-mage aggregated statistics across the entire fight.
 */
export class MageStats {
  /**
   * @param {number} id
   * @param {string} name
   */
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.fireSpellCasts = 0;
    this.fireSpellCrits = 0;
    this.fireCritDamage = 0;
    this.igniteContributed = 0;
    /** Crits that hit while Ignite was already at 5 stacks (refresh only, no damage added) */
    this.refreshOnlyCrits = 0;
    this.igniteThreat = 0;
    this.ownershipTimeMs = 0;
    /** @type {number[]} */
    this.critTimestamps = [];
    /** @type {{time: number, damage: number, spell: string}[]} */
    this.allFireHits = [];
  }

  get avgTimeBetweenCrits() {
    if (this.critTimestamps.length < 2) return 0;
    const sorted = [...this.critTimestamps].sort((a, b) => a - b);
    let totalGap = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalGap += sorted[i] - sorted[i - 1];
    }
    return totalGap / (sorted.length - 1);
  }
}

/**
 * Main analysis result for a fight.
 */
export class IgniteAnalysis {
  /**
   * @param {object} params
   * @param {any[]} params.events - WCL events
   * @param {number} params.fightStart
   * @param {number} params.fightEnd
   * @param {Record<number, {id: number, name: string, type: string}>} params.units
   * @param {Record<number, {id: number, name: string}>} params.enemies
   */
  constructor({ events, fightStart, fightEnd, units, enemies }) {
    this.events = events;
    this.fightStart = fightStart;
    this.fightEnd = fightEnd;
    this.units = units;
    this.enemies = enemies;

    /** @type {Map<number, IgniteTimeline>} */
    this.timelines = new Map();

    /** @type {Map<number, MageStats>} */
    this.mageStats = new Map();

    /**
     * Tranquil Air uptime intervals per player ID.
     * Each entry is an array of {start, end} intervals.
     * @type {Map<number, {start: number, end: number}[]>}
     */
    this.tranquilAirIntervals = new Map();
    /** Tracks whether Tranquil Air is currently active per player (for building intervals) */
    this._tranquilAirActive = new Map();

    /**
     * Power Infusion uptime intervals per player ID (the target who received PI).
     * @type {Map<number, {start: number, end: number}[]>}
     */
    this.powerInfusionIntervals = new Map();
    this._powerInfusionActive = new Map();

    /**
     * Trinket/cooldown uptime intervals per player ID.
     * Each entry is an array of {start, end, spellId, name, color}.
     * @type {Map<number, {start: number, end: number, spellId: number, name: string, color: string}[]>}
     */
    this.cooldownIntervals = new Map();
    /** @type {Map<string, number>} key = "playerId-spellId" */
    this._cooldownActive = new Map();
  }

  /**
   * Process all events and build the Ignite timelines.
   */
  process() {
    // Initialize timelines for each enemy
    for (const id in this.enemies) {
      const enemy = this.enemies[id];
      this.timelines.set(
        enemy.id,
        new IgniteTimeline(enemy.id, enemy.name, this.fightStart, this.fightEnd)
      );
    }

    // Initialize mage stats for each mage in the raid
    for (const id in this.units) {
      const unit = this.units[id];
      if (unit.type === "Mage") {
        this.mageStats.set(unit.id, new MageStats(unit.id, unit.name));
      }
    }

    // Process events chronologically
    for (const ev of this.events) {
      this._processEvent(ev);
    }

    // Close any Tranquil Air intervals that were still active at fight end
    for (const [playerId, startTime] of this._tranquilAirActive) {
      if (!this.tranquilAirIntervals.has(playerId)) {
        this.tranquilAirIntervals.set(playerId, []);
      }
      this.tranquilAirIntervals.get(playerId).push({ start: startTime, end: this.fightEnd });
    }

    // Close any Power Infusion intervals that were still active at fight end
    for (const [playerId, startTime] of this._powerInfusionActive) {
      if (!this.powerInfusionIntervals.has(playerId)) {
        this.powerInfusionIntervals.set(playerId, []);
      }
      this.powerInfusionIntervals.get(playerId).push({ start: startTime, end: this.fightEnd });
    }

    // Close any tracked cooldown intervals that were still active at fight end
    for (const [key, startTime] of this._cooldownActive) {
      const [playerIdStr, spellIdStr] = key.split("-");
      const playerId = parseInt(playerIdStr);
      const spellId = parseInt(spellIdStr);
      if (!this.cooldownIntervals.has(playerId)) {
        this.cooldownIntervals.set(playerId, []);
      }
      const cd = TRACKED_COOLDOWNS[spellId];
      this.cooldownIntervals.get(playerId).push({
        start: startTime,
        end: this.fightEnd,
        spellId,
        name: cd ? cd.name : `${spellId}`,
        color: cd ? cd.color : "#888",
      });
    }

    // Finalize all timelines
    for (const [, timeline] of this.timelines) {
      timeline.finalize();
      this._calculateOwnership(timeline);
    }
  }

  _processEvent(ev) {
    if (!ev.ability) return;
    const spellId = ev.ability.guid;

    // Fire spell damage from a friendly mage hitting an enemy.
    // Detect by spell school (ability.type includes Fire = 4) rather than
    // a hardcoded spell ID list, so we catch all fire spells across game versions.
    const isFireSchool = ev.ability && (ev.ability.type & School.Fire) !== 0;
    if (
      ev.type === "damage" &&
      ev.sourceIsFriendly &&
      !ev.targetIsFriendly &&
      isFireSchool &&
      spellId !== IGNITE_SPELL_ID && // Ignite ticks are handled separately
      !ev.tick // Exclude periodic damage (e.g. Pyroblast DoT) — only direct hits trigger Ignite
    ) {
      const mage = this.mageStats.get(ev.sourceID);
      if (!mage) return; // Not a mage we're tracking

      mage.fireSpellCasts++;
      const spellName = FIRE_SPELL_NAMES[spellId] || ev.ability.name;
      mage.allFireHits.push({ time: ev.timestamp, damage: ev.amount || 0, spell: spellName });

      // Check for crit
      if (ev.hitType === HitType.Crit) {
        const critDamage = ev.amount || 0;
        mage.fireSpellCrits++;
        mage.fireCritDamage += critDamage;
        mage.critTimestamps.push(ev.timestamp);

        // Find or create timeline for this enemy
        let timeline = this.timelines.get(ev.targetID);
        if (!timeline) {
          const enemyUnit = this.units[ev.targetID];
          const name = enemyUnit ? enemyUnit.name : `Enemy ${ev.targetID}`;
          timeline = new IgniteTimeline(ev.targetID, name, this.fightStart, this.fightEnd);
          this.timelines.set(ev.targetID, timeline);
        }

        // Check if this crit will actually contribute damage (stack cap)
        const willContribute = !timeline.active || timeline.currentStacks < MAX_IGNITE_STACKS;
        if (willContribute) {
          mage.igniteContributed += critDamage * IGNITE_DAMAGE_PERCENT;
        } else {
          mage.refreshOnlyCrits++;
        }

        timeline.handleFireCrit(ev.timestamp, ev.sourceID, mage.name, critDamage, spellId);
      }
    }

    // Ignite damage tick
    if (
      ev.type === "damage" &&
      spellId === IGNITE_SPELL_ID &&
      ev.sourceIsFriendly &&
      !ev.targetIsFriendly
    ) {
      const timeline = this.timelines.get(ev.targetID);
      if (timeline) {
        const damage = ev.amount || 0;
        // Threat goes to the first crit owner of the current segment
        const threatOwnerMage = this.mageStats.get(timeline.threatOwner);
        const ownerName = threatOwnerMage ? threatOwnerMage.name : "";
        timeline.handleIgniteTick(ev.timestamp, damage, ownerName);

        if (threatOwnerMage) {
          threatOwnerMage.igniteThreat += damage;
        }
      }
    }

    // Ignite debuff applied on enemy (applydebuff)
    if (
      (ev.type === "applydebuff") &&
      spellId === IGNITE_SPELL_ID &&
      !ev.targetIsFriendly
    ) {
      // We handle application via fire crit detection above,
      // but this confirms the buff was applied
    }

    // Ignite debuff refreshed on enemy
    if (
      ev.type === "refreshdebuff" &&
      spellId === IGNITE_SPELL_ID &&
      !ev.targetIsFriendly
    ) {
      // Refresh is handled by fire crit detection
    }

    // Ignite debuff removed from enemy
    if (
      ev.type === "removedebuff" &&
      spellId === IGNITE_SPELL_ID &&
      !ev.targetIsFriendly
    ) {
      const timeline = this.timelines.get(ev.targetID);
      if (timeline) {
        timeline.handleIgniteDrop(ev.timestamp, "Expired");
      }
    }

    // Enemy death — close Ignite
    if (ev.type === "death" && !ev.targetIsFriendly) {
      const timeline = this.timelines.get(ev.targetID);
      if (timeline && timeline.active) {
        timeline.handleIgniteDrop(ev.timestamp, "Target died");
      }
    }

    // Tranquil Air Totem buff applied to a friendly player
    if (ev.type === "applybuff" && spellId === TRANQUIL_AIR_BUFF_ID && ev.targetIsFriendly) {
      this._tranquilAirActive.set(ev.targetID, ev.timestamp);
    }

    // Tranquil Air Totem buff removed from a friendly player
    if (ev.type === "removebuff" && spellId === TRANQUIL_AIR_BUFF_ID && ev.targetIsFriendly) {
      const startTime = this._tranquilAirActive.get(ev.targetID);
      if (startTime !== undefined) {
        if (!this.tranquilAirIntervals.has(ev.targetID)) {
          this.tranquilAirIntervals.set(ev.targetID, []);
        }
        this.tranquilAirIntervals.get(ev.targetID).push({ start: startTime, end: ev.timestamp });
        this._tranquilAirActive.delete(ev.targetID);
      }
    }

    // Power Infusion applied to a friendly player
    if (ev.type === "applybuff" && spellId === POWER_INFUSION_BUFF_ID && ev.targetIsFriendly) {
      this._powerInfusionActive.set(ev.targetID, ev.timestamp);
    }

    // Power Infusion removed from a friendly player
    if (ev.type === "removebuff" && spellId === POWER_INFUSION_BUFF_ID && ev.targetIsFriendly) {
      const startTime = this._powerInfusionActive.get(ev.targetID);
      if (startTime !== undefined) {
        if (!this.powerInfusionIntervals.has(ev.targetID)) {
          this.powerInfusionIntervals.set(ev.targetID, []);
        }
        this.powerInfusionIntervals.get(ev.targetID).push({ start: startTime, end: ev.timestamp });
        this._powerInfusionActive.delete(ev.targetID);
      }
    }

    // Tracked trinkets/cooldowns (TOEP, ZHC, MQG, Combustion, AP)
    if (ev.type === "applybuff" && TRACKED_COOLDOWN_IDS.has(spellId) && ev.targetIsFriendly) {
      const key = ev.targetID + "-" + spellId;
      this._cooldownActive.set(key, ev.timestamp);
    }

    if (ev.type === "removebuff" && TRACKED_COOLDOWN_IDS.has(spellId) && ev.targetIsFriendly) {
      const key = ev.targetID + "-" + spellId;
      const startTime = this._cooldownActive.get(key);
      if (startTime !== undefined) {
        if (!this.cooldownIntervals.has(ev.targetID)) {
          this.cooldownIntervals.set(ev.targetID, []);
        }
        const cd = TRACKED_COOLDOWNS[spellId];
        this.cooldownIntervals.get(ev.targetID).push({
          start: startTime,
          end: ev.timestamp,
          spellId,
          name: cd.name,
          color: cd.color,
        });
        this._cooldownActive.delete(key);
      }
    }
  }

  /**
   * Calculate ownership time per mage for a timeline.
   */
  _calculateOwnership(timeline) {
    if (timeline.history.length === 0) return;

    let lastTime = timeline.history[0].time;
    let lastOwner = timeline.history[0].owner;

    for (let i = 1; i < timeline.history.length; i++) {
      const point = timeline.history[i];
      if (lastOwner > 0) {
        const mage = this.mageStats.get(lastOwner);
        if (mage) {
          mage.ownershipTimeMs += point.time - lastTime;
        }
      }
      lastTime = point.time;
      lastOwner = point.owner;
    }
  }

  /**
   * Get the primary timeline (the one with the most Ignite damage — typically the boss).
   */
  getPrimaryTimeline() {
    let best = null;
    let bestDamage = 0;
    for (const [, timeline] of this.timelines) {
      if (timeline.totalIgniteDamage > bestDamage) {
        bestDamage = timeline.totalIgniteDamage;
        best = timeline;
      }
    }
    return best;
  }
}
