#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PortfolioCertificateStack } from '../lib/certificate-stack';
import { PortfolioStorageStack } from '../lib/storage-stack';
import { PortfolioCDNStack } from '../lib/cdn-stack';
import { PortfolioAPIStack } from '../lib/api-stack';
import { PortfolioDNSStack } from '../lib/dns-stack';
import { PortfolioBudgetStack } from '../lib/budget-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1'
};

const domainName: string = app.node.tryGetContext('domainName');
if (!domainName) {
  throw new Error('domainName must be set in cdk.json context. See cdk.json.example.');
}

const cloudfrontDistributionArn = app.node.tryGetContext('cloudfrontDistributionArn') as string | undefined;

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

app.synth();
