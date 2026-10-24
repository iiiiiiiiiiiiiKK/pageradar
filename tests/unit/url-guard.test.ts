import { describe, expect, it } from 'vitest';
import { checkResolvedAddresses, checkUrl, classifyIpv4, classifyIpv6, normalizeNumericHost } from '../../src/worker/security/url-guard.ts';

describe('SSRF：URL 基本校验', () => {
  it('接受正常的公网 HTTPS 地址', () => {
    const r = checkUrl('https://example.com/pricing?x=1');
    expect(r.ok).toBe(true);
    expect(r.url?.hostname).toBe('example.com');
  });

  it('接受 http 与 8080 / 8443 端口', () => {
    expect(checkUrl('http://example.com/').ok).toBe(true);
    expect(checkUrl('http://example.com:8080/').ok).toBe(true);
    expect(checkUrl('https://example.com:8443/').ok).toBe(true);
  });

  it('拒绝非 HTTP(S) 协议', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'javascript:alert(1)', 'data:text/html,hi']) {
      const r = checkUrl(u);
      expect(r.ok, u).toBe(false);
    }
  });

  it('拒绝空值与非法格式', () => {
    expect(checkUrl('').ok).toBe(false);
    expect(checkUrl('   ').ok).toBe(false);
    expect(checkUrl('not a url').ok).toBe(false);
  });

  it('拒绝 URL 中携带凭据', () => {
    const r = checkUrl('https://user:pass@example.com/');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('credentials-in-url');
  });

  it('拒绝非白名单端口', () => {
    for (const p of ['22', '6379', '5432', '9000', '2375']) {
      expect(checkUrl(`http://example.com:${p}/`).ok, p).toBe(false);
    }
  });

  it('拒绝超长 URL', () => {
    expect(checkUrl('https://example.com/' + 'a'.repeat(3000)).ok).toBe(false);
  });
});

describe('SSRF：内网与元数据地址', () => {
  it('拒绝 IPv4 环回 / 私网 / 链路本地字面量', () => {
    const cases = [
      'http://127.0.0.1/',
      'http://127.1.2.3/',
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://172.31.255.254/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://224.0.0.1/',
      'http://255.255.255.255/',
    ];
    for (const u of cases) {
      const r = checkUrl(u);
      expect(r.ok, u).toBe(false);
    }
  });

  it('拒绝 IPv6 字面量（含映射地址）', () => {
    for (const u of ['http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/']) {
      expect(checkUrl(u).ok, u).toBe(false);
    }
  });

  it('拒绝十进制 / 十六进制 / 八进制编码的 IP', () => {
    // 2130706433 = 127.0.0.1
    expect(checkUrl('http://2130706433/').ok).toBe(false);
    expect(checkUrl('http://0x7f000001/').ok).toBe(false);
    expect(checkUrl('http://0177.0.0.1/').ok).toBe(false);
  });

  it('拒绝 internal / local / metadata 等内部域名', () => {
    const cases = [
      'http://localhost/',
      'http://localhost./',
      'http://metadata.google.internal/',
      'http://metadata/',
      'http://foo.local/',
      'http://service.internal/',
      'http://x.corp/',
      'http://kubernetes.default.svc/',
      'http://instance-data.ec2.internal/',
    ];
    for (const u of cases) {
      expect(checkUrl(u).ok, u).toBe(false);
    }
  });

  it('拒绝没有点的主机名', () => {
    expect(checkUrl('http://intranet/').ok).toBe(false);
  });

  it('放行看起来相似但合法的公网域名', () => {
    for (const u of ['https://localhost.example.com/', 'https://metadata.example.com/', 'https://internal.example.org/']) {
      expect(checkUrl(u).ok, u).toBe(true);
    }
  });
});

describe('SSRF：数值归一化与分类', () => {
  it('归一化十进制 / 十六进制 / 八进制', () => {
    expect(normalizeNumericHost('2130706433')).toBe('127.0.0.1');
    expect(normalizeNumericHost('0x7f000001')).toBe('127.0.0.1');
    expect(normalizeNumericHost('0177.0.0.1')).toBe('127.0.0.1');
    expect(normalizeNumericHost('example.com')).toBeNull();
  });

  it('IPv4 分类覆盖关键网段', () => {
    expect(classifyIpv4([127, 0, 0, 1])).toBe('ipv4-loopback');
    expect(classifyIpv4([10, 1, 2, 3])).toBe('ipv4-private');
    expect(classifyIpv4([169, 254, 169, 254])).toBe('ipv4-link-local');
    expect(classifyIpv4([8, 8, 8, 8])).toBeNull();
  });

  it('IPv6 分类覆盖关键网段', () => {
    expect(classifyIpv6('::1')).toBe('ipv6-private');
    expect(classifyIpv6('fd12::1')).toBe('ipv6-private');
    expect(classifyIpv6('::ffff:10.0.0.1')).toBe('ipv4-private');
    expect(classifyIpv6('2606:4700::1111')).toBeNull();
  });

  it('DNS 解析结果含私网地址时拒绝（防 rebinding）', () => {
    expect(checkResolvedAddresses(['93.184.216.34']).ok).toBe(true);
    const bad = checkResolvedAddresses(['93.184.216.34', '10.0.0.7']);
    expect(bad.ok).toBe(false);
    expect(bad.offenders).toContain('10.0.0.7');
  });
});
