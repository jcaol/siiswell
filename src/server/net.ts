/**
 * @file IP / CIDR matching for the trusted-proxy checks of the self-hosted server (IPv4, IPv6, IPv4-mapped IPv6).
 * @module server/net
 */

export interface Cidr {
  /** 16 bytes (IPv4 is stored IPv4-mapped). */
  addr: Uint8Array;
  bits: number;
}

function parseV4(s: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  if (b.some((n) => n > 255)) return null;
  const out = new Uint8Array(16);
  out[10] = 0xff;
  out[11] = 0xff;
  out.set(b, 12);
  return out;
}

function parseV6(s: string): Uint8Array | null {
  if (!/^[0-9a-f:.]+$/i.test(s) || s.split("::").length > 2) return null;
  let tail4: Uint8Array | null = null;
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    tail4 = parseV4(s.slice(lastColon + 1));
    if (!tail4) return null;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const [head, rest] = s.split("::") as [string, string | undefined];
  const hs = head ? head.split(":") : [];
  const ts = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups = rest === undefined ? hs : [...hs, ...Array(8 - hs.length - ts.length).fill("0"), ...ts];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  if (tail4) out.set(tail4.subarray(12), 12);
  return out;
}

/** 16-byte form of an IPv4 / IPv6 address (brackets and a zone id are tolerated), or null. */
export function parseIp(raw: string): Uint8Array | null {
  const s = raw.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return parseV4(s) ?? (s.includes(":") ? parseV6(s) : null);
}

export function parseCidrs(raw: string): { ok: true; cidrs: Cidr[] } | { ok: false; bad: string[] } {
  const cidrs: Cidr[] = [];
  const bad: string[] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [ip, len] = part.split("/") as [string, string | undefined];
    const addr = parseIp(ip);
    const v4 = addr !== null && parseV4(ip.trim()) !== null;
    const max = v4 ? 32 : 128;
    const n = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
    if (!addr || !(n >= 0 && n <= max)) bad.push(part);
    else cidrs.push({ addr, bits: v4 ? n + 96 : n });
  }
  return bad.length ? { ok: false, bad } : { ok: true, cidrs };
}

export function ipInCidrs(ip: string | null | undefined, cidrs: readonly Cidr[]): boolean {
  const a = ip ? parseIp(ip) : null;
  if (!a) return false;
  return cidrs.some(({ addr, bits }) => {
    for (let i = 0; i < 16 && bits > 0; i++, bits -= 8) {
      const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
      if (((a[i] as number) & mask) !== ((addr[i] as number) & mask)) return false;
    }
    return true;
  });
}

/**
 * The client address: the socket peer, or, when the peer is a trusted proxy, the right-most X-Forwarded-For entry
 * that is not itself a trusted proxy (entries further left are client-controlled and never believed).
 */
export function clientIp(peer: string | null, xff: string | null, trusted: readonly Cidr[]): string {
  let ip = peer ?? "";
  if (!xff || !ipInCidrs(ip, trusted)) return ip;
  const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    ip = hops[i] as string;
    if (!ipInCidrs(ip, trusted)) return ip;
  }
  return ip;
}

/**
 * The IPv4 address carried inside an IPv6 one, or the address itself when it is IPv4: IPv4-mapped (::ffff:0:0/96),
 * IPv4-compatible (::/96, except :: and ::1), NAT64 well-known prefix (64:ff9b::/96) and 6to4 (2002::/16, bits
 * 16-47). One IPv4 host must not get a fresh limiter bucket by spelling itself as IPv6.
 */
export function embeddedV4(a: Uint8Array): [number, number, number, number] | null {
  const zero = (from: number, to: number) => a.subarray(from, to).every((b) => b === 0);
  const tail = (): [number, number, number, number] => [a[12], a[13], a[14], a[15]] as [number, number, number, number];
  if (zero(0, 10) && a[10] === 0xff && a[11] === 0xff) return tail();
  if (zero(0, 12) && !(zero(12, 15) && ((a[15] as number) <= 1))) return tail();
  if (a[0] === 0x00 && a[1] === 0x64 && a[2] === 0xff && a[3] === 0x9b && zero(4, 12)) return tail();
  if (a[0] === 0x20 && a[1] === 0x02) return [a[2], a[3], a[4], a[5]] as [number, number, number, number];
  return null;
}

export interface RateKeys {
  /** The client itself (IPv4 dotted, embedded IPv4 extracted, IPv6 fully expanded). */
  exact: string;
  /** Its neighbourhood: public IPv4 /24, public IPv6 /64; = exact for loopback / private / ULA / link-local. */
  aggregate: string;
}

/**
 * The login limiter's keys for a client address. Two tiers: a tight cap on the exact address and a looser one on
 * its /24 (IPv4) or /64 (IPv6, one subscriber usually holds a whole /64), so rotating addresses inside a prefix buys
 * little while one guesser sharing the admin's NAT or ISP prefix cannot lock the admin's own address out. Loopback,
 * private (10/8, 172.16/12, 192.168/16, 100.64/10), ULA and link-local addresses are never grouped: behind a reverse
 * proxy / on a LAN, neighbouring addresses are different people.
 */
export function rateKeys(ip: string): RateKeys {
  const a = parseIp(ip);
  if (!a) return { exact: ip, aggregate: ip };
  const v4 = embeddedV4(a);
  if (v4) {
    const [b0, b1, b2, b3] = v4;
    const exact = `${b0}.${b1}.${b2}.${b3}`;
    const local = b0 === 127 || b0 === 10 || (b0 === 172 && b1 >= 16 && b1 < 32) || (b0 === 192 && b1 === 168) || (b0 === 100 && b1 >= 64 && b1 < 128);
    return { exact, aggregate: local ? exact : `${b0}.${b1}.${b2}.0/24` };
  }
  const hex = Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  const groups = (n: number) => (hex.slice(0, n * 4).match(/.{4}/g) as string[]).map((g) => g.replace(/^0+(?=.)/, "")).join(":");
  const local = (a.subarray(0, 15).every((b) => b === 0) && a[15] === 1) || ((a[0] as number) & 0xfe) === 0xfc || (a[0] === 0xfe && ((a[1] as number) & 0xc0) === 0x80);
  const exact = groups(8);
  return { exact, aggregate: local ? exact : `${groups(4)}::/64` };
}

/** The aggregate key alone (kept for callers that want one bucket). */
export function rateBucket(ip: string): string {
  return rateKeys(ip).aggregate;
}
