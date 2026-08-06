#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { PortfolioCertificateStack } from '../lib/certificate-stack';
import { PortfolioStorageStack } from '../lib/storage-stack';
import { PortfolioCDNStack } from '../lib/cdn-stack';
import { PortfolioAPIStack } from '../lib/api-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1'
};

const domainName: string = app.node.tryGetContext('domainName');
if (!domainName) {
  throw new Error('domainName must be set in cdk.json context. See cdk.json.example.');
}

// After first CDN deploy, store the distribution ARN in SSM:
// aws ssm put-parameter --name /portfolio/cloudfront-distribution-arn --value "arn:aws:cloudfront::ACCOUNT:distribution/ID" --type String --profile personal
// Then redeploy storage stack to apply the OAC bucket policy
const cloudfrontDistributionArn = app.node.tryGetContext('cloudfrontDistributionArn') as string | undefined;

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
  cloudfrontDistributionArn,
  description: 'portfolio: S3 bucket for static site assets'
});

// Stack 3 — API (Lambda + API Gateway + SES)
const apiStack = new PortfolioAPIStack(app, 'PortfolioAPIStack', {
  env,
  domainName,
  description: 'portfolio: Lambda contact form, API Gateway, and SES domain verification'
});

// Stack 4 — CloudFront CDN
const cdnStack = new PortfolioCDNStack(app, 'PortfolioCDNStack', {
  env,
  domainName,
  bucketName: storageStack.bucketName,
  bucketArn: storageStack.bucketArn,
  certificate: certificateStack.certificate,
  apiOriginDomain: apiStack.apiOriginDomain,
  description: 'portfolio: CloudFront distribution, OAC, redirect function, and API proxy'
});
cdnStack.addStackDependency(apiStack);
cdnStack.addStackDependency(storageStack);
cdnStack.addStackDependency(certificateStack);

app.synth();
