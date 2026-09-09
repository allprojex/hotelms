// Deterministic pseudo-randomness and fictional name pools.
//
// Every value the seeder invents comes from here, driven by one seed, so the
// same command produces the same demo story every time. Nothing in this file
// is copied from production: the names are common Ghanaian and international
// given/family names combined arbitrarily, and every address, phone number and
// email belongs to reserved, non-routable space (RFC 2606 `.example`, and the
// +233 30 000 xxxx block, which is not an assignable subscriber range).

export function rng(seed = 20260909) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRandom(seed) {
  const next = rng(seed);
  const api = {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    picks(arr, n) {
      const copy = [...arr];
      const out = [];
      while (out.length < n && copy.length) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
      return out;
    },
    chance: (p) => next() < p,
    money: (min, max, step = 0.5) => Math.round((min + next() * (max - min)) / step) * step,
  };
  return api;
}

export const FIRST_NAMES = [
  "Kwame", "Ama", "Kofi", "Akosua", "Yaw", "Abena", "Kojo", "Adwoa", "Kwabena", "Afua",
  "Nana", "Esi", "Kwaku", "Akua", "Yaa", "Fiifi", "Maame", "Kwesi", "Araba", "Kobby",
  "Selorm", "Mawuli", "Elikem", "Dzifa", "Sena", "Edem", "Delali", "Enyonam",
  "Ibrahim", "Fatima", "Musah", "Zainab", "Abdul", "Hawa", "Salma", "Yusif",
  "Grace", "Daniel", "Priscilla", "Emmanuel", "Naa", "Joshua", "Leticia", "Samuel",
  "Claire", "Thomas", "Amelia", "Lucas", "Sofia", "Mateo", "Ingrid", "Anders",
  "Chidi", "Ngozi", "Tunde", "Amara", "Wanjiru", "Otieno", "Thandiwe", "Sipho",
];

export const LAST_NAMES = [
  "Mensah", "Owusu", "Boateng", "Asante", "Adjei", "Darko", "Frimpong", "Agyemang",
  "Ofori", "Amponsah", "Bediako", "Sarpong", "Nyarko", "Oduro", "Gyamfi", "Baffour",
  "Tetteh", "Quartey", "Lartey", "Ankrah", "Nortey", "Amartey", "Odoi", "Nii-Armah",
  "Agbeko", "Dogbe", "Kudjoe", "Amenyo", "Setordjie", "Akoto",
  "Mahama", "Alhassan", "Seidu", "Iddrisu",
  "Whitfield", "Lindqvist", "Moreau", "Okafor", "Mwangi", "Dlamini", "Pereira", "Novak",
];

export const NATIONALITIES = [
  ["GH", "Ghanaian"], ["NG", "Nigerian"], ["GB", "British"], ["US", "American"],
  ["DE", "German"], ["FR", "French"], ["ZA", "South African"], ["KE", "Kenyan"],
  ["CI", "Ivorian"], ["NL", "Dutch"], ["CA", "Canadian"], ["IN", "Indian"],
];

export const GH_REGIONS = [
  ["GA", "Accra"], ["AS", "Kumasi"], ["WP", "Sekondi-Takoradi"], ["EP", "Koforidua"],
  ["CP", "Cape Coast"], ["NP", "Tamale"], ["VR", "Ho"], ["BA", "Sunyani"],
];

export const STREETS = [
  "Independence Avenue", "Liberation Road", "Oxford Street", "Ring Road East",
  "Spintex Road", "Airport Hills Close", "Cantonments Crescent", "Labone Link",
  "Achimota Lane", "Tema Station Road", "Osu Badu Street", "Dzorwulu Highway",
];

/** Fictional, non-routable contact details. */
export function fakeEmail(first, last, n) {
  const slug = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "");
  return `${slug}${n}@guests.infinitygrand.example`;
}

export function fakePhone(rand) {
  return `+233 30 000 ${String(rand.int(1000, 9999))}`;
}

export function fakeAddress(rand) {
  const [, city] = rand.pick(GH_REGIONS);
  return `${rand.int(1, 240)} ${rand.pick(STREETS)}, ${city}`;
}

// ── date helpers (all dates are plain YYYY-MM-DD in property local time) ────

export function day(dateStr, delta = 0) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

export function atTime(dateStr, hour, minute = 0) {
  // Africa/Accra is UTC+0 all year, so local wall-clock time is UTC here.
  return `${dateStr}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+00:00`;
}

export function monthStart(dateStr) {
  return `${dateStr.slice(0, 7)}-01`;
}

export function monthEnd(dateStr) {
  const d = new Date(`${dateStr.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
