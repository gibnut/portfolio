#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PortfolioCertificateStack } from '../lib/certificate-stack';
import { PortfolioStorageStack } from '../lib/storage-stack';
import { PortfolioCDNStack } from '../lib/cdn-stack';
import { PortfolioAPIStack } from '../lib/api-stack';
import { PortfolioDNSStack } from '../lib/dns-stack';
import { PortfolioAthenaStack } from '../lib/athena-stack';
import { logRetention } from '../lib/common/utils/retention';

const app = new cdk.App();

// Fixed CDK behavior settings for this codebase. They are not deployment-specific
// data like domainName or an ARN, so they live in code rather than in the
// gitignored cdk.json, and every fresh clone gets them.
//
// defaultCrossStackReferences: this app passes values between stacks (the CDN
// stack consumes the storage stack's buckets, the certificate stack's
// certificate and the API stack's origin domain). "strong" links them with
// CloudFormation exports and imports, so CloudFormation won't let a stack
// remove an output another stack still uses. CDK behaves this way when the flag
// is unset, but then warns on every synth and recommends migrating to "weak".
// Setting "strong" explicitly locks in the current behavior and silences the
// warning. Known cost ("deadly embrace"): replacing an exported resource, such
// as the certificate, is rejected while another stack imports it. See
// docs/notes.md, "Decisions", before changing this.
app.node.setContext('@aws-cdk/core:defaultCrossStackReferences', 'strong');

// Pinned account: the CDK CLI refuses to deploy if the --profile credentials
// belong to a different account. The ID lives in gitignored cdk.json.
const accountId: string = app.node.tryGetContext('accountId');
if (!accountId || !/^\d{12}$/.test(accountId) || accountId === '000000000000') {
  throw new Error('accountId must be set in cdk.json context as a 12-digit string. See cdk.json.example.');
}
const env = {
  account: accountId,
  region: 'us-east-1',
};

const domainName: string = app.node.tryGetContext('domainName');
if (!domainName || domainName === 'your-domain.com') {
  throw new Error('domainName must be set in cdk.json context. See cdk.json.example.');
}

// Prefix for every physical AWS resource name and SSM parameter path in this
// app (Lambda functions, IAM roles, /portfolio/... parameters, the Glue
// database, the Athena workgroup, alarms, SNS topics). Fixed rather than
// derived from the domain, so names stay the same if the domain ever changes
// and never collide with another app in the same account.
const projectSlug = 'portfolio';

// How long the app keeps data, in days, in one place: every Lambda log group,
// the logging bucket (CloudFront logs, S3 access logs, the Athena Parquet
// copies), and old versions of website files. Notes:
// - Log groups accept only fixed values (1, 3, 5, 7, 14, 30, 60, 90, 120, 150,
//   180, 365, ...); synth fails with the list if this isn't one of them.
// - Lowering it deletes data older than the new value on the next deploy.
// - Athena query results keep their own 30 days (athena-stack.ts): scratch files.
const retentionDays = 90;
logRetention(retentionDays); // fails synth now, with a clear message, if the value isn't allowed

// Termination protection: CloudFormation refuses to delete these stacks until
// it's switched off (deploys and updates are unaffected). On every stack whose
// loss would cause an outage or lose data: the hosted zone and its nameservers
// (DNS), the distribution's address (CDN), the SES identity and its DKIM
// records (API), the buckets (Storage), and the certificate. Athena holds
// nothing a redeploy can't restore.
const terminationProtection = true;

// Optional ARNs from cdk.json. An empty string ("") means "not set yet", which
// is how cdk.json.example ships them, so a verbatim copy is safe to synth.
// Anything else must look like a real ARN: a leftover placeholder fails here
// instead of quietly turning on the Athena stack or writing a bucket policy
// for a distribution that doesn't exist.
function optionalArn(key: string): string | undefined {
  const value: unknown = app.node.tryGetContext(key);
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !/^arn:aws:[a-z0-9-]+:/.test(value) || /[<>]|ACCOUNT_ID|DISTRIBUTION_ID/.test(value)) {
    throw new Error(`${key} in cdk.json is not a real ARN ("${String(value)}"). Set the real value, or leave it as "" until then. See README.md, "Configure CDK context".`);
  }
  return value;
}
const cloudfrontDistributionArn = optionalArn('cloudfrontDistributionArn');
const pandasLayerArn = optionalArn('pandasLayerArn');

// Stack 1 - ACM certificate
const certificateStack = new PortfolioCertificateStack(app, 'PortfolioCertificateStack', {
  env,
  terminationProtection,
  domainName,
  projectSlug,
  description: `${projectSlug}: ACM wildcard certificate for CloudFront`,
});

// Stack 2 - S3 storage: the website bucket and a dedicated logging bucket
const storageStack = new PortfolioStorageStack(app, 'PortfolioStorageStack', {
  env,
  terminationProtection,
  domainName,
  projectSlug,
  cloudfrontDistributionArn,
  retentionDays,
  description: `${projectSlug}: S3 website bucket and dedicated logging bucket`,
});

// Stack 3 - API (Lambda + API Gateway + SES)
const apiStack = new PortfolioAPIStack(app, 'PortfolioAPIStack', {
  env,
  terminationProtection,
  domainName,
  projectSlug,
  retentionDays,
  description: `${projectSlug}: Lambda contact form, API Gateway, and SES domain verification`,
});

// Stack 4 - CloudFront CDN
// CloudFront logs go to the dedicated logging bucket, so BucketDeployment never
// prunes them.
const cdnStack = new PortfolioCDNStack(app, 'PortfolioCDNStack', {
  env,
  terminationProtection,
  domainName,
  projectSlug,
  bucketName: storageStack.bucketName,
  bucketArn: storageStack.bucketArn,
  loggingBucketName: storageStack.loggingBucketName,
  certificate: certificateStack.certificate,
  apiOriginDomain: apiStack.apiOriginDomain,
  retentionDays,
  description: `${projectSlug}: CloudFront distribution, OAC, edge function, and API proxy`,
});
cdnStack.addStackDependency(apiStack);
cdnStack.addStackDependency(storageStack);
cdnStack.addStackDependency(certificateStack);

// Stack 5 - DNS: hosted zone, CloudFront alias records, zone.txt import
const dnsStack = new PortfolioDNSStack(app, 'PortfolioDNSStack', {
  env,
  terminationProtection,
  domainName,
  projectSlug,
  description: `${projectSlug}: Route 53 hosted zone and DNS records`,
});
dnsStack.addStackDependency(cdnStack);

// Stack 6 - Athena (optional; only added if pandasLayerArn is set)
// Read-only against the logging bucket from PortfolioStorageStack: queries
// CloudFront logs, never manages the bucket itself.
//
// Conditional on purpose: pandasLayerArn is a one-time manual lookup (see
// README), and this stack shouldn't block deploying any of the others while that
// value isn't set yet. `cdk deploy --all` before setting it deploys every other
// stack normally and skips this one.
if (pandasLayerArn) {
  const athenaStack = new PortfolioAthenaStack(app, 'PortfolioAthenaStack', {
    env,
    domainName,
    projectSlug,
    loggingBucketName: storageStack.loggingBucketName,
    pandasLayerArn,
    retentionDays,
    description: `${projectSlug}: Athena database and tables, ETL Lambda, and saved queries for CloudFront log analysis`,
  });
  athenaStack.addStackDependency(storageStack);
} else {
  console.warn(
    'Skipping PortfolioAthenaStack: pandasLayerArn is not set in cdk.json context. ' +
    'See README.md ("Configure CDK context") to add it. Every other stack is unaffected.',
  );
}

const assembly = app.synth();

// CloudFormation templates must be pure ASCII. Em dashes, en dashes, curly
// quotes and similar characters in descriptions, outputs, or the edge function
// get stored in mangled form, and every `cdk diff` then reports them as
// "Omitted N changes because they are likely mangled non-ASCII characters."
// Use plain hyphens and straight quotes in anything that reaches a template.
// Comments in .ts files are fine; they never reach a template.
for (const stack of assembly.stacks) {
  const json = JSON.stringify(stack.template);
  const match = json.match(/[^\x00-\x7f]/);
  if (match) {
    const at = json.indexOf(match[0]);
    throw new Error(`${stack.stackName} template contains a non-ASCII character ("${match[0]}", U+${match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}) near: ...${json.slice(Math.max(0, at - 80), at + 20)}... Replace it with a plain ASCII character (e.g. a hyphen).`);
  }
}

// Every Lambda function, including the helper Lambdas CDK adds for things like
// BucketDeployment and autoDeleteObjects, must send its logs to a log group
// this app creates with a retention period. Otherwise Lambda creates
// /aws/lambda/<name> on the first run with no expiry, and its logs are kept
// forever.
for (const stack of assembly.stacks) {
  const resources: Record<string, { Type: string; Properties?: { LoggingConfig?: { LogGroup?: unknown } } }> = stack.template.Resources ?? {};
  for (const [id, resource] of Object.entries(resources)) {
    if (resource.Type === 'AWS::Lambda::Function' && !resource.Properties?.LoggingConfig?.LogGroup) {
      throw new Error(`${stack.stackName}: Lambda function ${id} has no log group, so its logs would never expire. Give it a logs.LogGroup with a retention period (see the log groups in api-stack.ts, cdn-stack.ts and athena-stack.ts).`);
    }
  }
}
