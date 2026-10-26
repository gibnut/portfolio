#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PortfolioCertificateStack } from '../lib/certificate-stack';
import { PortfolioStorageStack } from '../lib/storage-stack';
import { PortfolioCDNStack } from '../lib/cdn-stack';
import { PortfolioAPIStack } from '../lib/api-stack';
import { PortfolioDNSStack } from '../lib/dns-stack';
import { PortfolioBudgetStack } from '../lib/budget-stack';
import { PortfolioAthenaStack } from '../lib/athena-stack';
const app = new cdk.App();
// Pinned account: the CDK CLI refuses to deploy if the --profile credentials
// belong to a different account. The ID lives in gitignored cdk.json.
const accountId: string = app.node.tryGetContext('accountId');
if (!accountId || !/^\d{12}$/.test(accountId)) {
  throw new Error('accountId must be set in cdk.json context as a 12-digit string. See cdk.json.example.');
}
const env = {
  account: accountId,
  region: 'us-east-1'
};
const domainName: string = app.node.tryGetContext('domainName');
if (!domainName) {
  throw new Error('domainName must be set in cdk.json context. See cdk.json.example.');
}
const cloudfrontDistributionArn = app.node.tryGetContext('cloudfrontDistributionArn') as string | undefined;
const pandasLayerArn = app.node.tryGetContext('pandasLayerArn') as string | undefined;
// Stack 1 — ACM Certificate
const certificateStack = new PortfolioCertificateStack(app, 'PortfolioCertificateStack', {
  env,
  domainName,
  description: 'portfolio: ACM wildcard certificate for CloudFront'
});
// Stack 2 — S3 Storage
// Creates both the website bucket and a dedicated logging bucket
const storageStack = new PortfolioStorageStack(app, 'PortfolioStorageStack', {
  env,
  domainName,
  cloudfrontDistributionArn,
  description: 'portfolio: S3 website bucket and dedicated logging bucket'
});
// Stack 3 — API (Lambda + API Gateway + SES)
const apiStack = new PortfolioAPIStack(app, 'PortfolioAPIStack', {
  env,
  domainName,
  description: 'portfolio: Lambda contact form, API Gateway, and SES domain verification'
});
// Stack 4 — CloudFront CDN
// Receives loggingBucketName from storage stack
// CloudFront logs go to dedicated logging bucket — no conflict with BucketDeployment
const cdnStack = new PortfolioCDNStack(app, 'PortfolioCDNStack', {
  env,
  domainName,
  bucketName: storageStack.bucketName,
  bucketArn: storageStack.bucketArn,
  loggingBucketName: storageStack.loggingBucketName,
  certificate: certificateStack.certificate,
  apiOriginDomain: apiStack.apiOriginDomain,
  description: 'portfolio: CloudFront distribution, OAC, redirect function, and API proxy'
});
cdnStack.addStackDependency(apiStack);
cdnStack.addStackDependency(storageStack);
cdnStack.addStackDependency(certificateStack);
// Stack 5 — DNS
const dnsStack = new PortfolioDNSStack(app, 'PortfolioDNSStack', {
  env,
  domainName,
  description: 'portfolio: Route 53 hosted zone and DNS records'
});
dnsStack.addStackDependency(cdnStack);
// Stack 6 — Budget
new PortfolioBudgetStack(app, 'PortfolioBudgetStack', {
  env,
  domainName,
  description: 'portfolio: Monthly cost budget and alert'
});
// Stack 7 — Athena (optional — only added if pandasLayerArn is set)
// Read-only against the logging bucket from PortfolioStorageStack — queries CloudFront logs,
// never manages the bucket itself.
//
// Conditional on purpose: pandasLayerArn is a one-time manual lookup (see README),
// and this stack shouldn't block deploying any of the others while that value isn't
// set yet. If you run `cdk deploy` with no stack name (deploys everything) before
// setting it, every other stack deploys normally and this one is just skipped —
// re-run once pandasLayerArn is in cdk.json to add it in.
if (pandasLayerArn) {
  const athenaStack = new PortfolioAthenaStack(app, 'PortfolioAthenaStack', {
    env,
    domainName,
    loggingBucketName: storageStack.loggingBucketName,
    pandasLayerArn,
    description: 'portfolio: Athena database/tables, ETL Lambda, and saved queries for CloudFront log analysis'
  });
  athenaStack.addStackDependency(storageStack);
} else {
  console.warn(
    'Skipping PortfolioAthenaStack: pandasLayerArn is not set in cdk.json context. ' +
    'See README.md ("Configure CDK context") to add it — every other stack is unaffected.'
  );
}
app.synth();
