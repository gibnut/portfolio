import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface PortfolioCDNStackProps extends cdk.StackProps {
  domainName: string;
  bucket: s3.IBucket;
  certificate: acm.ICertificate;
  // API Gateway endpoint passed in from API stack
  // Used to create CloudFront proxy behavior
  // Never appears in HTML source code
  apiEndpoint: string;
}

export class PortfolioCDNStack extends cdk.Stack {
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: PortfolioCDNStackProps) {
    super(scope, id, props);

    const { domainName, bucket, certificate, apiEndpoint } = props;

    // Parse API Gateway origin from full endpoint URL
    // e.g. https://abc123.execute-api.us-east-1.amazonaws.com/contact
    // -> abc123.execute-api.us-east-1.amazonaws.com
    const apiUrl = new URL(apiEndpoint);
    const apiOriginDomain = apiUrl.hostname;

    // CloudFront function handles all redirects at the edge
    // www.example.com -> example.com
    // resume.example.com -> example.com/resume
    // Appends index.html to directory requests
    const redirectFunction = new cloudfront.Function(this, 'RedirectFunction', {
      functionName: 'portfolio-redirects',
      comment: 'Handles www and subdomain redirects, and appends index.html',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var host = request.headers.host
    ? request.headers.host.value
    : '';
  var uri = request.uri;

  // Redirect www to apex
  if (host === 'www.${domainName}') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://${domainName}' + uri }
      }
    };
  }

  // Redirect resume subdomain to /resume path
  if (host === 'resume.${domainName}') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://${domainName}/resume' }
      }
    };
  }

  // Append index.html to directory requests
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

    // Origin Access Control — only CloudFront can read from S3
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      description: 'portfolio OAC for S3 bucket access',
    });

    // Security headers policy applied to all responses
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

    // API Gateway origin for contact form proxy
    // Proxies /contact requests to API Gateway
    // API Gateway URL never appears in HTML source code
    const apiOrigin = new origins.HttpOrigin(apiOriginDomain, {
      originPath: '/contact',
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    // Cache policy for API — no caching, always fresh
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'APICachePolicy', {
      cachePolicyName: 'portfolio-api-no-cache',
      defaultTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(0),
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'portfolio',
      domainNames: [
        domainName,
        `www.${domainName}`,
        `resume.${domainName}`,
      ],
      certificate,

      // Default behavior — serves static site from S3
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

      // /contact behavior — proxies to API Gateway
      // Visitor sees yourdomain.com/contact in the HTML
      // Real API Gateway URL is never exposed
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

    this.distributionDomainName = distribution.distributionDomainName;

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain — add as CNAME in GoDaddy',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'GoDaddyNote', {
      value: `Add CNAME records in GoDaddy: ${domainName}, www.${domainName}, and resume.${domainName} all pointing to ${distribution.distributionDomainName}`,
      description: 'Manual DNS step required in GoDaddy',
    });

    new cdk.CfnOutput(this, 'ContactEndpointNote', {
      value: `Contact form endpoint visible in HTML: https://${domainName}/contact — API Gateway URL never exposed`,
      description: 'CloudFront proxy hides real API Gateway endpoint',
    });
  }
}
