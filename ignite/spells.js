/**
 * Fire Mage Ignite spell configuration for Classic WoW ERA.
 *
 * Ignite (Talent): Fire spell crits apply a DoT for 40% of the crit damage
 * over 4 seconds (2 ticks). Shared across all mages on a single target.
 */

export const IGNITE_SPELL_ID = 12654;
export const IGNITE_DURATION_MS = 4000;
export const IGNITE_TICK_INTERVAL_MS = 2000;
export const IGNITE_DAMAGE_PERCENT = 0.40; // 40% of crit damage at rank 5

/** WCL spell school constants */
export const School = {
  Physical: 1,
  Holy: 2,
  Fire: 4,
  Nature: 8,
  Frost: 16,
  Shadow: 32,
  Arcane: 64,
};

/** Combustion buff ID */
export const COMBUSTION_BUFF_ID = 29977;

/**
 * All fire spell IDs that can trigger Ignite (when they crit).
 * Includes all ranks of each spell.
 */
export const FIRE_SPELL_IDS = new Set([
  // Fireball (Ranks 1-12)
  133, 143, 145, 3140, 8400, 8401, 8402, 10148, 10149, 10150, 10151, 25306,
  // Fire Blast (Ranks 1-7)
  2136, 2137, 2138, 8412, 8413, 10197, 10199,
  // Scorch (Ranks 1-7)
  2948, 8444, 8445, 8446, 10205, 10206, 10207,
  // Pyroblast (Ranks 1-8)
  11366, 12505, 12522, 12523, 12524, 12525, 12526, 18809,
  // Flamestrike (Ranks 1-6)
  2120, 2121, 8422, 8423, 10215, 10216,
  // Blast Wave (Ranks 1-5)
  11113, 13018, 13019, 13020, 13021,
  // Cone of Cold is frost, not fire
  // Dragon's Breath (not in Classic ERA)
]);

/**
 * Spell names for display purposes.
 */
export const FIRE_SPELL_NAMES = {
  133: "Fireball", 143: "Fireball", 145: "Fireball", 3140: "Fireball",
  8400: "Fireball", 8401: "Fireball", 8402: "Fireball", 10148: "Fireball",
  10149: "Fireball", 10150: "Fireball", 10151: "Fireball", 25306: "Fireball",
  2136: "Fire Blast", 2137: "Fire Blast", 2138: "Fire Blast",
  8412: "Fire Blast", 8413: "Fire Blast", 10197: "Fire Blast", 10199: "Fire Blast",
  2948: "Scorch", 8444: "Scorch", 8445: "Scorch", 8446: "Scorch",
  10205: "Scorch", 10206: "Scorch", 10207: "Scorch",
  11366: "Pyroblast", 12505: "Pyroblast", 12522: "Pyroblast", 12523: "Pyroblast",
  12524: "Pyroblast", 12525: "Pyroblast", 12526: "Pyroblast", 18809: "Pyroblast",
  2120: "Flamestrike", 2121: "Flamestrike", 8422: "Flamestrike",
  8423: "Flamestrike", 10215: "Flamestrike", 10216: "Flamestrike",
  11113: "Blast Wave", 13018: "Blast Wave", 13019: "Blast Wave",
  13020: "Blast Wave", 13021: "Blast Wave",
};

/** Tranquil Air Totem buff — reduces threat by 20% */
export const TRANQUIL_AIR_BUFF_ID = 25909;
export const TRANQUIL_AIR_THREAT_MODIFIER = 0.8;

/** Power Infusion buff — 20% increased spell damage for 15s */
export const POWER_INFUSION_BUFF_ID = 10060;

/**
 * Trackable trinket/cooldown buff IDs for fire mages.
 * Only one on-use trinket can be active at a time.
 */
export const TRACKED_COOLDOWNS = {
  23271: { name: "TOEP", color: "#ffcc00" },        // Talisman of Ephemeral Power
  24659: { name: "ZHC", color: "#00cc66" },          // Unstable Power (Zandalarian Hero Charm)
  23723: { name: "MQG", color: "#cc44ff" },          // Mind Quickening Gem
  28779: { name: "Sapphiron", color: "#00aadd" },    // Essence of Sapphiron (Restrained Essence)
  29977: { name: "Combustion", color: "#ff4400" },   // Combustion
  12042: { name: "AP", color: "#4488ff" },            // Arcane Power
};

/** All tracked cooldown buff IDs as a Set */
export const TRACKED_COOLDOWN_IDS = new Set(Object.keys(TRACKED_COOLDOWNS).map(Number));

/**
 * Tracked enemy debuffs that boost fire damage.
 * Multiple spell IDs may map to the same debuff (different ranks).
 */
export const TRACKED_DEBUFFS = {
  // Curse of Elements (Ranks 1-3) — reduces fire/frost resistance
  1490:  { name: "Curse of Elements", color: "#8787ed" },
  11721: { name: "Curse of Elements", color: "#8787ed" },
  11722: { name: "Curse of Elements", color: "#8787ed" },
  // Fire Vulnerability (Improved Scorch) — +3% fire damage per stack, up to 5
  22959: { name: "Fire Vulnerability", color: "#ff6622" },
  // Spell Vulnerability (Nightfall axe proc) — +15% spell damage
  23605: { name: "Spell Vulnerability", color: "#cc44ff" },
  // Flame Buffet (Arcanite Dragonling) — reduces fire resistance, stacks
  9658:  { name: "Flame Buffet", color: "#ff4444" },
};

/** All tracked debuff spell IDs as a Set */
export const TRACKED_DEBUFF_IDS = new Set(Object.keys(TRACKED_DEBUFFS).map(Number));

/** WCL hit types */
export const HitType = {
  Miss: 0,
  Normal: 1,
  Crit: 2,
};
