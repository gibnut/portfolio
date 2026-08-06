#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PortfolioCertificateStack } from '../lib/certificate-stack';
import { PortfolioStorageStack } from '../lib/storage-stack';
import { PortfolioCDNStack } from '../lib/cdn-stack';
import { PortfolioAPIStack } from '../lib/api-stack';

const app = new cdk.App();

// All resources deploy to us-east-1
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1'
};

// Domain name loaded from CDK context (cdk.json — gitignored)
const domainName: string = app.node.tryGetContext('domainName');
if (!domainName) {
  throw new Error('domainName must be set in cdk.json context. See cdk.json.example.');
}

// Stack 1 — ACM Certificate
const certificateStack = new PortfolioCertificateStack(app, 'PortfolioCertificateStack', {
  env,
  domainName,
  description: 'portfolio: ACM wildcard certificate for CloudFront'
});

// Stack 2 — S3 Storage
const storageStack = new PortfolioStorageStack(app, 'PortfolioStorageStack', {
  env,
  domainName,
  description: 'portfolio: S3 bucket for static site assets'
});

// Stack 3 — API (Lambda + API Gateway + SES)
// Deployed before CDN so CDN can reference the API endpoint
const apiStack = new PortfolioAPIStack(app, 'PortfolioAPIStack', {
  env,
  domainName,
  description: 'portfolio: Lambda contact form, API Gateway, and SES domain verification'
});

// Stack 4 — CloudFront CDN
// Depends on certificate, storage, and API stacks
const cdnStack = new PortfolioCDNStack(app, 'PortfolioCDNStack', {
  env,
  domainName,
  bucket: storageStack.bucket,
  certificate: certificateStack.certificate,
  apiEndpoint: apiStack.apiEndpoint,
  description: 'portfolio: CloudFront distribution, OAC, redirect function, and API proxy'
});
cdnStack.addDependency(certificateStack);
cdnStack.addDependency(storageStack);
cdnStack.addDependency(apiStack);

app.synth();
