/**
 * SSRF 防护：URL 校验 + DNS 解析校验。
 *
 * 威胁模型（全部真实存在，不是纸面上的）：
 *  1. 直接访问 127.0.0.1 / 10.x / 192.168.x / 172.16-31.x —— 打到内网服务
 *  2. 云元数据地址 169.254.169.254 / fd00:ec2::254 —— 偷 IAM 凭据
 *  3. IPv6 回环 / 链路本地 / ULA
 *  4. 十进制/八进制/十六进制 IP（2130706433 = 127.0.0.1）
 *  5. 内部域名 localhost / *.local / *.internal / *.svc / metadata.google.internal
 *  6. DNS rebinding：首次解析是公网 IP，后续解析成内网 IP
 *  7. 恶意重定向：301 跳到 169.254.169.254
 *  8. 非 HTTP(S) 协议：file:// gopher:// ftp://
 *
 * 本模块只做纯计算，不发起网络请求，因此可以在 Node 里直接单测。
 */

export type UrlRejection =
  | 'invalid-url'
  | 'bad-scheme'
  | 'bad-port'
  | 'credentials-in-url'
  | 'blocked-hostname'
  | 'ipv4-private'
  | 'ipv4-loopback'
  | 'ipv4-link-local'
  | 'ipv4-cgnat'
  | 'ipv4-reserved'
  | 'ipv4-multicast'
  | 'ipv6-private'
  | 'numeric-host'
  | 'ip-literal-host'
  | 'dns-failed'
  | 'dns-private-answer'
  | 'too-long';

export interface UrlCheck {
  ok: boolean;
  url?: URL;
  reason?: UrlRejection;
  message?: string;
  /** 该 URL 是否直接使用了 IP 字面量（IP 字面量一律拒绝，避免绕过 DNS 检查）。 */
  hostKind: 'domain' | 'ipv4' | 'ipv6' | 'unknown';
}

const MAX_URL_LENGTH = 2048;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/** 云厂商元数据 / 内部服务常用地址，逐个显式禁用。 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

const BLOCKED_TLDS = ['.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp', '.test', '.invalid', '.onion'];

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/** 把 2130706433 / 0x7f000001 / 0177.0.0.1 这类写法归一成点分十进制。 */
export function normalizeNumericHost(host: string): string | null {
  // 纯十进制整数
  if (/^\d{1,10}$/.test(host)) {
    const n = Number(host);
    if (n > 0xffffffff) return null;
    return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
  }
  // 十六进制
  if (/^0x[0-9a-f]{1,8}$/i.test(host)) {
    const n = parseInt(host, 16);
    return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
  }
  // 八进制 / 混合（0177.0.0.1）
  if (/^0[0-7.]*$/.test(host) && host.includes('.')) {
    const parts = host.split('.');
    if (parts.length === 4 && parts.every((p) => /^0?[0-7]{1,3}$/.test(p))) {
      const nums = parts.map((p) => parseInt(p, 8));
      if (nums.every((n) => n >= 0 && n <= 255)) return nums.join('.');
    }
  }
  return null;
}

export function classifyIpv4(octets: number[]): UrlRejection | null {
  const [a, b] = octets;
  if (a === 0) return 'ipv4-reserved'; // 0.0.0.0/8
  if (a === 127) return 'ipv4-loopback';
  if (a === 10) return 'ipv4-private';
  if (a === 172 && b >= 16 && b <= 31) return 'ipv4-private';
  if (a === 192 && b === 168) return 'ipv4-private';
  if (a === 169 && b === 254) return 'ipv4-link-local'; // 含 169.254.169.254 元数据
  if (a === 100 && b >= 64 && b <= 127) return 'ipv4-cgnat';
  if (a === 192 && b === 0 && octets[2] === 0) return 'ipv4-reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'ipv4-reserved';
  if (a >= 224 && a <= 239) return 'ipv4-multicast';
  if (a >= 240) return 'ipv4-reserved';
  if (a === 255) return 'ipv4-reserved';
  return null;
}

/** 判断一个 IPv6 文本地址是否属于不可访问范围。 */
export function classifyIpv6(raw: string): UrlRejection | null {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '::' || host === '::1') return 'ipv6-private';
  if (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return 'ipv6-private';
  if (host.startsWith('ff')) return 'ipv6-private';
  // IPv4-mapped: ::ffff:127.0.0.1
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const octets = parseIpv4(mapped[1]);
    if (octets) return classifyIpv4(octets) ?? 'ipv6-private';
  }
  if (host.startsWith('64:ff9b') || host.startsWith('2001:db8') || host.startsWith('2002')) return 'ipv6-private';
  return null;
}

export function checkUrl(input: string): UrlCheck {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, reason: 'invalid-url', message: '请输入一个网址。', hostKind: 'unknown' };
  }
  const raw = input.trim();
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'too-long', message: `网址长度超过 ${MAX_URL_LENGTH} 字符。`, hostKind: 'unknown' };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid-url', message: '网址格式不正确，需要以 http:// 或 https:// 开头。', hostKind: 'unknown' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'bad-scheme', message: `只允许 HTTP 和 HTTPS，收到的是 ${url.protocol.replace(':', '')}。`, hostKind: 'unknown' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials-in-url', message: '网址中不能包含用户名或密码。', hostKind: 'unknown' };
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, reason: 'bad-port', message: `端口 ${url.port} 不在允许范围内（80 / 443 / 8080 / 8443）。`, hostKind: 'unknown' };
  }

  let host = url.hostname.toLowerCase();

  // IPv6 字面量
  if (host.startsWith('[') || host.includes(':')) {
    const bad = classifyIpv6(host);
    return {
      ok: false,
      reason: bad ?? 'ip-literal-host',
      message: '不允许直接使用 IP 字面量作为目标（会被用于绕过域名层面的防护）。',
      hostKind: 'ipv6',
    };
  }

  // 数值形式（十进制/十六进制/八进制）先归一
  const numeric = normalizeNumericHost(host);
  if (numeric) {
    const octets = parseIpv4(numeric);
    const bad = octets ? classifyIpv4(octets) : 'numeric-host';
    return {
      ok: false,
      reason: bad ?? 'numeric-host',
      message: '不允许使用数字形式的主机名或 IP 地址。',
      hostKind: 'ipv4',
    };
  }

  const directV4 = parseIpv4(host);
  if (directV4) {
    const bad = classifyIpv4(directV4);
    return {
      ok: false,
      reason: bad ?? 'ip-literal-host',
      message: '不允许直接使用 IP 地址作为监控目标。',
      hostKind: 'ipv4',
    };
  }

  // 去掉末尾的点，避免 "localhost." 绕过
  host = host.replace(/\.+$/, '');

  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: 'blocked-hostname', message: `主机名 ${host} 指向本机或云元数据服务，已拒绝。`, hostKind: 'domain' };
  }
  for (const tld of BLOCKED_TLDS) {
    if (host.endsWith(tld)) {
      return { ok: false, reason: 'blocked-hostname', message: `不允许访问内部域名（${tld}）。`, hostKind: 'domain' };
    }
  }
  if (!host.includes('.')) {
    return { ok: false, reason: 'blocked-hostname', message: '请输入完整域名（例如 example.com）。', hostKind: 'domain' };
  }
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return { ok: false, reason: 'invalid-url', message: '域名包含不允许的字符。', hostKind: 'domain' };
  }

  url.hostname = host;
  return { ok: true, url, hostKind: 'domain' };
}

/** 对 DNS 解析结果做二次校验（防 DNS rebinding 的第一步）。 */
export function checkResolvedAddresses(addresses: string[]): { ok: boolean; offenders: string[] } {
  const offenders: string[] = [];
  for (const addr of addresses) {
    const a = addr.trim();
    const v4 = parseIpv4(a);
    if (v4) {
      if (classifyIpv4(v4)) offenders.push(a);
      continue;
    }
    if (a.includes(':')) {
      if (classifyIpv6(a)) offenders.push(a);
      continue;
    }
    offenders.push(a); // 无法识别的格式，保守拒绝
  }
  return { ok: offenders.length === 0, offenders };
}
