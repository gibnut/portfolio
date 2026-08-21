import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';

// ===========================
// ZONE FILE PARSER
// Reads zone.txt from project root at synth time
// zone.txt is gitignored — DNS data never reaches GitHub
// SOA and NS records are skipped — Route 53 manages these automatically
// Multiline records enclosed in parentheses are joined before parsing
// ===========================

interface ParsedRecord {
  type: string;
  name: string;
  ttl: number;
  values: string[];
  priority?: number;
}

function parseZoneFile(filePath: string, domainName: string): ParsedRecord[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const rawLines = content.split('\n');
  const records: ParsedRecord[] = [];
  let currentTtl = 3600;
  let lastOwner = '@';

  // ===========================
  // PASS 1 — Join multiline records
  // Records enclosed in parentheses span multiple lines.
  // Join them into single lines before parsing.
  // Strip inline comments (everything after ;) during this pass.
  // ===========================
  const lines: string[] = [];
  let buffer = '';
  let inParens = false;

  for (const rawLine of rawLines) {
    // Strip inline comments (;) but only outside of quoted strings
    // e.g. "v=DMARC1; p=quarantine" must not be truncated at the semicolon
    let line = '';
    let inQuotes = false;
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      if (ch === ';' && !inQuotes) break;
      line += ch;
    }
    line = line.trim();

    if (!line) continue;

    if (inParens) {
      buffer += ' ' + line;
      if (line.includes(')')) {
        inParens = false;
        lines.push(buffer.replace(/[()]/g, '').trim());
        buffer = '';
      }
    } else if (line.includes('(')) {
      inParens = true;
      buffer = line;
      if (line.includes(')')) {
        inParens = false;
        lines.push(buffer.replace(/[()]/g, '').trim());
        buffer = '';
      }
    } else {
      lines.push(line);
    }
  }

  // ===========================
  // PASS 2 — Parse joined lines into records
  // ===========================
  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith('$')) {
      if (line.startsWith('$TTL')) {
        const ttlVal = parseInt(line.split(/\s+/)[1]);
        if (!isNaN(ttlVal)) currentTtl = ttlVal;
      }
      continue;
    }

    const parts = line.split(/\s+/).filter(p => p.length > 0);
    if (parts.length < 2) continue;

    let idx = 0;

    const startsWithWhitespace = /^\s/.test(
      rawLines.find(r => r.trim() === line.trim()) || line
    );

    let name: string;
    if (startsWithWhitespace) {
      name = lastOwner;
    } else {
      name = parts[idx++];
      lastOwner = name;
    }

    if (name !== '@') {
      if (name.endsWith('.')) name = name.slice(0, -1);
      if (name === domainName) name = '@';
      else if (name.endsWith('.' + domainName)) {
        name = name.slice(0, -(domainName.length + 1));
      }
    }

    let ttl = currentTtl;
    if (idx < parts.length && /^\d+$/.test(parts[idx])) {
      ttl = parseInt(parts[idx++]);
    }

    if (idx < parts.length && /^(IN|CH|HS)$/i.test(parts[idx])) {
      idx++;
    }

    if (idx < parts.length && /^\d+$/.test(parts[idx])) {
      ttl = parseInt(parts[idx++]);
    }

    if (idx >= parts.length) continue;
    const type = parts[idx++].toUpperCase();

    if (type === 'SOA' || type === 'NS') continue;

    if (idx >= parts.length) continue;

    const remaining = parts.slice(idx);

    switch (type) {
      case 'A':
        if (remaining[0]) {
          records.push({ type, name, ttl, values: [remaining[0]] });
        }
        break;

      case 'AAAA':
        if (remaining[0]) {
          records.push({ type, name, ttl, values: [remaining[0]] });
        }
        break;

      case 'CNAME': {
        let cname = remaining[0] || '';
        if (cname.endsWith('.')) cname = cname.slice(0, -1);
        if (cname) records.push({ type, name, ttl, values: [cname] });
        break;
      }

      case 'MX': {
        const prio = parseInt(remaining[0]);
        const host = remaining[1] || '';
        if (!isNaN(prio) && host) {
          records.push({
            type,
            name,
            ttl,
            priority: prio,
            values: [host.endsWith('.') ? host : host + '.'],
          });
        }
        break;
      }

      case 'TXT': {
        const raw = remaining.join(' ');
        const matches = raw.match(/"([^"]*)"/g);
        const txtValue = matches
          ? matches.map(m => m.replace(/"/g, '')).join('')
          : raw.replace(/"/g, '').trim();

        if (!txtValue) break;

        const existing = records.find(r => r.type === 'TXT' && r.name === name);
        if (existing) {
          existing.values.push(txtValue);
        } else {
          records.push({ type, name, ttl, values: [txtValue] });
        }
        break;
      }

      default:
        break;
    }
  }

  return records;
}

interface PortfolioDNSStackProps extends cdk.StackProps {
  domainName: string;
}

export class PortfolioDNSStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PortfolioDNSStackProps) {
    super(scope, id, props);

    const { domainName } = props;

    // CloudFront distribution domain retrieved from SSM Parameter Store
    // Stored after CDN stack deployment via:
    // aws ssm put-parameter --name "/portfolio/cloudfront-domain" --value "d1234abcd.cloudfront.net" --type "String" --profile personal
    const cloudfrontDomain = ssm.StringParameter.valueForStringParameter(
      this, '/portfolio/cloudfront-domain'
    );

    // Public hosted zone for the domain
    // Route 53 assigns four nameservers on creation
    // Update registrar nameservers to these values after deployment
    const zone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: domainName,
    });

    // ===========================
    // CLOUDFRONT ALIAS RECORDS
    // Route 53 Alias records are used rather than CNAMEs because
    // the DNS standard does not permit CNAME records at the zone apex.
    // Alias records resolve at the Route 53 level with no additional
    // DNS lookup and incur no TTL delay on updates.
    // Z2FDTNDATAQYW2 is the hosted zone ID for all CloudFront
    // distributions and is a fixed AWS value.
    // ===========================
    new route53.ARecord(this, 'ApexAliasRecord', {
      zone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias({
        bind: () => ({
          dnsName: cloudfrontDomain,
          hostedZoneId: 'Z2FDTNDATAQYW2',
        }),
      }),
    });

    new route53.ARecord(this, 'WwwAliasRecord', {
      zone,
      recordName: 'www',
      target: route53.RecordTarget.fromAlias({
        bind: () => ({
          dnsName: cloudfrontDomain,
          hostedZoneId: 'Z2FDTNDATAQYW2',
        }),
      }),
    });

    new route53.ARecord(this, 'ResumeAliasRecord', {
      zone,
      recordName: 'resume',
      target: route53.RecordTarget.fromAlias({
        bind: () => ({
          dnsName: cloudfrontDomain,
          hostedZoneId: 'Z2FDTNDATAQYW2',
        }),
      }),
    });

    // ===========================
    // RECORDS PARSED FROM ZONE FILE
    // zone.txt is read at synth time from the project root
    // The file is gitignored — DNS data never reaches GitHub
    // SOA and NS records are skipped — Route 53 manages these automatically
    // A and CNAME records for apex, www, and resume are skipped here
    // since they are handled above as CloudFront alias records
    // ===========================
    const zoneFilePath = path.join(__dirname, '..', 'zone.txt');

    if (!fs.existsSync(zoneFilePath)) {
      console.warn('WARNING: zone.txt not found at project root. Only CloudFront alias records will be created.');
    } else {
      const parsed = parseZoneFile(zoneFilePath, domainName);

      const usedIds: Record<string, number> = {};
      const uniqueId = (base: string): string => {
        usedIds[base] = (usedIds[base] || 0) + 1;
        return usedIds[base] === 1 ? base : `${base}${usedIds[base]}`;
      };

      // These names are handled as CloudFront alias records above
      // Skip both A and CNAME records for these names to avoid conflicts
      const skipNames = new Set(['@', 'www', 'resume']);

      for (const record of parsed) {
        // Skip apex, www, and resume for both A and CNAME types
        if (skipNames.has(record.name) && (record.type === 'A' || record.type === 'CNAME')) continue;

        switch (record.type) {
          case 'A':
            new route53.ARecord(this, uniqueId(`ZoneA-${record.name}`), {
              zone,
              recordName: record.name === '@' ? domainName : record.name,
              target: route53.RecordTarget.fromIpAddresses(...record.values),
              ttl: cdk.Duration.seconds(record.ttl),
            });
            break;

          case 'CNAME':
            new route53.CnameRecord(this, uniqueId(`ZoneCNAME-${record.name}`), {
              zone,
              recordName: record.name,
              domainName: record.values[0],
              ttl: cdk.Duration.seconds(record.ttl),
            });
            break;

          case 'MX': {
            const allMx = parsed.filter(r => r.type === 'MX' && r.name === record.name);
            if (allMx[0] !== record) break;
            new route53.MxRecord(this, uniqueId(`ZoneMX-${record.name}`), {
              zone,
              recordName: record.name === '@' ? domainName : record.name,
              values: allMx.map(r => ({
                hostName: r.values[0],
                priority: r.priority || 10,
              })),
              ttl: cdk.Duration.seconds(record.ttl),
            });
            break;
          }

          case 'TXT':
            new route53.TxtRecord(this, uniqueId(`ZoneTXT-${record.name}`), {
              zone,
              recordName: record.name === '@' ? domainName : record.name,
              values: record.values,
              ttl: cdk.Duration.seconds(record.ttl),
            });
            break;
        }
      }
    }

    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(', ', zone.hostedZoneNameServers!),
      description: 'Route 53 nameservers — update registrar to these values after deployment',
    });

    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: zone.hostedZoneId,
      description: 'Route 53 hosted zone ID',
    });
  }
}
