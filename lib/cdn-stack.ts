import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

interface PortfolioCDNStackProps extends cdk.StackProps {
  domainName: string;
  bucketName: string;
  bucketArn: string;
  certificate: acm.ICertificate;
  apiOriginDomain: string;
}

export class PortfolioCDNStack extends cdk.Stack {
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: PortfolioCDNStackProps) {
    super(scope, id, props);

    const { domainName, bucketName, bucketArn, certificate, apiOriginDomain } = props;

    // Import bucket by name/arn rather than passing the object
    // This breaks the cross-stack object reference that causes the dependency cycle
    const bucket = s3.Bucket.fromBucketAttributes(this, 'ImportedBucket', {
      bucketName,
      bucketArn,
    });

    const redirectFunction = new cloudfront.Function(this, 'RedirectFunction', {
      functionName: 'portfolio-redirects',
      comment: 'Handles www and subdomain redirects, and appends index.html',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value : '';
  var uri = request.uri;

  if (host === 'www.${domainName}') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://${domainName}' + uri } }
    };
  }

  if (host === 'resume.${domainName}') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://${domainName}/resume' } }
    };
  }

  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (!uri.includes('.')) {
    request.uri = uri + '/index.html';
  }

  return request;
}
      `),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      description: 'portfolio OAC for S3 bucket access',
    });

    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        xssProtection: {
          protection: true,
          modeBlock: true,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    const apiOrigin = new origins.HttpOrigin(apiOriginDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    const apiCachePolicy = new cloudfront.CachePolicy(this, 'APICachePolicy', {
      cachePolicyName: 'portfolio-api-no-cache',
      defaultTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(0),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'portfolio',
      domainNames: [
        domainName,
        `www.${domainName}`,
        `resume.${domainName}`,
      ],
      certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeadersPolicy,
        functionAssociations: [{
          function: redirectFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      additionalBehaviors: {
        '/contact': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: apiCachePolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeadersPolicy,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
      enableLogging: true,
      logFilePrefix: 'cloudfront-logs/',
    });

    // BucketDeployment without distribution reference
    // Cache invalidation handled separately via CLI after deploy
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('./website')],
      destinationBucket: bucket,
      cacheControl: [
        s3deploy.CacheControl.fromString('max-age=300, must-revalidate'),
      ],
    });

    this.distributionDomainName = distribution.distributionDomainName;

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain — add as CNAME in GoDaddy',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID — use for cache invalidation after deploys',
    });

    new cdk.CfnOutput(this, 'GoDaddyNote', {
      value: `Add CNAME records in GoDaddy: ${domainName}, www.${domainName}, and resume.${domainName} all pointing to ${distribution.distributionDomainName}`,
      description: 'Manual DNS step required in GoDaddy',
    });

    new cdk.CfnOutput(this, 'ContactEndpointNote', {
      value: `Contact form endpoint in HTML: https://${domainName}/contact — API Gateway URL never exposed`,
      description: 'CloudFront proxy hides real API Gateway endpoint',
    });
  }
}
