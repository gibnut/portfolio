import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';

// ===========================
// ZONE FILE PARSER
// Reads zone.txt from the project root at synth time. zone.txt is gitignored,
// so DNS data never reaches GitHub. SOA and NS records are skipped (Route 53
// manages these). Multiline records in parentheses are joined before parsing.
// Supported record types: A, AAAA, CNAME, MX, TXT, CAA, SRV. Any other type is
// reported with a synth warning instead of being dropped silently.
// ===========================

export interface ParsedRecord {
  type: string;
  name: string; // '@' for the apex, otherwise relative to the domain
  ttl: number;
  values: string[]; // one entry per value; meaning depends on type (see below)
}

export interface ParseResult {
  records: ParsedRecord[];
  unsupported: string[];
}

interface JoinedLine {
  text: string;
  // True when the record's first physical line started with whitespace, which
  // in zone-file syntax means "same owner name as the previous record"
  inheritsOwner: boolean;
}

export function parseZoneFile(content: string, domainName: string): ParseResult {
  const rawLines = content.split(/\r?\n/);
  const records: ParsedRecord[] = [];
  const unsupported: string[] = [];
  const domain = domainName.toLowerCase();
  let currentTtl = 3600;
  let lastOwner = '@';

  // PASS 1: strip comments, join multiline records, and remember for each
  // record whether its first line was indented (owner inherited).
  const lines: JoinedLine[] = [];
  let buffer = '';
  let bufferInherits = false;
  let inParens = false;

  for (const rawLine of rawLines) {
    // Strip ; comments, but only outside quoted strings
    // (e.g. "v=DMARC1; p=quarantine" must not be cut at the semicolon)
    let line = '';
    let inQuotes = false;
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      if (ch === ';' && !inQuotes) break;
      line += ch;
    }
    const indented = /^[ \t]/.test(line);
    line = line.trim();
    if (!line) continue;

    if (inParens) {
      buffer += ' ' + line;
      if (line.includes(')')) {
        inParens = false;
        lines.push({ text: buffer.replace(/[()]/g, ' ').trim(), inheritsOwner: bufferInherits });
        buffer = '';
      }
    } else if (line.includes('(') && !line.includes(')')) {
      inParens = true;
      buffer = line;
      bufferInherits = indented;
    } else {
      lines.push({ text: line.replace(/[()]/g, ' ').trim(), inheritsOwner: indented });
    }
  }

  // PASS 2: parse joined lines into records
  for (const { text, inheritsOwner } of lines) {
    if (text.startsWith('$')) {
      if (text.toUpperCase().startsWith('$TTL')) {
        const ttlVal = parseInt(text.split(/\s+/)[1], 10);
        if (!isNaN(ttlVal)) currentTtl = ttlVal;
      }
      continue;
    }

    const parts = text.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length < 2) continue;

    let idx = 0;
    let name: string;
    if (inheritsOwner) {
      name = lastOwner;
    } else {
      name = parts[idx++];
      lastOwner = name;
    }

    // Normalize the owner name to '@' or a name relative to the domain
    let rel = name.toLowerCase();
    if (rel !== '@') {
      if (rel.endsWith('.')) {
        rel = rel.slice(0, -1);
        if (rel === domain) rel = '@';
        else if (rel.endsWith('.' + domain)) rel = rel.slice(0, -(domain.length + 1));
      } else if (rel === domain) {
        rel = '@';
      } else if (rel.endsWith('.' + domain)) {
        rel = rel.slice(0, -(domain.length + 1));
      }
    }

    // Optional TTL and class, in either order
    let ttl = currentTtl;
    for (let k = 0; k < 2 && idx < parts.length; k++) {
      if (/^\d+$/.test(parts[idx])) ttl = parseInt(parts[idx++], 10);
      else if (/^(IN|CH|HS)$/i.test(parts[idx])) idx++;
    }

    if (idx >= parts.length) continue;
    const type = parts[idx++].toUpperCase();
    if (type === 'SOA' || type === 'NS') continue;
    if (idx >= parts.length) continue;
    const remaining = parts.slice(idx);

    const add = (value: string) => {
      const existing = records.find((r) => r.type === type && r.name === rel);
      if (existing) existing.values.push(value);
      else records.push({ type, name: rel, ttl, values: [value] });
    };

    switch (type) {
      case 'A':
      case 'AAAA':
        add(remaining[0]);
        break;

      case 'CNAME': {
        const target = remaining[0].replace(/\.$/, '');
        if (target) add(target);
        break;
      }

      case 'MX': {
        // value: "<priority> <host>"
        const prio = parseInt(remaining[0], 10);
        const host = remaining[1] || '';
        if (!isNaN(prio) && host) add(`${prio} ${host.endsWith('.') ? host : host + '.'}`);
        break;
      }

      case 'TXT': {
        // Multiple quoted strings in one record are one value, joined
        const raw = remaining.join(' ');
        const matches = raw.match(/"([^"]*)"/g);
        const txtValue = matches
          ? matches.map((m) => m.slice(1, -1)).join('')
          : raw.replace(/"/g, '').trim();
        if (txtValue) add(txtValue);
        break;
      }

      case 'CAA': {
        // value: "<flag> <tag> <value>"
        const flag = parseInt(remaining[0], 10);
        const tag = (remaining[1] || '').toLowerCase();
        const value = remaining.slice(2).join(' ').replace(/^"|"$/g, '');
        if (!isNaN(flag) && tag && value) add(`${flag} ${tag} ${value}`);
        break;
      }

      case 'SRV': {
        // value: "<priority> <weight> <port> <target>"
        const [prio, weight, port, target] = remaining;
        if ([prio, weight, port].every((v) => /^\d+$/.test(v ?? '')) && target) {
          add(`${prio} ${weight} ${port} ${target.replace(/\.$/, '')}`);
        }
        break;
      }

      default:
        unsupported.push(`${name} ${type}`);
        break;
    }
  }

  return { records, unsupported };
}

const CAA_TAGS: Record<string, route53.CaaTag> = {
  issue: route53.CaaTag.ISSUE,
  issuewild: route53.CaaTag.ISSUEWILD,
  iodef: route53.CaaTag.IODEF,
};

interface PortfolioDNSStackProps extends cdk.StackProps {
  domainName: string;
  // Physical-resource-name prefix (bin/app.ts)
  projectSlug: string;
}

export class PortfolioDNSStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PortfolioDNSStackProps) {
    super(scope, id, props);

    const { domainName, projectSlug } = props;

    // CloudFront distribution domain, from SSM. Stored after the CDN stack's
    // first deploy (README, "Deploy"). Read through SSM rather than a
    // cross-stack reference so replacing the distribution never runs into an
    // export that's still in use.
    const cloudfrontDomain = ssm.StringParameter.valueForStringParameter(
      this, `/${projectSlug}/cloudfront-domain`,
    );

    // Public hosted zone. Route 53 assigns four nameservers on creation; point
    // the registrar at them after deployment.
    const zone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: domainName,
    });

    // Zone ID and name for other apps in this account (the tracker), which add
    // their own records to this zone. SSM rather than CloudFormation exports,
    // so neither app can block the other from changing.
    new ssm.StringParameter(this, 'SharedHostedZoneId', {
      parameterName: '/shared/hosted-zone-id',
      stringValue: zone.hostedZoneId,
      description: 'Route 53 hosted zone ID for the domain (owned by the portfolio app)',
    });
    new ssm.StringParameter(this, 'SharedHostedZoneName', {
      parameterName: '/shared/hosted-zone-name',
      stringValue: domainName,
      description: 'Route 53 hosted zone name for the domain (owned by the portfolio app)',
    });

    // ===========================
    // CLOUDFRONT ALIAS RECORDS (IPv4 and IPv6)
    // Alias records rather than CNAMEs, because DNS doesn't allow a CNAME at the
    // zone apex. Z2FDTNDATAQYW2 is the fixed hosted zone ID AWS uses for all
    // CloudFront distributions. The distribution has IPv6 enabled, so each name
    // gets an AAAA alias next to its A alias.
    // ===========================
    const aliasTarget = route53.RecordTarget.fromAlias({
      bind: () => ({
        dnsName: cloudfrontDomain,
        hostedZoneId: 'Z2FDTNDATAQYW2',
      }),
    });
    const aliasNames: Array<[string, string]> = [
      ['Apex', domainName],
      ['Www', 'www'],
      ['Resume', 'resume'],
    ];
    for (const [idPrefix, recordName] of aliasNames) {
      new route53.ARecord(this, `${idPrefix}AliasRecord`, { zone, recordName, target: aliasTarget });
      new route53.AaaaRecord(this, `${idPrefix}AliasRecordIpv6`, { zone, recordName, target: aliasTarget });
    }

    // ===========================
    // RECORDS PARSED FROM ZONE FILE
    // A, AAAA and CNAME records for the alias names above are skipped, since
    // those names are CloudFront aliases.
    // ===========================
    const zoneFilePath = path.join(__dirname, '..', 'zone.txt');

    if (!fs.existsSync(zoneFilePath)) {
      console.warn('WARNING: zone.txt not found at project root. Only CloudFront alias records will be created.');
    } else {
      const { records, unsupported } = parseZoneFile(fs.readFileSync(zoneFilePath, 'utf8'), domainName);

      if (unsupported.length > 0) {
        cdk.Annotations.of(this).addWarningV2(
          `${projectSlug}:dns:unsupportedRecords`,
          `zone.txt records not created (unsupported type): ${unsupported.join(', ')}. Add support in dns-stack.ts if they are needed.`,
        );
      }

      const usedIds: Record<string, number> = {};
      const uniqueId = (base: string): string => {
        const safe = base.replace(/[^A-Za-z0-9-]/g, '_');
        usedIds[safe] = (usedIds[safe] || 0) + 1;
        return usedIds[safe] === 1 ? safe : `${safe}${usedIds[safe]}`;
      };

      const skipNames = new Set(['@', 'www', 'resume']);
      const fqdn = (name: string) => (name === '@' ? domainName : name);

      for (const record of records) {
        if (skipNames.has(record.name) && ['A', 'AAAA', 'CNAME'].includes(record.type)) continue;

        const common = {
          zone,
          recordName: fqdn(record.name),
          ttl: cdk.Duration.seconds(record.ttl),
        };
        const id = uniqueId(`Zone${record.type}-${record.name}`);

        switch (record.type) {
          case 'A':
            new route53.ARecord(this, id, { ...common, target: route53.RecordTarget.fromIpAddresses(...record.values) });
            break;

          case 'AAAA':
            new route53.AaaaRecord(this, id, { ...common, target: route53.RecordTarget.fromIpAddresses(...record.values) });
            break;

          case 'CNAME':
            new route53.CnameRecord(this, id, { ...common, domainName: record.values[0] });
            break;

          case 'MX':
            new route53.MxRecord(this, id, {
              ...common,
              values: record.values.map((v) => {
                const [prio, host] = v.split(' ');
                return { priority: parseInt(prio, 10), hostName: host };
              }),
            });
            break;

          case 'TXT':
            new route53.TxtRecord(this, id, { ...common, values: record.values });
            break;

          case 'CAA': {
            const values = record.values.flatMap((v) => {
              const [flag, tag, ...rest] = v.split(' ');
              const caaTag = CAA_TAGS[tag];
              return caaTag ? [{ flag: parseInt(flag, 10), tag: caaTag, value: rest.join(' ') }] : [];
            });
            if (values.length > 0) new route53.CaaRecord(this, id, { ...common, values });
            break;
          }

          case 'SRV':
            new route53.SrvRecord(this, id, {
              ...common,
              values: record.values.map((v) => {
                const [priority, weight, port, hostName] = v.split(' ');
                return { priority: parseInt(priority, 10), weight: parseInt(weight, 10), port: parseInt(port, 10), hostName };
              }),
            });
            break;
        }
      }
    }

    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(', ', zone.hostedZoneNameServers!),
      description: 'Route 53 nameservers - point the registrar at these after deployment',
    });

    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: zone.hostedZoneId,
      description: 'Route 53 hosted zone ID',
    });
  }
}
