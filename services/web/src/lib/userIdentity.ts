/**
 * Per-browser-tab user identity for Yjs Awareness. Persisted in sessionStorage
 * so reconnects within the same tab keep the same color/name, while different
 * tabs get distinct identities (good signal for "two people in a file").
 */

const STORAGE_KEY = "conduit.userIdentity.v1";

export type UserIdentity = {
  name: string;
  /** CSS color used for cursor + selection caret. */
  color: string;
  /** Lower-opacity variant used for selection backgrounds. */
  colorLight: string;
};

const ADJECTIVES = [
  "Cosmic",
  "Quiet",
  "Wandering",
  "Curious",
  "Daring",
  "Lively",
  "Gentle",
  "Mellow",
  "Brisk",
  "Sunny",
  "Steady",
  "Quirky",
];

const ANIMALS = [
  "Otter",
  "Heron",
  "Fox",
  "Lynx",
  "Wren",
  "Badger",
  "Hawk",
  "Marmot",
  "Newt",
  "Owl",
  "Seal",
  "Tern",
];

const COLORS: { color: string; colorLight: string }[] = [
  { color: "#f38ba8", colorLight: "#f38ba833" },
  { color: "#fab387", colorLight: "#fab38733" },
  { color: "#f9e2af", colorLight: "#f9e2af33" },
  { color: "#a6e3a1", colorLight: "#a6e3a133" },
  { color: "#94e2d5", colorLight: "#94e2d533" },
  { color: "#89dceb", colorLight: "#89dceb33" },
  { color: "#74c7ec", colorLight: "#74c7ec33" },
  { color: "#89b4fa", colorLight: "#89b4fa33" },
  { color: "#b4befe", colorLight: "#b4befe33" },
  { color: "#cba6f7", colorLight: "#cba6f733" },
  { color: "#f5c2e7", colorLight: "#f5c2e733" },
  { color: "#eba0ac", colorLight: "#eba0ac33" },
];

function pickIndex(rand: () => number, len: number): number {
  return Math.floor(rand() * len) % len;
}

/**
 * Picks a fresh identity using `rand` (defaults to Math.random). Pulled into a
 * function so tests can pass a deterministic generator.
 */
export function makeUserIdentity(rand: () => number = Math.random): UserIdentity {
  const adj = ADJECTIVES[pickIndex(rand, ADJECTIVES.length)] ?? "Anonymous";
  const animal = ANIMALS[pickIndex(rand, ANIMALS.length)] ?? "User";
  const palette = COLORS[pickIndex(rand, COLORS.length)] ?? COLORS[0]!;
  return { name: `${adj} ${animal}`, color: palette.color, colorLight: palette.colorLight };
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/**
 * Returns the cached identity for this tab, or creates and persists a new one.
 * `storage` defaults to `sessionStorage` (so each tab gets its own row) but
 * can be overridden for tests.
 */
export function loadOrCreateUserIdentity(
  storage?: Storage,
  rand: () => number = Math.random,
): UserIdentity {
  const store = storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null);
  if (!store) {
    return makeUserIdentity(rand);
  }
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserIdentity> | null;
      if (
        parsed &&
        typeof parsed.name === "string" &&
        typeof parsed.color === "string" &&
        typeof parsed.colorLight === "string"
      ) {
        return { name: parsed.name, color: parsed.color, colorLight: parsed.colorLight };
      }
    }
  } catch {
    /* fall through and regenerate */
  }
  const fresh = makeUserIdentity(rand);
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(fresh));
  } catch {
    /* ignore quota / unavailable */
  }
  return fresh;
}
