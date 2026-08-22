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
  // Dedicated logging bucket name — receives CloudFront access logs
  // Separate from the website bucket to prevent BucketDeployment conflicts
  loggingBucketName: string;
  certificate: acm.ICertificate;
  apiOriginDomain: string;
}

export class PortfolioCDNStack extends cdk.Stack {
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: PortfolioCDNStackProps) {
    super(scope, id, props);

    const { domainName, bucketName, bucketArn, loggingBucketName, certificate, apiOriginDomain } = props;

    // Import website bucket by name/arn
    // Avoids cross-stack object reference that caused dependency cycle
    const bucket = s3.Bucket.fromBucketAttributes(this, 'ImportedBucket', {
      bucketName,
      bucketArn,
    });

    // Import logging bucket by name
    // CloudFront access logs are written here under cloudfront-logs/ prefix
    const loggingBucket = s3.Bucket.fromBucketName(this, 'ImportedLoggingBucket', loggingBucketName);

    const redirectFunction = new cloudfront.Function(this, 'RedirectFunction', {
      functionName: 'portfolio-redirects',
      // Full rationale: handles www/subdomain redirects, resolves the two real
      // routes (/ and /resume) to index.html, and rejects everything else at
      // the edge via an allowlist — stops scanner probes (/wp-*, *.php, /.env,
      // random filenames) from ever reaching S3, instead of a blocklist.
      comment: 'Redirects + edge allowlist for known routes/assets',
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

  // Strip a single trailing slash for route matching. Root '/' must become
  // '' here too, not just '/resume/' -> '/resume' — no length guard, since
  // an empty string doesn't end in '/' anyway.
  var path = uri;
  if (path.charAt(path.length - 1) === '/') {
    path = path.slice(0, -1);
  }

  // The site has exactly two real routes. Anything else extensionless
  // (e.g. /wp-admin, /phpmyadmin) falls through to the reject at the bottom
  // instead of silently becoming /whatever/index.html.
  if (path === '' || path === '/resume') {
    request.uri = (path === '' ? '/index.html' : path + '/index.html');
    return request;
  }

  // Static asset allowlist — anything with one of these extensions is passed
  // through as-is. S3 will 404 it naturally if the specific file doesn't exist;
  // this only guards against non-asset paths reaching the origin at all.
  var allowedExtensions = [
    '.html', '.css', '.js', '.mjs', '.json',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
    '.woff', '.woff2', '.ttf', '.eot',
    '.pdf', '.xml', '.txt', '.webmanifest', '.map'
  ];
  var lower = uri.toLowerCase();
  for (var i = 0; i < allowedExtensions.length; i++) {
    if (lower.indexOf(allowedExtensions[i], lower.length - allowedExtensions[i].length) !== -1) {
      return request;
    }
  }

  // Everything else — .php, /wp-*, /.env, /.git/*, /cgi-bin/*, random-named
  // probe files, etc. — never reaches S3. No blocklist to maintain: if it's
  // not one of the two real routes or a recognized asset extension, it's rejected.
  return {
    statusCode: 404,
    statusDescription: 'Not Found',
    headers: { 'content-type': { value: 'text/plain' } },
    body: { encoding: 'text', data: 'Not Found' }
  };
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
      // CloudFront access logs go to the dedicated logging bucket
      // No longer writing to the website bucket — eliminates BucketDeployment conflict
      enableLogging: true,
      logBucket: loggingBucket,
      logFilePrefix: 'cloudfront-logs/',
    });

    // BucketDeployment syncs website files to S3
    // prune defaults to true but only affects the website bucket
    // which contains only website files — no log files to conflict with
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
      description: 'CloudFront distribution domain',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID — use for cache invalidation after deploys',
    });

    new cdk.CfnOutput(this, 'DistributionArnNote', {
      value: `Add CloudFront distribution ARN to cdk.json cloudfrontDistributionArn context key, then redeploy PortfolioStorageStack to apply OAC bucket policy`,
      description: 'Post-deploy step required after first CDN deployment',
    });

    new cdk.CfnOutput(this, 'ContactEndpointNote', {
      value: `Contact form endpoint in HTML: https://${domainName}/contact — API Gateway URL never exposed`,
      description: 'CloudFront proxy hides real API Gateway endpoint',
    });
  }
}
