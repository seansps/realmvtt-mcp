/**
 * FX animations — the spell/attack effects an `<fxcontrol>` field drives.
 *
 * ── Where one is stored ───────────────────────────────────────────────────────
 * A ruleset declares `<fxcontrol field="animation">` in a record type's layout
 * (5e and Level Up both do, on spells, items, abilities and npc-actions). The
 * RecordTab resolves that to the data path `data.<field>`, so the usual home is
 * `data.animation` — but the field name comes from the RULESET, so it is a
 * parameter here rather than a constant.
 *
 * The stored value is a plain object of the shape FXControl's `defaultAnimationData`
 * describes: `animationName` plus presentation overrides. An UNSET control writes
 * nothing at all, which is why a freshly imported spell simply has no `animation`
 * key rather than an empty one.
 *
 * ── What `animationName` may be ───────────────────────────────────────────────
 * Either one of the 25 built-in sprite-sheet effects catalogued below, or a path to
 * a campaign WEBM (the "custom animation" browser lists the campaign's own webm
 * uploads). Only the built-ins are global and therefore the only thing this module
 * validates; a custom path is campaign-scoped and passed through untouched.
 *
 * ── On the descriptions ───────────────────────────────────────────────────────
 * `motion`, `scale`, `sound` and the frame phases are read off the real
 * `ANIMATIONS` table in `defaultAnimations.ts` and are exact. `looks` and
 * `goodFor` are editorial — derived from each effect's NAME and its motion, to give
 * a caller enough to choose sensibly. They are a guide, not a rendering.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, RealmClient } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { json, safe, text } from "./registry.js";

/**
 * How an effect moves, which is the thing that actually decides whether it suits a
 * spell. Read off `moveToDestination` / `destinationOnly` / `startAtCenter`.
 */
export type Motion =
  /** Flies from the caster to the target. Ranged attacks and bolt-style spells. */
  | "projectile"
  /** Plays only at the target. Area spells, and anything that lands rather than flies. */
  | "burst"
  /** Plays at the target, up close. Melee swings. */
  | "melee"
  /** Plays centred on the caster. Buffs, wards, self-targeted spells. */
  | "self";

export interface AnimationInfo extends Json {
  name: string;
  motion: Motion;
  /** What it depicts — editorial, see the module comment. */
  looks: string;
  /** The kinds of record this suits — editorial. */
  goodFor: string;
  /** The effect's own default scale, from the ANIMATIONS table. */
  scale: number;
  /** Sound the effect ships with, if any. */
  sound?: string;
}

/**
 * The built-in effects, mirroring `ANIMATIONS` in the client's
 * `VttRenderer/defaultAnimations.ts`. Kept as a literal rather than fetched: it is
 * compiled into the client, not served by any API, so there is nothing to fetch.
 * If the client's table gains an entry, add it here.
 */
export const ANIMATIONS: AnimationInfo[] = [
  {
    name: "air_1",
    motion: "projectile",
    looks: "A gust or blast of wind travelling to the target.",
    goodFor: "Thunder, force and wind spells — gust of wind, thunderwave at range.",
    scale: 1.0,
  },
  {
    name: "arrow_1",
    motion: "projectile",
    looks: "A single arrow in flight.",
    goodFor: "Bow attacks, and arrow-shaped spells like arcane archer shots.",
    scale: 0.5,
  },
  {
    name: "arrow_2",
    motion: "projectile",
    looks: "An arrow in flight, alternate art.",
    goodFor: "A second bow look, so two weapons in a party don't animate identically.",
    scale: 0.5,
  },
  {
    name: "bludgeon_1",
    motion: "melee",
    looks: "A heavy impact at the target.",
    goodFor: "Maces, clubs, hammers, slams and unarmed strikes.",
    scale: 0.5,
  },
  {
    name: "bullet_1",
    motion: "projectile",
    looks: "A small fast round. Smallest of the three (scale 0.2).",
    goodFor: "Firearms and sling stones in modern or gunpowder settings.",
    scale: 0.2,
  },
  {
    name: "bullet_2",
    motion: "projectile",
    looks: "A fast round, larger read than bullet_1.",
    goodFor: "Heavier firearms.",
    scale: 0.5,
  },
  {
    name: "bullet_3",
    motion: "projectile",
    looks: "A fast round, mid-sized.",
    goodFor: "A third firearm look.",
    scale: 0.25,
  },
  {
    name: "claws_1",
    motion: "melee",
    looks: "Raking claw marks across the target.",
    goodFor: "Natural weapons — beasts, lycanthropes, monster claw attacks.",
    scale: 0.5,
    sound: "slash_1",
  },
  {
    name: "explosion_1",
    motion: "burst",
    looks: "A blast that goes off at the target point.",
    goodFor: "Fireball and any area spell that detonates — the default for `20-foot radius` damage.",
    scale: 1,
  },
  {
    name: "slash_1",
    motion: "melee",
    looks: "A sword slash across the target.",
    goodFor: "Swords, axes and most slashing melee.",
    scale: 0.75,
  },
  {
    name: "slash_2",
    motion: "melee",
    looks: "A slash, alternate art and larger (scale 1.0).",
    goodFor: "Greatswords and two-handed slashing weapons.",
    scale: 1.0,
  },
  {
    name: "bolt_1",
    motion: "projectile",
    looks: "An energy bolt travelling to the target.",
    goodFor: "Eldritch blast, magic missile, generic arcane bolts.",
    scale: 1.0,
  },
  {
    name: "bolt_2",
    motion: "projectile",
    looks: "An energy bolt, alternate art.",
    goodFor: "A second bolt look for a different damage type.",
    scale: 0.75,
  },
  {
    name: "bolt_3",
    motion: "projectile",
    looks: "An energy bolt, third variant.",
    goodFor: "A third bolt look.",
    scale: 0.75,
  },
  {
    name: "fire_1",
    motion: "projectile",
    looks: "Flame travelling to the target.",
    goodFor: "Fire bolt, burning hands at range, most single-target fire damage.",
    scale: 0.75,
  },
  {
    name: "fire_2",
    motion: "projectile",
    looks: "Flame travelling to the target, larger (scale 1.0).",
    goodFor: "Bigger fire spells that still fly rather than detonate.",
    scale: 1.0,
  },
  {
    name: "healing_1",
    motion: "burst",
    looks: "Restorative light rising at the target.",
    goodFor: "Cure wounds, healing word — anything whose `healing` field is set.",
    scale: 1,
  },
  {
    name: "ice_1",
    motion: "projectile",
    looks: "Ice or frost travelling to the target.",
    goodFor: "Cold damage — ray of frost, ice knife, cone of cold.",
    scale: 1.0,
  },
  {
    name: "lightning_1",
    motion: "projectile",
    looks: "An arc of lightning to the target.",
    goodFor: "Lightning and thunder damage — shocking grasp, lightning bolt, call lightning.",
    scale: 1.0,
  },
  {
    name: "necrotic_1",
    motion: "burst",
    looks: "Dark necrotic energy at the target.",
    goodFor: "Necrotic damage, curses, life drain and death domain spells.",
    scale: 0.5,
  },
  {
    name: "orb_1",
    motion: "projectile",
    looks: "A glowing orb flying to the target.",
    goodFor: "Force damage and generic arcane spells with no obvious element.",
    scale: 1.0,
  },
  {
    name: "pierce_1",
    motion: "melee",
    looks: "A thrusting stab at the target.",
    goodFor: "Spears, rapiers, daggers — piercing melee.",
    scale: 0.75,
  },
  {
    name: "radiant_1",
    motion: "projectile",
    looks: "Holy light travelling to the target.",
    goodFor: "Radiant damage — guiding bolt, sacred flame, most cleric and paladin offence.",
    scale: 0.5,
  },
  {
    name: "shield_1",
    motion: "self",
    looks: "A ward forming around the caster.",
    goodFor: "Shield, mage armor, absorb elements — buffs and defensive spells on self.",
    scale: 1.0,
  },
  {
    name: "splash_1",
    motion: "projectile",
    looks: "Liquid splashing onto the target.",
    goodFor: "Acid and poison damage — acid splash, vitriolic sphere, alchemist's fire.",
    scale: 1.0,
  },
];

/** Sound keys an effect may reference, from the client's `DEFAULT_SOUNDS`. */
export const DEFAULT_SOUNDS = [
  "air_1",
  "arrow_1",
  "bolt_1",
  "bolt_2",
  "bludgeon_1",
  "explosive_1",
  "gun_1",
  "healing_1",
  "laser_1",
  "laser_2",
  "laser_3",
  "lightning_1",
  "slash_1",
  "slash_2",
  "water_1",
  "whip_1",
] as const;

/** Where an `<fxcontrol field="animation">` lands. The field name is the ruleset's. */
export const DEFAULT_ANIMATION_PATH = "data.animation";

export function findAnimation(name: string): AnimationInfo | undefined {
  return ANIMATIONS.find((anim) => anim.name === name);
}

/** A campaign-uploaded WEBM rather than a built-in — passed through unvalidated. */
export function isCustomAnimation(name: string): boolean {
  return /\.(webm|mp4)(\?|$)/i.test(name) || name.startsWith("/");
}

/**
 * Split a dotted data path into segments, rejecting the shapes that would write
 * somewhere unintended — a leading/trailing dot, or an empty segment.
 */
export function pathSegments(path: string): [string, ...string[]] {
  const parts = path.split(".");
  if (parts.some((part) => part.trim() === "")) {
    throw new Error(`\`${path}\` is not a valid field path — it has an empty segment.`);
  }
  // `split` never returns an empty array, and the check above rules out the one
  // element it could otherwise hold, so the first segment is always a real key.
  return parts as [string, ...string[]];
}

/**
 * Set a nested value, copying every object along the way.
 *
 * Copy rather than mutate because the source is the record we just fetched: patching
 * with a structure that shares references with the original makes a partial failure
 * very hard to reason about.
 */
export function setByPath(root: Json, path: string, value: unknown): Json {
  const [head, ...rest] = pathSegments(path);
  const out: Json = { ...root };
  if (rest.length === 0) {
    out[head] = value as Json[string];
    return out;
  }
  const child = root[head];
  const base: Json = child && typeof child === "object" && !Array.isArray(child) ? (child as Json) : {};
  out[head] = setByPath(base, rest.join("."), value) as Json[string];
  return out;
}

export function getByPath(root: Json | undefined, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of pathSegments(path)) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Json)[segment];
  }
  return cursor;
}

/**
 * The blob FXControl writes. Only keys the caller actually set are included beyond
 * `animationName` — FXControl merges what it finds over its own defaults, so writing
 * a full set of defaults here would freeze values that should track the effect's own.
 */
export interface AnimationOptions {
  animationName: string;
  scale?: number;
  opacity?: number;
  rotation?: number;
  animationSpeed?: number;
  moveSpeed?: number;
  count?: number;
  sound?: string;
  hue?: number;
  contrast?: number;
  brightness?: number;
  moveToDestination?: boolean;
  stretchToDestination?: boolean;
  destinationOnly?: boolean;
  startAtCenter?: boolean;
  windUpTime?: number;
  customAnimationName?: string;
}

export function buildAnimation(opts: AnimationOptions): Json {
  const blob: Json = { animationName: opts.animationName };
  const optional: Array<keyof AnimationOptions> = [
    "scale",
    "opacity",
    "rotation",
    "animationSpeed",
    "moveSpeed",
    "count",
    "sound",
    "hue",
    "contrast",
    "brightness",
    "moveToDestination",
    "stretchToDestination",
    "destinationOnly",
    "startAtCenter",
    "windUpTime",
    "customAnimationName",
  ];
  for (const key of optional) {
    const value = opts[key];
    if (value !== undefined) blob[key] = value as Json[string];
  }
  return blob;
}

export function registerAnimationTools(server: McpServer): void {
  server.registerTool(
    "realm_list_animations",
    {
      title: "List the built-in FX animations",
      description:
        "The 25 sprite-sheet effects an `<fxcontrol>` field can play — the ones the app's " +
        "'Cast Animation' dropdown offers. Use this before setting an animation so the choice is " +
        "made from what exists rather than guessed.\n\n" +
        "Each entry gives `motion` (`projectile` flies caster→target, `burst` plays at the target, " +
        "`melee` is an up-close hit, `self` plays on the caster), plus what it depicts and what it " +
        "suits. `motion` is the field that usually decides: an area spell wants `burst`, a ranged " +
        "attack wants `projectile`, a self-buff wants `self`.\n\n" +
        "There are only 25, covering broad elemental and weapon categories — so expect to pick the " +
        "closest reasonable match, not an exact one. A campaign can also use its own uploaded WEBM " +
        "by passing that path as the animation name.",
      inputSchema: {
        motion: z
          .enum(["projectile", "burst", "melee", "self"])
          .optional()
          .describe("Only effects that move this way."),
        search: z
          .string()
          .optional()
          .describe("Free text matched against name, description and suggested uses, e.g. `fire`, `healing`."),
      },
    },
    safe(async (args) => {
      let matches = ANIMATIONS;
      if (args.motion) matches = matches.filter((anim) => anim.motion === args.motion);
      if (args.search?.trim()) {
        const needle = args.search.trim().toLowerCase();
        matches = matches.filter((anim) =>
          `${anim.name} ${anim.looks} ${anim.goodFor}`.toLowerCase().includes(needle),
        );
      }
      return json({
        total: matches.length,
        animations: matches,
        sounds: DEFAULT_SOUNDS,
        note:
          "Set one with `realm_set_record_animation`. The stored field is usually " +
          `\`${DEFAULT_ANIMATION_PATH}\`, but the name comes from the ruleset's ` +
          "`<fxcontrol field=\"…\">` — check a record type's layout if unsure.",
      });
    }),
  );

  server.registerTool(
    "realm_set_record_animation",
    {
      title: "Set a record's FX animation",
      description:
        "Give a spell, item, ability or npc-action its cast/attack animation — the value the " +
        "app's FX Control writes. Pick the effect with `realm_list_animations` first.\n\n" +
        "The animation is stored as an object at `path` (default `data.animation`, which is where " +
        "`<fxcontrol field=\"animation\">` puts it). Only `animationName` is required; every other " +
        "option overrides the effect's own default, so leave them off unless there's a reason.\n\n" +
        "Writes are read-modify-write on the record's `data`, one record per call — there is no " +
        "bulk form, and the rest of `data` is preserved.\n\n" +
        "`clear: true` removes the animation instead, matching the app's 'None'.",
      inputSchema: {
        recordId: z.string().describe("The record's `_id`."),
        type: z
          .string()
          .describe("Record type, e.g. `spells`, `items`, `npcs`. Needed to pick the endpoint."),
        animation: z
          .string()
          .optional()
          .describe(
            "Built-in effect name from `realm_list_animations` (e.g. `explosion_1`), or the path " +
              "to a campaign WEBM for a custom effect. Omit only with `clear: true`.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Where to store it. Default `data.animation`. Change it only if the ruleset's " +
              "`<fxcontrol>` declares a different `field`.",
          ),
        clear: z.boolean().optional().describe("Remove the animation instead of setting one."),
        scale: z.number().optional().describe("Size multiplier. Overrides the effect's default."),
        opacity: z.number().min(0).max(1).optional().describe("0–1."),
        rotation: z.number().optional().describe("Extra rotation in degrees."),
        animationSpeed: z.number().optional().describe("Playback FPS. Effects default to 12."),
        moveSpeed: z.number().optional().describe("Travel speed, projectiles only."),
        count: z.number().int().min(1).optional().describe("How many copies fire at once."),
        sound: z
          .string()
          .optional()
          .describe("Sound key to play with it — one of the `sounds` from `realm_list_animations`."),
        hue: z.number().optional().describe("Hue rotation in degrees, for recolouring an effect."),
        contrast: z.number().optional().describe("Contrast multiplier."),
        brightness: z.number().optional().describe("Brightness multiplier."),
        destinationOnly: z
          .boolean()
          .optional()
          .describe("Play only at the target, not the caster."),
        startAtCenter: z.boolean().optional().describe("Play centred on the caster."),
        windUpTime: z.number().optional().describe("Milliseconds to charge before travelling."),
      },
    },
    safe(async (args) => {
      const client = session.client();
      const path = args.path ?? DEFAULT_ANIMATION_PATH;

      if (!args.clear && !args.animation) {
        return text("Pass `animation` to set one, or `clear: true` to remove it.");
      }

      let known: AnimationInfo | undefined;
      if (args.animation && !isCustomAnimation(args.animation)) {
        known = findAnimation(args.animation);
        if (!known) {
          return text(
            `\`${args.animation}\` is not a built-in effect. Call \`realm_list_animations\` for ` +
              `the ${ANIMATIONS.length} that exist, or pass a campaign WEBM path for a custom one.`,
          );
        }
      }

      return withAuthRecovery(async () => {
        const { path: endpoint } = client.recordEndpoint(args.type);
        const record = await client.get<Json>(endpoint, args.recordId);

        const blob = args.clear
          ? undefined
          : buildAnimation({
              animationName: args.animation!,
              scale: args.scale,
              opacity: args.opacity,
              rotation: args.rotation,
              animationSpeed: args.animationSpeed,
              moveSpeed: args.moveSpeed,
              count: args.count,
              sound: args.sound,
              hue: args.hue,
              contrast: args.contrast,
              brightness: args.brightness,
              destinationOnly: args.destinationOnly,
              startAtCenter: args.startAtCenter,
              windUpTime: args.windUpTime,
            });

        // The path always starts inside `data` in practice, but patching the whole
        // record root would clobber fields the caller never asked about — so rebuild
        // only the top-level key the path names and patch that one key.
        const [top] = pathSegments(path);
        const rebuilt = setByPath(record as Json, path, blob);
        const updated = await client.patch<Json>(endpoint, args.recordId, {
          [top]: rebuilt[top],
        });

        return json({
          record: { id: updated._id, name: updated.name },
          path,
          ...(args.clear
            ? { cleared: true }
            : { animation: getByPath(updated, path), motion: known?.motion }),
        });
      });
    }),
  );
}

